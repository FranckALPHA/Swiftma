//! Relais de `/mcp` et `/api/ai/*` vers le service MCP/IA (NYOTA_MCP_URL), en flux dans les deux sens.
//! Réservé aux personnes connectées (401 sinon) ; les en-têtes `Authorization` et `Cookie` d'origine sont relayés :
//! le service les réutilise pour appeler l'API du hub avec les droits de la personne.

use std::time::Duration;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use serde_json::json;

use crate::auth::CurrentUser;
use crate::{AppState, BoxError};

pub struct Proxy {
    base: String,
    client: reqwest::Client,
}

impl Proxy {
    pub fn new(base: &str) -> Result<Proxy, BoxError> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            // Service configuré explicitement : pas de mandataire système
            .no_proxy()
            .build()?;
        Ok(Proxy {
            base: base.trim_end_matches('/').to_string(),
            client,
        })
    }
}

/// En-têtes propres à une connexion, à ne pas relayer.
fn hop_by_hop(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "proxy-connection"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "host"
    )
}

fn copy_headers(from: &HeaderMap) -> HeaderMap {
    let mut out = HeaderMap::with_capacity(from.len());
    for (name, value) in from {
        if !hop_by_hop(name) {
            out.append(name.clone(), value.clone());
        }
    }
    out
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, axum::Json(json!({ "error": message }))).into_response()
}

pub async fn relay(_me: CurrentUser, State(state): State<AppState>, req: Request) -> Response {
    let Some(proxy) = state.proxy.clone() else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "Service MCP/IA non configuré");
    };
    let path = req.uri().path_and_query().map_or("/", |p| p.as_str()).to_string();
    if path == "/mcp" || path.starts_with("/mcp/") || path.starts_with("/mcp?") {
        state.hub.mcp_seen().await;
    }
    let url = format!("{}{}", proxy.base, path);
    let (parts, body) = req.into_parts();
    // Le corps est relayé en flux, via un canal (le flux d'axum n'est pas `Sync`)
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<bytes::Bytes, axum::Error>>(16);
    tokio::spawn(async move {
        let mut stream = body.into_data_stream();
        while let Some(chunk) = stream.next().await {
            if tx.send(chunk).await.is_err() {
                break;
            }
        }
    });
    let stream = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|c| (c, rx)) });
    let upstream = proxy
        .client
        .request(parts.method, &url)
        .headers(copy_headers(&parts.headers))
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await;
    let upstream = match upstream {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("relais vers {url} impossible : {e}");
            return error(StatusCode::BAD_GATEWAY, "Service MCP/IA injoignable");
        }
    };
    let status = upstream.status();
    let headers = copy_headers(upstream.headers());
    let mut res = Response::new(Body::from_stream(upstream.bytes_stream()));
    *res.status_mut() = status;
    *res.headers_mut() = headers;
    res
}
