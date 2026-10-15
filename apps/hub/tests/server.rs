// Tests d'intégration : le hub démarre sur un port libre avec une base temporaire.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use nyota_hub::{Config, run};
use reqwest::StatusCode;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

const TIMEOUT: Duration = Duration::from_secs(5);

struct Server {
    addr: SocketAddr,
    http: reqwest::Client,
    stop: Option<oneshot::Sender<()>>,
    handle: JoinHandle<()>,
}

async fn start(db: &Path, mcp_url: Option<String>) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let config = Config {
        port: addr.port(),
        db_path: db.to_path_buf(),
        static_dir: None,
        mcp_url,
        legacy_doc: Some(db.with_file_name("absent.json")),
    };
    let (tx, rx) = oneshot::channel::<()>();
    let handle = tokio::spawn(async move {
        run(config, listener, async move {
            let _ = rx.await;
        })
        .await
        .unwrap();
    });
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    Server {
        addr,
        http,
        stop: Some(tx),
        handle,
    }
}

impl Server {
    fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.addr)
    }

    async fn call(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut req = self.http.request(method.parse().unwrap(), self.url(path));
        if let Some(body) = body {
            req = req.json(&body);
        }
        let res = req.send().await.unwrap();
        let status = res.status();
        let text = res.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::String(text)))
    }

    async fn get(&self, path: &str) -> Value {
        let (status, body) = self.call("GET", path, None).await;
        assert_eq!(status, StatusCode::OK, "GET {path} : {body}");
        body
    }

    async fn send(&self, method: &str, path: &str, body: Value) -> Value {
        let (status, res) = self.call(method, path, Some(body)).await;
        assert_eq!(status, StatusCode::OK, "{method} {path} : {res}");
        res
    }

    async fn ws(&self, file: &str, user: &str) -> Ws {
        let url = format!("ws://{}/ws?file={file}&user={user}&name=Nom%20{user}", self.addr);
        let (stream, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        Ws { stream }
    }

    async fn stop(mut self) {
        let _ = self.stop.take().unwrap().send(());
        tokio::time::timeout(TIMEOUT, self.handle)
            .await
            .expect("arrêt du hub")
            .unwrap();
    }

    /// Crée un projet et un fichier vide ; renvoie l'id du fichier.
    async fn new_file(&self, name: &str) -> String {
        let project = self.send("POST", "/api/projects", json!({ "name": "Projet" })).await;
        let pid = project["id"].as_str().unwrap();
        let file = self
            .send("POST", &format!("/api/projects/{pid}/files"), json!({ "name": name }))
            .await;
        file["id"].as_str().unwrap().to_string()
    }
}

struct Ws {
    stream: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
}

impl Ws {
    async fn next(&mut self) -> Value {
        loop {
            let msg = tokio::time::timeout(TIMEOUT, self.stream.next())
                .await
                .expect("message attendu")
                .expect("connexion ouverte")
                .unwrap();
            if let Message::Text(t) = msg {
                return serde_json::from_str(t.as_str()).unwrap();
            }
        }
    }

    /// Prochain message du type donné (les autres sont ignorés).
    async fn next_of(&mut self, kind: &str) -> Value {
        loop {
            let msg = self.next().await;
            if msg["type"] == kind {
                return msg;
            }
        }
    }

    /// Prochain message autre que la présence.
    async fn next_event(&mut self) -> Value {
        loop {
            let msg = self.next().await;
            if msg["type"] != "presence" {
                return msg;
            }
        }
    }

    /// Attend un message de présence qui vérifie `pred`.
    async fn presence_until(&mut self, pred: impl Fn(&Value) -> bool) -> Value {
        loop {
            let msg = self.next_of("presence").await;
            if pred(&msg) {
                return msg;
            }
        }
    }

    async fn send(&mut self, msg: Value) {
        self.stream.send(Message::Text(msg.to_string().into())).await.unwrap();
    }

