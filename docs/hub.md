# Hub Swiftma (Rust) — contrat

Le hub est le backend de Swiftma, écrit en Rust (`apps/hub`, axum + tokio + SQLite). Il détient les **projets**, les
**fichiers** (un fichier = un document de design), leur **historique de versions**, et fait vivre la **collaboration
en temps réel** : une salle WebSocket par fichier, des opérations ordonnées par le serveur, l'annulation par
utilisateur.

Le hub ne connaît pas le design : il applique les opérations de façon **générique** sur du JSON. Toute la logique de
design (auto-layout, composants, styles, exports) vit dans `packages/core` (TypeScript), partagé par l'éditeur et par
le service MCP/IA. Les clients envoient des opérations **résolues** : si une opération déplace des éléments par
auto-layout, les déplacements sont inclus dans le lot sous forme d'opérations `update`. Ainsi le document du hub est
toujours exactement celui des clients, et l'inverse générique d'un lot restaure tout.

```
 Éditeur (React)  ──WebSocket /ws──┐
 Éditeur (React)  ──WebSocket /ws──┤       ┌───────────────┐
                                   ├──────▶│  Hub (Rust)   │── SQLite (projets, fichiers, versions)
 Service MCP/IA (TS) ──REST /api───┘       │  :4000        │── sert l'éditeur compilé (production)
            ▲                              └──────┬────────┘
            └──── /mcp, /api/ai/* relayés ────────┘
```

## Démarrage

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `4000` | Port HTTP |
| `SWIFTMA_DB` | `data/swiftma.db` | Base SQLite (créée au besoin, dossier compris) |
| `SWIFTMA_STATIC` | — | Dossier de l'éditeur compilé (`apps/editor/dist`) servi en `/` avec repli SPA sur `index.html` |
| `SWIFTMA_MCP_URL` | — | Service MCP/IA (ex. `http://localhost:4001`) : `/mcp` et `/api/ai/*` y sont relayés tels quels |
| `SWIFTMA_LEGACY_DOC` | `data/document.json` | Ancien document unique : importé une fois comme fichier si la base est vide |

Au premier démarrage (base vide), le hub crée le projet « Mon premier projet » avec un fichier « Sans titre »
(ou le document importé depuis `SWIFTMA_LEGACY_DOC` s'il existe).

## Document

Un document est un objet JSON : `{ "id", "name", "background", "nodes": { id: nœud }, "roots": [ids], ... }`.
D'autres clés peuvent exister (ex. `styles`) et doivent être conservées telles quelles.
Un nœud est un objet JSON dont le hub n'utilise que `id`, `parentId` (string ou null), `children` (liste d'ids),
`text` (objet ou null). Toutes les autres clés sont conservées telles quelles.

Document vide : `{ "id": <nouvel id>, "name": <nom du fichier>, "background": "#F5F5F5", "nodes": {}, "roots": [] }`.

## Opérations

Une opération est un objet JSON avec `kind`. Un **lot** est appliqué de façon **atomique** : si une opération
échoue, le document revient exactement à son état d'avant le lot et une erreur est renvoyée. Appliquer un lot
renvoie son **inverse** : la liste des opérations inverses, **dans l'ordre inverse** (inverse de la dernière opération
d'abord), aplatie.

- `{"kind":"create","node":{...},"index"?:n}`
  - erreur si `nodes[node.id]` existe (« Le nœud X existe déjà ») ou si `node.parentId` est non nul et introuvable
    (« Parent introuvable : X ») ;
  - le nœud est stocké avec `children: []` (les enfants fournis sont ignorés) ;
  - il est inséré dans `children` de son parent (ou dans `roots` si `parentId` est null) à `index` ; `index` absent,
    négatif ou > longueur → à la fin ;
  - inverse : `[{"kind":"delete","id":id}]`.
- `{"kind":"update","id":id,"props":{...}}`
  - erreur si le nœud est introuvable (« Nœud introuvable : X ») ;
  - pour chaque clé de `props` : valeur précédente = `node[clé]` si présente, sinon **null** ;
  - `props.text` est **fusionné** dans `node.text` (`{...node.text, ...props.text}`), erreur si `node.text` est null
    (« Le nœud X n'est pas un texte ») ; la valeur précédente enregistrée est l'objet `text` complet d'avant ;
  - les autres clés remplacent la valeur (null compris) ;
  - inverse : `[{"kind":"update","id":id,"props":{valeurs précédentes}}]`.
- `{"kind":"delete","id":id}`
  - erreur si introuvable ;
  - supprime le nœud et tous ses descendants ; le retire de la liste de son parent (ou de `roots`) ;
  - inverse : une opération `create` par nœud du sous-arbre, **parents d'abord** (parcours en profondeur dans l'ordre
    des `children`), chacune avec une copie complète du nœud tel qu'il était (`children` compris) ; la première porte
    `index` = son ancienne position, les suivantes n'ont pas d'`index`.
