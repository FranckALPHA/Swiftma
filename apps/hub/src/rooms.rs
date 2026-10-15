//! Salles de collaboration : une par fichier ouvert. Chaque salle garde le document en mémoire, ordonne les lots
//! (version +1 par lot), tient les piles d'annulation par utilisateur, la présence, et sauvegarde en différé.
//!
//! Les clés internes des utilisateurs (piles d'annulation, présence) sont préfixées par l'id du compte
//! (`<compte>:<onglet>`) : un compte ne peut pas annuler à la place d'un autre.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use axum::extract::ws::Utf8Bytes;
use indexmap::IndexMap;
use serde_json::{Value, json};
use tokio::sync::{MutexGuard, broadcast};

use crate::db::{Db, DbResult};
use crate::now_ms;
use crate::ops::{OpError, apply_ops};

/// Délai maximal entre une modification et sa sauvegarde.
pub const SAVE_DELAY: Duration = Duration::from_secs(1);
/// Intervalle minimal entre deux instantanés automatiques d'un fichier.
pub const AUTO_VERSION_INTERVAL_MS: i64 = 10 * 60 * 1000;
/// Intervalle minimal entre deux messages de présence.
pub const PRESENCE_INTERVAL: Duration = Duration::from_millis(50);
/// Taille maximale d'une pile d'annulation.
pub const MAX_UNDO: usize = 500;
/// Une salle sans connexion et sauvegardée est libérée après ce délai d'inactivité.
pub const IDLE_UNLOAD: Duration = Duration::from_secs(10 * 60);

pub const AUTO_VERSION_LABEL: &str = "Sauvegarde automatique";

const COLORS: &[&str] = &[
    "#F24822", "#0D99FF", "#14AE5C", "#9747FF", "#FFA629", "#FF24BD", "#00B5CE", "#E5A000",
];

/// Ensemble des salles chargées.
pub struct Hub {
    pub db: Arc<Db>,
    rooms: Mutex<HashMap<String, Arc<Room>>>,
    /// Dernière activité MCP (ms), 0 si aucune.
    mcp_last_seen: AtomicI64,
    /// Dernier fichier actif (ouvert ou modifié) de chaque compte : le fichier par défaut des outils MCP.
    active_file: Mutex<HashMap<String, String>>,
}

impl Hub {
    pub fn new(db: Arc<Db>) -> Arc<Hub> {
        Arc::new(Hub {
            db,
            rooms: Mutex::new(HashMap::new()),
            mcp_last_seen: AtomicI64::new(0),
            active_file: Mutex::new(HashMap::new()),
        })
    }

    /// Note qu'un compte vient d'ouvrir ou de modifier un fichier.
    pub fn touch_active(&self, account: &str, file_id: &str) {
        self.active_file
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(account.to_string(), file_id.to_string());
    }

    /// Dernier fichier actif d'un compte (il peut avoir été supprimé depuis).
    pub fn active_file(&self, account: &str) -> Option<String> {
        self.active_file
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(account)
            .cloned()
    }

