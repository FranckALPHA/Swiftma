//! Comptes et identification : sessions (cookie `swiftma_session`), jetons personnels (`Authorization: Bearer`),
//! mots de passe argon2id, limitation des tentatives de connexion, routes `/api/auth/*` et `/api/admin/users`.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use argon2::Argon2;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use axum::extract::{FromRequestParts, Path, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{AppendHeaders, IntoResponse};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::api::{ApiError, ApiResult, Body};
use crate::db::{NewUserError, User};
use crate::{AppState, now_ms};

pub const SESSION_COOKIE: &str = "swiftma_session";
/// Durée d'une session : 30 jours.
pub const SESSION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// Fenêtre de la limitation des tentatives de connexion.
pub const LOGIN_WINDOW_MS: i64 = 15 * 60 * 1000;
/// Nombre d'échecs tolérés dans la fenêtre.
pub const MAX_LOGIN_FAILURES: usize = 5;
/// Intervalle minimal entre deux mises à jour de `lastUsedAt` d'un jeton.
pub const TOKEN_TOUCH_MS: i64 = 60 * 1000;
pub const TOKEN_PREFIX: &str = "swiftma_";
/// Validité d'un lien de réinitialisation du mot de passe : 24 heures.
pub const RESET_MS: i64 = 24 * 60 * 60 * 1000;

pub const MSG_UNAUTHORIZED: &str = "Connexion requise";
pub const MSG_BAD_LOGIN: &str = "Email ou mot de passe incorrect";
pub const MSG_TOO_MANY: &str = "Trop de tentatives, réessaie dans quelques minutes";
pub const MSG_SHORT_PASSWORD: &str = "Mot de passe trop court (8 caractères minimum)";
pub const MSG_EMAIL_TAKEN: &str = "Un compte existe déjà avec cette adresse";
pub const MSG_SIGNUP_CLOSED: &str = "Inscriptions fermées : demande un compte à l'administrateur";
pub const MSG_BAD_CURRENT_PASSWORD: &str = "Mot de passe actuel incorrect";
pub const MSG_ADMIN_ONLY: &str = "Réservé à l'administrateur";
pub const MSG_BAD_RESET: &str = "Lien de réinitialisation invalide, déjà utilisé ou expiré";

/// Réglages et état de l'identification.
pub struct Auth {
    /// `SWIFTMA_SIGNUP=open` : tout le monde peut créer un compte.
    pub signup_open: bool,
    /// `SWIFTMA_SECURE_COOKIES=1` : cookie `Secure`.
    pub secure_cookies: bool,
    /// Échecs de connexion récents par adresse (ms).
    failures: Mutex<HashMap<String, Vec<i64>>>,
}

impl Auth {
    pub fn new(signup_open: bool, secure_cookies: bool) -> Auth {
        Auth {
            signup_open,
            secure_cookies,
            failures: Mutex::new(HashMap::new()),
        }
    }

    fn failures(&self) -> std::sync::MutexGuard<'_, HashMap<String, Vec<i64>>> {
        self.failures.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Vrai si l'adresse a atteint le nombre d'échecs autorisés dans la fenêtre.
    fn blocked(&self, email: &str) -> bool {
        let now = now_ms();
        let mut all = self.failures();
        if all.len() > 10_000 {
            all.retain(|_, v| v.iter().any(|t| now - *t < LOGIN_WINDOW_MS));
        }
        match all.get_mut(email) {
            Some(list) => {
                list.retain(|t| now - *t < LOGIN_WINDOW_MS);
                list.len() >= MAX_LOGIN_FAILURES
            }
            None => false,
        }
    }

    fn fail(&self, email: &str) {
        self.failures().entry(email.to_string()).or_default().push(now_ms());
    }

    fn reset(&self, email: &str) {
        self.failures().remove(email);
    }

    /// En-tête `Set-Cookie` d'une nouvelle session.
    fn session_cookie(&self, value: &str) -> HeaderValue {
        let secure = if self.secure_cookies { "; Secure" } else { "" };
        let max_age = SESSION_MS / 1000;
        HeaderValue::from_str(&format!(
            "{SESSION_COOKIE}={value}; HttpOnly; SameSite=Lax; Path=/; Max-Age={max_age}{secure}"
        ))
        .expect("cookie ASCII")
    }

