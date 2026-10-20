<p align="center"><b>✦ Swiftma</b></p>

<p align="center">
  <b>L'outil de design d'interface libre, pensé pour l'IA, que vous hébergez vous-même.</b><br>
  <a href="README.md">English</a> · <b>Français</b> · <a href="#démarrer">Démarrer</a> · <a href="docs/hub.md">Contrat du hub</a> · <a href="CONTRIBUTING.md">Contribuer</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="Licence AGPL-3.0" src="https://img.shields.io/badge/licence-AGPL--3.0-blue"></a>
  <a href="https://github.com/FranckALPHA/swiftma/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/FranckALPHA/swiftma/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="MCP" src="https://img.shields.io/badge/MCP-natif-7c3aed">
  <img alt="Auto-hébergé" src="https://img.shields.io/badge/auto--h%C3%A9berg%C3%A9-Docker-0db7ed">
</p>

![L'éditeur Swiftma : un écran d'app de tontine dessiné par une IA via MCP, en auto-layout](docs/images/editor.png)

## Pourquoi Swiftma

Les outils de design sont devenus des abonnements par siège, hébergés ailleurs, où vos maquettes, vos composants et
votre savoir-faire vivent chez un fournisseur. Pendant ce temps, les agents IA savent désormais lire, dessiner et
coder : la valeur se déplace du « siège loué » vers **les données, les outils ouverts et les agents qui les
utilisent**. C'est ce que beaucoup appellent la *SaaSpocalypse*.

Swiftma est notre réponse, construite au Cameroun avec l'ambition de servir partout :

- **Souverain** : une image Docker sur votre serveur (école, entreprise, administration, VPS). Vos fichiers restent
  chez vous, dans une base SQLite que vous pouvez sauvegarder et lire.
- **L'IA comme utilisatrice à part entière** : un serveur **MCP** intégré ; Claude Code, Claude Desktop, Cursor ou
  tout agent compatible dessine dans vos fichiers **avec les mêmes outils que vous**, en direct, avec vos droits.
- **Du design au code** : export React (un composant par élément, flexbox responsive, design tokens) et HTML/CSS.
- **Libre pour de bon** : licence **AGPL-3.0**. Toute version modifiée proposée en ligne doit publier son code :
  les améliorations reviennent à tout le monde.

Statique et léger : frames, formes, vecteurs, images, textes, couleurs, dégradés, ombres, radius.
Pas d'animation ni de prototypage.

L'humain et l'IA travaillent **dans les deux sens, sur le même document, avec les mêmes outils** :

- **Capture d'écran → design** : dans l'onglet IA, colle une capture (Ctrl+V) et l'IA la reconstruit en calques éditables. Ailleurs, l'image collée devient un calque à décalquer.
- **Texte → design** : « page de paiement Mobile Money, style moderne ».
- **SVG → maquette** : importe un SVG (export Figma, Illustrator, Inkscape…) ; il devient une maquette éditable, calques et noms compris.
- **Design → React** : export en `.zip` d'un projet Vite, **un composant par élément** (voir plus bas).
- **Design → HTML/CSS** : export rapide d'une frame.
- **Serveur MCP intégré** : Claude Code, Claude Desktop, Cursor ou toute IA compatible MCP peut lire et dessiner dans tes fichiers, en direct.
- **Comme un outil pro** : auto-layout, contraintes, composants et variantes, styles partagés, projets,
  collaboration temps réel, historique des versions — backend en Rust, auto-hébergeable avec Docker.

## Architecture

```
packages/core     Modèle de document, opérations (avec annulation), auto-layout, contraintes, composants,
                  styles partagés, OUTILS DE DESIGN, exports React et HTML/CSS (TypeScript)
apps/hub          Backend en Rust (axum, SQLite) : projets, fichiers, versions, collaboration temps réel,
                  sert l'éditeur compilé et relaie le service MCP/IA — contrat : docs/hub.md
apps/server       Service MCP/IA (TypeScript) : serveur MCP (/mcp) et agent « capture d'écran → design »
apps/editor       Éditeur React + Konva : écran Projets, canevas, calques, composants, propriétés, code
```