    fn rooms(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Room>>> {
        self.rooms.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Salle d'un fichier, chargée depuis SQLite au premier accès. `None` si le fichier n'existe pas.
    pub fn room(self: &Arc<Self>, file_id: &str) -> DbResult<Option<Arc<Room>>> {
        let mut rooms = self.rooms();
        if let Some(room) = rooms.get(file_id) {
            return Ok(Some(room.clone()));
        }
        let Some((doc, version)) = self.db.file_doc(file_id)? else {
            return Ok(None);
        };
        let last_auto_at = self.db.last_auto_version_at(file_id)?.unwrap_or(0);
        let (tx, _) = broadcast::channel(4096);
        let room = Arc::new(Room {
            file_id: file_id.to_string(),
            db: self.db.clone(),
            hub: Arc::downgrade(self),
            state: tokio::sync::Mutex::new(RoomState {
                doc,
                version,
                undo: HashMap::new(),
                redo: HashMap::new(),
                users: IndexMap::new(),
                dirty: false,
                save_pending: false,
                last_auto_at,
                last_presence: None,
                presence_pending: false,
                last_active: Instant::now(),
            }),
            tx,
            deleted: AtomicBool::new(false),
        });
        rooms.insert(file_id.to_string(), room.clone());
        Ok(Some(room))
    }

    /// Salle déjà chargée, sans accès à la base.
    pub fn loaded(&self, file_id: &str) -> Option<Arc<Room>> {
        self.rooms().get(file_id).cloned()
    }

    /// Ferme la salle d'un fichier supprimé : ses éditeurs sont prévenus, plus rien n'est sauvegardé.
    pub fn close(&self, file_id: &str) {
        if let Some(room) = self.rooms().remove(file_id) {
            room.deleted.store(true, Ordering::SeqCst);
            room.send(&json!({ "type": "error", "message": "Ce fichier a été supprimé" }));
        }
    }

    pub fn mcp_last_seen(&self) -> Option<i64> {
        match self.mcp_last_seen.load(Ordering::Relaxed) {
            0 => None,
            t => Some(t),
        }
    }

    /// Note une activité MCP et met à jour la présence de toutes les salles.
    pub async fn mcp_seen(&self) {
        self.mcp_last_seen.store(now_ms(), Ordering::Relaxed);
        let rooms: Vec<Arc<Room>> = self.rooms().values().cloned().collect();
        for room in rooms {
            let mut st = room.lock().await;
            room.presence_changed(&mut st);
        }
    }

    /// Sauvegarde immédiatement toutes les salles modifiées (arrêt du hub).
    pub async fn flush_all(&self) {
        let rooms: Vec<Arc<Room>> = self.rooms().values().cloned().collect();
        for room in rooms {
            let mut st = room.lock().await;
            room.save_locked(&mut st);
        }
    }

    /// Libère les salles inutilisées depuis longtemps (sans connexion, sauvegardées, référencées par personne).
    pub fn unload_idle(&self) {
        self.rooms().retain(|_, room| {
            if Arc::strong_count(room) > 1 {
                return true;
            }
            match room.state.try_lock() {
                Ok(st) => st.dirty || !st.users.is_empty() || st.last_active.elapsed() < IDLE_UNLOAD,
                Err(_) => true,
            }
        });
    }
}

struct Entry {
    ops: Vec<Value>,
    inverse: Vec<Value>,
    label: Option<String>,
    author: String,
}

struct Presence {
    /// Identifiant d'onglet (`user` du WebSocket), montré comme `id`.
    tab: String,
    /// Id du compte, montré comme `userId`.
    account: String,
    name: String,
    color: String,
    selection: Vec<String>,
    cursor: Option<(f64, f64)>,
    connections: usize,
}

pub struct RoomState {
    pub doc: Value,
    pub version: u64,
    undo: HashMap<String, Vec<Entry>>,
    redo: HashMap<String, Vec<Entry>>,
    users: IndexMap<String, Presence>,
    dirty: bool,
    save_pending: bool,
    last_auto_at: i64,
    last_presence: Option<Instant>,
    presence_pending: bool,
    last_active: Instant,
}

pub struct Room {
    pub file_id: String,
    db: Arc<Db>,
    hub: Weak<Hub>,
    state: tokio::sync::Mutex<RoomState>,
    tx: broadcast::Sender<Utf8Bytes>,
    deleted: AtomicBool,
}

/// Lot à appliquer.
pub struct Batch {
    pub ops: Vec<Value>,
    pub author: String,
    pub label: Option<String>,
    pub origin: Option<String>,
    /// Pile d'annulation qui reçoit le lot (aucune pour les modifications internes du hub).
    pub stack: Option<String>,
    /// Compte à l'origine du lot : le fichier devient son fichier actif.
    pub account: Option<String>,
}

impl Room {
    pub async fn lock(&self) -> MutexGuard<'_, RoomState> {
        let mut st = self.state.lock().await;
        st.last_active = Instant::now();
        st
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Utf8Bytes> {
        self.tx.subscribe()
    }

    pub fn is_deleted(&self) -> bool {
        self.deleted.load(Ordering::SeqCst)
    }

    /// Diffuse un message à tous les éditeurs de la salle.
    pub fn send(&self, msg: &Value) {
        let _ = self.tx.send(Utf8Bytes::from(msg.to_string()));
    }

    pub fn doc_message(st: &RoomState) -> Utf8Bytes {
        Utf8Bytes::from(json!({ "type": "doc", "doc": st.doc, "version": st.version }).to_string())
    }

    /// Applique un lot de façon atomique, le diffuse et l'empile. Renvoie la nouvelle version.
    pub fn commit(self: &Arc<Self>, st: &mut RoomState, batch: Batch) -> Result<u64, OpError> {
        if let (Some(hub), Some(account)) = (self.hub.upgrade(), batch.account.as_deref()) {
            hub.touch_active(account, &self.file_id);
        }
        if batch.ops.is_empty() {
            return Ok(st.version);
        }
        let inverse = apply_ops(&mut st.doc, &batch.ops)?;
        self.broadcast_ops(
            st,
            &batch.ops,
            &batch.author,
            batch.label.as_deref(),
            batch.origin.as_deref(),
        );
        if let Some(stack) = batch.stack {
            st.redo.remove(&stack);
            let undo = st.undo.entry(stack).or_default();
            undo.push(Entry {
                ops: batch.ops,
                inverse,
                label: batch.label,
                author: batch.author,
            });
            if undo.len() > MAX_UNDO {
                undo.remove(0);
            }
        }
        Ok(st.version)
    }

    /// Annule le dernier lot de la pile `user` (diffusé avec `origin`). `Ok(false)` s'il n'y a rien à annuler.
    pub fn undo(self: &Arc<Self>, st: &mut RoomState, user: &str, origin: &str) -> Result<bool, OpError> {
        let Some(entry) = st.undo.get_mut(user).and_then(Vec::pop) else {
            return Ok(false);
        };
        // En cas d'échec (le document a changé entre-temps), l'entrée est abandonnée
        apply_ops(&mut st.doc, &entry.inverse).map_err(|e| OpError(format!("Impossible d'annuler : {e}")))?;
        self.broadcast_ops(st, &entry.inverse, &entry.author, entry.label.as_deref(), Some(origin));
        st.redo.entry(user.to_string()).or_default().push(entry);
        Ok(true)
    }

    /// Rétablit le dernier lot annulé de la pile `user` (diffusé avec `origin`).
    pub fn redo(self: &Arc<Self>, st: &mut RoomState, user: &str, origin: &str) -> Result<bool, OpError> {
        let Some(mut entry) = st.redo.get_mut(user).and_then(Vec::pop) else {
            return Ok(false);
        };
        let inverse =
            apply_ops(&mut st.doc, &entry.ops).map_err(|e| OpError(format!("Impossible de rétablir : {e}")))?;
        // L'inverse recalculé tient compte des modifications des autres depuis
        entry.inverse = inverse;
        self.broadcast_ops(st, &entry.ops, &entry.author, entry.label.as_deref(), Some(origin));
        let undo = st.undo.entry(user.to_string()).or_default();
        undo.push(entry);
        if undo.len() > MAX_UNDO {
            undo.remove(0);
        }
        Ok(true)
    }

    /// Remplace le document (restauration d'une version) : piles vidées, document rediffusé.
    pub fn replace_doc(self: &Arc<Self>, st: &mut RoomState, doc: Value) -> u64 {
        st.doc = doc;
        st.version += 1;
        st.undo.clear();
        st.redo.clear();
        let _ = self.tx.send(Self::doc_message(st));
        self.schedule_save(st);
        st.version
    }

    fn broadcast_ops(
        self: &Arc<Self>,
        st: &mut RoomState,
        ops: &[Value],
        author: &str,
        label: Option<&str>,
        origin: Option<&str>,
    ) {
        st.version += 1;
        let mut msg = json!({ "type": "ops", "ops": ops, "author": author });
        if let Some(label) = label {
            msg["label"] = json!(label);
        }
        if let Some(origin) = origin {
            msg["origin"] = json!(origin);
        }
        msg["version"] = json!(st.version);
        self.send(&msg);
        self.schedule_save(st);
    }

    // --- Sauvegarde ---

    fn schedule_save(self: &Arc<Self>, st: &mut RoomState) {
        st.dirty = true;
        if st.save_pending {
            return;
        }
        st.save_pending = true;
        let room = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(SAVE_DELAY).await;
            let mut st = room.state.lock().await;
            room.save_locked(&mut st);
        });
    }

