//! Hub Nyota : projets, fichiers, versions et collaboration en temps réel (contrat : docs/hub.md).

pub mod api;
pub mod db;
pub mod ops;
pub mod proxy;
pub mod rooms;
pub mod ws;

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::{any, get};
use tokio::net::TcpListener;
use tokio::sync::watch;
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::{DefaultOnFailure, TraceLayer};

use crate::db::Db;
use crate::rooms::Hub;

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Taille maximale d'un corps de requête (documents, vignettes).
const BODY_LIMIT: usize = 64 * 1024 * 1024;

/// Configuration, lue depuis l'environnement (voir docs/hub.md).
#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub db_path: PathBuf,
    pub static_dir: Option<PathBuf>,
    pub mcp_url: Option<String>,
    pub legacy_doc: Option<PathBuf>,
}

impl Config {
    pub fn from_env() -> Config {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        Config {
            port: var("PORT").and_then(|p| p.parse().ok()).unwrap_or(4000),
            db_path: var("NYOTA_DB").unwrap_or_else(|| "data/nyota.db".into()).into(),
            static_dir: var("NYOTA_STATIC").map(PathBuf::from),
            mcp_url: var("NYOTA_MCP_URL"),
            legacy_doc: Some(
                var("NYOTA_LEGACY_DOC")
                    .unwrap_or_else(|| "data/document.json".into())
                    .into(),
            ),
        }
    }
}

/// État partagé par les routes.
#[derive(Clone)]
pub struct AppState {
    pub hub: Arc<Hub>,
    pub db: Arc<Db>,
    pub proxy: Option<Arc<proxy::Proxy>>,
    /// Passe à `true` à l'arrêt : les WebSocket se ferment.
    pub shutdown: watch::Receiver<bool>,
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Premier démarrage : un projet et un fichier (l'ancien document unique s'il existe).
fn seed(db: &Db, legacy: Option<&Path>) -> Result<(), BoxError> {
    if db.meta("seeded")?.is_some() {
        return Ok(());
    }
    if db.projects()?.is_empty() {
        let project = db.create_project("Mon premier projet")?;
        let file_id = new_id();
        let imported = legacy.and_then(|p| std::fs::read_to_string(p).ok()).and_then(|text| {
            let mut doc: serde_json::Value = serde_json::from_str(&text).ok()?;
            let name = doc
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("Sans titre")
                .to_string();
            ops::normalize_document(&mut doc, &new_id(), &name).ok()?;
            Some((doc, name))
        });
        let (doc, name) = match imported {
            Some((doc, name)) => {
                tracing::info!("ancien document importé : {name}");
                (doc, name)
            }
            None => (ops::empty_document(&new_id(), "Sans titre"), "Sans titre".to_string()),
        };
        db.create_file(&project.id, &file_id, &name, &doc)?;
    }
    db.set_meta("seeded", "1")?;
    Ok(())
}

pub fn router(state: AppState, static_dir: Option<&Path>) -> Router {
    let api = api::routes()
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .layer(CompressionLayer::new())
        .with_state(state.clone());
    let live = Router::new()
        .route("/ws", get(ws::handler))
        .route("/mcp", any(proxy::relay))
        .route("/mcp/{*rest}", any(proxy::relay))
        .route("/api/ai/{*rest}", any(proxy::relay))
        .with_state(state);
    let mut app = Router::new().merge(live).merge(api);
    if let Some(dir) = static_dir {
        // Repli SPA : toute route inconnue sert index.html
        let spa = ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html")));
        app = app.fallback_service(tower::ServiceBuilder::new().layer(CompressionLayer::new()).service(spa));
    }
    app.layer(TraceLayer::new_for_http().on_failure(DefaultOnFailure::new().level(tracing::Level::DEBUG)))
}

/// Démarre le hub sur `listener` jusqu'à `shutdown`, puis sauvegarde toutes les salles.
pub async fn run(
    config: Config,
    listener: TcpListener,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> Result<(), BoxError> {
    let db = Arc::new(Db::open(&config.db_path)?);
    seed(&db, config.legacy_doc.as_deref())?;
    let hub = Hub::new(db.clone());
    let proxy = config
        .mcp_url
        .as_deref()
        .map(proxy::Proxy::new)
        .transpose()?
        .map(Arc::new);
    let (stop_tx, stop_rx) = watch::channel(false);
    let state = AppState {
        hub: hub.clone(),
        db,
        proxy,
        shutdown: stop_rx,
    };
    let app = router(state, config.static_dir.as_deref());

    let janitor = {
        let hub = hub.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(60));
            loop {
                tick.tick().await;
                hub.unload_idle();
            }
        })
    };

    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown.await;
            let _ = stop_tx.send(true);
        })
        .await?;
    janitor.abort();
    hub.flush_all().await;
    tracing::info!("hub arrêté, documents sauvegardés");
    Ok(())
}
