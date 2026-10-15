# Hub Swiftma (Rust)

Backend de Swiftma : projets, fichiers, historique de versions et collaboration en temps réel (une salle WebSocket
par fichier, annulation par utilisateur). Il applique les opérations de façon générique sur le JSON des documents ;
la logique de design reste dans `packages/core`.

Le contrat complet (API REST, WebSocket, sémantique des opérations, persistance) est dans
[`docs/hub.md`](../../docs/hub.md).

## Lancer en développement

```sh
cd apps/hub
cargo run                      # http://localhost:4000, base dans data/swiftma.db
SWIFTMA_MCP_URL=http://localhost:4001 cargo run   # avec le service MCP/IA
```

## Variables

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `4000` | Port HTTP |
| `SWIFTMA_DB` | `data/swiftma.db` | Base SQLite (créée au besoin) |
| `SWIFTMA_STATIC` | — | Éditeur compilé (`apps/editor/dist`) servi en `/`, repli SPA sur `index.html` |
| `SWIFTMA_MCP_URL` | — | Service MCP/IA : `/mcp` et `/api/ai/*` y sont relayés (503 sinon) |
| `SWIFTMA_LEGACY_DOC` | `data/document.json` | Ancien document unique, importé au premier démarrage |
| `SWIFTMA_SIGNUP` | `open` | `open` : tout le monde peut créer un compte ; `closed` : seul le premier compte s'inscrit, l'administrateur crée les suivants (valeur inconnue → `closed`) |
| `SWIFTMA_SECURE_COOKIES` | `0` | `1` : cookie de session `Secure` (à activer derrière HTTPS) |
| `RUST_LOG` | `info` | Niveau des journaux (`debug`, `swiftma_hub=debug`…) |

Les chemins relatifs partent du dossier courant.

## Comptes et droits

Toute l'API (sauf `GET /api/health` et `GET /api/auth/config`), le WebSocket, `/mcp` et `/api/ai/*` exigent une
personne connectée : cookie `swiftma_session` (navigateur) ou `Authorization: Bearer swiftma_…` (jeton personnel créé par
`POST /api/auth/tokens`, pour le service MCP/IA et les scripts). Le premier compte créé est administrateur et devient
propriétaire des projets existants. Chaque projet a des membres `viewer`, `editor` ou `owner` ; un projet dont on
n'est pas membre répond 404. Détails : section « Comptes et droits d'accès » de [`docs/hub.md`](../../docs/hub.md).

Mots de passe en argon2id ; la base ne garde que l'empreinte SHA-256 des sessions et des jetons. Les bases
antérieures aux comptes migrent automatiquement (schéma `user_version` 2) : leurs projets reviennent au premier
compte créé.

```sh
# Jeton pour le service MCP/IA (après connexion dans l'éditeur, ou avec un cookie de session)
curl -X POST localhost:4000/api/auth/tokens -b 'swiftma_session=…' -d '{"name":"MCP"}'
```

## Tests

```sh
cargo test                                   # opérations (tests/fixtures/ops.json), serveur, comptes et droits
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```