    /// Écrit le document s'il a changé, et prend un instantané automatique si le dernier est assez ancien.
    pub fn save_locked(&self, st: &mut RoomState) {
        st.save_pending = false;
        if !st.dirty || self.is_deleted() {
            return;
        }
        let text = st.doc.to_string();
        if let Err(e) = self.db.save_doc(&self.file_id, &text, st.version) {
            tracing::error!("sauvegarde du fichier {} impossible : {e}", self.file_id);
            return;
        }
        st.dirty = false;
        let now = now_ms();
        if now - st.last_auto_at >= AUTO_VERSION_INTERVAL_MS {
            match self.db.create_version(&self.file_id, AUTO_VERSION_LABEL, &st.doc, true) {
                Ok(_) => st.last_auto_at = now,
                Err(e) => tracing::error!("instantané automatique de {} impossible : {e}", self.file_id),
            }
        }
    }

    // --- Présence ---

    /// Arrivée d'une connexion : `user` est la clé interne, `tab` l'identifiant d'onglet, `account` l'id du compte.
    pub fn join(self: &Arc<Self>, st: &mut RoomState, user: &str, tab: &str, account: &str, name: &str) {
        if let Some(hub) = self.hub.upgrade() {
            hub.touch_active(account, &self.file_id);
        }
        if let Some(p) = st.users.get_mut(user) {
            p.connections += 1;
            p.name = name.to_string();
        } else {
            let used: Vec<&str> = st.users.values().map(|p| p.color.as_str()).collect();
            let color = COLORS
                .iter()
                .find(|c| !used.contains(c))
                .unwrap_or(&COLORS[st.users.len() % COLORS.len()])
                .to_string();
            st.users.insert(
                user.to_string(),
                Presence {
                    tab: tab.to_string(),
                    account: account.to_string(),
                    name: name.to_string(),
                    color,
                    selection: Vec::new(),
                    cursor: None,
                    connections: 1,
                },
            );
        }
        self.presence_changed(st);
    }

