# Hub Nyota (Rust)

Backend de Nyota : projets, fichiers, historique de versions et collaboration en temps réel (une salle WebSocket
par fichier, annulation par utilisateur). Il applique les opérations de façon générique sur le JSON des documents ;
la logique de design reste dans `packages/core`.

Le contrat complet (API REST, WebSocket, sémantique des opérations, persistance) est dans
[`docs/hub.md`](../../docs/hub.md).

## Lancer en développement

```sh
cd apps/hub
cargo run                      # http://localhost:4000, base dans data/nyota.db
NYOTA_MCP_URL=http://localhost:4001 cargo run   # avec le service MCP/IA
```

## Variables

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `4000` | Port HTTP |
| `NYOTA_DB` | `data/nyota.db` | Base SQLite (créée au besoin) |
| `NYOTA_STATIC` | — | Éditeur compilé (`apps/editor/dist`) servi en `/`, repli SPA sur `index.html` |
| `NYOTA_MCP_URL` | — | Service MCP/IA : `/mcp` et `/api/ai/*` y sont relayés (503 sinon) |
| `NYOTA_LEGACY_DOC` | `data/document.json` | Ancien document unique, importé au premier démarrage |
| `RUST_LOG` | `info` | Niveau des journaux (`debug`, `nyota_hub=debug`…) |

Les chemins relatifs partent du dossier courant.

## Tests

```sh
cargo test                                   # opérations (tests/fixtures/ops.json) et serveur
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```
