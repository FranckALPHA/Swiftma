# Plugins Swiftma

Un plugin ajoute une source de contenu ou un outil à l'éditeur : icônes, photos, illustrations, graphiques, faux
texte, vérification d'accessibilité… Il dessine dans le fichier ouvert avec **les mêmes outils que l'IA et le MCP**,
et tout ce qu'il fait s'annule avec Ctrl+Z, se voit en temps réel chez les autres et respecte les droits (un lecteur
ne peut rien modifier, même par un plugin).

Swiftma livre une **bibliothèque** de plugins prêts à l'emploi (onglet Plugins → Bibliothèque) : Iconify, Photos,
Avatars, Contenu réaliste, Graphiques, QR code, Textures et fonds, Palettes, Contraste. Leur code
(`apps/editor/public/plugins/`) sert d'exemples complets.

## Ce qu'est un plugin

Deux fichiers, hébergés où vous voulez (GitHub Pages, Netlify, votre serveur…) :

- un **manifeste** JSON ;
- une **page web** (HTML, CSS, JavaScript), affichée dans le panneau Plugins.

```json
{
  "id": "mon-plugin",
  "name": "Mon plugin",
  "description": "Ce qu'il apporte, en une phrase.",
  "main": "index.html",
  "permissions": ["read", "write"],
  "author": "Vous",
  "homepage": "https://exemple.org"
}
```

| Champ | Rôle |
|---|---|
| `id` | identifiant unique : minuscules, chiffres, `.` `_` `-` |
| `name`, `description` | affichés dans la liste des plugins |
| `main` | la page du plugin, relative au manifeste ou absolue (http/https) |
| `permissions` | `read` : lire le fichier et la sélection ; `write` : créer et modifier des éléments |

Le manifeste doit être servi en HTTPS (sauf en local) **avec l'en-tête CORS** `Access-Control-Allow-Origin: *`,
pour que l'éditeur puisse le lire.

## Sécurité

La page tourne dans une iframe `sandbox` **sans** `allow-same-origin` : son origine est opaque. Elle n'a accès ni à la
session de la personne, ni aux cookies, ni à l'API de l'instance, ni aux autres fichiers. Elle ne parle à Swiftma que
par `postMessage`, et Swiftma refuse toute méthode qui demande une permission non déclarée dans le manifeste. Les SVG
reçus sont nettoyés (scripts, gestionnaires `on…`, liens `javascript:`) avant d'entrer dans la page.

Avant d'ajouter un plugin, la personne voit son nom, son hôte et ses permissions.

## L'API (version 1)

Incluez le SDK, servi par chaque instance :

```html
<script src="https://VOTRE-INSTANCE/plugins/swiftma-plugin.js"></script>
```

Il expose `swiftma.call(méthode, paramètres)` (une promesse) et `swiftma.on(événement, fonction)`.

| Méthode | Permission | Paramètres | Résultat |
|---|---|---|---|
| `getInfo` | — | — | `{ apiVersion, editor, tools }` : la liste des outils de design disponibles |
| `notify` | — | `{ message }` | affiche un court message dans le panneau |
| `getSelection` | `read` | — | les nœuds sélectionnés, avec leurs enfants |
| `getDocument` | `read` | — | `{ name, tree }` : tout le fichier |
| `select` | `read` | `{ ids }` | sélectionne ces nœuds |
| `insertSvg` | `write` | `{ svg, name, scaleWithFrame? }` | `{ id }` : le SVG devient des calques éditables, dans la frame sélectionnée ou au centre de la vue ; `scaleWithFrame` (vrai par défaut) : ses tracés suivent le redimensionnement |
| `insertImage` | `write` | `{ url, name, width?, height? }` | `{ id }` : une image `https:` (avec CORS) ou `data:image/…` ; `width`/`height` : taille d'affichage (une texture générée en basse définition, affichée en grand) |
| `runTool` | `write` | `{ name, input }` | le résultat de l'outil : **les mêmes outils que le MCP** (`create_nodes`, `update_nodes`, `add_auto_layout`, `group_nodes`, `reorder_nodes`, `export_react`…) avec les mêmes paramètres |

Événement : `selection`, avec la liste des identifiants sélectionnés, à chaque changement (plugins `read`).

Une erreur (permission manquante, fichier en lecture seule, paramètres invalides) rejette la promesse avec un message
lisible.

### Exemple : un plugin « Bouton »

```html
<!doctype html>
<meta charset="utf-8" />
<button id="go">Ajouter un bouton</button>
<script src="https://VOTRE-INSTANCE/plugins/swiftma-plugin.js"></script>
<script>
  document.getElementById("go").onclick = async () => {
    await swiftma.call("runTool", {
      name: "create_nodes",
      input: {
        nodes: [
          {
            ref: "bouton", type: "frame", name: "Bouton", fill: "#0A84FF", radius: 12,
            layout: { direction: "row", gap: 8, padding: [12, 20, 12, 20], justify: "center", align: "center" },
            sizingH: "hug", sizingV: "hug",
          },
          {
            ref: "libelle", parent: "bouton", type: "text", name: "Libellé",
            text: { content: "Payer", color: "#FFFFFF", fontSize: 15, fontWeight: 600 },
            sizingH: "hug", sizingV: "hug",
          },
        ],
      },
    });
    swiftma.call("notify", { message: "Bouton ajouté" });
  };
</script>
```

Les paramètres exacts de chaque outil sont ceux du MCP : `packages/core/src/tools.ts`.

## Installer un plugin

- **Pour soi** : onglet **Plugins** → **+** → URL du manifeste. Le plugin est enregistré dans ce navigateur.
- **Pour toute l'instance** (administrateur) : la liste vient de `plugins.json`, servi à la racine de l'éditeur.
  Avec Docker, remplacez-le par votre propre fichier :

  ```yaml
  # docker-compose.yml, service swiftma
  volumes:
    - ./plugins.json:/app/apps/editor/dist/plugins.json:ro
  ```

  ```json
  { "plugins": ["/plugins/iconify/manifest.json", "https://exemple.org/mon-plugin/manifest.json"] }
  ```

Pour retirer Iconify (par exemple sur une instance sans accès à internet), enlevez-le de cette liste.

La **bibliothèque** proposée à chacun vient de `plugins/catalog.json` (plugins rangés par catégorie), remplaçable de
la même façon : `./catalog.json:/app/apps/editor/dist/plugins/catalog.json:ro`. Iconify, Photos, Avatars et QR code
ont besoin d'internet ; les autres fonctionnent hors ligne.

## Développer un plugin

Servez votre dossier en local (`npx serve .` ou `python -m http.server`) et ajoutez
`http://localhost:PORT/manifest.json` dans l'onglet Plugins de votre éditeur de développement (`npm run dev`).
