# Banc de fidélité

Vérifie automatiquement que Nyota reproduit un SVG à l'identique :

1. le SVG passe par le **vrai** import de l'éditeur (`apps/editor/test/harness.ts`) ;
2. le document obtenu est exporté en projet React (un composant par calque) ;
3. ce projet est rendu dans Chromium ;
4. le rendu est comparé pixel par pixel au SVG d'origine, rendu par le même navigateur avec les mêmes polices.

Score d'un fichier = pixels très différents (écart > 64/255 sur un canal) ÷ pixels dessinés (non blancs).
« Fidèle » = score ≤ 2 %. Les petits fichiers sont rendus en haute densité (jusqu'à ×8) pour que la mesure soit sévère.

```bash
npm install                                  # à la racine
(cd tests/fidelity/harness && npm install)   # mini-application de rendu
npx playwright install chromium              # ou CHROMIUM_PATH=/chemin/vers/chromium
npm run fidelity -- dossier/de/svg autre.svg --jobs 4
```

Résultats dans `tests/fidelity/results/<date>/` : `results.jsonl` (un cas par ligne), `summary.md`
(synthèse par dossier) et `fail-XXXX.png` pour chaque écart (original | Nyota | écarts en rouge).

## Canevas de l'éditeur (`--canvas`)

```bash
npm run fidelity -- dossier/de/svg --canvas
```

Au lieu de l'export React, compare ce que **l'éditeur affiche** : la page de l'éditeur est ouverte,
le SVG importé comme par un glisser-déposer, la vue mise à l'échelle 1, et la zone du cadre racine du
canevas Konva est capturée puis comparée au SVG d'origine. Le serveur n'est pas nécessaire.
`NYOTA_DUMP=1` enregistre aussi chaque capture du canevas (`canvas-XXXX.png`).
