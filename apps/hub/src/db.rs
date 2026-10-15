//! Persistance SQLite : projets, fichiers (document courant), versions et vignettes.

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
];

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

    pub fn create_project(&self, name: &str) -> DbResult<Project> {
        let id = new_id();
        let now = now_ms();
        self.conn().execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
            params![id, name, now, now],
        )?;
        Ok(Project {
            id,
            name: name.to_string(),
            created_at: now,
            updated_at: now,
            file_count: 0,
        })
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
}