```
 Éditeur ──WebSocket──┐          ┌──────────────┐
 Éditeur ──WebSocket──┼─────────▶│  Hub (Rust)  │── SQLite
 IA (MCP) ──/mcp──────┘          └──────┬───────┘
                                        │ relaie /mcp et /api/ai/*
                                 Service MCP/IA (Node)
```

Le principe clé : **une seule définition des outils** (`packages/core/src/tools.ts`), utilisée par :

| Qui | Par où |
|---|---|
| L'utilisateur | l'éditeur → opérations → WebSocket du hub |
| L'agent intégré (capture d'écran) | API Claude, tool use → API du hub |
| N'importe quelle IA externe | MCP → API du hub |

Toute modification devient une **opération** (`create`, `update`, `delete`, `move`, `set-doc`). Le client applique
les règles du design (auto-layout, instances, styles) et envoie au hub un lot **résolu** ; le hub, qui ne connaît
pas le design, l'applique de façon générique, le diffuse à tous les éditeurs du fichier et l'ajoute à l'historique
de son auteur. Chacun annule ses propres actions ; Ctrl+Z annule aussi ce que l'IA a fait à ta demande.

## Collaboration et projets

- **Projets et fichiers** : écran d'accueil avec vignettes ; créer, renommer, dupliquer, supprimer, importer un SVG.
- **Temps réel** : plusieurs personnes (et des IA) sur le même fichier ; curseurs, sélections et avatars des autres.
  Les modifications simultanées convergent : nos lots en attente sont rejoués par-dessus l'état du hub.
- **Historique des versions** : versions nommées et sauvegardes automatiques, restaurables.
- **Brouillon hors ligne** : `/local` ouvre l'éditeur sans serveur ni compte (rien n'est sauvegardé).

## Comptes et droits d'accès

- **Comptes** par email et mot de passe (argon2). Le premier compte créé est **administrateur** et récupère les
  projets existants. Inscriptions ouvertes par défaut ; `SWIFTMA_SIGNUP=closed` les ferme (une école, une équipe) :
  l'administrateur crée alors les comptes (menu du compte → *Comptes de l'instance*).
- **Partage d'un projet** (bouton *Partager*) avec un rôle : **lecteur** (voit), **éditeur** (modifie),
  **propriétaire** (gère aussi les membres, supprime le projet). Un projet dont on n'est pas membre est invisible.
- **Jetons d'accès** pour les IA (MCP) et les scripts : menu du compte → *Jetons d'accès*. Un jeton a exactement les
  droits de son propriétaire et se révoque en un clic.
- **Mot de passe oublié** : l'administrateur crée un lien de réinitialisation (usage unique, 24 h) depuis
  *Comptes de l'instance*, ou sur le serveur : `swiftma-hub reset-password <email>`. Aucun SMTP à configurer.
- **Droits retirés en direct** : retirer un membre, révoquer un jeton ou fermer une session coupe immédiatement ses
  connexions temps réel ; un changement de rôle s'applique sans recharger.
- Sécurité : cookie de session `HttpOnly`, limitation des tentatives de connexion, empreintes des sessions, jetons et
  liens seulement en base. Derrière HTTPS, mettre `SWIFTMA_SECURE_COOKIES=1`.

## Plugins

Onglet **Plugins** de la barre de gauche : des sources de contenu et des outils ajoutés à l'éditeur. Swiftma livre
**Iconify** (plus de 200 000 icônes libres : Material, Lucide, Phosphor, Tabler, logos, drapeaux…), insérées en
vecteurs éditables qui se redimensionnent avec leur frame.

Un plugin est une page web dans un cadre isolé (iframe sandbox) : il dessine avec les mêmes outils que l'IA et le
MCP, donc tout s'annule avec Ctrl+Z et respecte les droits, mais il ne voit ni la session ni les autres fichiers.
L'administrateur choisit les plugins de l'instance (`plugins.json`) ; chacun peut en ajouter pour soi par l'URL de
leur manifeste. Écrire un plugin : [docs/plugins.md](docs/plugins.md).

