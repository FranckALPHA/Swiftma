//! Persistance SQLite : projets, fichiers (document courant), versions, vignettes, comptes, sessions, jetons et
//! membres des projets.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::Value;

use crate::{new_id, now_ms};

pub type DbResult<T> = rusqlite::Result<T>;

/// Nombre maximal d'instantanés automatiques gardés par fichier.
pub const MAX_AUTO_VERSIONS: i64 = 50;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub file_count: i64,
    /// Rôle de la personne qui demande (absent pour les usages internes).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<Role>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub has_thumbnail: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub id: String,
    pub file_id: String,
    pub label: String,
    pub created_at: i64,
    pub node_count: i64,
}

/// Rôle dans un projet, du plus faible au plus fort.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Viewer,
    Editor,
    Owner,
}

impl Role {
    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "viewer" => Some(Role::Viewer),
            "editor" => Some(Role::Editor),
            "owner" => Some(Role::Owner),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Role::Viewer => "viewer",
            Role::Editor => "editor",
            Role::Owner => "owner",
        }
    }
}

impl rusqlite::types::FromSql for Role {
    fn column_result(v: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Role> {
        Role::parse(v.as_str()?).ok_or(rusqlite::types::FromSqlError::InvalidType)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub email: String,
    pub name: String,
    pub is_admin: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub user_id: String,
    pub email: String,
    pub name: String,
    pub role: Role,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Token {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

/// Création de compte refusée.
#[derive(Debug, PartialEq, Eq)]
pub enum NewUserError {
    EmailTaken,
    /// Inscriptions fermées : seul le premier compte pouvait être créé.
    SignupClosed,
}

/// Changement de membre refusé.
#[derive(Debug, PartialEq, Eq)]
pub enum MemberError {
    NotMember,
    LastOwner,
}

pub struct Db {
    conn: Mutex<Connection>,
}

const MIGRATIONS: &[&str] = &[
    // 1 : schéma initial
    "CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE files (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        doc TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX files_project ON files(project_id);
    CREATE TABLE versions (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        auto INTEGER NOT NULL DEFAULT 0,
        doc TEXT NOT NULL,
        node_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX versions_file ON versions(file_id, created_at);
    CREATE TABLE thumbnails (
        file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
        mime TEXT NOT NULL,
        data BLOB NOT NULL
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    // 2 : comptes, sessions, jetons personnels et membres des projets
    "CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
    );
    CREATE INDEX sessions_user ON sessions(user_id);
    CREATE TABLE tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
    );
    CREATE INDEX tokens_user ON tokens(user_id);
    CREATE TABLE project_members (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'owner')),
        PRIMARY KEY (project_id, user_id)
    );
    CREATE INDEX project_members_user ON project_members(user_id);",
    // 3 : liens de réinitialisation du mot de passe (à usage unique)
    "CREATE TABLE password_resets (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
    );
    CREATE INDEX password_resets_user ON password_resets(user_id);",
];

const USER_COLUMNS: &str = "u.id, u.email, u.name, u.is_admin, u.created_at";

const FILE_COLUMNS: &str = "f.id, f.project_id, f.name, f.created_at, f.updated_at,
    EXISTS(SELECT 1 FROM thumbnails t WHERE t.file_id = f.id)";

const PROJECT_COLUMNS: &str = "p.id, p.name, p.created_at, p.updated_at,
    (SELECT COUNT(*) FROM files f WHERE f.project_id = p.id)";

fn project_row(r: &Row) -> DbResult<Project> {
    Ok(Project {
        id: r.get(0)?,
        name: r.get(1)?,
        created_at: r.get(2)?,
        updated_at: r.get(3)?,
        file_count: r.get(4)?,
        role: None,
    })
}

/// Ligne de projet suivie du rôle (colonne 5).
fn project_role_row(r: &Row) -> DbResult<Project> {
    let mut p = project_row(r)?;
    p.role = Some(r.get(5)?);
    Ok(p)
}

fn user_row(r: &Row) -> DbResult<User> {
    Ok(User {
        id: r.get(0)?,
        email: r.get(1)?,
        name: r.get(2)?,
        is_admin: r.get(3)?,
        created_at: r.get(4)?,
    })
}

fn member_row(r: &Row) -> DbResult<Member> {
    Ok(Member {
        user_id: r.get(0)?,
        email: r.get(1)?,
        name: r.get(2)?,
        role: r.get(3)?,
    })
}

fn file_row(r: &Row) -> DbResult<FileMeta> {
    Ok(FileMeta {
        id: r.get(0)?,
        project_id: r.get(1)?,
        name: r.get(2)?,
        created_at: r.get(3)?,
        updated_at: r.get(4)?,
        has_thumbnail: r.get(5)?,
    })
}

fn version_row(r: &Row) -> DbResult<Version> {
    Ok(Version {
        id: r.get(0)?,
        file_id: r.get(1)?,
        label: r.get(2)?,
        created_at: r.get(3)?,
        node_count: r.get(4)?,
    })
}

fn parse_doc(text: String) -> DbResult<Value> {
    serde_json::from_str(&text)
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))
}

