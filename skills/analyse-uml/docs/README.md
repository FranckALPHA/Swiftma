# Architecture JSON des diagrammes — Index

Documentation complète des structures JSON produites par le skill `analyse-uml`, une fiche par type de diagramme. Chaque fiche contient un exemple valide, la table des champs et les règles de fermeture des identifiants.

| Fiche | `type` | Règle skill |
|---|---|---|
| [activity.md](activity.md) | `activity` | 10 octies |
| [sequence.md](sequence.md) | `sequence` | 10 decies |
| [communication.md](communication.md) | `communication` | 41 bis |
| [object.md](object.md) | `object` | 41 ter |
| [interaction-overview.md](interaction-overview.md) | `interaction-overview` | 41 quater |
| [package.md](package.md) | `package` | 34 bis |
| [deployment.md](deployment.md) | `deployment` | 37 bis |
| [usecase.md](usecase.md) | `usecase` | 42 |
| [class.md](class.md) | `class` | 43 |
| [state.md](state.md) | `state` | 44 |

## Conventions communes

- `analysisMode` : `existing` (code source de vérité), `partial` (mixte), `greenfield` (cible).
- Statuts : `Confirmé`, `Proposé`, `À confirmer`, `À implémenter` (ne jamais présenter une proposition comme implémentée).
- Libellés en expression nominale métier (règle 10 duodecies) ; technique dans `evidence` et notes.
- Fermeture : tout identifiant cité existe dans sa collection ; JSON, description et diagramme décrivent le même objet.
