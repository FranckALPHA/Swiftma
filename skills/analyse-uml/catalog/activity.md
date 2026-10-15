# JSON — Diagramme d’activité (`type: activity`)

Référence : `references/activity.md`, règle 10 octies du skill.

## Exemple complet

```json
{
  "type": "activity",
  "name": "AchatBillet",
  "analysisMode": "partial",
  "partitions": [
    {"id": "user", "label": "Utilisateur"},
    {"id": "app", "label": "Tiketi"},
    {"id": "redis", "label": "Redis"},
    {"id": "paymentProvider", "label": "NotchPay", "external": true},
    {"id": "worker", "label": "Worker Celery"}
  ],
  "objects": [
    {"id": "request", "label": "Données de demande d’achat", "lifecycle": "created", "status": "confirmed"},
    {"id": "category", "label": "TicketCategory", "lifecycle": "read", "status": "confirmed"},
    {"id": "quotaAvailable", "label": "Quota Redis disponible", "lifecycle": "read", "status": "confirmed"},
    {"id": "orderPending", "label": "Order [pending]", "lifecycle": "created", "status": "confirmed"},
    {"id": "orderConfirmed", "label": "Order [confirmed]", "lifecycle": "updated", "status": "confirmed"}
  ],
  "actions": [
    {"id": "submitRequest", "label": "Faire une demande d’achat", "partition": "user", "produces": ["request"]},
    {"id": "validate", "label": "Valider événement et catégories", "partition": "app", "consumes": ["request", "category"]},
    {"id": "reserve", "label": "Réserver le quota", "partition": "redis", "consumes": ["quotaAvailable"], "produces": ["quotaAfterReservation"]}
  ],
  "events": [
    {"id": "paymentCompleted", "label": "PaymentCompleted", "emittedBy": "confirm", "partition": "eventBus"}
  ],
  "decisions": [
    {"id": "quotaCheck", "label": "Quota suffisant ?", "after": "reserve", "guards": ["quota suffisant", "quota insuffisant"]}
  ],
  "controlNodes": [
    {"id": "start", "kind": "initial", "label": "Début"},
    {"id": "final", "kind": "final", "label": "Fin succès"},
    {"id": "localFailure", "kind": "localFinal", "label": "Fin en échec"}
  ],
  "regions": [
    {
      "id": "paymentInterruptible",
      "kind": "interruptibleRegion",
      "contains": ["awaitWebhook", "handleWebhook", "confirm"],
      "interruptions": [
        {"event": "expiration", "handler": "cleanupExpiredOrders", "effect": "restituer le quota", "status": "confirmed"}
      ]
    }
  ],
  "controlFlows": [
    {"from": "start", "to": "submitRequest"},
    {"from": "quotaCheck", "to": "createOrder", "guard": "quota suffisant"},
    {"from": "quotaCheck", "to": "localFailure", "guard": "quota insuffisant"}
  ],
  "objectFlows": [
    {"from": "submitRequest", "to": "request", "relation": "produces"},
    {"from": "request", "to": "validate", "relation": "consumes"},
    {"from": "category", "to": "validate", "relation": "reads"}
  ],
  "consistencyNotes": [
    "TicketCategory est lue, pas modifiée par la réservation : l’état temporaire est porté par Redis."
  ]
}
```

## Champs

| Champ | Requis | Contenu |
|---|---|---|
| `type` | oui | Toujours `"activity"`. |
| `name` | oui | Nom métier du processus. |
| `analysisMode` | oui | `existing` (code source de vérité), `partial` (mixte confirmé/à vérifier), `greenfield` (cible à implémenter). |
| `partitions` | oui | Couloirs atomiques : un acteur, service, base, worker ou système externe chacun. `external: true` pour les systèmes hors frontière. |
| `objects` | oui | Données avec `lifecycle` (`created`, `read`, `updated`, `temporary`, `optional`, `external`, `input`) et `status` (`confirmed`, `to_verify`, …). Chaque objet a une provenance et une destination. |
| `actions` | oui | Traitements avec `partition`, `consumes`, `produces`, `reads`, `updates`, `emits`. Libellés nominaux (règle 10 duodecies). |
| `events` | non | Faits instantanés avec `emittedBy` (action ou partition externe). |
| `decisions` | oui si losanges | Losanges avec emplacement logique (`after`) et `guards` exhaustives. |
| `controlNodes` | oui | `initial`, `final`, `localFinal`, `acceptEvent`, `decision`. |
| `regions` | non | Régions interruptibles : `contains` (nœuds encadrés) + `interruptions` (`event`, `handler` existant, `effect`, `status`). |
| `controlFlows` | oui | Enchaînements `from -> to`, `guard` sur chaque sortie de décision. |
| `objectFlows` | oui | Relations `produces`, `consumes`, `reads`, `updates` entre actions et objets. |
| `consistencyNotes` | oui | Écarts backend, hypothèses, points à confirmer. |

## Règles de fermeture

- Tout `id` cité dans `controlFlows`, `objectFlows`, `decisions` et `regions` existe dans les collections.
- Tout `handler` d’interruption est une action déclarée dans une partition explicite.
- Aucun objet flottant : produit par une action, consommé/lu/transformé par une autre.
- `updates` prouvé par une écriture backend, avec états avant/après.