impl Db {
    /// Ouvre (ou crée, dossier compris) la base et applique les migrations.
    pub fn open(path: &Path) -> DbResult<Db> {
        if let Some(dir) = path.parent()
            && !dir.as_os_str().is_empty()
        {
            let _ = std::fs::create_dir_all(dir);
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        let current: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(current.max(0) as usize) {
            conn.execute_batch(&format!("BEGIN; {sql}; PRAGMA user_version = {}; COMMIT;", i + 1))?;
        }
        Ok(Db { conn: Mutex::new(conn) })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    // --- Méta ---

    pub fn meta(&self, key: &str) -> DbResult<Option<String>> {
        self.conn()
            .query_row("SELECT value FROM meta WHERE key = ?", [key], |r| r.get(0))
            .optional()
    }

    pub fn set_meta(&self, key: &str, value: &str) -> DbResult<()> {
        self.conn()
            .execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [key, value])?;
        Ok(())
    }

    // --- Projets ---

    pub fn projects(&self) -> DbResult<Vec<Project>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {PROJECT_COLUMNS} FROM projects p ORDER BY p.updated_at DESC, p.rowid DESC"
        ))?;
        stmt.query_map([], project_row)?.collect()
    }

    pub fn project(&self, id: &str) -> DbResult<Option<Project>> {
        self.conn()
            .query_row(
                &format!("SELECT {PROJECT_COLUMNS} FROM projects p WHERE p.id = ?"),
                [id],
                project_row,
            )
            .optional()
    }

    /// Crée un projet ; `owner` en devient propriétaire.
    pub fn create_project(&self, name: &str, owner: Option<&str>) -> DbResult<Project> {
        let id = new_id();
        let now = now_ms();
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
            params![id, name, now, now],
        )?;
        if let Some(owner) = owner {
            tx.execute(
                "INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')",
                params![id, owner],
            )?;
        }
        tx.commit()?;
        Ok(Project {
            id,
            name: name.to_string(),
            created_at: now,
            updated_at: now,
            file_count: 0,
            role: owner.map(|_| Role::Owner),
        })
    }

    /// Projets dont `user` est membre, avec son rôle, du plus récemment modifié au plus ancien.
    pub fn projects_for(&self, user: &str) -> DbResult<Vec<Project>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {PROJECT_COLUMNS}, m.role FROM projects p
             JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
             ORDER BY p.updated_at DESC, p.rowid DESC"
        ))?;
        stmt.query_map([user], project_role_row)?.collect()
    }

    pub fn rename_project(&self, id: &str, name: &str) -> DbResult<Option<Project>> {
        let n = self.conn().execute(
            "UPDATE projects SET name = ?, updated_at = ? WHERE id = ?",
            params![name, now_ms(), id],
        )?;
        if n == 0 { Ok(None) } else { self.project(id) }
    }

    /// Supprime un projet ; renvoie les ids de ses fichiers (supprimés avec leurs versions et vignettes).
    pub fn delete_project(&self, id: &str) -> DbResult<Option<Vec<String>>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let files: Vec<String> = {
            let mut stmt = tx.prepare("SELECT id FROM files WHERE project_id = ?")?;
            stmt.query_map([id], |r| r.get(0))?.collect::<DbResult<_>>()?
        };
        let n = tx.execute("DELETE FROM projects WHERE id = ?", [id])?;
        tx.commit()?;
        Ok((n > 0).then_some(files))
    }

    // --- Fichiers ---

    pub fn files(&self, project_id: &str) -> DbResult<Vec<FileMeta>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {FILE_COLUMNS} FROM files f WHERE f.project_id = ? ORDER BY f.updated_at DESC, f.rowid DESC"
        ))?;
        stmt.query_map([project_id], file_row)?.collect()
    }

    pub fn file(&self, id: &str) -> DbResult<Option<FileMeta>> {
        self.conn()
            .query_row(
                &format!("SELECT {FILE_COLUMNS} FROM files f WHERE f.id = ?"),
                [id],
                file_row,
            )
            .optional()
    }

    /// Document et version persistés d'un fichier.
    pub fn file_doc(&self, id: &str) -> DbResult<Option<(Value, u64)>> {
        let row: Option<(String, i64)> = self
            .conn()
            .query_row("SELECT doc, version FROM files WHERE id = ?", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        match row {
            Some((doc, version)) => Ok(Some((parse_doc(doc)?, version.max(0) as u64))),
            None => Ok(None),
        }
    }

    pub fn create_file(&self, project_id: &str, id: &str, name: &str, doc: &Value) -> DbResult<FileMeta> {
        let now = now_ms();
        let conn = self.conn();
        conn.execute(
            "INSERT INTO files (id, project_id, name, doc, version, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
            params![id, project_id, name, doc.to_string(), now, now],
        )?;
        conn.execute(
            "UPDATE projects SET updated_at = ? WHERE id = ?",
            params![now, project_id],
        )?;
        Ok(FileMeta {
            id: id.to_string(),
            project_id: project_id.to_string(),
            name: name.to_string(),
            created_at: now,
            updated_at: now,
            has_thumbnail: false,
        })
    }

    /// Renomme et/ou déplace un fichier (le document est mis à jour à part, par la salle).
    pub fn update_file(&self, id: &str, name: Option<&str>, project_id: Option<&str>) -> DbResult<()> {
        let now = now_ms();
        let conn = self.conn();
        let old_project: Option<String> = conn
            .query_row("SELECT project_id FROM files WHERE id = ?", [id], |r| r.get(0))
            .optional()?;
        if let Some(name) = name {
            conn.execute(
                "UPDATE files SET name = ?, updated_at = ? WHERE id = ?",
                params![name, now, id],
            )?;
        }
        if let Some(project_id) = project_id {
            conn.execute(
                "UPDATE files SET project_id = ?, updated_at = ? WHERE id = ?",
                params![project_id, now, id],
            )?;
            conn.execute(
                "UPDATE projects SET updated_at = ? WHERE id = ?",
                params![now, project_id],
            )?;
        }
        if let Some(old) = old_project {
            conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", params![now, old])?;
        }
        Ok(())
    }

    pub fn delete_file(&self, id: &str) -> DbResult<bool> {
        let conn = self.conn();
        conn.execute(
            "UPDATE projects SET updated_at = ? WHERE id = (SELECT project_id FROM files WHERE id = ?)",
            params![now_ms(), id],
        )?;
        Ok(conn.execute("DELETE FROM files WHERE id = ?", [id])? > 0)
    }

    /// Sauvegarde le document courant d'un fichier.
    pub fn save_doc(&self, id: &str, doc: &str, version: u64) -> DbResult<()> {
        let now = now_ms();
        let conn = self.conn();
        conn.execute(
            "UPDATE files SET doc = ?, version = ?, updated_at = ? WHERE id = ?",
            params![doc, version as i64, now, id],
        )?;
        conn.execute(
            "UPDATE projects SET updated_at = ? WHERE id = (SELECT project_id FROM files WHERE id = ?)",
            params![now, id],
        )?;
        Ok(())
    }

    // --- Versions ---

    pub fn versions(&self, file_id: &str) -> DbResult<Vec<Version>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, file_id, label, created_at, node_count FROM versions WHERE file_id = ?
             ORDER BY created_at DESC, rowid DESC",
        )?;
        stmt.query_map([file_id], version_row)?.collect()
    }

    /// Enregistre un instantané ; les automatiques au-delà de `MAX_AUTO_VERSIONS` sont supprimés.
    pub fn create_version(&self, file_id: &str, label: &str, doc: &Value, auto: bool) -> DbResult<Version> {
        let id = new_id();
        let now = now_ms();
        let node_count = crate::ops::node_count(doc) as i64;
        let conn = self.conn();
        conn.execute(
            "INSERT INTO versions (id, file_id, label, auto, doc, node_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![id, file_id, label, auto, doc.to_string(), node_count, now],
        )?;
        if auto {
            conn.execute(
                "DELETE FROM versions WHERE file_id = ?1 AND auto = 1 AND id NOT IN (
                    SELECT id FROM versions WHERE file_id = ?1 AND auto = 1
                    ORDER BY created_at DESC, rowid DESC LIMIT ?2)",
                params![file_id, MAX_AUTO_VERSIONS],
            )?;
        }
        Ok(Version {
            id,
            file_id: file_id.to_string(),
            label: label.to_string(),
            created_at: now,
            node_count,
        })
    }

    pub fn version_doc(&self, file_id: &str, version_id: &str) -> DbResult<Option<Value>> {
        let doc: Option<String> = self
            .conn()
            .query_row(
                "SELECT doc FROM versions WHERE id = ? AND file_id = ?",
                [version_id, file_id],
                |r| r.get(0),
            )
            .optional()?;
        doc.map(parse_doc).transpose()
    }

    /// Date du dernier instantané automatique d'un fichier.
    pub fn last_auto_version_at(&self, file_id: &str) -> DbResult<Option<i64>> {
        self.conn().query_row(
            "SELECT MAX(created_at) FROM versions WHERE file_id = ? AND auto = 1",
            [file_id],
            |r| r.get(0),
        )
    }

    // --- Vignettes ---

    pub fn set_thumbnail(&self, file_id: &str, mime: &str, data: &[u8]) -> DbResult<()> {
        self.conn().execute(
            "INSERT OR REPLACE INTO thumbnails (file_id, mime, data) VALUES (?, ?, ?)",
            params![file_id, mime, data],
        )?;
        Ok(())
    }

    pub fn thumbnail(&self, file_id: &str) -> DbResult<Option<(String, Vec<u8>)>> {
        self.conn()
            .query_row("SELECT mime, data FROM thumbnails WHERE file_id = ?", [file_id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()
    }
    // --- Comptes ---

    pub fn user_count(&self) -> DbResult<i64> {
        self.conn().query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))
    }

    /// Crée un compte. Le premier compte est administrateur et devient propriétaire des projets sans propriétaire.
    /// `only_if_first` : refusé s'il existe déjà un compte (inscriptions fermées).
    pub fn create_user(
        &self,
        email: &str,
        name: &str,
        password_hash: &str,
        is_admin: bool,
        only_if_first: bool,
    ) -> DbResult<Result<User, NewUserError>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let first: bool = tx.query_row("SELECT NOT EXISTS(SELECT 1 FROM users)", [], |r| r.get(0))?;
        if only_if_first && !first {
            return Ok(Err(NewUserError::SignupClosed));
        }
        let taken: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM users WHERE email = ?)", [email], |r| {
            r.get(0)
        })?;
        if taken {
            return Ok(Err(NewUserError::EmailTaken));
        }
        let user = User {
            id: new_id(),
            email: email.to_string(),
            name: name.to_string(),
            is_admin: is_admin || first,
            created_at: now_ms(),
        };
        tx.execute(
            "INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            params![
                user.id,
                user.email,
                user.name,
                password_hash,
                user.is_admin,
                user.created_at
            ],
        )?;
        if first {
            tx.execute(
                "INSERT OR REPLACE INTO project_members (project_id, user_id, role)
                 SELECT p.id, ?, 'owner' FROM projects p WHERE NOT EXISTS (
                    SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.role = 'owner')",
                [&user.id],
            )?;
        }
        tx.commit()?;
        Ok(Ok(user))
    }

    pub fn users(&self) -> DbResult<Vec<User>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {USER_COLUMNS} FROM users u ORDER BY u.created_at, u.rowid"
        ))?;
        stmt.query_map([], user_row)?.collect()
    }

    pub fn user(&self, id: &str) -> DbResult<Option<User>> {
        self.conn()
            .query_row(
                &format!("SELECT {USER_COLUMNS} FROM users u WHERE u.id = ?"),
                [id],
                user_row,
            )
            .optional()
    }

    /// Compte et empreinte du mot de passe, par adresse (déjà normalisée).
    pub fn user_by_email(&self, email: &str) -> DbResult<Option<(User, String)>> {
        self.conn()
            .query_row(
                &format!("SELECT {USER_COLUMNS}, u.password_hash FROM users u WHERE u.email = ?"),
                [email],
                |r| Ok((user_row(r)?, r.get(5)?)),
            )
            .optional()
    }

    pub fn password_hash(&self, user: &str) -> DbResult<Option<String>> {
        self.conn()
            .query_row("SELECT password_hash FROM users WHERE id = ?", [user], |r| r.get(0))
            .optional()
    }

    pub fn set_user_name(&self, user: &str, name: &str) -> DbResult<()> {
        self.conn()
            .execute("UPDATE users SET name = ? WHERE id = ?", params![name, user])?;
        Ok(())
    }

    /// Change le mot de passe et ferme les sessions du compte, sauf `keep_session`.
    pub fn set_password(&self, user: &str, hash: &str, keep_session: Option<&str>) -> DbResult<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute("UPDATE users SET password_hash = ? WHERE id = ?", params![hash, user])?;
        tx.execute(
            "DELETE FROM sessions WHERE user_id = ? AND token_hash IS NOT ?",
            params![user, keep_session],
        )?;
        tx.commit()
    }

    // --- Réinitialisation du mot de passe ---

    /// Nouveau lien de réinitialisation ; les liens précédents du compte sont annulés.
    pub fn create_password_reset(&self, user: &str, token_hash: &str, expires_at: i64) -> DbResult<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM password_resets WHERE user_id = ?", [user])?;
        tx.execute(
            "INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            params![token_hash, user, now_ms(), expires_at],
        )?;
        tx.commit()
    }

    /// Compte d'un lien encore valide (sans le consommer).
    pub fn password_reset_user(&self, token_hash: &str) -> DbResult<Option<User>> {
        self.conn()
            .query_row(
                &format!(
                    "SELECT {USER_COLUMNS} FROM password_resets r JOIN users u ON u.id = r.user_id
                     WHERE r.token_hash = ? AND r.expires_at > ?"
                ),
                params![token_hash, now_ms()],
                user_row,
            )
            .optional()
    }

    /// Applique un lien : nouveau mot de passe, toutes les sessions et tous les liens du compte fermés.
    /// Renvoie le compte, ou `None` si le lien est inconnu, déjà utilisé ou expiré.
    pub fn consume_password_reset(&self, token_hash: &str, password_hash: &str) -> DbResult<Option<User>> {
        let Some(user) = self.password_reset_user(token_hash)? else {
            return Ok(None);
        };
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        // Garde contre deux utilisations simultanées : seule la première supprime la ligne
        if tx.execute("DELETE FROM password_resets WHERE token_hash = ?", [token_hash])? == 0 {
            return Ok(None);
        }
        tx.execute("DELETE FROM password_resets WHERE user_id = ?", [&user.id])?;
        tx.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            params![password_hash, user.id],
        )?;
        tx.execute("DELETE FROM sessions WHERE user_id = ?", [&user.id])?;
        tx.commit()?;
        Ok(Some(user))
    }

    // --- Sessions ---

    pub fn create_session(&self, token_hash: &str, user: &str, expires_at: i64) -> DbResult<()> {
        self.conn().execute(
            "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            params![token_hash, user, now_ms(), expires_at],
        )?;
        Ok(())
    }

    /// Compte d'une session encore valide.
    pub fn session_user(&self, token_hash: &str) -> DbResult<Option<User>> {
        self.conn()
            .query_row(
                &format!(
                    "SELECT {USER_COLUMNS} FROM sessions s JOIN users u ON u.id = s.user_id
                     WHERE s.token_hash = ? AND s.expires_at > ?"
                ),
                params![token_hash, now_ms()],
                user_row,
            )
            .optional()
    }

    pub fn delete_session(&self, token_hash: &str) -> DbResult<()> {
        self.conn()
            .execute("DELETE FROM sessions WHERE token_hash = ?", [token_hash])?;
        Ok(())
    }

    pub fn purge_expired_sessions(&self) -> DbResult<()> {
        self.conn()
            .execute("DELETE FROM sessions WHERE expires_at <= ?", [now_ms()])?;
        Ok(())
    }

    // --- Jetons personnels ---

    pub fn create_token(&self, user: &str, name: &str, token_hash: &str) -> DbResult<Token> {
        let token = Token {
            id: new_id(),
            name: name.to_string(),
            created_at: now_ms(),
            last_used_at: None,
        };
        self.conn().execute(
            "INSERT INTO tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
            params![token.id, user, token.name, token_hash, token.created_at],
        )?;
        Ok(token)
    }

    pub fn tokens(&self, user: &str) -> DbResult<Vec<Token>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, name, created_at, last_used_at FROM tokens WHERE user_id = ?
             ORDER BY created_at DESC, rowid DESC",
        )?;
        stmt.query_map([user], |r| {
            Ok(Token {
                id: r.get(0)?,
                name: r.get(1)?,
                created_at: r.get(2)?,
                last_used_at: r.get(3)?,
            })
        })?
        .collect()
    }

    /// Compte d'un jeton ; note son usage (au plus une fois par `touch_ms`).
    pub fn token_user(&self, token_hash: &str, touch_ms: i64) -> DbResult<Option<User>> {
        let conn = self.conn();
        let found: Option<(String, User)> = conn
            .query_row(
                &format!(
                    "SELECT {USER_COLUMNS}, t.id FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?"
                ),
                [token_hash],
                |r| Ok((r.get(5)?, user_row(r)?)),
            )
            .optional()?;
        let Some((id, user)) = found else {
            return Ok(None);
        };
        let now = now_ms();
        conn.execute(
            "UPDATE tokens SET last_used_at = ?1 WHERE id = ?2 AND (last_used_at IS NULL OR last_used_at <= ?1 - ?3)",
            params![now, id, touch_ms],
        )?;
        Ok(Some(user))
    }

    pub fn delete_token(&self, user: &str, id: &str) -> DbResult<bool> {
        Ok(self
            .conn()
            .execute("DELETE FROM tokens WHERE id = ? AND user_id = ?", [id, user])?
            > 0)
    }

    // --- Membres ---

    pub fn project_role(&self, project: &str, user: &str) -> DbResult<Option<Role>> {
        self.conn()
            .query_row(
                "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
                [project, user],
                |r| r.get(0),
            )
            .optional()
    }

    /// Fichier et rôle de `user` dans son projet (`None` si le fichier n'existe pas ou n'est pas accessible).
    pub fn file_role(&self, file: &str, user: &str) -> DbResult<Option<(FileMeta, Role)>> {
        self.conn()
            .query_row(
                &format!(
                    "SELECT {FILE_COLUMNS}, m.role FROM files f
                     JOIN project_members m ON m.project_id = f.project_id AND m.user_id = ?
                     WHERE f.id = ?"
                ),
                [user, file],
                |r| Ok((file_row(r)?, r.get(6)?)),
            )
            .optional()
    }

    pub fn members(&self, project: &str) -> DbResult<Vec<Member>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT u.id, u.email, u.name, m.role FROM project_members m JOIN users u ON u.id = m.user_id
             WHERE m.project_id = ? ORDER BY u.email",
        )?;
        stmt.query_map([project], member_row)?.collect()
    }

    pub fn member(&self, project: &str, user: &str) -> DbResult<Option<Member>> {
        self.conn()
            .query_row(
                "SELECT u.id, u.email, u.name, m.role FROM project_members m JOIN users u ON u.id = m.user_id
                 WHERE m.project_id = ? AND m.user_id = ?",
                [project, user],
                member_row,
            )
            .optional()
    }

    /// Donne `role` à `user` dans le projet (ajouté s'il n'est pas membre et que `add` est vrai).
    /// Le dernier propriétaire ne peut pas être rétrogradé.
    pub fn set_member(&self, project: &str, user: &str, role: Role, add: bool) -> DbResult<Result<(), MemberError>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let current: Option<Role> = tx
            .query_row(
                "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
                [project, user],
                |r| r.get(0),
            )
            .optional()?;
        match current {
            None if !add => return Ok(Err(MemberError::NotMember)),
            Some(Role::Owner) if role != Role::Owner && owner_count(&tx, project)? <= 1 => {
                return Ok(Err(MemberError::LastOwner));
            }
            _ => {}
        }
        tx.execute(
            "INSERT OR REPLACE INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)",
            params![project, user, role.as_str()],
        )?;
        tx.commit()?;
        Ok(Ok(()))
    }

    /// Retire `user` du projet ; le dernier propriétaire ne peut pas être retiré.
    pub fn remove_member(&self, project: &str, user: &str) -> DbResult<Result<(), MemberError>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let current: Option<Role> = tx
            .query_row(
                "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
                [project, user],
                |r| r.get(0),
            )
            .optional()?;
        match current {
            None => return Ok(Err(MemberError::NotMember)),
            Some(Role::Owner) if owner_count(&tx, project)? <= 1 => return Ok(Err(MemberError::LastOwner)),
            _ => {}
        }
        tx.execute(
            "DELETE FROM project_members WHERE project_id = ? AND user_id = ?",
            [project, user],
        )?;
        tx.commit()?;
        Ok(Ok(()))
    }
}

fn owner_count(conn: &Connection, project: &str) -> DbResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM project_members WHERE project_id = ? AND role = 'owner'",
        [project],
        |r| r.get(0),
    )
}
