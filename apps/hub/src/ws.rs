//! WebSocket `/ws?file=<id>&user=<clientId>&name=<nom>` : une connexion = un utilisateur dans la salle d'un fichier.

use std::sync::Arc;

use axum::extract::ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::Response;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::broadcast::Receiver;
use tokio::sync::broadcast::error::{RecvError, TryRecvError};

use crate::rooms::{Batch, Room};
use crate::{AppState, new_id};

#[derive(Deserialize)]
pub struct WsQuery {
    file: Option<String>,
    user: Option<String>,
    name: Option<String>,
}

pub async fn handler(ws: WebSocketUpgrade, Query(q): Query<WsQuery>, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| session(socket, state, q))
}

fn text(msg: &Value) -> Message {
    Message::Text(Utf8Bytes::from(msg.to_string()))
}

fn error_message(message: &str) -> Message {
    text(&json!({ "type": "error", "message": message }))
}

async fn session(mut socket: WebSocket, state: AppState, q: WsQuery) {
    let file = q.file.unwrap_or_default();
    let user = q.user.filter(|u| !u.is_empty()).unwrap_or_else(new_id);
    let name = q
        .name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "Anonyme".into());
    let room = match state.hub.room(&file) {
        Ok(Some(room)) => room,
        Ok(None) => {
            let _ = socket
                .send(error_message(&format!("Fichier introuvable : {file}")))
                .await;
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
        room.join(&mut st, &user, &name);
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
                        if let Some(err) = handle(&room, &user, t.as_str()).await
                            && resync(&mut socket, &room, &mut rx, Some(&err)).await.is_err()
                        {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => {}
                },
                _ = shutdown.changed() => {
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }
            }
        }
    }

    let mut st = room.lock().await;
    room.leave(&mut st, &user);
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

/// Traite un message du client ; renvoie le message d'erreur si un lot est refusé.
async fn handle(room: &Arc<Room>, user: &str, raw: &str) -> Option<String> {
    let Ok(msg) = serde_json::from_str::<Value>(raw) else {
        return None;
    };
    let kind = msg.get("type").and_then(Value::as_str).unwrap_or_default();
    let mut st = room.lock().await;
    match kind {
        "ops" => {
            let Some(ops) = msg.get("ops").and_then(Value::as_array) else {
                return Some("Lot invalide : « ops » doit être une liste".into());
            };
            let batch = Batch {
                ops: ops.clone(),
                author: "human".into(),
                label: msg.get("label").and_then(Value::as_str).map(str::to_string),
                origin: Some(msg.get("origin").and_then(Value::as_str).unwrap_or(user).to_string()),
                stack: Some(user.to_string()),
            };
            room.commit(&mut st, batch).err().map(|e| e.0)
        }
        "undo" => room.undo(&mut st, user).err().map(|e| e.0),
        "redo" => room.redo(&mut st, user).err().map(|e| e.0),
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
