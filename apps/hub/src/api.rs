//! Routes REST (JSON) : projets, fichiers, opérations, vignettes et versions.

use axum::extract::{FromRequest, Path, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use bytes::Bytes;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::db::FileMeta;
use crate::ops::normalize_document;
use crate::rooms::{Batch, Room};
use crate::{AppState, new_id};

// --- Erreurs ---

/// Erreur renvoyée au client : statut + `{"error": message}`.
#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub String);

impl ApiError {
    pub fn bad_request(msg: impl Into<String>) -> ApiError {
        ApiError(StatusCode::BAD_REQUEST, msg.into())
    }
    pub fn not_found(msg: impl Into<String>) -> ApiError {
        ApiError(StatusCode::NOT_FOUND, msg.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(e: rusqlite::Error) -> ApiError {
        tracing::error!("base de données : {e}");
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Erreur de la base de données".into())
    }
}

type ApiResult<T> = Result<T, ApiError>;

/// Corps JSON tolérant : sans en-tête obligatoire, corps vide = `{}`, erreurs au format `{"error"}`.
pub struct Body<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for Body<T> {
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let bytes = Bytes::from_request(req, state)
            .await
            .map_err(|e| ApiError(e.status(), format!("Corps illisible : {}", e.body_text())))?;
        let bytes: &[u8] = if bytes.iter().all(u8::is_ascii_whitespace) {
            b"{}"
        } else {
            &bytes
        };
        serde_json::from_slice(bytes)
            .map(Body)
            .map_err(|e| ApiError::bad_request(format!("JSON invalide : {e}")))
    }
}

fn file_not_found() -> ApiError {
    ApiError::not_found("Fichier introuvable")
}

fn project_not_found() -> ApiError {
    ApiError::not_found("Projet introuvable")
}

fn ok() -> Json<Value> {
    Json(json!({ "ok": true }))
}

/// Nom nettoyé ; `default` s'il est absent ou vide (erreur si aucun défaut).
fn clean_name(name: Option<&str>, default: Option<&str>) -> ApiResult<String> {
    match name.map(str::trim).filter(|n| !n.is_empty()).or(default) {
        Some(n) => Ok(n.to_string()),
        None => Err(ApiError::bad_request("Nom manquant")),
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/health", get(|| async { ok() }))
        .route("/api/projects", get(list_projects).post(create_project))
        .route(
            "/api/projects/{id}",
            axum::routing::patch(rename_project).delete(delete_project),
        )
        .route("/api/projects/{id}/files", get(list_files).post(create_file))
        .route("/api/files/{id}", get(get_file).patch(update_file).delete(delete_file))
        .route("/api/files/{id}/duplicate", post(duplicate_file))
        .route("/api/files/{id}/ops", post(post_ops))
        .route("/api/files/{id}/events", post(post_event))
        .route("/api/files/{id}/thumbnail", get(get_thumbnail).put(put_thumbnail))
        .route("/api/files/{id}/versions", get(list_versions).post(create_version))
        .route("/api/files/{id}/versions/{vid}/restore", post(restore_version))
        .route("/api/files/{id}/presence", get(get_presence))
        .route("/api/active-file", get(active_file))
        .route(
            "/api/{*rest}",
            axum::routing::any(|| async { ApiError::not_found("Route inconnue") }),
        )
}

// --- Présence et fichier actif (pour le service MCP/IA) ---

async fn get_presence(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<impl IntoResponse> {
    meta(&s, &id)?;
    let room = room(&s, &id)?;
    let st = room.lock().await;
    Ok(Json(room.presence_json(&st)))
}

/// Dernier fichier ouvert ou modifié : celui sur lequel travaillent les IA par défaut.
async fn active_file(State(s): State<AppState>) -> ApiResult<impl IntoResponse> {
    let id = s
        .hub
        .active_file()
        .ok_or_else(|| ApiError::not_found("Aucun fichier ouvert"))?;
    let file =
        s.db.file(&id)?
            .ok_or_else(|| ApiError::not_found("Aucun fichier ouvert"))?;
    Ok(Json(json!({ "file": file })))
}

// --- Projets ---

#[derive(Deserialize)]
struct NameBody {
    name: Option<String>,
}

async fn list_projects(State(s): State<AppState>) -> ApiResult<impl IntoResponse> {
    Ok(Json(s.db.projects()?))
}

async fn create_project(State(s): State<AppState>, Body(b): Body<NameBody>) -> ApiResult<impl IntoResponse> {
    let name = clean_name(b.name.as_deref(), Some("Nouveau projet"))?;
    Ok(Json(s.db.create_project(&name)?))
}

async fn rename_project(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Body(b): Body<NameBody>,
) -> ApiResult<impl IntoResponse> {
    let name = clean_name(b.name.as_deref(), None)?;
    s.db.rename_project(&id, &name)?.map(Json).ok_or_else(project_not_found)
}

async fn delete_project(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<impl IntoResponse> {
    let files = s.db.delete_project(&id)?.ok_or_else(project_not_found)?;
    for file in files {
        s.hub.close(&file);
    }
    Ok(ok())
}

// --- Fichiers ---

async fn list_files(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<impl IntoResponse> {
    s.db.project(&id)?.ok_or_else(project_not_found)?;
    Ok(Json(s.db.files(&id)?))
}

#[derive(Deserialize)]
struct CreateFileBody {
    name: Option<String>,
    doc: Option<Value>,
}

async fn create_file(
    State(s): State<AppState>,
    Path(project): Path<String>,
    Body(b): Body<CreateFileBody>,
) -> ApiResult<impl IntoResponse> {
    s.db.project(&project)?.ok_or_else(project_not_found)?;
    let doc_name = b
        .doc
        .as_ref()
        .and_then(|d| d.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let name = clean_name(b.name.as_deref().or(doc_name.as_deref()), Some("Sans titre"))?;
    let mut doc = b.doc.unwrap_or_else(|| json!({}));
    normalize_document(&mut doc, &new_id(), &name).map_err(|e| ApiError::bad_request(e.0))?;
    Ok(Json(s.db.create_file(&project, &new_id(), &name, &doc)?))
}

/// Salle du fichier (chargée au besoin), 404 si le fichier n'existe pas.
fn room(s: &AppState, id: &str) -> ApiResult<std::sync::Arc<Room>> {
    s.hub.room(id)?.ok_or_else(file_not_found)
}

fn meta(s: &AppState, id: &str) -> ApiResult<FileMeta> {
    s.db.file(id)?.ok_or_else(file_not_found)
}

async fn get_file(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<impl IntoResponse> {
    let file = meta(&s, &id)?;
    let room = room(&s, &id)?;
    let st = room.lock().await;
    Ok(Json(json!({ "file": file, "doc": st.doc, "version": st.version })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateFileBody {
    name: Option<String>,
    project_id: Option<String>,
}

async fn update_file(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Body(b): Body<UpdateFileBody>,
) -> ApiResult<impl IntoResponse> {
    meta(&s, &id)?;
    if let Some(project) = &b.project_id {
        s.db.project(project)?.ok_or_else(project_not_found)?;
    }
    let name = b.name.as_deref().map(|n| clean_name(Some(n), None)).transpose()?;
    if let Some(name) = &name {
        // Le nom du document suit celui du fichier, diffusé aux éditeurs comme une opération
        let room = room(&s, &id)?;
        let mut st = room.lock().await;
        if st.doc.get("name").and_then(Value::as_str) != Some(name.as_str()) {
            let batch = Batch {
                ops: vec![json!({ "kind": "set-doc", "props": { "name": name } })],
                author: "human".into(),
                label: Some("Renommer".into()),
                origin: None,
                stack: None,
            };
            room.commit(&mut st, batch).map_err(|e| ApiError::bad_request(e.0))?;
        }
    }
    s.db.update_file(&id, name.as_deref(), b.project_id.as_deref())?;
    Ok(Json(meta(&s, &id)?))
}

async fn delete_file(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<impl IntoResponse> {
    if !s.db.delete_file(&id)? {
        return Err(file_not_found());
    }
    s.hub.close(&id);
    Ok(ok())
}

async fn duplicate_file(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<impl IntoResponse> {
    let file = meta(&s, &id)?;
    let mut doc = room(&s, &id)?.lock().await.doc.clone();
    let name = format!("{} (copie)", file.name);
    if let Some(d) = doc.as_object_mut() {
        d.insert("id".into(), json!(new_id()));
        d.insert("name".into(), json!(name));
    }
    let copy_id = new_id();
    let mut copy = s.db.create_file(&file.project_id, &copy_id, &name, &doc)?;
    if let Some((mime, data)) = s.db.thumbnail(&id)? {
        s.db.set_thumbnail(&copy_id, &mime, &data)?;
        copy.has_thumbnail = true;
    }
    Ok(Json(copy))
}

// --- Opérations et événements ---

#[derive(Deserialize)]
struct OpsBody {
    ops: Option<Value>,
    label: Option<String>,
    author: Option<String>,
    origin: Option<String>,
}

async fn post_ops(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Body(b): Body<OpsBody>,
) -> ApiResult<impl IntoResponse> {
    let Some(Value::Array(ops)) = b.ops else {
        return Err(ApiError::bad_request("« ops » doit être une liste d'opérations"));
    };
    let author = b.author.unwrap_or_else(|| "human".into());
    if !matches!(author.as_str(), "human" | "ai" | "mcp") {
        return Err(ApiError::bad_request(format!("Auteur inconnu : {author}")));
    }
    let room = room(&s, &id)?;
    let version = {
        let mut st = room.lock().await;
        let stack = b.origin.clone().unwrap_or_else(|| author.clone());
        let batch = Batch {
            ops,
            author: author.clone(),
            label: b.label,
            origin: b.origin,
            stack: Some(stack),
        };
        room.commit(&mut st, batch).map_err(|e| ApiError::bad_request(e.0))?
    };
    if author == "mcp" {
        s.hub.mcp_seen().await;
    }
    Ok(Json(json!({ "ok": true, "version": version })))
}

#[derive(Deserialize)]
struct EventBody {
    event: Option<Value>,
}

async fn post_event(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Body(b): Body<EventBody>,
) -> ApiResult<impl IntoResponse> {
    let event = b
        .event
        .filter(|e| !e.is_null())
        .ok_or_else(|| ApiError::bad_request("« event » manquant"))?;
    // Sans salle chargée, personne n'écoute : il suffit que le fichier existe
    match s.hub.loaded(&id) {
        Some(room) => room.send(&json!({ "type": "ai", "event": event })),
        None => {
            meta(&s, &id)?;
        }
    }
    Ok(ok())
}

// --- Vignettes ---

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailBody {
    data_url: Option<String>,
}

/// Décode `data:image/png;base64,...`.
fn parse_data_url(url: &str) -> Option<(String, Vec<u8>)> {
    let rest = url.strip_prefix("data:")?;
    let (header, data) = rest.split_once(',')?;
    let mime = header.strip_suffix(";base64")?;
    if !mime.starts_with("image/") || mime.contains(';') {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).ok()?;
    Some((mime.to_string(), bytes))
}

async fn put_thumbnail(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Body(b): Body<ThumbnailBody>,
) -> ApiResult<impl IntoResponse> {
    meta(&s, &id)?;
    let (mime, data) = b
        .data_url
        .as_deref()
        .and_then(parse_data_url)
        .ok_or_else(|| ApiError::bad_request("Image invalide : data URL base64 attendue"))?;
    s.db.set_thumbnail(&id, &mime, &data)?;
    Ok(ok())
}

async fn get_thumbnail(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> {
    let (mime, data) =
        s.db.thumbnail(&id)?
            .ok_or_else(|| ApiError::not_found("Aucune vignette"))?;
    Ok((
        [(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "no-cache".into())],
        data,
    )
        .into_response())
}

// --- Versions ---

async fn list_versions(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<impl IntoResponse> {
    meta(&s, &id)?;
    Ok(Json(s.db.versions(&id)?))
}

#[derive(Deserialize)]
struct VersionBody {
    label: Option<String>,
}

async fn create_version(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Body(b): Body<VersionBody>,
) -> ApiResult<impl IntoResponse> {
    let label = clean_name(b.label.as_deref(), Some("Version"))?;
    let room = room(&s, &id)?;
    let st = room.lock().await;
    Ok(Json(s.db.create_version(&id, &label, &st.doc, false)?))
}

async fn restore_version(
    State(s): State<AppState>,
    Path((id, vid)): Path<(String, String)>,
) -> ApiResult<impl IntoResponse> {
    let room = room(&s, &id)?;
    let doc =
        s.db.version_doc(&id, &vid)?
            .ok_or_else(|| ApiError::not_found("Version introuvable"))?;
    let mut st = room.lock().await;
    s.db.create_version(&id, "Avant restauration", &st.doc, false)?;
    let version = room.replace_doc(&mut st, doc);
    Ok(Json(json!({ "ok": true, "version": version })))
}

#[cfg(test)]
mod tests {
    use super::parse_data_url;

    #[test]
    fn data_url() {
        let (mime, data) = parse_data_url("data:image/png;base64,iVBORw==").unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(data, vec![0x89, 0x50, 0x4E, 0x47]);
        assert!(parse_data_url("data:text/html;base64,PGI+").is_none());
        assert!(parse_data_url("image/png;base64,iVBORw==").is_none());
    }
}
