# JSON — Diagramme d’états-transitions (`type: state`)

Référence : `references/state.md`, règle 44 du skill.

## Exemple complet

```json
{
  "type": "state",
  "name": "CycleDeVieCommande",
  "analysisMode": "existing",
  "class": "Order",
  "states": [
    {"id": "initial", "label": "Initial", "kind": "initial", "evidence": "Création en OrderService.create_order()"},
    {"id": "pending", "label": "En attente", "kind": "simple", "do": "attendre le webhook NotchPay", "evidence": "backend/modules/tickets/models.py (status pending)"},
    {"id": "confirmed", "label": "Confirmée", "kind": "simple", "evidence": "backend/modules/tickets/service.py:confirm_order()"},
    {"id": "final", "label": "Final", "kind": "final", "evidence": "Fin de vie confirmée ou échouée"}
  ],
  "transitions": [
    {"id": "t1", "from": "initial", "to": "pending", "event": "commande créée", "guard": "quota suffisant", "effect": "réserver le quota", "evidence": "tickets/service.py:308-438"},
    {"id": "t2", "from": "pending", "to": "confirmed", "event": "paiement confirmé", "guard": "webhook valide", "effect": "générer les QR", "evidence": "tickets/service.py:450-576"}
  ],
  "consistencyNotes": [
    "Activité do distinguée des effets de transition."
  ]
}
```

## Champs

| Champ | Requis | Contenu |
|---|---|---|
| `type` | oui | Toujours `"state"`. |
| `name` | oui | Nom du cycle de vie. |
| `analysisMode` | oui | `existing` / `partial` / `greenfield`. |
| `class` | oui | Classe porteuse du statut, issue du diagramme de classes. |
| `states` | oui | `kind` (`initial`, `simple`, `composite`, `final`), activité `do` éventuelle, `evidence`. Initiaux et finaux présents ; composites justifiés ; historique seulement si reprise réelle. |
| `transitions` | oui | `event` (instantané), `guard` (condition), `effect` (action) toujours séparés ; `evidence`. |
| `consistencyNotes` | oui | Portée des composites (jamais de référence externe à un sous-état), écarts, hypothèses. |

## Règles de fermeture

- Tout `id` cité dans `transitions` existe dans `states`.
- Chaque transition accessible ; chaque état durable justifié par le backend ou la conception.