    fn clear_cookie(&self) -> HeaderValue {
        let secure = if self.secure_cookies { "; Secure" } else { "" };
        HeaderValue::from_str(&format!(
            "{SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0{secure}"
        ))
        .expect("cookie ASCII")
    }
}

// --- Secrets et mots de passe ---

/// 32 octets aléatoires en base64url (sans remplissage).
pub fn random_secret() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("générateur aléatoire du système");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

/// Empreinte SHA-256 (hexadécimal) : seule forme gardée en base des sessions et des jetons.
pub fn sha256_hex(secret: &str) -> String {
    Sha256::digest(secret.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn hash_password_sync(password: &str) -> Result<String, argon2::password_hash::Error> {
    let mut salt = [0u8; 16];
    getrandom::fill(&mut salt).expect("générateur aléatoire du système");
    let salt = SaltString::encode_b64(&salt)?;
    Ok(Argon2::default().hash_password(password.as_bytes(), &salt)?.to_string())
}

fn verify_password_sync(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
        .unwrap_or(false)
}

/// Empreinte factice : une adresse inconnue coûte autant qu'une vraie (pas d'énumération des comptes).
fn dummy_hash() -> &'static str {
    static HASH: OnceLock<String> = OnceLock::new();
    HASH.get_or_init(|| hash_password_sync(&random_secret()).unwrap_or_default())
}

/// argon2id hors du fil d'exécution asynchrone.
pub async fn hash_password(password: String) -> ApiResult<String> {
    tokio::task::spawn_blocking(move || hash_password_sync(&password))
        .await
        .ok()
        .and_then(Result::ok)
        .ok_or_else(|| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Erreur interne".into()))
}

pub async fn verify_password(password: String, hash: Option<String>) -> bool {
    tokio::task::spawn_blocking(move || match hash {
        Some(hash) => verify_password_sync(&password, &hash),
        None => {
            verify_password_sync(&password, dummy_hash());
            false
        }
    })
    .await
    .unwrap_or(false)
}

fn check_password(password: &str) -> ApiResult<()> {
    if password.chars().count() < 8 {
        return Err(ApiError::bad_request(MSG_SHORT_PASSWORD));
    }
    Ok(())
}

/// Adresse normalisée : espaces retirés, en minuscules.
pub fn normalize_email(email: &str) -> String {
    email
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase()
}

// --- Personne connectée ---

/// Personne connectée, par jeton (`Authorization: Bearer`) ou session (cookie). Rejet : 401.
pub struct CurrentUser {
    pub user: User,
    /// Empreinte de la session utilisée, si l'identification vient du cookie.
    pub session: Option<String>,
    /// Empreinte du jeton utilisé, si l'identification vient de `Authorization`.
    pub token: Option<String>,
}

impl CurrentUser {
    /// Vrai tant que la session ou le jeton ayant servi à l'identification existe encore (connexions longues).
    pub fn still_valid(&self, s: &AppState) -> crate::db::DbResult<bool> {
        if let Some(hash) = &self.session {
            return Ok(s.db.session_user(hash)?.is_some());
        }
        if let Some(hash) = &self.token {
            return Ok(s.db.token_user(hash, i64::MAX)?.is_some());
        }
        Ok(false)
    }
}

fn unauthorized() -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, MSG_UNAUTHORIZED.into())
}