    pub fn leave(self: &Arc<Self>, st: &mut RoomState, user: &str) {
        if let Some(p) = st.users.get_mut(user) {
            p.connections = p.connections.saturating_sub(1);
            if p.connections == 0 {
                st.users.shift_remove(user);
            }
        }
        self.presence_changed(st);
    }

    pub fn set_selection(self: &Arc<Self>, st: &mut RoomState, user: &str, ids: Vec<String>) {
        if let Some(p) = st.users.get_mut(user) {
            p.selection = ids;
            self.presence_changed(st);
        }
    }

    pub fn set_cursor(self: &Arc<Self>, st: &mut RoomState, user: &str, cursor: Option<(f64, f64)>) {
        if let Some(p) = st.users.get_mut(user) {
            p.cursor = cursor;
            self.presence_changed(st);
        }
    }

    /// Diffuse la présence, au plus toutes les 50 ms (le dernier état est toujours envoyé).
    pub fn presence_changed(self: &Arc<Self>, st: &mut RoomState) {
        if st.presence_pending {
            return;
        }
        let wait = st
            .last_presence
            .map(|t| PRESENCE_INTERVAL.saturating_sub(t.elapsed()))
            .unwrap_or_default();
        if wait.is_zero() {
            self.send_presence(st);
            return;
        }
        st.presence_pending = true;
        let room = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(wait).await;
            let mut st = room.state.lock().await;
            st.presence_pending = false;
            room.send_presence(&mut st);
        });
    }

    fn send_presence(&self, st: &mut RoomState) {
        st.last_presence = Some(Instant::now());
        let msg = self.presence_json(st);
        self.send(&msg);
    }

    /// Message de présence : les personnes dans le fichier, leur sélection et leur curseur.
    pub fn presence_json(&self, st: &RoomState) -> Value {
        let users: Vec<Value> = st
            .users
            .iter()
            .map(|(_, p)| {
                json!({
                    "id": p.tab,
                    "userId": p.account,
                    "name": p.name,
                    "color": p.color,
                    "selection": p.selection,
                    "cursor": p.cursor.map(|(x, y)| json!({ "x": x, "y": y })),
                })
            })
            .collect();
        let mcp = self.hub.upgrade().and_then(|h| h.mcp_last_seen());
        json!({ "type": "presence", "users": users, "mcpLastSeen": mcp })
    }
}