## Composants et styles partagés

- **Composants** (Ctrl+Alt+K) : les instances suivent le composant principal ; modifier une instance crée une
  surcharge conservée (« Réinitialiser » pour revenir). **Variantes** (état, taille…) : on choisit la variante sur
  chaque instance, les textes surchargés sont gardés. Onglet *Composants* à gauche pour insérer.
- À l'export React, une instance devient `<Bouton etat="Survol" libelle="Payer" />` : le composant est défini une
  seule fois, ses textes deviennent des props.
- **Styles partagés** (couleurs, typographies, ombres) : liste quand rien n'est sélectionné, sélecteur ◆ dans les
  propriétés, détection automatique sur une maquette importée. À l'export : `src/styles/tokens.css` et `var(--…)`.
- **Contraintes** (gauche, droite, les deux, centre, échelle) et **tailles min/max** pour les éléments en position
  libre ; textes qui s'ajustent à leur contenu.

## Export React : un composant par élément

Un texte dans une frame, elle-même dans une autre frame, donne trois composants :

```
src/components/
  EcranAccueil/   EcranAccueil.jsx  EcranAccueil.module.css   ← importe et place CarteSolde
  CarteSolde/     CarteSolde.jsx    CarteSolde.module.css     ← importe et place Solde
  Solde/          Solde.jsx         Solde.module.css
STRUCTURE.md      ← l'arbre complet : qui contient qui
```

- Le CSS d'un composant décrit **son apparence** (taille, couleur, radius, police).
- Le CSS du **parent** décrit **où l'enfant est posé** (`left`, `top`, rotation), via la classe qu'il lui passe.
- Chaque fichier indique en en-tête son parent et ses enfants.
- Tous les composants acceptent `className` et `style`, les textes acceptent `text` et les conteneurs `children`.

On ne cherche pas à écrire une page « parfaite » d'un coup : on obtient des briques fidèles et indépendantes,
qu'on peut ensuite réorganiser (flexbox, données dynamiques…). Les IA y ont accès aussi via l'outil `export_react`.

## Import SVG

Trois façons : le bouton d'import du panneau Calques, glisser un `.svg` sur le canevas, ou coller du code SVG
(« Copier en SVG » dans Figma). Le navigateur calcule la géométrie exacte de chaque élément, puis :

