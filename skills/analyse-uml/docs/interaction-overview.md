# JSON — Vue d’ensemble des interactions (`type: interaction-overview`)

Référence : `references/interaction-overview.md`, règle 41 quater du skill.

## Exemple complet

```json
{
  "type": "interaction-overview",
  "name": "TiketiParcours",
  "analysisMode": "existing",
  "nodes": [
    {"id": "start", "kind": "initial", "label": "Début"},
    {"id": "choix", "kind": "decision", "label": "Quel parcours ?", "guards": ["acheter un billet", "vendre un stand"]},
    {"id": "fusion", "kind": "merge", "label": "Fusion des parcours"},
    {"id": "fin", "kind": "final", "label": "Fin"}
  ],
  "refs": [
    {"id": "refAchat", "label": "AchatBillet", "target": "docs/uml/sequences/UtilisateurConnecte/AchatBillet.md", "kind": "sequence", "status": "Confirmé"}
  ],
  "flows": [
    {"from": "start", "to": "choix"},
    {"from": "choix", "to": "refAchat", "guard": "acheter un billet"},
    {"from": "refAchat", "to": "fusion"},
    {"from": "fusion", "to": "fin"}
  ],
  "consistencyNotes": [
    "La validation d'accès suppose un billet confirmed : dépendance souple annotée, pas de flux forcé."
  ]
}
```

## Champs

| Champ | Requis | Contenu |
|---|---|---|
| `type` | oui | Toujours `"interaction-overview"`. |
| `name` | oui | Nom du parcours. |
| `analysisMode` | oui | `existing` / `partial` / `greenfield`. |
| `nodes` | oui | Contrôle : `initial`, `final`, `decision` (gardes exhaustives), `merge`, `fork`/`join` (parallélisme réel seul). |
| `refs` | oui | Cadres vers des diagrammes existants : `target` (chemin), `kind` (`sequence`, `communication`), `status` (`Confirmé`, `À créer`). |
| `flows` | oui | `from -> to` entre nœuds et `ref`, `guard` sur chaque sortie de décision. |
| `consistencyNotes` | oui | Dépendances souples, écarts, hypothèses. |

## Règles de fermeture

- Chaque `target` de `ref` existe ou est marqué `À créer`.
- Aucun détail de message dans la vue ; mini-séquences imbriquées réservées aux interactions très courtes.
- Aucun parallélisme inventé.
