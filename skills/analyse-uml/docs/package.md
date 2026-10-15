# JSON — Diagramme de packages (`type: package`)

Référence : `references/package.md`, règle 34 bis du skill.

## Exemple complet

```json
{
  "type": "package",
  "name": "GlobalSimple",
  "analysisMode": "partial",
  "packages": [
    {"id": "tiketi", "label": "Tiketi", "responsibility": "Racine fonctionnelle", "contains": ["identity", "events", "commerce"], "status": "Confirmé", "evidence": "docs/uml/classes/Global/GlobalSimple.md"},
    {"id": "contracts", "label": "Contracts", "responsibility": "Abstractions stables anti-cycle", "contains": ["UserReference", "EventReference"], "status": "Proposé", "evidence": "Proposition d'architecture, non confirmée"},
    {"id": "commerce", "label": "Commerce", "responsibility": "Commandes, billets, paiements", "contains": ["Order", "OrderItem", "Ticket", "Payment"], "status": "Confirmé", "evidence": "backend/modules/tickets/models.py; backend/modules/payments/models.py"}
  ],
  "dependencies": [
    {"id": "d3", "from": "commerce", "to": "events", "via": "association", "status": "Confirmé", "evidence": "backend/modules/tickets/models.py (Order.event_id)"},
    {"id": "d4", "from": "commerce", "to": "contracts", "via": "implementation", "status": "Proposé", "evidence": "Abstraction à introduire, non confirmée"}
  ],
  "interfaces": [
    {"id": "i1", "package": "contracts", "exposes": "UserReference", "status": "Proposé", "evidence": "Proposition d'architecture, non confirmée"}
  ],
  "cycles": [],
  "consistencyNotes": [
    "Cycle Identity -> Events -> Identity évité par les contrats proposés ; aucun cycle confirmé."
  ]
}
```

## Champs

| Champ | Requis | Contenu |
|---|---|---|
| `type` | oui | Toujours `"package"`. |
| `name` | oui | Nom de l’organisation. |
| `analysisMode` | oui | `existing` / `partial` / `greenfield`. |
| `packages` | oui | `responsibility`, `contains` (sous-packages ou classes), `status` (`Confirmé`, `Proposé`, `À confirmer`, `À implémenter`), `evidence`. Pas de fourre-tout. |
| `dependencies` | oui | Orientée `from -> to` (l’utilisateur vers l’utilisé), `via` fermé (`import`, `service`, `association`, `inheritance`, `implementation`), `status`, `evidence` (import, service ou relation réelle). |
| `interfaces` | non | Contrats stables exposés par package. |
| `cycles` | oui | `path` + `resolution`, même vide (jamais de cycle inventé). Recherche acyclique obligatoire. |
| `consistencyNotes` | oui | Ruptures proposées marquées, écarts, hypothèses. |

## Règles de fermeture

- Tout `id` cité dans `dependencies`, `interfaces`, `cycles` existe dans `packages`.
- Contenance par imbrication ; dépendances dérivées du réel, jamais décoratives.
