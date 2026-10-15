// Hub Swiftma : point d'entrée (configuration, démarrage, arrêt propre avec sauvegarde).

use swiftma_hub::db::Db;
use swiftma_hub::{Config, auth, run};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let config = Config::from_env();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(cmd) = args.first() {
        std::process::exit(command(&config, cmd, &args[1..]));
    }
    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", config.port)).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!("impossible d'écouter sur le port {} : {e}", config.port);
            std::process::exit(1);
        }
    };
    tracing::info!("Swiftma hub     → http://localhost:{}", config.port);
    tracing::info!("Base          → {}", config.db_path.display());
    match &config.static_dir {
        Some(dir) => tracing::info!("Éditeur       → {}", dir.display()),
        None => tracing::info!("SWIFTMA_STATIC absent : l'éditeur n'est pas servi"),
    }
    match &config.mcp_url {
        Some(url) => tracing::info!("MCP/IA        → {url} (relayé en /mcp et /api/ai/*)"),
        None => tracing::info!("SWIFTMA_MCP_URL absent : /mcp et /api/ai/* répondent 503"),
    }

    tracing::info!(
        "Inscriptions  → {}",
        if config.signup_open {
            "ouvertes (SWIFTMA_SIGNUP=open)"
        } else {
            "fermées (SWIFTMA_SIGNUP=closed)"
        }
    );
    if !config.secure_cookies {
        tracing::info!("Cookies       → sans Secure (SWIFTMA_SECURE_COOKIES=1 derrière HTTPS)");
    }

    if let Err(e) = run(config, listener, shutdown_signal()).await {
        tracing::error!("arrêt sur erreur : {e}");
        std::process::exit(1);
    }
}

/// Commandes d'administration (`swiftma-hub <commande>`) : agissent directement sur la base, hub démarré ou non.
fn command(config: &Config, cmd: &str, args: &[String]) -> i32 {
    match (cmd, args) {
        ("reset-password", [email]) => {
            let db = match Db::open(&config.db_path) {
                Ok(db) => db,
                Err(e) => {
                    eprintln!("base {} : {e}", config.db_path.display());
                    return 1;
                }
            };
            let email = auth::normalize_email(email);
            let user = match db.user_by_email(&email) {
                Ok(Some((user, _))) => user,
                Ok(None) => {
                    eprintln!("aucun compte avec l'adresse {email}");
                    return 1;
                }
                Err(e) => {
                    eprintln!("erreur de la base : {e}");
                    return 1;
                }
            };
            match auth::new_password_reset(&db, &user.id) {
                Ok((secret, _)) => {
                    let base = std::env::var("SWIFTMA_PUBLIC_URL")
                        .ok()
                        .filter(|u| !u.trim().is_empty())
                        .unwrap_or_else(|| format!("http://localhost:{}", config.port));
                    println!(
                        "Lien de réinitialisation pour {} (valable 24 h, usage unique) :",
                        user.email
                    );
                    println!("{}{}", base.trim_end_matches('/'), auth::reset_path(&secret));
                    0
                }
                Err(e) => {
                    eprintln!("erreur de la base : {e}");
                    1
                }
            }
        }
        ("help" | "--help" | "-h", _) => {
            println!("swiftma-hub                          démarre le hub");
            println!("swiftma-hub reset-password <email>   affiche un lien de réinitialisation du mot de passe");
            0
        }
        _ => {
            eprintln!("commande inconnue : {cmd} (swiftma-hub help)");
            2
        }
    }
}

/// Ctrl+C, ou SIGTERM sous Unix.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending().await,
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = term => {},
    }
    tracing::info!("arrêt demandé, sauvegarde…");
}
