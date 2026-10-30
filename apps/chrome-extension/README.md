# Extension Chrome « HTML vers Swiftma »

Cette première version capture le DOM visible dans l’onglet courant et télécharge un fichier `.swiftma.json`.
Swiftma importe ce fichier en calques éditables, sans serveur intermédiaire et sans envoyer la page à un service tiers.

## Installation locale

1. Ouvrir `chrome://extensions` dans Chrome et activer le **Mode développeur**.
2. Choisir **Charger l’extension non empaquetée** et sélectionner ce dossier.
3. Ouvrir une page web, cliquer sur l’extension puis sur **Capturer cette page**.
4. Importer le fichier `.swiftma.json` avec **Importer SVG / capture Chrome** dans l’écran du projet, ou avec le bouton d’import des calques dans un fichier Swiftma.

## Modes de capture

1. **Capturer la fenêtre visible** : capture fidèlement la portion affichée à l’écran.
2. **Capturer la page entière** : capture toute la hauteur et largeur (`scrollWidth`/`scrollHeight`), idéal pour les landing pages complètes.
3. **Sélectionner un composant (Inspecteur)** : met en surbrillance interactive les éléments au survol de la souris. Un simple clic isole et capture uniquement le composant souhaité (carte, navbar, formulaire, footer). Échap permet d'annuler.

## Portée actuelle

- Modes de capture : fenêtre visible, page entière défilable, ou composant isolé sous la souris.
- Reproduit les blocs HTML visibles, les textes, couleurs CSS modernes (dont `oklch()`), bordures, rayons, opacités, images `<img>` (y compris data URLs).
- Capture les logos et icônes vectorielles SVG inline avec sérialisation autonome (définitions `<use>`, `currentColor`, viewBox).
- Capture les éléments `<canvas>` et les images d'arrière-plan CSS (`background-image: url(...)`).
- Capture les bordures asymétriques ou par côté (`border-top`, `border-bottom`, etc.) sous forme de sous-calques de séparation exacts.
- Capture les pseudo-éléments CSS `::before` et `::after` (polices d'icônes, badges, puces décoratives).
- Capture les ombres CSS portées et internes, y compris les ombres multiples avec couleurs alpha.
- Convertit les dégradés CSS linéaires et radiaux courants en calques, y compris les arrêts transparents.
- Convertit les conteneurs Flexbox simples (`row`/`column`) en auto-layout Swiftma, avec gap, padding, alignement et éléments absolus.
- Le wrap est converti uniquement avec un alignement des lignes au départ ; direction RTL, propriétés `order` et alignements individuels gardent le rendu capturé en positions fixes.
- Les textes masqués par `clip`/`clip-path` ou par les techniques usuelles de texte accessible masqué ne sont pas exportés.
- Les conteneurs Grid, distributions Flexbox non représentables et layouts complexes conservent leurs positions capturées.
- Les wrappers DOM sans boîte visible (par exemple `display: contents`) sont aplatis afin de conserver leurs descendants visibles.
- Les iframes, médias audio/vidéo et certains effets CSS 3D sont ignorés.
- Les images distantes restent référencées par leur URL d’origine ou intégrées en data URLs ; l’éditeur les chargera directement.
- La capture est limitée à 12 000 éléments et l’import à 20 Mo.

L’extension demande uniquement `activeTab`, `scripting` et `downloads`. Le contenu capturé reste dans le navigateur jusqu’au téléchargement local ; les références d’images externes restent toutefois des URL vers leurs hôtes d’origine.
