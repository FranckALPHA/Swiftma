//! WebSocket `/ws?file=<id>&user=<clientId>` : une connexion = un onglet d'une personne connectée dans la salle
//! d'un fichier. L'identification (cookie ou `Authorization`) est vérifiée avant l'upgrade (401 sinon) ; le rôle
//! est revérifié à chaque écriture et à chaque changement de droits signalé par le hub : un membre retiré, une
//! session fermée ou un jeton révoqué perd la connexion tout de suite, un rôle modifié est annoncé (`role`).

use std::sync::Arc;

use axum::extract::ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::Response;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::broadcast::Receiver;
use tokio::sync::broadcast::error::{RecvError, TryRecvError};

use crate::api::{MSG_READ_ONLY, require};
use crate::auth::CurrentUser;
use crate::db::{Role, User};
use crate::rooms::{Batch, Room};
use crate::{AppState, new_id};

const MSG_NOT_FOUND: &str = "Fichier introuvable";
const MSG_ACCESS_REVOKED: &str = "Accès retiré : tu n'as plus accès à ce fichier";
const MSG_SESSION_ENDED: &str = "Session terminée : reconnecte-toi";

#[derive(Deserialize)]
pub struct WsQuery {
    file: Option<String>,
    user: Option<String>,
    // `name` est ignoré : le nom affiché est celui du compte
}

pub async fn handler(
    me: CurrentUser,
    ws: WebSocketUpgrade,
    Query(q): Query<WsQuery>,
    State(state): State<AppState>,
) -> Response {
    ws.on_upgrade(move |socket| session(socket, state, me, q))
}

/// Connexion d'un onglet.
struct Client {
    /// Id du compte.
    account: String,
    /// Identifiant d'onglet (`user`), `origin` par défaut de ses lots.
    tab: String,
    /// Clé interne (présence, piles d'annulation) : `<compte>:<onglet>`.
    key: String,
}

/// Réponse à un message refusé.
enum Refusal {
    /// Lot refusé : erreur puis resynchronisation.
    Resync(String),
    /// Écriture d'un lecteur : erreur seule.
    Error(String),
    /// Fichier devenu inaccessible : erreur puis fermeture.
    Gone,
}

fn text(msg: &Value) -> Message {
    Message::Text(Utf8Bytes::from(msg.to_string()))
}

fn error_message(message: &str) -> Message {
    text(&json!({ "type": "error", "message": message }))
}

