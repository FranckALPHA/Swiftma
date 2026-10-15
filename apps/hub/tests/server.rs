// Tests d'intégration : le hub démarre sur un port libre avec une base temporaire.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use swiftma_hub::{Config, run};
use reqwest::StatusCode;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

const TIMEOUT: Duration = Duration::from_secs(5);
const PASSWORD: &str = "motdepasse";
const ADMIN: &str = "admin@swiftma.test";
const READ_ONLY: &str = "Lecture seule : tu n'as pas les droits de modification sur ce projet";

/// Client HTTP/WebSocket identifié (cookie de session ou jeton), ou anonyme.
#[derive(Clone)]
struct Api {
    addr: SocketAddr,
    http: reqwest::Client,
    /// En-tête d'identification : (`cookie` ou `authorization`, valeur).
    auth: Option<(&'static str, String)>,
}

struct Server {
    api: Api,
    stop: Option<oneshot::Sender<()>>,
    handle: JoinHandle<()>,
}

impl std::ops::Deref for Server {
    type Target = Api;
    fn deref(&self) -> &Api {
        &self.api
    }
}

/// Démarre le hub sans se connecter.
async fn start_bare(db: &Path, mcp_url: Option<String>, signup_open: bool) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let config = Config {
        port: addr.port(),
        db_path: db.to_path_buf(),
        static_dir: None,
        mcp_url,
        legacy_doc: Some(db.with_file_name("absent.json")),
        signup_open,
        secure_cookies: false,
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
        api: Api { addr, http, auth: None },
        stop: Some(tx),
        handle,
    }
}

/// Démarre le hub et s'identifie avec le compte administrateur (créé au besoin : premier compte).
async fn start(db: &Path, mcp_url: Option<String>) -> Server {
    let mut s = start_bare(db, mcp_url, true).await;
    let config = s.get("/api/auth/config").await;
    s.api = if config["hasUsers"] == true {
        s.login(ADMIN, PASSWORD).await
    } else {
        s.register(ADMIN, "Admin").await
    };
    s
}

/// Valeur `swiftma_session=…` d'une réponse.
fn session_cookie(res: &reqwest::Response) -> String {
    let set = res.headers()["set-cookie"].to_str().unwrap();
    set.split(';').next().unwrap().trim().to_string()
}