    /// Vérifie qu'aucun message hors présence n'arrive pendant un court délai.
    async fn assert_quiet(&mut self) {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(300);
        loop {
            match tokio::time::timeout_at(deadline, self.stream.next()).await {
                Err(_) => return,
                Ok(Some(Ok(Message::Text(t)))) => {
                    let v: Value = serde_json::from_str(t.as_str()).unwrap();
                    assert_eq!(v["type"], "presence", "message inattendu : {v}");
                }
                Ok(_) => {}
            }
        }
    }
}

fn temp_db() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sous-dossier").join("nyota.db");
    (dir, path)
}

fn rect(id: &str, parent: Option<&str>) -> Value {
    json!({ "id": id, "type": "rect", "name": id, "parentId": parent, "children": [], "x": 0, "y": 0, "text": null })
}

fn create(id: &str) -> Value {
    json!({ "kind": "create", "node": rect(id, None) })
}

#[tokio::test]
async fn projets_et_fichiers() {
    let (_dir, db) = temp_db();
    let s = start(&db, None).await;
    assert_eq!(s.get("/api/health").await, json!({ "ok": true }));

    // Premier démarrage : projet et fichier par défaut
    let projects = s.get("/api/projects").await;
    assert_eq!(projects.as_array().unwrap().len(), 1);
    assert_eq!(projects[0]["name"], "Mon premier projet");
    assert_eq!(projects[0]["fileCount"], 1);
    let first = projects[0]["id"].as_str().unwrap().to_string();
    let files = s.get(&format!("/api/projects/{first}/files")).await;
    assert_eq!(files[0]["name"], "Sans titre");

    // Création, renommage, ordre
    let p = s.send("POST", "/api/projects", json!({ "name": "Site" })).await;
    let pid = p["id"].as_str().unwrap().to_string();
    assert_eq!(p["fileCount"], 0);
    assert!(p["createdAt"].as_i64().unwrap() > 0);
    let p = s
        .send("PATCH", &format!("/api/projects/{pid}"), json!({ "name": "Site web" }))
        .await;
    assert_eq!(p["name"], "Site web");
    let projects = s.get("/api/projects").await;
    assert_eq!(projects[0]["id"], pid.as_str(), "le plus récemment modifié d'abord");

    let f = s
        .send(
            "POST",
            &format!("/api/projects/{pid}/files"),
            json!({ "name": "Accueil" }),
        )
        .await;
    let fid = f["id"].as_str().unwrap().to_string();
    assert_eq!(f["projectId"], pid.as_str());
    assert_eq!(f["hasThumbnail"], false);
    let got = s.get(&format!("/api/files/{fid}")).await;
    assert_eq!(got["file"]["name"], "Accueil");
    assert_eq!(got["version"], 0);
    assert_eq!(got["doc"]["name"], "Accueil");
    assert_eq!(got["doc"]["background"], "#F5F5F5");
    assert_eq!(got["doc"]["nodes"], json!({}));
    assert_eq!(got["doc"]["roots"], json!([]));
    assert!(got["doc"]["id"].is_string());

    // Fichier créé avec un document (clés inconnues conservées)
    let doc = json!({ "id": "d1", "name": "x", "background": "#000", "styles": { "a": 1 }, "nodes": { "n": rect("n", None) }, "roots": ["n"] });
    let f2 = s
        .send(
            "POST",
            &format!("/api/projects/{pid}/files"),
            json!({ "name": "Importé", "doc": doc }),
        )
        .await;
    let f2id = f2["id"].as_str().unwrap().to_string();
    let got = s.get(&format!("/api/files/{f2id}")).await;
    assert_eq!(got["doc"]["styles"], json!({ "a": 1 }));
    assert_eq!(got["doc"]["roots"], json!(["n"]));
    assert_eq!(got["doc"]["name"], "Importé");
    let files = s.get(&format!("/api/projects/{pid}/files")).await;
    assert_eq!(files.as_array().unwrap().len(), 2);
    assert_eq!(files[0]["id"], f2id.as_str(), "le plus récent d'abord");

    // Renommer change aussi le nom du document ; déplacer vers un autre projet
    let f = s
        .send("PATCH", &format!("/api/files/{fid}"), json!({ "name": "Accueil v2" }))
        .await;
    assert_eq!(f["name"], "Accueil v2");
    assert_eq!(s.get(&format!("/api/files/{fid}")).await["doc"]["name"], "Accueil v2");
    let f = s
        .send("PATCH", &format!("/api/files/{fid}"), json!({ "projectId": first }))
        .await;
    assert_eq!(f["projectId"], first.as_str());
    let (status, body) = s
        .call(
            "PATCH",
            &format!("/api/files/{fid}"),
            Some(json!({ "projectId": "nope" })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(body["error"].is_string());

    // Suppressions
    assert_eq!(
        s.send("DELETE", &format!("/api/files/{fid}"), json!({})).await,
        json!({ "ok": true })
    );
    let (status, body) = s.call("GET", &format!("/api/files/{fid}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"], "Fichier introuvable");
    assert_eq!(
        s.send("DELETE", &format!("/api/projects/{pid}"), json!({})).await,
        json!({ "ok": true })
    );
    let (status, _) = s.call("GET", &format!("/api/files/{f2id}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "les fichiers du projet sont supprimés");
    let (status, _) = s.call("GET", &format!("/api/projects/{pid}/files"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, body) = s.call("GET", "/api/inconnu", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(body["error"].is_string());
    s.stop().await;
}

#[tokio::test]
async fn operations_rest_duplication_et_vignette() {
    let (_dir, db) = temp_db();
    let s = start(&db, None).await;
    let fid = s.new_file("Écran").await;
    let ops_path = format!("/api/files/{fid}/ops");

    let res = s
        .send(
            "POST",
            &ops_path,
            json!({ "ops": [create("a"), create("b")], "label": "Créer", "author": "ai" }),
        )
        .await;
    assert_eq!(res, json!({ "ok": true, "version": 1 }));
    let res = s
        .send(
            "POST",
            &ops_path,
            json!({ "ops": [{ "kind": "update", "id": "a", "props": { "x": 42 } }], "author": "mcp" }),
        )
        .await;
    assert_eq!(res["version"], 2);
    let got = s.get(&format!("/api/files/{fid}")).await;
    assert_eq!(got["version"], 2);
    assert_eq!(got["doc"]["roots"], json!(["a", "b"]));
    assert_eq!(got["doc"]["nodes"]["a"]["x"], 42);

    // Lot invalide : erreur du cœur, rien n'est gardé
    let (status, body) = s
        .call(
            "POST",
            &ops_path,
            Some(json!({ "ops": [{ "kind": "update", "id": "a", "props": { "x": 1 } }, { "kind": "delete", "id": "zz" }] })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "Nœud introuvable : zz");
    let got = s.get(&format!("/api/files/{fid}")).await;
    assert_eq!(got["version"], 2);
    assert_eq!(got["doc"]["nodes"]["a"]["x"], 42);
    let (status, _) = s
        .call("POST", &ops_path, Some(json!({ "ops": [], "author": "robot" })))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = s.call("POST", &ops_path, Some(json!({ "ops": "non" }))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Vignette
    let (status, _) = s.call("GET", &format!("/api/files/{fid}/thumbnail"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let res = s
        .send(
            "PUT",
            &format!("/api/files/{fid}/thumbnail"),
            json!({ "dataUrl": "data:image/png;base64,iVBORw0KGgo=" }),
        )
        .await;
    assert_eq!(res, json!({ "ok": true }));
    let res = s
        .http
        .get(s.url(&format!("/api/files/{fid}/thumbnail")))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["content-type"], "image/png");
    assert_eq!(
        res.bytes().await.unwrap().as_ref(),
        &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]
    );
    let (status, _) = s
        .call(
            "PUT",
            &format!("/api/files/{fid}/thumbnail"),
            Some(json!({ "dataUrl": "pas une image" })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Duplication
    let copy = s.send("POST", &format!("/api/files/{fid}/duplicate"), json!({})).await;
    assert_eq!(copy["name"], "Écran (copie)");
    assert_eq!(copy["hasThumbnail"], true);
    let original = s.get(&format!("/api/files/{fid}")).await;
    assert_eq!(original["file"]["hasThumbnail"], true);
    assert_eq!(copy["projectId"], original["file"]["projectId"]);
    let cid = copy["id"].as_str().unwrap();
    assert_ne!(cid, fid);
    let dup = s.get(&format!("/api/files/{cid}")).await;
    assert_eq!(dup["doc"]["nodes"], original["doc"]["nodes"]);
    assert_eq!(dup["doc"]["name"], "Écran (copie)");
    assert_ne!(dup["doc"]["id"], original["doc"]["id"]);

    // Événement IA sans éditeur connecté : accepté
    let res = s
        .send(
            "POST",
            &format!("/api/files/{fid}/events"),
            json!({ "event": { "kind": "start", "jobId": "j" } }),
        )
        .await;
    assert_eq!(res, json!({ "ok": true }));
    s.stop().await;
}

#[tokio::test]
async fn versions_et_restauration() {
    let (_dir, db) = temp_db();
    let s = start(&db, None).await;
    let fid = s.new_file("Versions").await;
    s.send(
        "POST",
        &format!("/api/files/{fid}/ops"),
        json!({ "ops": [create("a")] }),
    )
    .await;
    let v1 = s
        .send("POST", &format!("/api/files/{fid}/versions"), json!({ "label": "V1" }))
        .await;
    assert_eq!(v1["label"], "V1");
    assert_eq!(v1["fileId"], fid.as_str());
    assert_eq!(v1["nodeCount"], 1);
    let vid = v1["id"].as_str().unwrap();
    s.send(
        "POST",
        &format!("/api/files/{fid}/ops"),
        json!({ "ops": [create("b"), create("c")], "origin": "x" }),
    )
    .await;

    let mut ws = s.ws(&fid, "u1").await;
    assert_eq!(ws.next_of("doc").await["doc"]["roots"], json!(["a", "b", "c"]));

    let res = s
        .send("POST", &format!("/api/files/{fid}/versions/{vid}/restore"), json!({}))
        .await;
    assert_eq!(res["ok"], true);
    let version = res["version"].as_u64().unwrap();
    assert_eq!(version, 3);
    let doc = ws.next_event().await;
    assert_eq!(doc["type"], "doc");
    assert_eq!(doc["version"], version);
    assert_eq!(doc["doc"]["roots"], json!(["a"]));
    let got = s.get(&format!("/api/files/{fid}")).await;
    assert_eq!(got["doc"]["roots"], json!(["a"]));

    // Les piles d'annulation sont vidées : annuler ne fait rien
    ws.send(json!({ "type": "undo" })).await;
    ws.assert_quiet().await;

    let versions = s.get(&format!("/api/files/{fid}/versions")).await;
    let labels: Vec<&str> = versions
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["label"].as_str().unwrap())
        .filter(|l| *l != "Sauvegarde automatique")
        .collect();
    assert_eq!(labels, vec!["Avant restauration", "V1"]);
    let before = versions
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["label"] == "Avant restauration")
        .unwrap();
    assert_eq!(before["nodeCount"], 3);

    let (status, body) = s
        .call("POST", &format!("/api/files/{fid}/versions/inconnue/restore"), None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"], "Version introuvable");
    s.stop().await;
}

#[tokio::test]
async fn collaboration_websocket() {
    let (_dir, db) = temp_db();
    let s = start(&db, None).await;
    let fid = s.new_file("Collab").await;
    let mut a = s.ws(&fid, "A").await;
    let mut b = s.ws(&fid, "B").await;
    let doc = a.next_of("doc").await;
    assert_eq!(doc["version"], 0);
    b.next_of("doc").await;

    // Chacun reçoit les lots de l'autre (et les siens), version croissante
    a.send(json!({ "type": "ops", "ops": [create("na")], "label": "Créer A", "origin": "A" }))
        .await;
    for ws in [&mut a, &mut b] {
        let m = ws.next_event().await;
        assert_eq!(m["type"], "ops");
        assert_eq!(m["version"], 1);
        assert_eq!(m["origin"], "A");
        assert_eq!(m["author"], "human");
        assert_eq!(m["label"], "Créer A");
        assert_eq!(m["ops"][0]["node"]["id"], "na");
    }
    b.send(json!({ "type": "ops", "ops": [create("nb")], "origin": "B" }))
        .await;
    for ws in [&mut a, &mut b] {
        let m = ws.next_event().await;
        assert_eq!(m["version"], 2);
        assert_eq!(m["origin"], "B");
    }

    // A annule : seul son lot est défait
    a.send(json!({ "type": "undo" })).await;
    for ws in [&mut a, &mut b] {
        let m = ws.next_event().await;
        assert_eq!(m["type"], "ops");
        assert_eq!(m["version"], 3);
        assert_eq!(m["origin"], "A");
        assert_eq!(m["ops"], json!([{ "kind": "delete", "id": "na" }]));
    }
    let got = s.get(&format!("/api/files/{fid}")).await;
    assert_eq!(got["doc"]["roots"], json!(["nb"]));
    // Plus rien à annuler pour A ; B garde le sien
    a.send(json!({ "type": "undo" })).await;
    a.assert_quiet().await;

    a.send(json!({ "type": "redo" })).await;
    for ws in [&mut a, &mut b] {
        let m = ws.next_event().await;
        assert_eq!(m["version"], 4);
        assert_eq!(m["ops"][0]["kind"], "create");
    }
    let got = s.get(&format!("/api/files/{fid}")).await;
    assert_eq!(got["doc"]["roots"], json!(["nb", "na"]));

    b.send(json!({ "type": "undo" })).await;
    for ws in [&mut a, &mut b] {
        let m = ws.next_event().await;
        assert_eq!(m["version"], 5);
        assert_eq!(m["origin"], "B");
    }
    let got = s.get(&format!("/api/files/{fid}")).await;
    assert_eq!(got["doc"]["roots"], json!(["na"]));

    // Lot invalide : error puis doc pour l'émetteur seulement
    b.send(json!({ "type": "ops", "ops": [create("x"), { "kind": "delete", "id": "zz" }], "origin": "B" }))
        .await;
    let m = b.next_event().await;
    assert_eq!(m["type"], "error");
    assert_eq!(m["message"], "Nœud introuvable : zz");
    let m = b.next_event().await;
    assert_eq!(m["type"], "doc");
    assert_eq!(m["version"], 5);
    assert_eq!(m["doc"]["roots"], json!(["na"]));
    a.assert_quiet().await;

    // Annulation impossible : le document a changé entre-temps
    b.send(json!({ "type": "ops", "ops": [{ "kind": "delete", "id": "na" }], "origin": "B" }))
        .await;
    for ws in [&mut a, &mut b] {
        assert_eq!(ws.next_event().await["version"], 6);
    }
    a.send(json!({ "type": "undo" })).await;
    let m = a.next_event().await;
    assert_eq!(m["type"], "error");
    assert_eq!(m["message"], "Impossible d'annuler : Nœud introuvable : na");
    assert_eq!(a.next_event().await["type"], "doc");

    // Lot REST : diffusé aux éditeurs, avec l'auteur
    s.send(
        "POST",
        &format!("/api/files/{fid}/ops"),
        json!({ "ops": [create("m")], "author": "mcp", "label": "MCP", "origin": "agent" }),
    )
    .await;
    for ws in [&mut a, &mut b] {
        let m = ws.next_event().await;
        assert_eq!(m["author"], "mcp");
        assert_eq!(m["origin"], "agent");
        assert_eq!(m["version"], 7);
    }
    a.presence_until(|p| p["mcpLastSeen"].is_i64()).await;

    // Événement IA relayé
    s.send(
        "POST",
        &format!("/api/files/{fid}/events"),
        json!({ "event": { "kind": "thinking", "jobId": "j", "text": "…" } }),
    )
    .await;
    let m = b.next_event().await;
    assert_eq!(
        m,
        json!({ "type": "ai", "event": { "kind": "thinking", "jobId": "j", "text": "…" } })
    );
    s.stop().await;
}

#[tokio::test]
async fn presence() {
    let (_dir, db) = temp_db();
    let s = start(&db, None).await;
    let fid = s.new_file("Présence").await;
    let mut a = s.ws(&fid, "A").await;
    a.next_of("doc").await;
    let mut b = s.ws(&fid, "B").await;
    b.next_of("doc").await;

    let p = a.presence_until(|p| p["users"].as_array().unwrap().len() == 2).await;
    let users = p["users"].as_array().unwrap();
    assert_eq!(users[0]["id"], "A");
    assert_eq!(users[0]["name"], "Nom A");
    assert_eq!(users[1]["id"], "B");
    assert!(users[0]["color"].is_string());
    assert_ne!(users[0]["color"], users[1]["color"]);
    assert_eq!(users[0]["selection"], json!([]));
    assert_eq!(users[0]["cursor"], Value::Null);
    assert!(p.get("mcpLastSeen").is_some());

    a.send(json!({ "type": "selection", "ids": ["n1", "n2"] })).await;
    a.send(json!({ "type": "cursor", "x": 10.5, "y": 20 })).await;
    let p = b
        .presence_until(|p| p["users"][0]["selection"] == json!(["n1", "n2"]) && p["users"][0]["cursor"]["x"] == 10.5)
        .await;
    assert_eq!(p["users"][0]["cursor"]["y"], 20.0);
    a.send(json!({ "type": "cursor", "x": null, "y": null })).await;
    b.presence_until(|p| p["users"][0]["cursor"].is_null()).await;

    // Départ
    drop(a);
    b.presence_until(|p| p["users"].as_array().unwrap().len() == 1 && p["users"][0]["id"] == "B")
        .await;

    // Fichier introuvable
    let mut x = s.ws("inconnu", "C").await;
    let m = x.next().await;
    assert_eq!(m["type"], "error");
    s.stop().await;
}

#[tokio::test]
async fn persistance() {
    let (_dir, db) = temp_db();
    let s = start(&db, None).await;
    let fid = s.new_file("Persistant").await;
    let mut a = s.ws(&fid, "A").await;
    a.next_of("doc").await;
    a.send(json!({ "type": "ops", "ops": [create("p1")], "origin": "A" }))
        .await;
    assert_eq!(a.next_event().await["version"], 1);

    // Sauvegarde différée : au plus tard 1 s après la modification
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let other = nyota_hub::db::Db::open(&db).unwrap();
    let (doc, version) = other.file_doc(&fid).unwrap().unwrap();
    assert_eq!(doc["roots"], json!(["p1"]));
    assert_eq!(version, 1);
    // Premier enregistrement : instantané automatique
    let versions = other.versions(&fid).unwrap();
    assert!(versions.iter().any(|v| v.label == "Sauvegarde automatique"));
    drop(other);

    // Modification juste avant l'arrêt : sauvegardée à l'arrêt
    a.send(json!({ "type": "ops", "ops": [create("p2")], "origin": "A" }))
        .await;
    assert_eq!(a.next_event().await["version"], 2);
    s.stop().await;

    let s = start(&db, None).await;
    let got = s.get(&format!("/api/files/{fid}")).await;
    assert_eq!(got["doc"]["roots"], json!(["p1", "p2"]));
    assert_eq!(got["version"], 2);
    assert_eq!(
        s.get("/api/projects").await.as_array().unwrap().len(),
        2,
        "pas de nouveau projet par défaut"
    );
    let mut b = s.ws(&fid, "B").await;
    let doc = b.next_of("doc").await;
    assert_eq!(doc["version"], 2);
    assert_eq!(doc["doc"]["nodes"]["p2"]["id"], "p2");
    s.stop().await;
}

#[tokio::test]
async fn relais_mcp() {
    use axum::routing::any;
    // Service MCP/IA factice : renvoie méthode, chemin, en-tête et corps
    let upstream = axum::Router::new().fallback(any(|req: axum::extract::Request| async move {
        let method = req.method().to_string();
        let uri = req.uri().to_string();
        let marker = req.headers().get("x-test").map(|v| v.to_str().unwrap().to_string());
        let body = axum::body::to_bytes(req.into_body(), usize::MAX).await.unwrap();
        (
            [("x-upstream", "1")],
            axum::Json(
                json!({ "method": method, "uri": uri, "marker": marker, "body": String::from_utf8_lossy(&body) }),
            ),
        )
    }));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let up = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });

    let (_dir, db) = temp_db();
    let s = start(&db, Some(format!("http://{up}/"))).await;
    let res = s
        .http
        .post(s.url("/mcp"))
        .header("x-test", "oui")
        .body("{\"jsonrpc\":\"2.0\"}")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["x-upstream"], "1");
    let body: Value = res.json().await.unwrap();
    assert_eq!(
        body,
        json!({ "method": "POST", "uri": "/mcp", "marker": "oui", "body": "{\"jsonrpc\":\"2.0\"}" })
    );
    let body = s.get("/api/ai/design?x=1").await;
    assert_eq!(body["method"], "GET");
    assert_eq!(body["uri"], "/api/ai/design?x=1");
    s.stop().await;

    // Sans NYOTA_MCP_URL : 503
    let (_dir2, db2) = temp_db();
    let s = start(&db2, None).await;
    let (status, body) = s.call("POST", "/mcp", Some(json!({}))).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body, json!({ "error": "Service MCP/IA non configuré" }));
    let (status, _) = s.call("POST", "/api/ai/design", Some(json!({}))).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    s.stop().await;
}

#[tokio::test]
async fn fichier_actif_et_presence_rest() {
    let (_dir, db) = temp_db();
    let s = start(&db, None).await;
    // Le projet par défaut a déjà un fichier, mais rien n'est encore ouvert
    let (status, _) = s.call("GET", "/api/active-file", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let fid = s.new_file("Actif").await;
    let mut a = s.ws(&fid, "A").await;
    a.next_of("doc").await;
    assert_eq!(s.get("/api/active-file").await["file"]["id"], fid.as_str());

    a.send(json!({ "type": "selection", "ids": ["x1"] })).await;
    a.presence_until(|p| p["users"][0]["selection"] == json!(["x1"])).await;
    let p = s.get(&format!("/api/files/{fid}/presence")).await;
    assert_eq!(p["users"][0]["id"], "A");
    assert_eq!(p["users"][0]["selection"], json!(["x1"]));

    // Un lot REST sur un autre fichier en fait le fichier actif
    let other = s.new_file("Autre").await;
    s.send(
        "POST",
        &format!("/api/files/{other}/ops"),
        json!({ "ops": [create("r1")], "author": "mcp" }),
    )
    .await;
    assert_eq!(s.get("/api/active-file").await["file"]["id"], other.as_str());
    let (status, _) = s.call("GET", "/api/files/inconnu/presence", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    s.stop().await;
}
