# ✦ Nyota

**Un outil de design d'interface pensé pour l'IA dès la première ligne de code.**
Statique et léger : frames, formes, vecteurs, images, textes, couleurs, dégradés, ombres, radius.
Pas d'animation ni de prototypage.

L'humain et l'IA travaillent **dans les deux sens, sur le même document, avec les mêmes outils** :

- **Capture d'écran → design** : colle une capture (Ctrl+V) et l'IA la reconstruit en calques éditables.
- **Texte → design** : « page de paiement Mobile Money, style moderne ».
- **SVG → maquette** : importe un SVG (export Figma, Illustrator, Inkscape…) ; il devient une maquette éditable, calques et noms compris.
- **Design → React** : export en `.zip` d'un projet Vite, **un composant par élément** (voir plus bas).
- **Design → HTML/CSS** : export rapide d'une frame.
- **Serveur MCP intégré** : Claude Code, Claude Desktop, Cursor ou toute IA compatible MCP peut lire et dessiner dans ton document, en direct.

## Architecture

```
packages/core     Modèle de document, opérations (avec annulation), OUTILS DE DESIGN, export HTML/CSS
apps/server       Document de référence + WebSocket + serveur MCP (/mcp) + agent IA intégré (/api/ai/design)
apps/editor       Éditeur React + Konva (canevas, calques, propriétés, onglet Code, panneau IA, import SVG)
```

Le principe clé : **une seule définition des outils** (`packages/core/src/tools.ts`), utilisée par :

| Qui | Par où |
|---|---|
| L'utilisateur | l'éditeur → opérations → WebSocket |
| L'agent intégré (capture d'écran) | API Claude, tool use |
| N'importe quelle IA externe | MCP |

Toute modification devient une **opération** (`create`, `update`, `delete`, `move`) appliquée par le serveur,
diffusée à tous les éditeurs ouverts et ajoutée à l'historique. Donc Ctrl+Z annule aussi ce que l'IA a fait.

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

| SVG | Devient dans Nyota |
|---|---|
| `<g>` | frame (sans fond) ; avec un masque ou un `clip-path`, frame qui rogne (ex. avatar rond) |
| `<rect>` | rectangle avec radius, ou **image** s'il est rempli par un motif d'image |
| `<circle>`, `<ellipse>` | ellipse |
| `<path>`, `<polygon>`, `<line>`… | **vecteur** (le tracé d'origine est conservé) |
| `<image>` | **image** |
| `<text>` | texte (même dégradé : `background-clip: text` à l'export) |
| `fill="url(#…Gradient)"` | **dégradé** linéaire ou radial |
| `filter` (ombres Figma) | **ombres portées et internes**, valeurs exactes (décalage, flou, étendue, couleur) |

Les noms de calques (attribut `id`, comme dans les exports Figma) sont conservés et deviennent les noms des
composants React. Les images gardent leur recadrage exact, et les textes multi-lignes leur interligne
(calculé à partir des métriques de la police).

Testé sur deux exports Figma, en comparant pixel par pixel l'export React au SVG d'origine :

| Maquette | Calques | Pixels différents |
|---|---|---|
| Tableau de bord (1440×900, textes vectorisés, avatars masqués, dégradés) | 188 | 0,72 % |
| Page d'accueil (1440×4388, 93 textes, 9 photos recadrées, 7 ombres, texte en dégradé) | 253 | 0,07 % |

Les écarts restants viennent du lissage des contours du texte.

Limites actuelles : les flous de calque et d'arrière-plan sont ignorés, un dégradé radial tourné perd sa rotation,
et un masque en forme libre est approché par sa boîte englobante.

## Dégradés et ombres

Chaque élément peut avoir un **dégradé** (linéaire ou radial, autant d'arrêts que voulu) et des **ombres**
(portées ou internes, cumulables), éditables dans les sections *Remplissage* et *Effets* du panneau Design.
Les coordonnées d'un dégradé sont en fractions de la boîte de l'élément : il suit les redimensionnements.

À l'export, un dégradé linéaire est converti en `linear-gradient` CSS **exact** (angle et position des arrêts
recalculés pour la taille de l'élément) ; les ombres deviennent `box-shadow` (ou `filter: drop-shadow` pour les
vecteurs, textes et frames sans fond, qui suit leur contour). Les IA y ont accès via les outils MCP.

## Démarrer

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # pour l'agent intégré (le MCP fonctionne sans)
npm run dev
```

- Éditeur : http://localhost:5173
- MCP : http://localhost:4000/mcp

Brancher Claude Code sur ton document :

```bash
claude mcp add --transport http nyota http://localhost:4000/mcp
```

Puis par exemple : *« Dans Nyota, crée un écran de connexion pour une app de tontine, puis aligne les champs sur une grille de 8 px. »*

## Raccourcis

| Touche | Action |
|---|---|
| V F R O T H | Sélection, Frame, Rectangle, Ellipse, Texte, Main |
| Espace + glisser / molette | Déplacer le canevas |
| Ctrl + molette | Zoom |
| Ctrl+Z / Ctrl+Shift+Z | Annuler / Rétablir |
| Ctrl+D | Dupliquer |
| Suppr | Supprimer |
| Flèches (+Maj) | Décaler de 1 px (10 px) |
| Double-clic sur un texte | Éditer |
| Ctrl+V avec une image | Envoyer la capture à l'IA |
| Ctrl+V avec du code SVG | Importer comme maquette |
| Maj+1 / Maj+2 / Maj+0 | Tout afficher / Cadrer la sélection / Zoom 100 % |

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Clé API pour l'agent intégré |
| `NYOTA_MODEL` | `claude-opus-5-5` | Modèle utilisé par l'agent |
| `PORT` | `4000` | Port du serveur |
| `NYOTA_DATA` | `data/document.json` | Fichier de sauvegarde du document |

## Feuille de route

- [ ] Auto-layout (flexbox) et contraintes
- [ ] Composants et instances, styles de couleur/texte partagés
- [ ] Images importées, icônes vectorielles, chemins (plume)
- [ ] Outil `get_screenshot` : l'IA voit le rendu et corrige elle-même son design
- [ ] Export Flutter / React / Jetpack Compose
- [ ] Multi-documents, collaboration temps réel (CRDT / Yjs)
- [ ] Mode hors ligne (PWA) et modèles locaux pour la souveraineté des données