impl Api {
    fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.addr)
    }

    fn anon(&self) -> Api {
        Api {
            auth: None,
            ..self.clone()
        }
    }

    fn with_cookie(&self, cookie: &str) -> Api {
        Api {
            auth: Some(("cookie", cookie.to_string())),
            ..self.clone()
        }
    }

    fn with_bearer(&self, token: &str) -> Api {
        Api {
            auth: Some(("authorization", format!("Bearer {token}"))),
            ..self.clone()
        }
    }

    fn request(&self, method: &str, path: &str) -> reqwest::RequestBuilder {
        let mut req = self.http.request(method.parse().unwrap(), self.url(path));
        if let Some((name, value)) = &self.auth {
            req = req.header(*name, value);
        }
        req
    }

    async fn call(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut req = self.request(method, path);
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

    /// Vérifie le statut et le message d'erreur d'un appel.
    async fn fails(&self, method: &str, path: &str, body: Option<Value>, status: StatusCode, message: &str) {
        let (got, res) = self.call(method, path, body).await;
        assert_eq!(got, status, "{method} {path} : {res}");
        assert_eq!(res["error"], message, "{method} {path}");
    }

    /// Crée un compte et renvoie un client identifié par son cookie.
    async fn register(&self, email: &str, name: &str) -> Api {
        let res = self
            .anon()
            .request("POST", "/api/auth/register")
            .json(&json!({ "email": email, "name": name, "password": PASSWORD }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK, "inscription de {email}");
        let cookie = session_cookie(&res);
        self.with_cookie(&cookie)
    }

    async fn login(&self, email: &str, password: &str) -> Api {
        let res = self
            .anon()
            .request("POST", "/api/auth/login")
            .json(&json!({ "email": email, "password": password }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK, "connexion de {email}");
        let cookie = session_cookie(&res);
        self.with_cookie(&cookie)
    }

    async fn me(&self) -> Value {
        self.get("/api/auth/me").await
    }

    fn ws_request(&self, file: &str, user: &str) -> tokio_tungstenite::tungstenite::handshake::client::Request {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let url = format!("ws://{}/ws?file={file}&user={user}&name=Ignor%C3%A9", self.addr);
        let mut req = url.into_client_request().unwrap();
        if let Some((name, value)) = &self.auth {
            req.headers_mut().insert(*name, value.parse().unwrap());
        }
        req
    }

    async fn ws(&self, file: &str, user: &str) -> Ws {
        let (stream, _) = tokio_tungstenite::connect_async(self.ws_request(file, user))
            .await
            .unwrap();
        Ws { stream }
    }

    /// Statut HTTP d'une connexion WebSocket refusée avant l'upgrade.
    async fn ws_refused(&self, file: &str, user: &str) -> StatusCode {
        match tokio_tungstenite::connect_async(self.ws_request(file, user)).await {
            Err(tokio_tungstenite::tungstenite::Error::Http(res)) => {
                StatusCode::from_u16(res.status().as_u16()).unwrap()
            }
            Err(e) => panic!("erreur inattendue : {e}"),
            Ok(_) => panic!("connexion acceptée"),
        }
    }

    /// Crée un projet ; renvoie son id.
    async fn new_project(&self, name: &str) -> String {
        let project = self.send("POST", "/api/projects", json!({ "name": name })).await;
        project["id"].as_str().unwrap().to_string()
    }

    /// Crée un fichier vide dans un projet ; renvoie son id.
    async fn new_file_in(&self, pid: &str, name: &str) -> String {
        let file = self
            .send("POST", &format!("/api/projects/{pid}/files"), json!({ "name": name }))
            .await;
        file["id"].as_str().unwrap().to_string()
    }

    /// Crée un projet et un fichier vide ; renvoie l'id du fichier.
    async fn new_file(&self, name: &str) -> String {
        let pid = self.new_project("Projet").await;
        self.new_file_in(&pid, name).await
    }
}

impl Server {
    async fn stop(mut self) {
        let _ = self.stop.take().unwrap().send(());
        tokio::time::timeout(TIMEOUT, self.handle)
            .await
            .expect("arrêt du hub")
            .unwrap();
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
    let path = dir.path().join("sous-dossier").join("swiftma.db");
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
        .request("GET", &format!("/api/files/{fid}/thumbnail"))
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
    // Nom du compte (le paramètre `name` est ignoré) et id du compte
    let me = s.me().await;
    assert_eq!(users[0]["name"], "Admin");
    assert_eq!(users[0]["userId"], me["id"]);
    assert_eq!(users[1]["id"], "B");
    assert_eq!(users[1]["userId"], me["id"]);
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
    assert_eq!(m, json!({ "type": "error", "message": "Fichier introuvable" }));
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
    let other = swiftma_hub::db::Db::open(&db).unwrap();
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
        let (marker, cookie, authorization) = {
            let header = |name: &str| req.headers().get(name).map(|v| v.to_str().unwrap().to_string());
            (header("x-test"), header("cookie"), header("authorization"))
        };
        let body = axum::body::to_bytes(req.into_body(), usize::MAX).await.unwrap();
        (
            [("x-upstream", "1")],
            axum::Json(json!({
                "method": method, "uri": uri, "marker": marker, "body": String::from_utf8_lossy(&body),
                "cookie": cookie, "authorization": authorization,
            })),
        )
    }));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let up = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });

    let (_dir, db) = temp_db();
    let s = start(&db, Some(format!("http://{up}/"))).await;
    let res = s
        .request("POST", "/mcp")
        .header("x-test", "oui")
        .body("{\"jsonrpc\":\"2.0\"}")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["x-upstream"], "1");
    let body: Value = res.json().await.unwrap();
    let cookie = s.auth.as_ref().unwrap().1.clone();
    assert_eq!(
        body,
        json!({ "method": "POST", "uri": "/mcp", "marker": "oui", "body": "{\"jsonrpc\":\"2.0\"}",
                "cookie": cookie, "authorization": null })
    );
    let body = s.get("/api/ai/design?x=1").await;
    assert_eq!(body["method"], "GET");
    assert_eq!(body["uri"], "/api/ai/design?x=1");
    assert_eq!(body["cookie"], cookie.as_str(), "cookie d'origine relayé");

    // Avec un jeton : l'en-tête Authorization est relayé tel quel
    let token = s.send("POST", "/api/auth/tokens", json!({ "name": "MCP" })).await;
    let token = token["token"].as_str().unwrap().to_string();
    let bearer = s.with_bearer(&token);
    let body = bearer.send("POST", "/mcp", json!({})).await;
    assert_eq!(body["authorization"], format!("Bearer {token}"));
    assert_eq!(body["cookie"], Value::Null);

    // Sans identification (ou identification invalide) : 401, rien n'est relayé
    for path in ["/mcp", "/mcp/sse", "/api/ai/design"] {
        s.anon()
            .fails(
                "POST",
                path,
                Some(json!({})),
                StatusCode::UNAUTHORIZED,
                "Connexion requise",
            )
            .await;
        s.with_bearer("swiftma_faux")
            .fails(
                "POST",
                path,
                Some(json!({})),
                StatusCode::UNAUTHORIZED,
                "Connexion requise",
            )
            .await;
    }
    s.stop().await;

    // Sans SWIFTMA_MCP_URL : 503
    let (_dir2, db2) = temp_db();
    let s = start(&db2, None).await;
    let (status, _) = s.anon().call("POST", "/mcp", Some(json!({}))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
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

// --- Comptes et droits d'accès ---

#[tokio::test]
async fn inscription_connexion_deconnexion() {
    let (_dir, db) = temp_db();
    let s = start_bare(&db, None, true).await;
    assert_eq!(s.get("/api/health").await, json!({ "ok": true }));
    assert_eq!(
        s.get("/api/auth/config").await,
        json!({ "signup": true, "hasUsers": false })
    );

    // Tout le reste exige une personne connectée
    for (method, path) in [
        ("GET", "/api/projects"),
        ("POST", "/api/projects"),
        ("GET", "/api/auth/me"),
        ("GET", "/api/auth/tokens"),
        ("GET", "/api/active-file"),
        ("GET", "/api/admin/users"),
        ("GET", "/api/inconnu"),
    ] {
        s.fails(method, path, None, StatusCode::UNAUTHORIZED, "Connexion requise")
            .await;
    }
    assert_eq!(s.ws_refused("x", "A").await, StatusCode::UNAUTHORIZED);
    let faux = s.with_cookie("swiftma_session=inconnue");
    faux.fails(
        "GET",
        "/api/auth/me",
        None,
        StatusCode::UNAUTHORIZED,
        "Connexion requise",
    )
    .await;

    // Validation
    let register = |email: &str, password: &str| json!({ "email": email, "name": "X", "password": password });
    s.fails(
        "POST",
        "/api/auth/register",
        Some(register("a@b.fr", "court")),
        StatusCode::BAD_REQUEST,
        "Mot de passe trop court (8 caractères minimum)",
    )
    .await;
    let (status, _) = s
        .call("POST", "/api/auth/register", Some(register("sans-arobase", PASSWORD)))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Inscription : User + cookie de session
    let res = s
        .request("POST", "/api/auth/register")
        .json(&json!({ "email": "  Ana@Exemple.FR ", "name": "Ana", "password": PASSWORD }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let set = res.headers()["set-cookie"].to_str().unwrap().to_string();
    assert!(set.starts_with("swiftma_session="), "{set}");
    for attr in ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=2592000"] {
        assert!(set.contains(attr), "{set} : {attr}");
    }
    assert!(!set.contains("Secure"), "pas de Secure par défaut");
    let ana = s.with_cookie(&session_cookie(&res));
    let user: Value = res.json().await.unwrap();
    assert_eq!(user["email"], "ana@exemple.fr");
    assert_eq!(user["name"], "Ana");
    assert_eq!(user["isAdmin"], true, "premier compte : administrateur");
    assert!(user["createdAt"].as_i64().unwrap() > 0);
    assert!(user["id"].is_string());
    assert!(user.get("passwordHash").is_none() && user.get("password").is_none());
    assert_eq!(ana.me().await, user);
    assert_eq!(
        s.get("/api/auth/config").await,
        json!({ "signup": true, "hasUsers": true })
    );

    // Adresse déjà prise (casse et espaces ignorés)
    s.fails(
        "POST",
        "/api/auth/register",
        Some(register("ANA@exemple.fr", PASSWORD)),
        StatusCode::CONFLICT,
        "Un compte existe déjà avec cette adresse",
    )
    .await;

    // Deuxième compte : pas administrateur
    let bob = s.register("bob@exemple.fr", "Bob").await;
    assert_eq!(bob.me().await["isAdmin"], false);

    // Connexion : mauvaise adresse ou mauvais mot de passe → même message
    for body in [
        json!({ "email": "ana@exemple.fr", "password": "mauvais-mdp" }),
        json!({ "email": "personne@exemple.fr", "password": PASSWORD }),
        json!({}),
    ] {
        s.fails(
            "POST",
            "/api/auth/login",
            Some(body),
            StatusCode::UNAUTHORIZED,
            "Email ou mot de passe incorrect",
        )
        .await;
    }
    let ana2 = s.login(" ANA@exemple.fr", PASSWORD).await;
    assert_eq!(ana2.me().await["id"], user["id"]);
    assert_ne!(ana2.auth, ana.auth, "nouvelle session");

    // Déconnexion : session supprimée, cookie effacé ; l'autre session reste valide
    let res = ana.request("POST", "/api/auth/logout").send().await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let set = res.headers()["set-cookie"].to_str().unwrap().to_string();
    assert!(set.starts_with("swiftma_session=;") && set.contains("Max-Age=0"), "{set}");
    assert_eq!(res.json::<Value>().await.unwrap(), json!({ "ok": true }));
    ana.fails(
        "GET",
        "/api/auth/me",
        None,
        StatusCode::UNAUTHORIZED,
        "Connexion requise",
    )
    .await;
    assert_eq!(ana2.me().await["id"], user["id"]);

    // Changer de nom
    let me = ana2.send("PATCH", "/api/auth/me", json!({ "name": "Ana B." })).await;
    assert_eq!(me["name"], "Ana B.");

    // Le cookie l'emporte… sauf si un en-tête Authorization (invalide ici) est présent
    let res = ana2
        .request("GET", "/api/auth/me")
        .header("authorization", "Bearer swiftma_invalide")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    s.stop().await;
}

#[tokio::test]
async fn limitation_des_tentatives() {
    let (_dir, db) = temp_db();
    let s = start(&db, None).await;
    s.register("cible@exemple.fr", "Cible").await;
    let login = |password: &str| json!({ "email": "cible@exemple.fr", "password": password });
    for _ in 0..5 {
        s.anon()
            .fails(
                "POST",
                "/api/auth/login",
                Some(login("mauvais-mdp")),
                StatusCode::UNAUTHORIZED,
                "Email ou mot de passe incorrect",
            )
            .await;
    }
    // Même avec le bon mot de passe, et quelle que soit la casse de l'adresse
    for email in ["cible@exemple.fr", "CIBLE@exemple.fr "] {
        s.anon()
            .fails(
                "POST",
                "/api/auth/login",
                Some(json!({ "email": email, "password": PASSWORD })),
                StatusCode::TOO_MANY_REQUESTS,
                "Trop de tentatives, réessaie dans quelques minutes",
            )
            .await;
    }
    // Les autres adresses ne sont pas touchées
    s.login(ADMIN, PASSWORD).await;

    // Un succès avant la limite remet le compteur à zéro
    s.register("autre@exemple.fr", "Autre").await;
    for _ in 0..4 {
        let (status, _) = s
            .anon()
            .call(
                "POST",
                "/api/auth/login",
                Some(json!({ "email": "autre@exemple.fr", "password": "faux-faux" })),
            )
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    s.login("autre@exemple.fr", PASSWORD).await;
    let (status, _) = s
        .anon()
        .call(
            "POST",
            "/api/auth/login",
            Some(json!({ "email": "autre@exemple.fr", "password": "faux-faux" })),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    s.login("autre@exemple.fr", PASSWORD).await;
    s.stop().await;
}

#[tokio::test]
async fn inscriptions_fermees_et_administration() {
    let (_dir, db) = temp_db();
    let s = start_bare(&db, None, false).await;
    // Amorçage : le premier compte peut s'inscrire
    assert_eq!(
        s.get("/api/auth/config").await,
        json!({ "signup": true, "hasUsers": false })
    );
    let admin = s.register(ADMIN, "Admin").await;
    assert_eq!(admin.me().await["isAdmin"], true);
    assert_eq!(
        s.get("/api/auth/config").await,
        json!({ "signup": false, "hasUsers": true })
    );
    s.fails(
        "POST",
        "/api/auth/register",
        Some(json!({ "email": "b@exemple.fr", "name": "B", "password": PASSWORD })),
        StatusCode::FORBIDDEN,
        "Inscriptions fermées : demande un compte à l'administrateur",
    )
    .await;

    // L'administrateur crée des comptes
    let created = admin
        .send(
            "POST",
            "/api/admin/users",
            json!({ "email": "B@exemple.fr", "name": "Béa", "password": PASSWORD }),
        )
        .await;
    assert_eq!(created["email"], "b@exemple.fr");
    assert_eq!(created["isAdmin"], false);
    let other_admin = admin
        .send(
            "POST",
            "/api/admin/users",
            json!({ "email": "c@exemple.fr", "name": "C", "password": PASSWORD, "isAdmin": true }),
        )
        .await;
    assert_eq!(other_admin["isAdmin"], true);
    admin
        .fails(
            "POST",
            "/api/admin/users",
            Some(json!({ "email": "b@exemple.fr", "name": "B", "password": PASSWORD })),
            StatusCode::CONFLICT,
            "Un compte existe déjà avec cette adresse",
        )
        .await;
    let users = admin.get("/api/admin/users").await;
    let emails: Vec<&str> = users
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["email"].as_str().unwrap())
        .collect();
    assert_eq!(emails, vec![ADMIN, "b@exemple.fr", "c@exemple.fr"]);

    // Le compte créé se connecte ; il n'est pas administrateur
    let bea = s.login("b@exemple.fr", PASSWORD).await;
    assert_eq!(bea.me().await["name"], "Béa");
    bea.fails(
        "GET",
        "/api/admin/users",
        None,
        StatusCode::FORBIDDEN,
        "Réservé à l'administrateur",
    )
    .await;
    bea.fails(
        "POST",
        "/api/admin/users",
        Some(json!({ "email": "d@exemple.fr", "name": "D", "password": PASSWORD })),
        StatusCode::FORBIDDEN,
        "Réservé à l'administrateur",
    )
    .await;
    // Pas de droits particuliers de l'administrateur sur les projets des autres
    let pid = bea.new_project("Privé").await;
    admin
        .fails(
            "GET",
            &format!("/api/projects/{pid}/files"),
            None,
            StatusCode::NOT_FOUND,
            "Projet introuvable",
        )
        .await;
    s.stop().await;
}

#[tokio::test]
async fn premier_compte_recupere_le_projet_par_defaut() {
    let (_dir, db) = temp_db();
    let s = start(&db, None).await;
    let projects = s.get("/api/projects").await;
    assert_eq!(projects.as_array().unwrap().len(), 1);
    assert_eq!(projects[0]["name"], "Mon premier projet");
    assert_eq!(projects[0]["role"], "owner");
    let pid = projects[0]["id"].as_str().unwrap().to_string();
    let members = s.get(&format!("/api/projects/{pid}/members")).await;
    let me = s.me().await;
    assert_eq!(
        members,
        json!([{ "userId": me["id"], "email": ADMIN, "name": "Admin", "role": "owner" }])
    );
    let files = s.get(&format!("/api/projects/{pid}/files")).await;
    let fid = files[0]["id"].as_str().unwrap().to_string();
    assert_eq!(s.get(&format!("/api/files/{fid}")).await["role"], "owner");

    // Le deuxième compte ne récupère rien
    let bob = s.register("bob@exemple.fr", "Bob").await;
    assert_eq!(bob.get("/api/projects").await, json!([]));
    bob.fails(
        "GET",
        &format!("/api/files/{fid}"),
        None,
        StatusCode::NOT_FOUND,
        "Fichier introuvable",
    )
    .await;
    // Créer un projet en fait le propriétaire
    let p = bob.send("POST", "/api/projects", json!({ "name": "Bob" })).await;
    assert_eq!(p["role"], "owner");
    assert_eq!(bob.get("/api/projects").await.as_array().unwrap().len(), 1);
    assert_eq!(s.get("/api/projects").await.as_array().unwrap().len(), 1);
    s.stop().await;
}

#[tokio::test]
async fn jetons_personnels() {
    let (_dir, db) = temp_db();
    let s = start(&db, None).await;
    assert_eq!(s.get("/api/auth/tokens").await, json!([]));
    let created = s.send("POST", "/api/auth/tokens", json!({ "name": "Claude" })).await;
    assert_eq!(created["name"], "Claude");
    assert_eq!(created["lastUsedAt"], Value::Null);
    assert!(created["createdAt"].as_i64().unwrap() > 0);
    let token = created["token"].as_str().unwrap().to_string();
    assert!(token.starts_with("swiftma_"));
    assert_eq!(token.len(), "swiftma_".len() + 43);
    let tid = created["id"].as_str().unwrap().to_string();
    let list = s.get("/api/auth/tokens").await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["id"], tid.as_str());
    assert!(list[0].get("token").is_none(), "le jeton n'est montré qu'une fois");
    assert_eq!(list[0]["lastUsedAt"], Value::Null);

    // Usage en Bearer : mêmes droits que son propriétaire
    let bearer = s.anon().with_bearer(&token);
    assert_eq!(bearer.me().await["email"], ADMIN);
    let fid = bearer.new_file("Par jeton").await;
    bearer
        .send(
            "POST",
            &format!("/api/files/{fid}/ops"),
            json!({ "ops": [create("t1")], "author": "mcp" }),
        )
        .await;
    let used = s.get("/api/auth/tokens").await[0]["lastUsedAt"].as_i64().unwrap();
    assert!(used > 0);
    // Au plus une mise à jour par minute
    bearer.me().await;
    assert_eq!(s.get("/api/auth/tokens").await[0]["lastUsedAt"].as_i64().unwrap(), used);

    // WebSocket avec le jeton
    let mut ws = bearer.ws(&fid, "agent").await;
    assert_eq!(ws.next_of("doc").await["doc"]["roots"], json!(["t1"]));
    drop(ws);

    // Le jeton d'un autre compte ne se supprime pas
    let bob = s.register("bob@exemple.fr", "Bob").await;
    bob.fails(
        "DELETE",
        &format!("/api/auth/tokens/{tid}"),
        None,
        StatusCode::NOT_FOUND,
        "Jeton introuvable",
    )
    .await;
    assert_eq!(bob.get("/api/auth/tokens").await, json!([]));

    // Révocation : 401 sur l'API et le WebSocket
    assert_eq!(
        s.send("DELETE", &format!("/api/auth/tokens/{tid}"), json!({})).await,
        json!({ "ok": true })
    );
    bearer
        .fails(
            "GET",
            "/api/projects",
            None,
            StatusCode::UNAUTHORIZED,
            "Connexion requise",
        )
        .await;
    assert_eq!(bearer.ws_refused(&fid, "agent").await, StatusCode::UNAUTHORIZED);
    s.fails(
        "DELETE",
        &format!("/api/auth/tokens/{tid}"),
        None,
        StatusCode::NOT_FOUND,
        "Jeton introuvable",
    )
    .await;
    // Jeton mal formé
    s.anon()
        .with_bearer("pas-un-jeton")
        .fails(
            "GET",
            "/api/auth/me",
            None,
            StatusCode::UNAUTHORIZED,
            "Connexion requise",
        )
        .await;
    s.stop().await;
}

#[tokio::test]
async fn droits_par_role() {
    let (_dir, db) = temp_db();
    let s = start(&db, None).await;
    let owner = s.api.clone();
    let bob = s.register("bob@exemple.fr", "Bob").await;
    let bob_id = bob.me().await["id"].as_str().unwrap().to_string();
    let pid = owner.new_project("Partagé").await;
    let fid = owner.new_file_in(&pid, "Écran").await;
    owner
        .send(
            "POST",
            &format!("/api/files/{fid}/ops"),
            json!({ "ops": [create("a")] }),
        )
        .await;
    let vid = owner
        .send("POST", &format!("/api/files/{fid}/versions"), json!({ "label": "V" }))
        .await["id"]
        .as_str()
        .unwrap()
        .to_string();

    // Non-membre : tout répond 404, comme si rien n'existait
    let project_paths = [
        ("GET", format!("/api/projects/{pid}/files")),
        ("POST", format!("/api/projects/{pid}/files")),
        ("PATCH", format!("/api/projects/{pid}")),
        ("DELETE", format!("/api/projects/{pid}")),
        ("GET", format!("/api/projects/{pid}/members")),
        ("POST", format!("/api/projects/{pid}/members")),
    ];
    for (method, path) in &project_paths {
        bob.fails(
            method,
            path,
            Some(json!({ "name": "x" })),
            StatusCode::NOT_FOUND,
            "Projet introuvable",
        )
        .await;
    }
    let file_paths = [
        ("GET", format!("/api/files/{fid}")),
        ("PATCH", format!("/api/files/{fid}")),
        ("DELETE", format!("/api/files/{fid}")),
        ("POST", format!("/api/files/{fid}/duplicate")),
        ("POST", format!("/api/files/{fid}/ops")),
        ("POST", format!("/api/files/{fid}/events")),
        ("GET", format!("/api/files/{fid}/thumbnail")),
        ("GET", format!("/api/files/{fid}/versions")),
        ("POST", format!("/api/files/{fid}/versions")),
        ("POST", format!("/api/files/{fid}/versions/{vid}/restore")),
        ("GET", format!("/api/files/{fid}/presence")),
    ];
    for (method, path) in &file_paths {
        bob.fails(
            method,
            path,
            Some(json!({ "ops": [], "event": {} })),
            StatusCode::NOT_FOUND,
            "Fichier introuvable",
        )
        .await;
    }
    let mut ws = bob.ws(&fid, "B").await;
    assert_eq!(
        ws.next().await,
        json!({ "type": "error", "message": "Fichier introuvable" })
    );

    // Ajouter un membre : adresse inconnue, rôle inconnu
    let members = format!("/api/projects/{pid}/members");
    owner
        .fails(
            "POST",
            &members,
            Some(json!({ "email": "inconnu@exemple.fr", "role": "viewer" })),
            StatusCode::NOT_FOUND,
            "Aucun compte avec cette adresse",
        )
        .await;
    let (status, _) = owner
        .call(
            "POST",
            &members,
            Some(json!({ "email": "bob@exemple.fr", "role": "chef" })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let m = owner
        .send(
            "POST",
            &members,
            json!({ "email": " BOB@exemple.fr", "role": "viewer" }),
        )
        .await;
    assert_eq!(
        m,
        json!({ "userId": bob_id, "email": "bob@exemple.fr", "name": "Bob", "role": "viewer" })
    );

    // Lecteur : lecture OK
    let projects = bob.get("/api/projects").await;
    assert_eq!(projects[0]["id"], pid.as_str());
    assert_eq!(projects[0]["role"], "viewer");
    let got = bob.get(&format!("/api/files/{fid}")).await;
    assert_eq!(got["role"], "viewer");
    assert_eq!(got["doc"]["roots"], json!(["a"]));
    assert_eq!(
        bob.get(&format!("/api/projects/{pid}/files"))
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(bob.get(&format!("/api/files/{fid}/versions")).await[0]["label"], "V");
    bob.get(&format!("/api/files/{fid}/presence")).await;
    assert_eq!(bob.get(&members).await.as_array().unwrap().len(), 2);
    let (status, _) = bob.call("GET", &format!("/api/files/{fid}/thumbnail"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "aucune vignette, mais accès autorisé");

    // Lecteur : écritures REST → 403 « Lecture seule … »
    let writes = [
        ("POST", format!("/api/projects/{pid}/files"), json!({ "name": "x" })),
        ("PATCH", format!("/api/projects/{pid}"), json!({ "name": "x" })),
        ("DELETE", format!("/api/projects/{pid}"), json!({})),
        (
            "POST",
            members.clone(),
            json!({ "email": "bob@exemple.fr", "role": "owner" }),
        ),
        ("PATCH", format!("{members}/{bob_id}"), json!({ "role": "owner" })),
        ("PATCH", format!("/api/files/{fid}"), json!({ "name": "x" })),
        ("DELETE", format!("/api/files/{fid}"), json!({})),
        ("POST", format!("/api/files/{fid}/duplicate"), json!({})),
        ("POST", format!("/api/files/{fid}/ops"), json!({ "ops": [create("b")] })),
        (
            "POST",
            format!("/api/files/{fid}/events"),
            json!({ "event": { "kind": "x" } }),
        ),
        (
            "PUT",
            format!("/api/files/{fid}/thumbnail"),
            json!({ "dataUrl": "data:image/png;base64,iVBORw==" }),
        ),
        ("POST", format!("/api/files/{fid}/versions"), json!({})),
        ("POST", format!("/api/files/{fid}/versions/{vid}/restore"), json!({})),
    ];
    for (method, path, body) in &writes {
        bob.fails(method, path, Some(body.clone()), StatusCode::FORBIDDEN, READ_ONLY)
            .await;
    }
    assert_eq!(
        owner.get(&format!("/api/files/{fid}")).await["version"],
        1,
        "rien n'a changé"
    );

    // Lecteur sur le WebSocket : reçoit tout, ses écritures répondent error sans resynchronisation
    let mut bws = bob.ws(&fid, "B").await;
    bws.next_of("doc").await;
    let mut ows = owner.ws(&fid, "O").await;
    ows.next_of("doc").await;
    for msg in [
        json!({ "type": "ops", "ops": [create("b")], "origin": "B" }),
        json!({ "type": "undo" }),
        json!({ "type": "redo" }),
    ] {
        bws.send(msg).await;
        assert_eq!(bws.next_event().await, json!({ "type": "error", "message": READ_ONLY }));
        bws.assert_quiet().await;
    }
    ows.assert_quiet().await;
    // La présence reste permise
    bws.send(json!({ "type": "selection", "ids": ["a"] })).await;
    ows.presence_until(|p| {
        p["users"]
            .as_array()
            .unwrap()
            .iter()
            .any(|u| u["userId"] == bob_id.as_str() && u["selection"] == json!(["a"]) && u["name"] == "Bob")
    })
    .await;
    ows.send(json!({ "type": "ops", "ops": [create("o1")], "origin": "O" }))
        .await;
    assert_eq!(bws.next_event().await["origin"], "O");
    ows.next_event().await;

    // Éditeur : écrit (rôle revérifié sur la connexion déjà ouverte), mais ne gère pas les membres
    let m = owner
        .send("PATCH", &format!("{members}/{bob_id}"), json!({ "role": "editor" }))
        .await;
    assert_eq!(m["role"], "editor");
    bws.send(json!({ "type": "ops", "ops": [create("b1")], "origin": "B" }))
        .await;
    let m = bws.next_event().await;
    assert_eq!(m["type"], "ops");
    assert_eq!(m["origin"], "B");
    bob.send(
        "POST",
        &format!("/api/files/{fid}/ops"),
        json!({ "ops": [create("b2")] }),
    )
    .await;
    let p = bob
        .send("PATCH", &format!("/api/projects/{pid}"), json!({ "name": "Renommé" }))
        .await;
    assert_eq!(p["role"], "editor");
    bob.send("POST", &format!("/api/files/{fid}/versions"), json!({})).await;
    let copy = bob
        .send("POST", &format!("/api/files/{fid}/duplicate"), json!({}))
        .await;
    let owner_only = "Réservé aux propriétaires du projet";
    bob.fails(
        "POST",
        &members,
        Some(json!({ "email": ADMIN, "role": "viewer" })),
        StatusCode::FORBIDDEN,
        owner_only,
    )
    .await;
    bob.fails(
        "DELETE",
        &format!("/api/projects/{pid}"),
        None,
        StatusCode::FORBIDDEN,
        owner_only,
    )
    .await;
    let owner_id = owner.me().await["id"].as_str().unwrap().to_string();
    bob.fails(
        "DELETE",
        &format!("{members}/{owner_id}"),
        None,
        StatusCode::FORBIDDEN,
        owner_only,
    )
    .await;

    // Déplacer un fichier : au moins éditeur dans les deux projets
    let cid = copy["id"].as_str().unwrap();
    let bob_project = bob.new_project("À Bob").await;
    bob.fails(
        "PATCH",
        &format!("/api/files/{cid}"),
        Some(json!({ "projectId": "inconnu" })),
        StatusCode::NOT_FOUND,
        "Projet introuvable",
    )
    .await;
    let viewer_project = owner.new_project("Lecture").await;
    owner
        .send(
            "POST",
            &format!("/api/projects/{viewer_project}/members"),
            json!({ "email": "bob@exemple.fr", "role": "viewer" }),
        )
        .await;
    bob.fails(
        "PATCH",
        &format!("/api/files/{cid}"),
        Some(json!({ "projectId": viewer_project })),
        StatusCode::FORBIDDEN,
        READ_ONLY,
    )
    .await;
    let moved = bob
        .send(
            "PATCH",
            &format!("/api/files/{cid}"),
            json!({ "projectId": bob_project }),
        )
        .await;
    assert_eq!(moved["projectId"], bob_project.as_str());
    owner
        .fails(
            "GET",
            &format!("/api/files/{cid}"),
            None,
            StatusCode::NOT_FOUND,
            "Fichier introuvable",
        )
        .await;

    // Propriétaire : le dernier est protégé
    let last = "Un projet doit garder au moins un propriétaire";
    owner
        .fails(
            "PATCH",
            &format!("{members}/{owner_id}"),
            Some(json!({ "role": "editor" })),
            StatusCode::BAD_REQUEST,
            last,
        )
        .await;
    owner
        .fails(
            "DELETE",
            &format!("{members}/{owner_id}"),
            None,
            StatusCode::BAD_REQUEST,
            last,
        )
        .await;
    owner
        .fails(
            "POST",
            &members,
            Some(json!({ "email": ADMIN, "role": "viewer" })),
            StatusCode::BAD_REQUEST,
            last,
        )
        .await;
    owner
        .fails(
            "PATCH",
            &format!("{members}/inconnu"),
            Some(json!({ "role": "editor" })),
            StatusCode::NOT_FOUND,
            "Membre introuvable",
        )
        .await;
    // Si déjà membre, POST met à jour le rôle
    let m = owner
        .send("POST", &members, json!({ "email": "bob@exemple.fr", "role": "owner" }))
        .await;
    assert_eq!(m["role"], "owner");
    assert_eq!(owner.get(&members).await.as_array().unwrap().len(), 2);
    // Deux propriétaires : on peut maintenant rétrograder, puis quitter le projet
    owner
        .send("PATCH", &format!("{members}/{owner_id}"), json!({ "role": "viewer" }))
        .await;
    assert_eq!(
        owner.send("DELETE", &format!("{members}/{owner_id}"), json!({})).await,
        json!({ "ok": true })
    );
    owner
        .fails(
            "GET",
            &format!("/api/files/{fid}"),
            None,
            StatusCode::NOT_FOUND,
            "Fichier introuvable",
        )
        .await;
    assert!(
        owner
            .get("/api/projects")
            .await
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["id"] != pid.as_str())
    );
    // L'ancien propriétaire déjà connecté au WebSocket : sa prochaine écriture ferme la connexion
    ows.send(json!({ "type": "ops", "ops": [create("o2")], "origin": "O" }))
        .await;
    let error = loop {
        // Les lots de Bob reçus entre-temps passent d'abord
        let m = ows.next_event().await;
        if m["type"] != "ops" {
            break m;
        }
    };
    assert_eq!(error, json!({ "type": "error", "message": "Fichier introuvable" }));
    // Bob, seul propriétaire, ne peut plus quitter
    bob.fails(
        "DELETE",
        &format!("{members}/{bob_id}"),
        None,
        StatusCode::BAD_REQUEST,
        last,
    )
    .await;
    // Un lecteur peut quitter le projet de lui-même
    let carl = s.register("carl@exemple.fr", "Carl").await;
    let carl_id = carl.me().await["id"].as_str().unwrap().to_string();
    bob.send(
        "POST",
        &members,
        json!({ "email": "carl@exemple.fr", "role": "viewer" }),
    )
    .await;
    carl.fails(
        "DELETE",
        &format!("{members}/{bob_id}"),
        None,
        StatusCode::FORBIDDEN,
        READ_ONLY,
    )
    .await;
    assert_eq!(
        carl.send("DELETE", &format!("{members}/{carl_id}"), json!({})).await,
        json!({ "ok": true })
    );
    assert_eq!(carl.get("/api/projects").await, json!([]));

    // Propriétaire : supprimer le projet
    assert_eq!(
        bob.send("DELETE", &format!("/api/projects/{pid}"), json!({})).await,
        json!({ "ok": true })
    );
    s.stop().await;
}

#[tokio::test]
async fn annulation_separee_par_compte() {
    let (_dir, db) = temp_db();
    let s = start(&db, None).await;
    let bob = s.register("bob@exemple.fr", "Bob").await;
    let pid = s.new_project("Commun").await;
    let fid = s.new_file_in(&pid, "F").await;
    s.send(
        "POST",
        &format!("/api/projects/{pid}/members"),
        json!({ "email": "bob@exemple.fr", "role": "editor" }),
    )
    .await;
    // Même identifiant d'onglet pour deux comptes différents
    let mut a = s.ws(&fid, "T").await;
    a.next_of("doc").await;
    let mut b = bob.ws(&fid, "T").await;
    b.next_of("doc").await;
    let p = a.presence_until(|p| p["users"].as_array().unwrap().len() == 2).await;
    assert_eq!(p["users"][0]["id"], "T");
    assert_eq!(p["users"][1]["id"], "T");
    assert_ne!(p["users"][0]["userId"], p["users"][1]["userId"]);
    assert_eq!(p["users"][1]["name"], "Bob");

    a.send(json!({ "type": "ops", "ops": [create("x")], "origin": "T" }))
        .await;
    assert_eq!(b.next_event().await["version"], 1);
    a.next_event().await;
    // Bob ne peut pas annuler le lot de l'autre compte
    b.send(json!({ "type": "undo" })).await;
    b.assert_quiet().await;
    // Lot REST de Bob avec origin = son onglet : il l'annule depuis le WebSocket
    bob.send(
        "POST",
        &format!("/api/files/{fid}/ops"),
        json!({ "ops": [create("y")], "origin": "T" }),
    )
    .await;
    for ws in [&mut a, &mut b] {
        assert_eq!(ws.next_event().await["version"], 2);
    }
    b.send(json!({ "type": "undo" })).await;
    for ws in [&mut a, &mut b] {
        let m = ws.next_event().await;
        assert_eq!(m["version"], 3);
        assert_eq!(m["ops"], json!([{ "kind": "delete", "id": "y" }]));
    }
    a.send(json!({ "type": "undo" })).await;
    let m = a.next_event().await;
    assert_eq!(m["version"], 4);
    assert_eq!(m["ops"], json!([{ "kind": "delete", "id": "x" }]));
    s.stop().await;
}

#[tokio::test]
async fn fichier_actif_par_compte() {
    let (_dir, db) = temp_db();
    let s = start(&db, None).await;
    let bob = s.register("bob@exemple.fr", "Bob").await;
    let f1 = s.new_file("Admin").await;
    let f2 = bob.new_file("Bob").await;
    let mut a = s.ws(&f1, "A").await;
    a.next_of("doc").await;
    assert_eq!(s.get("/api/active-file").await["file"]["id"], f1.as_str());
    bob.fails(
        "GET",
        "/api/active-file",
        None,
        StatusCode::NOT_FOUND,
        "Aucun fichier ouvert",
    )
    .await;
    bob.send("POST", &format!("/api/files/{f2}/ops"), json!({ "ops": [create("b")] }))
        .await;
    assert_eq!(bob.get("/api/active-file").await["file"]["id"], f2.as_str());
    assert_eq!(s.get("/api/active-file").await["file"]["id"], f1.as_str());
    // Fichier supprimé : plus de fichier actif
    bob.send("DELETE", &format!("/api/files/{f2}"), json!({})).await;
    bob.fails(
        "GET",
        "/api/active-file",
        None,
        StatusCode::NOT_FOUND,
        "Aucun fichier ouvert",
    )
    .await;
    s.stop().await;
}

#[tokio::test]
async fn changement_de_mot_de_passe() {
    let (_dir, db) = temp_db();
    let s = start(&db, None).await;
    let first = s.api.clone();
    let second = s.login(ADMIN, PASSWORD).await;
    let token = first.send("POST", "/api/auth/tokens", json!({ "name": "t" })).await;
    let bearer = s.anon().with_bearer(token["token"].as_str().unwrap());

    first
        .fails(
            "PATCH",
            "/api/auth/me",
            Some(json!({ "password": "nouveau-mdp", "currentPassword": "mauvais-mdp" })),
            StatusCode::FORBIDDEN,
            "Mot de passe actuel incorrect",
        )
        .await;
    first
        .fails(
            "PATCH",
            "/api/auth/me",
            Some(json!({ "password": "nouveau-mdp" })),
            StatusCode::FORBIDDEN,
            "Mot de passe actuel incorrect",
        )
        .await;
    first
        .fails(
            "PATCH",
            "/api/auth/me",
            Some(json!({ "password": "court", "currentPassword": PASSWORD })),
            StatusCode::BAD_REQUEST,
            "Mot de passe trop court (8 caractères minimum)",
        )
        .await;
    second.me().await;

    let me = first
        .send(
            "PATCH",
            "/api/auth/me",
            json!({ "password": "nouveau-mdp", "currentPassword": PASSWORD, "name": "Nouveau nom" }),
        )
        .await;
    assert_eq!(me["name"], "Nouveau nom");
    // La session courante reste ouverte, les autres sont fermées ; les jetons restent valides
    first.me().await;
    second
        .fails(
            "GET",
            "/api/auth/me",
            None,
            StatusCode::UNAUTHORIZED,
            "Connexion requise",
        )
        .await;
    bearer.me().await;
    s.anon()
        .fails(
            "POST",
            "/api/auth/login",
            Some(json!({ "email": ADMIN, "password": PASSWORD })),
            StatusCode::UNAUTHORIZED,
            "Email ou mot de passe incorrect",
        )
        .await;
    s.login(ADMIN, "nouveau-mdp").await;
    s.stop().await;
}

#[tokio::test]
async fn migration_d_une_base_sans_comptes() {
    let (_dir, db) = temp_db();
    std::fs::create_dir_all(db.parent().unwrap()).unwrap();
    {
        // Base au schéma 1 (avant les comptes), avec un projet et un fichier
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            r##"
            CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL);
            CREATE TABLE files (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                name TEXT NOT NULL, doc TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
            CREATE INDEX files_project ON files(project_id);
            CREATE TABLE versions (id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                label TEXT NOT NULL, auto INTEGER NOT NULL DEFAULT 0, doc TEXT NOT NULL,
                node_count INTEGER NOT NULL, created_at INTEGER NOT NULL);
            CREATE INDEX versions_file ON versions(file_id, created_at);
            CREATE TABLE thumbnails (file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
                mime TEXT NOT NULL, data BLOB NOT NULL);
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO meta VALUES ('seeded', '1');
            INSERT INTO projects VALUES ('p-ancien', 'Ancien projet', 1000, 2000);
            INSERT INTO projects VALUES ('p-autre', 'Autre', 1000, 1500);
            INSERT INTO files VALUES ('f-ancien', 'p-ancien', 'Maquette',
                '{"id":"d","name":"Maquette","background":"#FFF","nodes":{},"roots":[],"styles":{"s":1}}', 7, 1000, 2000);
            INSERT INTO versions VALUES ('v1', 'f-ancien', 'Jalon', 0,
                '{"id":"d","name":"Maquette","background":"#FFF","nodes":{},"roots":[]}', 0, 1500);
            PRAGMA user_version = 1;
            "##,
        )
        .unwrap();
    }
    let s = start_bare(&db, None, false).await;
    assert_eq!(
        s.get("/api/auth/config").await,
        json!({ "signup": true, "hasUsers": false })
    );
    let admin = s.register(ADMIN, "Admin").await;
    let projects = admin.get("/api/projects").await;
    let names: Vec<&str> = projects
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["Ancien projet", "Autre"], "pas de projet par défaut ajouté");
    assert!(projects.as_array().unwrap().iter().all(|p| p["role"] == "owner"));
    let got = admin.get("/api/files/f-ancien").await;
    assert_eq!(got["version"], 7);
    assert_eq!(got["role"], "owner");
    assert_eq!(got["doc"]["styles"], json!({ "s": 1 }));
    assert_eq!(admin.get("/api/files/f-ancien/versions").await[0]["label"], "Jalon");
    s.stop().await;

    let conn = rusqlite::Connection::open(&db).unwrap();
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(version, 2);
    let hash: String = conn
        .query_row("SELECT password_hash FROM users", [], |r| r.get(0))
        .unwrap();
    assert!(hash.starts_with("$argon2id$"), "argon2id");
    let sessions: Vec<String> = conn
        .prepare("SELECT token_hash FROM sessions")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(sessions.len(), 1);
    let cookie = admin
        .auth
        .as_ref()
        .unwrap()
        .1
        .strip_prefix("swiftma_session=")
        .unwrap()
        .to_string();
    assert_ne!(sessions[0], cookie, "seule l'empreinte de la session est gardée");
    assert_eq!(sessions[0].len(), 64);
}