/// Valeur du cookie de session, s'il est présent.
pub fn session_from_headers(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(k, _)| *k == SESSION_COOKIE)
        .map(|(_, v)| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Identifie la personne à partir des en-têtes ; l'en-tête `Authorization` l'emporte sur le cookie.
pub fn authenticate(s: &AppState, headers: &HeaderMap) -> ApiResult<CurrentUser> {
    if let Some(auth) = headers.get(header::AUTHORIZATION) {
        let token = auth
            .to_str()
            .ok()
            .and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")))
            .map(str::trim)
            .filter(|t| t.starts_with(TOKEN_PREFIX))
            .ok_or_else(unauthorized)?;
        let hash = sha256_hex(token);
        let user = s.db.token_user(&hash, TOKEN_TOUCH_MS)?.ok_or_else(unauthorized)?;
        return Ok(CurrentUser {
            user,
            session: None,
            token: Some(hash),
        });
    }
    let value = session_from_headers(headers).ok_or_else(unauthorized)?;
    let hash = sha256_hex(&value);
    let user = s.db.session_user(&hash)?.ok_or_else(unauthorized)?;
    Ok(CurrentUser {
        user,
        session: Some(hash),
        token: None,
    })
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, s: &AppState) -> Result<Self, Self::Rejection> {
        authenticate(s, &parts.headers)
    }
}

// --- Routes ---

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/auth/config", get(config))
        .route("/api/auth/register", post(register))
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/me", get(me).patch(update_me))
        .route("/api/auth/tokens", get(list_tokens).post(create_token))
        .route("/api/auth/tokens/{id}", delete(delete_token))
        .route("/api/auth/reset", get(reset_info).post(reset_password))
        .route("/api/admin/users", get(admin_users).post(admin_create_user))
        .route("/api/admin/users/{id}/reset", post(admin_reset_link))
}

/// Crée un lien de réinitialisation pour un compte : renvoie le secret (à transmettre à la personne).
pub fn new_password_reset(db: &crate::db::Db, user: &str) -> crate::db::DbResult<(String, i64)> {
    let secret = random_secret();
    let expires_at = now_ms() + RESET_MS;
    db.create_password_reset(user, &sha256_hex(&secret), expires_at)?;
    Ok((secret, expires_at))
}

/// Chemin de la page de réinitialisation : le secret est dans le fragment, jamais envoyé au serveur par le navigateur.
pub fn reset_path(secret: &str) -> String {
    format!("/reset#{secret}")
}

async fn config(State(s): State<AppState>) -> ApiResult<Json<Value>> {
    let has_users = s.db.user_count()? > 0;
    Ok(Json(
        json!({ "signup": s.auth.signup_open || !has_users, "hasUsers": has_users }),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewUserBody {
    email: Option<String>,
    name: Option<String>,
    password: Option<String>,
    is_admin: Option<bool>,
}

/// Valide et crée un compte.
async fn new_user(s: &AppState, b: NewUserBody, is_admin: bool, only_if_first: bool) -> ApiResult<User> {
    let email = normalize_email(b.email.as_deref().unwrap_or_default());
    if !email.contains('@') {
        return Err(ApiError::bad_request("Adresse email invalide"));
    }
    let name = match b.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => n.to_string(),
        None => email.split('@').next().unwrap_or_default().to_string(),
    };
    let password = b.password.unwrap_or_default();
    check_password(&password)?;
    let hash = hash_password(password).await?;
    match s.db.create_user(&email, &name, &hash, is_admin, only_if_first)? {
        Ok(user) => {
            tracing::info!(
                "compte créé : {}{}",
                user.email,
                if user.is_admin { " (admin)" } else { "" }
            );
            Ok(user)
        }
        Err(NewUserError::EmailTaken) => Err(ApiError(StatusCode::CONFLICT, MSG_EMAIL_TAKEN.into())),
        Err(NewUserError::SignupClosed) => Err(ApiError(StatusCode::FORBIDDEN, MSG_SIGNUP_CLOSED.into())),
    }
}

/// Ouvre une session : réponse `User` + cookie.
fn start_session(s: &AppState, user: User) -> ApiResult<impl IntoResponse + use<>> {
    let value = random_secret();
    s.db.create_session(&sha256_hex(&value), &user.id, now_ms() + SESSION_MS)?;
    Ok((
        AppendHeaders([(header::SET_COOKIE, s.auth.session_cookie(&value))]),
        Json(user),
    ))
}

async fn register(State(s): State<AppState>, Body(b): Body<NewUserBody>) -> ApiResult<impl IntoResponse> {
    if !s.auth.signup_open && s.db.user_count()? > 0 {
        return Err(ApiError(StatusCode::FORBIDDEN, MSG_SIGNUP_CLOSED.into()));
    }
    let user = new_user(&s, b, false, !s.auth.signup_open).await?;
    start_session(&s, user)
}

#[derive(Deserialize)]
struct LoginBody {
    email: Option<String>,
    password: Option<String>,
}

async fn login(State(s): State<AppState>, Body(b): Body<LoginBody>) -> ApiResult<impl IntoResponse> {
    let email = normalize_email(b.email.as_deref().unwrap_or_default());
    if s.auth.blocked(&email) {
        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, MSG_TOO_MANY.into()));
    }
    let found = s.db.user_by_email(&email)?;
    let (user, hash) = match found {
        Some((user, hash)) => (Some(user), Some(hash)),
        None => (None, None),
    };
    let ok = verify_password(b.password.unwrap_or_default(), hash).await;
    match user {
        Some(user) if ok => {
            s.auth.reset(&email);
            start_session(&s, user)
        }
        _ => {
            s.auth.fail(&email);
            Err(ApiError(StatusCode::UNAUTHORIZED, MSG_BAD_LOGIN.into()))
        }
    }
}