/// Résultat de la revérification des droits d'une connexion ouverte.
enum Access {
    Same,
    Role(Role),
    Revoked(&'static str),
}

fn recheck(state: &AppState, me: &CurrentUser, file: &str, current: Role) -> Access {
    match me.still_valid(state) {
        Ok(true) => {}
        Ok(false) => return Access::Revoked(MSG_SESSION_ENDED),
        Err(e) => {
            tracing::error!("revérification de la session : {e}");
            return Access::Same;
        }
    }
    match state.db.file_role(file, &me.user.id) {
        Ok(Some((_, role))) if role == current => Access::Same,
        Ok(Some((_, role))) => Access::Role(role),
        Ok(None) => Access::Revoked(MSG_ACCESS_REVOKED),
        Err(e) => {
            tracing::error!("revérification des droits sur {file} : {e}");
            Access::Same
        }
    }
}

async fn session(mut socket: WebSocket, state: AppState, me: CurrentUser, q: WsQuery) {
    let account: &User = &me.user;
    let file = q.file.unwrap_or_default();
    let tab = q.user.filter(|u| !u.is_empty()).unwrap_or_else(new_id);
    let client = Client {
        key: format!("{}:{tab}", account.id),
        account: account.id.clone(),
        tab,
    };
    // Abonné avant la vérification : aucun changement de droits ne peut passer inaperçu
    let mut access = state.hub.watch_access();
    let mut role = Role::Viewer;
    let room = match state.db.file_role(&file, &account.id).and_then(|found| match found {
        Some((_, r)) => {
            role = r;
            state.hub.room(&file)
        }
        None => Ok(None),
    }) {
        Ok(Some(room)) => room,
        Ok(None) => {
            let _ = socket.send(error_message(MSG_NOT_FOUND)).await;
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
        Err(e) => {
            tracing::error!("chargement du fichier {file} : {e}");
            let _ = socket.send(error_message("Erreur de la base de données")).await;
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
    };

    // Abonnement et document pris sous le même verrou : aucun lot ne peut se glisser entre les deux
    let (mut rx, doc) = {
        let mut st = room.lock().await;
        let rx = room.subscribe();
        let doc = Room::doc_message(&st);
        room.join(&mut st, &client.key, &client.tab, &client.account, &account.name);
        (rx, doc)
    };
    let mut shutdown = state.shutdown.clone();

    if socket.send(Message::Text(doc)).await.is_ok() {
        loop {
            tokio::select! {
                msg = rx.recv() => match msg {
                    Ok(msg) => {
                        if socket.send(Message::Text(msg)).await.is_err() || room.is_deleted() {
                            break;
                        }
                    }
                    Err(RecvError::Lagged(_)) => {
                        // Trop de retard : on renvoie le document complet
                        if resync(&mut socket, &room, &mut rx, None).await.is_err() {
                            break;
                        }
                    }
                    Err(RecvError::Closed) => break,
                },
                incoming = socket.recv() => match incoming {
                    Some(Ok(Message::Text(t))) => {
                        let sent = match handle(&state, &room, &client, t.as_str()).await {
                            None => Ok(()),
                            Some(Refusal::Resync(err)) => resync(&mut socket, &room, &mut rx, Some(&err)).await,
                            Some(Refusal::Error(err)) => socket.send(error_message(&err)).await,
                            Some(Refusal::Gone) => {
                                let _ = socket.send(error_message(MSG_NOT_FOUND)).await;
                                let _ = socket.send(Message::Close(None)).await;
                                break;
                            }
                        };
                        if sent.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => {}
                },
                changed = access.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    match recheck(&state, &me, &file, role) {
                        Access::Same => {}
                        Access::Role(r) => {
                            role = r;
                            if socket.send(text(&json!({ "type": "role", "role": r.as_str() }))).await.is_err() {
                                break;
                            }
                        }
                        Access::Revoked(message) => {
                            let _ = socket.send(error_message(message)).await;
                            let _ = socket.send(Message::Close(None)).await;
                            break;
                        }
                    }
                }
                _ = shutdown.changed() => {
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }
            }
        }
    }

    let mut st = room.lock().await;
    room.leave(&mut st, &client.key);
}

/// Envoie (après les messages déjà diffusés) l'erreur éventuelle puis le document courant.
async fn resync(
    socket: &mut WebSocket,
    room: &Arc<Room>,
    rx: &mut Receiver<Utf8Bytes>,
    error: Option<&str>,
) -> Result<(), axum::Error> {
    let (pending, doc) = {
        // Sous le verrou, plus rien n'est diffusé : tout ce qui suit aura une version plus grande que ce document
        let st = room.lock().await;
        let mut pending = Vec::new();
        loop {
            match rx.try_recv() {
                Ok(m) => pending.push(m),
                Err(TryRecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
        (pending, Room::doc_message(&st))
    };
    for m in pending {
        socket.send(Message::Text(m)).await?;
    }
    if let Some(error) = error {
        socket.send(error_message(error)).await?;
    }
    socket.send(Message::Text(doc)).await
}

/// Traite un message du client ; renvoie le refus éventuel.
async fn handle(state: &AppState, room: &Arc<Room>, client: &Client, raw: &str) -> Option<Refusal> {
    let Ok(msg) = serde_json::from_str::<Value>(raw) else {
        return None;
    };
    let kind = msg.get("type").and_then(Value::as_str).unwrap_or_default();
    if matches!(kind, "ops" | "undo" | "redo") {
        // Le rôle peut avoir changé depuis la connexion : revérifié à chaque écriture
        match state.db.file_role(&room.file_id, &client.account) {
            Ok(Some((_, role))) => {
                if require(role, Role::Editor).is_err() {
                    return Some(Refusal::Error(MSG_READ_ONLY.into()));
                }
            }
            Ok(None) => return Some(Refusal::Gone),
            Err(e) => {
                tracing::error!("droits sur {} : {e}", room.file_id);
                return Some(Refusal::Error("Erreur de la base de données".into()));
            }
        }
    }
    let user = client.key.as_str();
    let mut st = room.lock().await;
    let resync = |e: crate::ops::OpError| Refusal::Resync(e.0);
    match kind {
        "ops" => {
            let Some(ops) = msg.get("ops").and_then(Value::as_array) else {
                return Some(Refusal::Resync("Lot invalide : « ops » doit être une liste".into()));
            };
            let batch = Batch {
                ops: ops.clone(),
                author: "human".into(),
                label: msg.get("label").and_then(Value::as_str).map(str::to_string),
                origin: Some(
                    msg.get("origin")
                        .and_then(Value::as_str)
                        .unwrap_or(&client.tab)
                        .to_string(),
                ),
                stack: Some(user.to_string()),
                account: Some(client.account.clone()),
            };
            room.commit(&mut st, batch).err().map(resync)
        }
        "undo" => room.undo(&mut st, user, &client.tab).err().map(resync),
        "redo" => room.redo(&mut st, user, &client.tab).err().map(resync),
        "selection" => {
            let ids = msg
                .get("ids")
                .and_then(Value::as_array)
                .map(|ids| ids.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            room.set_selection(&mut st, user, ids);
            None
        }
        "cursor" => {
            let x = msg.get("x").and_then(Value::as_f64);
            let y = msg.get("y").and_then(Value::as_f64);
            room.set_cursor(&mut st, user, x.zip(y));
            None
        }
        _ => None,
    }
}