| SVG | Devient dans Swiftma |
|---|---|
| `<g>` | frame (sans fond) ; avec un masque ou un `clip-path`, frame qui rogne selon la **forme exacte** du masque (avatar rond, étoile, anneau, forme tournée…) |
| `<rect>` | rectangle avec radius, ou **image** s'il est rempli par un motif d'image |
| `<circle>`, `<ellipse>` | ellipse |
| `<path>`, `<polygon>`, `<line>`… | **vecteur** (le tracé d'origine est conservé) |
| `<image>` | **image** |
| `<text>` | texte : polices Google chargées automatiquement, italique, alignement des lignes détecté, morceaux de ligne séparés gardés à leur place (même dégradé : `background-clip: text`) |
| `fill="url(#…Gradient)"` | **dégradé** linéaire ou radial |
| `filter` (effets Figma) | **ombres portées et internes** (décalage, flou, étendue, couleur) et **flou de calque** |
| `data-figma-bg-blur-radius` | **flou d'arrière-plan** (verre dépoli) |

Les noms de calques (attribut `id`, comme dans les exports Figma) sont conservés et deviennent les noms des
composants React. Les images gardent leur recadrage exact, et les textes multi-lignes leur interligne
(calculé à partir des métriques de la police).

Testé sur deux exports Figma, en comparant pixel par pixel l'export React au SVG d'origine :

| Maquette | Calques | Pixels différents |
|---|---|---|
| Tableau de bord (1440×900, textes vectorisés, avatars masqués, dégradés) | 188 | 0,72 % |
| Page d'accueil (1440×4388, 93 textes, 9 photos recadrées, 7 ombres, texte en dégradé) | 253 | 0,02 % |
| Portfolio (2048×3141, 69 textes en 5 polices dont italique, verre dépoli, contours intérieurs, masque en fondu) | 986 | 0,16 % |

| Effets (800×500 : verre dépoli, flou de calque, radial tourné, ombre de groupe) — [`examples/effets-figma.svg`](examples/effets-figma.svg) | 12 | 0,00 % (canevas : 0,01 %) |
| Masques (800×400 : étoile, anneau evenodd, goutte tournée) — [`examples/masques-figma.svg`](examples/masques-figma.svg) | 15 | 0,04 % (canevas : 0,00 %) |

Les écarts restants viennent du lissage des contours. Un masque de forme libre est exporté en CSS `mask`
(image SVG intégrée), exact même quand la forme est transformée ; un masque rempli d'un dégradé devient un fondu.

### Réglages d'export SVG dans Figma

Dans la section *Exporter* d'une frame, format SVG, menu « … » :

| Option (Figma en français) | Réglage |
|---|---|
| Inclure un attribut « id » | ✅ coché — garde les noms des calques (et donc des composants React) |
| Ébauche de texte (*Outline text*) | ❌ décoché — sinon les textes deviennent des dessins non modifiables |
| Ignorer les chevauchements de calques | ✅ coché |
| Inclure la zone de délimitation | ☐ décoché |
| Profil colorimétrique | sRGB |

## Dégradés et ombres

Chaque élément peut avoir un **dégradé** (linéaire ou radial, elliptique et tourné, autant d'arrêts que voulu),
des **ombres** (portées ou internes, cumulables), un **flou de calque** et un **flou d'arrière-plan** (verre dépoli),
éditables dans les sections *Remplissage* et *Effets* du panneau Design.
Les coordonnées d'un dégradé sont en fractions de la boîte de l'élément : il suit les redimensionnements.

À l'export, un dégradé linéaire est converti en `linear-gradient` CSS **exact** (angle et position des arrêts
recalculés pour la taille de l'élément) ; un radial tourné, que CSS ne sait pas exprimer, devient une image SVG
intégrée, exacte. Les ombres deviennent `box-shadow` (ou `filter: drop-shadow` pour les vecteurs, textes et frames
sans fond, qui suit leur contour), les flous `filter: blur` et `backdrop-filter: blur`. Les IA y ont accès via MCP.

## Auto-layout et code responsive

Une frame peut avoir un **auto-layout**, comme dans Figma : ses enfants s'empilent tout seuls en ligne ou en
colonne, avec un espacement, des marges internes, un alignement (grille 3×3), une répartition de l'espace et un
retour à la ligne. Chaque élément a un **dimensionnement** par axe : *Fixe*, *Remplir* (prend la place libre du
parent) ou *Ajuster* (une frame prend la taille de son contenu). Un enfant peut sortir du flux (*position absolue*).

- **Maj+A** : sur une frame, devine son auto-layout d'après la disposition de ses enfants ; sur une sélection,
  l'englobe dans une nouvelle frame en auto-layout. Glisser un élément dans un auto-layout change son ordre.
- **Rendre responsive** (section *Exporter*) : convertit une maquette importée sans rien déplacer. Chaque zone
  régulière (lignes, colonnes, à 1 px près) passe en auto-layout, les fonds de frame exportés par Figma redeviennent
  des fonds, les éléments pleine largeur passent en *Remplir*, les rangées passent à la ligne quand la place
  manque, et la racine prend toute la largeur de l'écran. Les zones irrégulières (texte posé sur une image…)
  gardent leurs positions : à régler à la main.
- Le moteur de mise en page (`packages/core/src/layout.ts`) tourne après chaque opération, à l'identique dans
  l'éditeur et sur le serveur ; Ctrl+Z restaure aussi les positions qu'il a changées.
- À l'export, l'auto-layout devient du **flexbox** (`display: flex`, `gap`, `padding`, `flex: 1 1 0`,
  `align-self: stretch`, `flex-wrap`) : le code s'adapte à la largeur de l'écran.
- Les IA (MCP et agent intégré) créent directement des frames en auto-layout, sans calculer de coordonnées, et ont
  les outils `add_auto_layout` et `make_responsive`.

## Démarrer

Prérequis : Node 22 et Rust (stable).

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # facultatif : l'agent intégré (le MCP fonctionne sans)
npm run dev        # hub Rust (:4000) + service MCP/IA (:4001) + éditeur (:5173)
npm test           # tests du cœur (auto-layout, contraintes, composants, styles, lots résolus)
npm run test:hub   # tests du hub Rust
```

- Éditeur : http://localhost:5173
- MCP : http://localhost:4000/mcp

### Avec Docker (une commande, données dans un volume)

```bash
docker compose up -d          # → http://localhost:4000 (éditeur, API et MCP sur le même port)
```

Image seule : `docker build -t swiftma . && docker run -p 4000:4000 -v swiftma-data:/data swiftma`.

### En ligne, en HTTPS (certificat automatique)

Sur un serveur dont le nom de domaine pointe vers lui (ports 80 et 443 ouverts) :

```bash
cp .env.example .env      # renseigner SWIFTMA_DOMAIN et SWIFTMA_PUBLIC_URL
docker compose --profile https up -d      # → https://votre-domaine (Caddy + Let's Encrypt)
```

Le fichier `.env.example` active déjà `SWIFTMA_SECURE_COOKIES=1` et ferme les inscriptions
(`SWIFTMA_SIGNUP=closed`) : le premier compte créé est administrateur et invite les autres. Pensez à fermer le port
4000 au public (pare-feu) : tout passe par Caddy. Avec Nginx ou un autre proxy, relayer aussi les WebSocket (`/ws`).

Administrateur sans accès à son compte :

```bash
docker compose exec swiftma swiftma-hub reset-password admin@exemple.cm   # affiche un lien à usage unique
```

Brancher Claude Code sur Swiftma (créer d'abord un jeton : menu du compte → *Jetons d'accès*) :

```bash
claude mcp add --transport http swiftma http://localhost:4000/mcp \
  --header "Authorization: Bearer swiftma_…"
```

Puis par exemple : *« Dans Swiftma, crée un écran de connexion pour une app de tontine, en auto-layout, avec un
composant Bouton à deux variantes. »* Les outils agissent sur le fichier ouvert dans l'éditeur (ou `open_file`).

### Tests

- `npm test`, `npm run test:hub` : unitaires et intégration.
- `npm run fidelity -- dossier/svg [--canvas] [--responsive] [--styles]` : banc de fidélité pixel par pixel
  (voir `tests/fidelity/README.md`).
- `node tests/e2e/collaboration.mjs` (avec `npm run dev` lancé) : deux personnes et une IA sur le même fichier.
- La CI GitHub (`.github/workflows/ci.yml`) lance tout cela, plus la construction de l'image Docker.

## Raccourcis

| Touche | Action |
|---|---|
| V F R O T H | Sélection, Frame, Rectangle, Ellipse, Texte, Main |
| Espace + glisser / molette | Déplacer le canevas |
| Ctrl + molette | Zoom |
| Ctrl+Z / Ctrl+Shift+Z | Annuler / Rétablir |
| Ctrl+C / Ctrl+X / Ctrl+V | Copier / Couper / Coller (aussi d'un onglet ou d'un fichier à l'autre) |
| Ctrl+D | Dupliquer |
| Ctrl+Maj+H / Ctrl+Maj+L | Masquer / Verrouiller |
| Glisser dans une frame | L'élément y entre ; hors de la frame, il en sort. Tracer une frame autour d'éléments les englobe |
| Suppr | Supprimer |
| Flèches (+Maj) | Décaler de 1 px (10 px) |
| Double-clic sur un texte | Éditer |
| Ctrl+V avec une image | La poser sur le canevas comme calque (onglet IA ouvert : l'envoyer à l'IA) |
| Ctrl+V avec du code SVG | Importer comme maquette |
| Maj+1 / Maj+2 / Maj+0 | Tout afficher / Cadrer la sélection / Zoom 100 % |
| Maj+A | Ajouter un auto-layout (frame) ou englober la sélection dans un auto-layout |
| Alt+Maj+A | Retirer l'auto-layout (les éléments restent à leur place) |
| Ctrl+G / Ctrl+Maj+G | Grouper / Dissocier (groupe ou auto-layout) |
| Ctrl+↑ / Ctrl+↓ | Avancer / Reculer d'un cran |
| Ctrl+Maj+↑ / Ctrl+Maj+↓ | Premier plan / Arrière-plan |
| Clic droit | Menu de l'élément (ordre, groupe, auto-layout, composant…) |
| F | Outil Frame : formats prêts à l'emploi dans le panneau de droite (téléphone, ordinateur, réseaux sociaux…) |

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Clé API pour l'agent intégré (service MCP/IA) |
| `SWIFTMA_MODEL` | (voir `apps/server/src/agent.ts`) | Modèle Claude utilisé par l'agent |
| `PORT` | `4000` (hub), `4001` (service MCP/IA) | Ports |
| `SWIFTMA_DB` | `data/swiftma.db` | Base SQLite du hub |
| `SWIFTMA_STATIC` | — | Éditeur compilé servi par le hub (production) |
| `SWIFTMA_MCP_URL` | — | Adresse du service MCP/IA, relayé par le hub |
| `SWIFTMA_HUB_URL` | `http://localhost:4000` | Adresse du hub, pour le service MCP/IA |
| `SWIFTMA_SIGNUP` | `open` | `closed` : seul le premier compte s'inscrit, l'administrateur crée les autres |
| `SWIFTMA_SECURE_COOKIES` | `0` | `1` derrière HTTPS (cookie de session `Secure`) |
| `SWIFTMA_PUBLIC_URL` | `http://localhost:4000` | Adresse publique, pour les liens de `swiftma-hub reset-password` |
| `SWIFTMA_DOMAIN` | `localhost` | Domaine servi par Caddy (profil `https` de docker compose) |

## Feuille de route

- [x] Auto-layout (flexbox) et code responsive
- [x] Contraintes et tailles min/max
- [x] Composants, instances et variantes ; styles partagés (design tokens)
- [x] Projets, collaboration temps réel, historique des versions (hub Rust)
- [x] Image Docker et CI
- [x] Comptes, partage par projet (lecteur, éditeur, propriétaire), jetons d'accès pour les IA
- [x] Mot de passe oublié (liens de réinitialisation), droits retirés en direct, HTTPS automatique (Caddy)
- [ ] Diagrammes UML générés par l'IA (fusion d'Easy Analyst : cas d'utilisation, classes, séquences, activités)
- [ ] Envoi des liens par email (SMTP facultatif)
- [ ] Outil `get_screenshot` : l'IA voit le rendu et corrige elle-même son design
- [ ] Outil plume, édition des points d'un vecteur
- [ ] Export Flutter / Jetpack Compose
- [ ] Mode hors ligne (PWA) et modèles locaux pour la souveraineté des données

## Contribuer

Les contributions sont les bienvenues : code, traductions, retours d'usage, maquettes de test. Lire
[CONTRIBUTING.md](CONTRIBUTING.md) et le [code de conduite](CODE_OF_CONDUCT.md). Faille de sécurité : voir
[SECURITY.md](SECURITY.md) (jamais dans une issue publique).

## Licence

Swiftma est un logiciel libre sous licence [GNU Affero General Public License v3.0](LICENSE).
Vous pouvez l'utiliser, l'étudier, le modifier et le redistribuer. Si vous proposez une version modifiée à des
utilisateurs à travers un réseau (un service en ligne), vous devez leur donner accès à son code source
(l'éditeur affiche un lien « Code source »).