/// Ferme la session du cookie (s'il y en a une) et efface le cookie ; toujours `{"ok":true}`.
async fn logout(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<impl IntoResponse> {
    if let Some(value) = session_from_headers(&headers) {
        s.db.delete_session(&sha256_hex(&value))?;
        s.hub.access_changed();
    }
    Ok((
        AppendHeaders([(header::SET_COOKIE, s.auth.clear_cookie())]),
        Json(json!({ "ok": true })),
    ))
}

async fn me(me: CurrentUser) -> Json<User> {
    Json(me.user)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateMeBody {
    name: Option<String>,
    password: Option<String>,
    current_password: Option<String>,
}

async fn update_me(me: CurrentUser, State(s): State<AppState>, Body(b): Body<UpdateMeBody>) -> ApiResult<Json<User>> {
    let name = match b.name.as_deref().map(str::trim) {
        Some("") => return Err(ApiError::bad_request("Nom manquant")),
        other => other.map(str::to_string),
    };
    if let Some(password) = b.password {
        check_password(&password)?;
        let current = s.db.password_hash(&me.user.id)?;
        if !verify_password(b.current_password.unwrap_or_default(), current).await {
            return Err(ApiError(StatusCode::FORBIDDEN, MSG_BAD_CURRENT_PASSWORD.into()));
        }
        let hash = hash_password(password).await?;
        s.db.set_password(&me.user.id, &hash, me.session.as_deref())?;
        s.hub.access_changed();
    }
    if let Some(name) = name {
        s.db.set_user_name(&me.user.id, &name)?;
    }
    s.db.user(&me.user.id)?.map(Json).ok_or_else(unauthorized)
}

async fn list_tokens(me: CurrentUser, State(s): State<AppState>) -> ApiResult<impl IntoResponse> {
    Ok(Json(s.db.tokens(&me.user.id)?))
}

#[derive(Deserialize)]
struct TokenBody {
    name: Option<String>,
}

async fn create_token(
    me: CurrentUser,
    State(s): State<AppState>,
    Body(b): Body<TokenBody>,
) -> ApiResult<impl IntoResponse> {
    let name = b
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or("Jeton")
        .to_string();
    let secret = format!("{TOKEN_PREFIX}{}", random_secret());
    let token = s.db.create_token(&me.user.id, &name, &sha256_hex(&secret))?;
    let mut out = serde_json::to_value(token).unwrap_or_default();
    out["token"] = json!(secret);
    Ok(Json(out))
}

async fn delete_token(
    me: CurrentUser,
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    if !s.db.delete_token(&me.user.id, &id)? {
        return Err(ApiError::not_found("Jeton introuvable"));
    }
    s.hub.access_changed();
    Ok(Json(json!({ "ok": true })))
}

fn require_admin(me: &CurrentUser) -> ApiResult<()> {
    if me.user.is_admin {
        Ok(())
    } else {
        Err(ApiError(StatusCode::FORBIDDEN, MSG_ADMIN_ONLY.into()))
    }
}

/// Lien de réinitialisation du mot de passe d'un compte (administrateur).
async fn admin_reset_link(
    me: CurrentUser,
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    require_admin(&me)?;
    let user =
        s.db.user(&id)?
            .ok_or_else(|| ApiError::not_found("Compte introuvable"))?;
    let (secret, expires_at) = new_password_reset(&s.db, &user.id)?;
    tracing::info!(
        "lien de réinitialisation créé pour {} par {}",
        user.email,
        me.user.email
    );
    Ok(Json(json!({
        "token": secret,
        "path": reset_path(&secret),
        "expiresAt": expires_at,
        "email": user.email,
    })))
}

#[derive(Deserialize)]
struct ResetQuery {
    token: Option<String>,
}

/// Adresse du compte d'un lien encore valide (affichée sur la page de réinitialisation).
async fn reset_info(
    State(s): State<AppState>,
    axum::extract::Query(q): axum::extract::Query<ResetQuery>,
) -> ApiResult<impl IntoResponse> {
    let token = q.token.unwrap_or_default();
    let user =
        s.db.password_reset_user(&sha256_hex(token.trim()))?
            .ok_or_else(|| ApiError::bad_request(MSG_BAD_RESET))?;
    Ok(Json(json!({ "email": user.email, "name": user.name })))
}

#[derive(Deserialize)]
struct ResetBody {
    token: Option<String>,
    password: Option<String>,
}

/// Applique un lien : nouveau mot de passe, sessions du compte fermées, nouvelle session ouverte.
async fn reset_password(State(s): State<AppState>, Body(b): Body<ResetBody>) -> ApiResult<impl IntoResponse> {
    let token = b.token.unwrap_or_default();
    let hash = sha256_hex(token.trim());
    if s.db.password_reset_user(&hash)?.is_none() {
        return Err(ApiError::bad_request(MSG_BAD_RESET));
    }
    let password = b.password.unwrap_or_default();
    check_password(&password)?;
    let password_hash = hash_password(password).await?;
    let user =
        s.db.consume_password_reset(&hash, &password_hash)?
            .ok_or_else(|| ApiError::bad_request(MSG_BAD_RESET))?;
    s.auth.reset(&user.email);
    s.hub.access_changed();
    tracing::info!("mot de passe réinitialisé : {}", user.email);
    start_session(&s, user)
}

async fn admin_users(me: CurrentUser, State(s): State<AppState>) -> ApiResult<impl IntoResponse> {
    require_admin(&me)?;
    Ok(Json(s.db.users()?))
}

async fn admin_create_user(
    me: CurrentUser,
    State(s): State<AppState>,
    Body(b): Body<NewUserBody>,
) -> ApiResult<impl IntoResponse> {
    require_admin(&me)?;
    let is_admin = b.is_admin.unwrap_or(false);
    Ok(Json(new_user(&s, b, is_admin, false).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mots_de_passe_et_empreintes() {
        let hash = hash_password_sync("secret123").unwrap();
        assert!(hash.starts_with("$argon2id$"));
        assert!(verify_password_sync("secret123", &hash));
        assert!(!verify_password_sync("autre", &hash));
        assert_eq!(sha256_hex("abc").len(), 64);
        let a = random_secret();
        assert_eq!(a.len(), 43);
        assert_ne!(a, random_secret());
        assert_eq!(normalize_email("  Ana@Exemple.FR "), "ana@exemple.fr");
    }

    #[test]
    fn cookie_de_session() {
        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            HeaderValue::from_static("a=1; swiftma_session=xyz; b=2"),
        );
        assert_eq!(session_from_headers(&h).as_deref(), Some("xyz"));
        let auth = Auth::new(true, true);
        let c = auth.session_cookie("v");
        let c = c.to_str().unwrap();
        assert!(c.contains("HttpOnly") && c.contains("SameSite=Lax") && c.contains("Path=/"));
        assert!(c.contains("Max-Age=2592000") && c.ends_with("; Secure"));
    }
}