- `{"kind":"move","id":id,"parentId":id|null,"index"?:n}`
  - erreur si le nœud est introuvable ; si `parentId` est le nœud lui-même ou un de ses descendants (« Impossible de
    déplacer un nœud dans lui-même ») ; si `parentId` est non nul et introuvable ;
  - retire le nœud de son ancienne liste, met à jour `parentId`, l'insère à `index` (mêmes règles que `create`) ;
  - inverse : `[{"kind":"move","id":id,"parentId":ancien parent,"index":ancienne position}]`.
- `{"kind":"set-doc","props":{...}}`
  - erreur si une clé est `nodes`, `roots` ou `id` ;
  - pour chaque clé : valeur précédente = `doc[clé]` si présente, sinon `"#F5F5F5"` pour `background`, sinon null ;
    puis `doc[clé] = valeur` ;
  - inverse : `[{"kind":"set-doc","props":{valeurs précédentes}}]`.

Référence exécutable : `tests/fixtures/ops.json` (généré par le cœur TypeScript,
`npx tsx packages/core/test/gen-op-fixtures.ts`). Chaque cas donne `before`, `ops`, puis soit `after` + `inverse`, soit
`error: true`. Comparaison : une clé absente et une clé à `null` sont équivalentes.

## API REST (JSON)

Dates : millisecondes depuis l'époque Unix. Ids : chaînes générées par le hub. Erreurs : statut 4xx/5xx avec
`{"error": "message lisible"}`.

| Méthode et chemin | Corps | Réponse |
|---|---|---|
| `GET /api/health` | | `{"ok":true}` |
| `GET /api/projects` | | `[Project]`, du plus récemment modifié au plus ancien |
| `POST /api/projects` | `{"name"}` | `Project` |
| `PATCH /api/projects/:id` | `{"name"}` | `Project` |
| `DELETE /api/projects/:id` | | `{"ok":true}` (supprime ses fichiers et leurs versions) |
| `GET /api/projects/:id/files` | | `[FileMeta]`, du plus récent au plus ancien |
| `POST /api/projects/:id/files` | `{"name", "doc"?}` | `FileMeta` (document vide si `doc` absent) |
| `GET /api/files/:id` | | `{"file": FileMeta, "doc": Document, "version": n}` |
| `PATCH /api/files/:id` | `{"name"?, "projectId"?}` | `FileMeta` (renommer change aussi `doc.name`) |
| `DELETE /api/files/:id` | | `{"ok":true}` |
| `POST /api/files/:id/duplicate` | | `FileMeta` de la copie (« Nom (copie) », même projet) |
| `POST /api/files/:id/ops` | `{"ops", "label"?, "author"?: "human"\|"ai"\|"mcp", "origin"?}` | `{"ok":true,"version":n}` ou 400 `{"error"}` ; diffusé aux éditeurs du fichier, entre dans la pile d'annulation de `origin` (ou de l'auteur) |
| `POST /api/files/:id/events` | `{"event": AiEvent}` | `{"ok":true}` ; relaie `{"type":"ai","event"}` aux éditeurs du fichier |
| `PUT /api/files/:id/thumbnail` | `{"dataUrl":"data:image/png;base64,..."}` | `{"ok":true}` |
| `GET /api/files/:id/thumbnail` | | l'image (`image/png`…), 404 si aucune |
| `GET /api/files/:id/versions` | | `[Version]`, de la plus récente à la plus ancienne |
| `POST /api/files/:id/versions` | `{"label"?}` | `Version` (instantané du document courant) |
| `GET /api/files/:id/presence` | | `{"users":[…], "mcpLastSeen"}` (même format que le message `presence`) : le service MCP/IA y lit la sélection |
| `GET /api/active-file` | | `{"file": FileMeta}` du dernier fichier ouvert (WebSocket) ou modifié ; 404 si aucun. Fichier par défaut des outils MCP |
| `POST /api/files/:id/versions/:vid/restore` | | `{"ok":true,"version":n}` : le document devient l'instantané (un instantané « Avant restauration » est d'abord pris), les piles d'annulation sont vidées, `{"type":"doc"}` est diffusé |

- `Project` : `{"id","name","createdAt","updatedAt","fileCount"}`
- `FileMeta` : `{"id","projectId","name","createdAt","updatedAt","hasThumbnail"}`
- `Version` : `{"id","fileId","label","createdAt","nodeCount"}`

Le hub prend aussi un instantané automatique (« Sauvegarde automatique ») d'un fichier modifié au plus toutes les
10 minutes, et en garde au plus 50 automatiques par fichier (les versions nommées sont gardées).

