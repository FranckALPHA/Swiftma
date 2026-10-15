# Contribuer à Swiftma · Contributing to Swiftma

*English below.*

Merci de vouloir améliorer Swiftma ! Toute aide compte : corriger un bug, traduire, tester sur vos maquettes,
améliorer la documentation, proposer une idée.

## Avant de commencer

- Un bug ou une idée : ouvrez d'abord une **issue** (modèles fournis) pour en discuter, surtout pour un changement
  important. Une petite correction peut aller directement en pull request.
- Une faille de sécurité : **pas d'issue publique**, voir [SECURITY.md](SECURITY.md).
- Respectez le [code de conduite](CODE_OF_CONDUCT.md).

## Installer

Node 22 et Rust stable.

```bash
npm install
npm run dev          # hub Rust (:4000) + service MCP/IA (:4001) + éditeur (:5173)
```

`/local` ouvre l'éditeur sans compte ni serveur (pratique pour tester un rendu).

## Avant d'ouvrir une pull request

```bash
npm run typecheck
npm test
npm run test:hub
cargo fmt --manifest-path apps/hub/Cargo.toml --check
cargo clippy --manifest-path apps/hub/Cargo.toml --all-targets -- -D warnings
node tests/e2e/collaboration.mjs        # si vous touchez au hub, aux comptes ou à la collaboration
```

La CI lance tout cela ; une pull request doit être verte pour être fusionnée.

## Repères

- **Un outil de design = une définition** dans `packages/core/src/tools.ts` ; l'éditeur, l'agent et le MCP la
  partagent. Ajouter un outil là le rend disponible partout.
- **Tout passe par des opérations** (`packages/core/src/ops.ts`). Le hub Rust ne connaît pas le design : le client
  envoie des lots résolus (voir `docs/hub.md`). Toute route ou tout message WebSocket nouveau doit être décrit dans
  `docs/hub.md`.
- **Style** : suivez le code voisin. Les messages d'interface et les commentaires sont en français ; gardez des noms
  explicites et peu de commentaires, là où ils expliquent un *pourquoi*.
- **Tests** : toute correction de bug vient avec un test qui échouait avant.
- **Commits** : un sujet court à l'impératif (« Corriger… », « Ajouter… »), le pourquoi dans le corps si utile.

## Licence des contributions

Swiftma est sous [AGPL-3.0](LICENSE). En proposant une contribution, vous acceptez qu'elle soit publiée sous cette
même licence (*inbound = outbound*). Pas de CLA à signer.

---

## English

Thanks for helping improve Swiftma! Every kind of help counts: fixing bugs, translating, testing with your own
mockups, improving docs, suggesting ideas.

- **Bugs and ideas:** open an issue first (templates provided), especially for larger changes. Small fixes can go
  straight to a pull request.
- **Security issues:** never in a public issue, see [SECURITY.md](SECURITY.md).
- **Setup:** Node 22 and stable Rust, then `npm install && npm run dev`.
- **Before a PR:** run `npm run typecheck`, `npm test` and `npm run test:hub`, plus `cargo fmt --check` and
  `cargo clippy -D warnings` on `apps/hub`. Also run the end-to-end test if you touch the hub, accounts or
  collaboration. CI must be green.
- **Architecture:**
  - Design tools are defined once, in `packages/core/src/tools.ts`.
  - Every change is an operation.
  - The Rust hub is design-agnostic, and its contract is `docs/hub.md`, which must be kept up to date.
- **Style:** match the surrounding code. UI strings and code comments are currently in French, and English
  contributions are welcome too.
- **License:** contributions are accepted under the [AGPL-3.0](LICENSE) (inbound = outbound), with no CLA.