## WebSocket `/ws?file=<id>&user=<clientId>&name=<nom affiché>`

Une connexion = un utilisateur dans la salle d'un fichier. `user` identifie le client (il est aussi l'`origin` de ses
opérations) ; `name` est affiché aux autres. Fichier introuvable → message `error` puis fermeture.

Serveur → client :
- `{"type":"doc","doc":Document,"version":n}` à la connexion et à chaque resynchronisation ;
- `{"type":"ops","ops":[...],"author":"human"|"ai"|"mcp","label"?,"origin"?,"version":n}` pour **chaque** lot
  appliqué, y compris ceux de ce client (il reconnaît les siens grâce à `origin`) ; `version` augmente de 1 par lot ;
- `{"type":"error","message"}` : lot refusé ; le serveur envoie ensuite `{"type":"doc"}` pour resynchroniser ;
- `{"type":"presence","users":[{"id","name","color","selection":[ids],"cursor":{"x","y"}|null}],"mcpLastSeen":ms|null}`
  à chaque arrivée/départ, sélection ou curseur (au plus toutes les 50 ms) ; `color` est attribuée par le hub ;
- `{"type":"ai","event":AiEvent}` relayé depuis le service MCP/IA.

Client → serveur :
- `{"type":"ops","ops":[...],"label"?,"origin"}` : appliqué, diffusé, et l'entrée `{ops, inverse, label}` est
  empilée dans la pile d'annulation de cet utilisateur (sa pile de rétablissement est vidée) ;
- `{"type":"undo"}` / `{"type":"redo"}` : annule / rétablit le dernier lot **de cet utilisateur** en appliquant son
  inverse / ses opérations ; diffusé comme un lot normal (`origin` = cet utilisateur). Si l'application échoue
  (le document a changé entre-temps), l'entrée est abandonnée et un `error` « Impossible d'annuler : … » est envoyé ;
- `{"type":"selection","ids":[...]}`, `{"type":"cursor","x","y"}` (ou `x`,`y` null quand le pointeur sort) :
  mettent à jour la présence.

Les piles d'annulation vivent en mémoire (500 entrées max par utilisateur). Le document est sauvegardé dans SQLite au
plus tard 1 s après une modification, et à l'arrêt du hub (Ctrl+C).

## Comptes et droits d'accès

Toute l'API (sauf `GET /api/health` et `GET /api/auth/config`), le WebSocket, `/mcp` et `/api/ai/*` exigent une
personne connectée. L'éditeur compilé (fichiers statiques) reste public : il affiche l'écran de connexion.

### Identification

- **Session (navigateur)** : cookie `swiftma_session` — `HttpOnly`, `SameSite=Lax`, `Path=/`, durée 30 jours, `Secure` si
  `SWIFTMA_SECURE_COOKIES=1` (à mettre derrière HTTPS). Valeur : 32 octets aléatoires (base64url) ; la base ne garde que
  son empreinte SHA-256.
- **Jeton personnel (IA via MCP, scripts)** : en-tête `Authorization: Bearer swiftma_…` (préfixe `swiftma_` + 32 octets
  aléatoires en base64url). Mêmes droits que son propriétaire. La base ne garde que l'empreinte SHA-256 ; le jeton n'est
  montré qu'une fois, à sa création. `lastUsedAt` est mis à jour à l'usage (au plus une fois par minute).
- Si les deux sont présents, l'en-tête `Authorization` l'emporte. Un jeton ou une session invalide → 401.
- **Mots de passe** : argon2id (paramètres par défaut de la crate `argon2`), 8 caractères minimum
  (« Mot de passe trop court (8 caractères minimum) »). Emails : espaces retirés, en minuscules, uniques
  (« Un compte existe déjà avec cette adresse »), doivent contenir `@`.
- **Tentatives de connexion** : après 5 échecs pour une même adresse en 15 minutes, `POST /api/auth/login` répond 429
  « Trop de tentatives, réessaie dans quelques minutes » (même avec le bon mot de passe) jusqu'à la fin de la fenêtre.
  Message d'échec unique : « Email ou mot de passe incorrect ».

### Inscriptions et administrateur

- `SWIFTMA_SIGNUP` = `open` (défaut) : tout le monde peut créer un compte ; `closed` : seul le **premier** compte peut être
  créé par `register` (amorçage) ; ensuite 403 « Inscriptions fermées : demande un compte à l'administrateur ».
- Le premier compte créé est **administrateur** (`isAdmin`) et devient **propriétaire de tous les projets sans
  propriétaire** (projet par défaut, projets antérieurs aux comptes).
- Un administrateur peut créer des comptes (`POST /api/admin/users`) même quand les inscriptions sont fermées.

### Rôles dans un projet

| Rôle | Lire (projet, fichiers, versions, vignettes, présence, WebSocket) | Modifier (fichiers, opérations, versions, renommer le projet) | Gérer les membres, supprimer le projet |
|---|---|---|---|
| `viewer` (lecteur) | oui | non | non |
| `editor` (éditeur) | oui | oui | non |
| `owner` (propriétaire) | oui | oui | oui |

- Créer un projet en fait son `owner`. Un projet ou un fichier d'un projet dont on n'est pas membre répond **404**
  (comme s'il n'existait pas). Une écriture par un `viewer` répond **403** « Lecture seule : tu n'as pas les droits de
  modification sur ce projet ».
- Déplacer un fichier vers un autre projet exige d'être au moins `editor` dans les deux.
- Un projet garde toujours au moins un `owner` : retirer ou rétrograder le dernier répond 400
  « Un projet doit garder au moins un propriétaire ».
- L'administrateur n'a pas de droits particuliers sur les projets des autres (il crée des comptes, c'est tout).

### Routes

| Méthode et chemin | Corps | Réponse |
|---|---|---|
| `GET /api/auth/config` | | `{"signup": bool, "hasUsers": bool}` (public) — `signup` vaut true si `register` est possible maintenant |
| `POST /api/auth/register` | `{"email","name","password"}` | `User` + cookie de session |
| `POST /api/auth/login` | `{"email","password"}` | `User` + cookie de session |
| `POST /api/auth/logout` | | `{"ok":true}`, session supprimée, cookie effacé (`Max-Age=0`) |
| `GET /api/auth/me` | | `User` (401 sinon) |
| `PATCH /api/auth/me` | `{"name"?, "password"?, "currentPassword"?}` | `User` ; changer de mot de passe exige `currentPassword` correct (403 « Mot de passe actuel incorrect ») et ferme les autres sessions |
| `GET /api/auth/tokens` | | `[{"id","name","createdAt","lastUsedAt"}]` |
| `POST /api/auth/tokens` | `{"name"}` | `{"id","name","createdAt","lastUsedAt":null,"token"}` (le seul moment où le jeton est visible) |
| `DELETE /api/auth/tokens/:id` | | `{"ok":true}` (404 si ce n'est pas un de ses jetons) |
| `GET /api/admin/users` | | `[User]` (403 si pas administrateur) |
| `POST /api/admin/users` | `{"email","name","password","isAdmin"?}` | `User` (403 si pas administrateur) |
| `GET /api/projects/:id/members` | | `[{"userId","email","name","role"}]` (tout membre) |
| `POST /api/projects/:id/members` | `{"email","role"}` | `Member` ; `owner` seulement ; 404 « Aucun compte avec cette adresse » ; si déjà membre, son rôle est mis à jour |
| `PATCH /api/projects/:id/members/:userId` | `{"role"}` | `Member` ; `owner` seulement |
| `DELETE /api/projects/:id/members/:userId` | | `{"ok":true}` ; `owner`, ou soi-même (quitter le projet) |

- `User` : `{"id","email","name","isAdmin","createdAt"}`. `Member` : `{"userId","email","name","role"}`.
- `GET /api/projects` ne liste que les projets dont on est membre ; chaque `Project` gagne `"role"`.
- `GET /api/files/:id` renvoie aussi `"role"` (le rôle de la personne dans le projet du fichier).
- `PATCH /api/projects/:id` (renommer) : `editor` ou `owner`. `DELETE /api/projects/:id` : `owner`.
- `GET /api/active-file` : le dernier fichier ouvert ou modifié **par cette personne** (404 sinon).

### Effets sur le WebSocket et le relais

- `/ws` : identification par le cookie (même origine) ou l'en-tête `Authorization` ; sinon la connexion est refusée
  (HTTP 401 avant l'upgrade). Fichier inaccessible → message `error` « Fichier introuvable » puis fermeture.
  Le nom affiché dans la présence est celui du compte (le paramètre `name` est ignoré) ; `user` (identifiant d'onglet)
  sert toujours à la présence et aux piles d'annulation, préfixé en interne par l'id du compte pour qu'un compte ne
  puisse pas annuler à la place d'un autre. Un `viewer` reçoit tout mais ses `ops`, `undo` et `redo` répondent
  `error` « Lecture seule : … » (sans resynchronisation). La présence gagne `"userId"` (id du compte) pour chaque entrée.
- `/mcp` et `/api/ai/*` : 401 sans identification valide ; sinon relayés au service MCP/IA avec les en-têtes
  `Authorization` et `Cookie` d'origine, que le service réutilise pour appeler l'API du hub : il agit avec les droits
  de la personne.
- Les lots REST (`POST /api/files/:id/ops`) entrent dans la pile d'annulation de `origin` préfixé par l'id du compte.
