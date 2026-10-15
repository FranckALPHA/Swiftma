# JSON — Diagramme de séquence (`type: sequence`)

Référence : `references/sequence.md`, règles 10 decies et 10 undecies du skill.

## Exemple complet

```json
{
  "type": "sequence",
  "name": "ValidationAccesEvenement",
  "analysisMode": "existing",
  "participants": [
    {"id": "agent", "label": "Agent de contrôle", "role": "Déclenche le scan et reçoit le résultat", "evidence": "backend/modules/scan/router.py:45-55"},
    {"id": "scanService", "label": "ScanService", "role": "Orchestre le contrôle", "evidence": "backend/modules/scan/service.py:88-145"},
    {"id": "redis", "label": "Redis", "role": "Anti-doublon et compteur", "evidence": "backend/modules/scan/service.py:218-226"},
    {"id": "postgres", "label": "PostgreSQL", "role": "Lit et persiste", "evidence": "backend/modules/scan/service.py:95-127"}
  ],
  "messages": [
    {"id": "m1", "from": "agent", "to": "router", "operation": "Soumettre le QR (contenu, événement)", "kind": "sync", "returns": "r1", "evidence": "backend/modules/scan/router.py:40-55"},
    {"id": "m9", "from": "scanService", "to": "redis", "operation": "Réserver le billet (billet, expiration)", "kind": "sync", "returns": "redisReservation", "evidence": "backend/modules/scan/service.py:218-226"},
    {"id": "m16", "from": "scanService", "to": "scanLog", "operation": "Créer le journal (résultat valide)", "kind": "create", "returns": "scanLogValid", "evidence": "backend/modules/scan/service.py:944"}
  ],
  "fragments": [
    {"id": "f0", "kind": "break", "condition": "Événement absent ou agent non autorisé", "messages": ["m3", "m5"], "consequence": "Interrompt avant toute vérification", "evidence": "backend/modules/scan/service.py:95-127"},
    {"id": "f1", "kind": "alt", "condition": "QR invalide ou suspect", "messages": ["m7", "m8"], "evidence": "backend/modules/scan/service.py:157-217"},
    {"id": "f4", "kind": "opt", "condition": "Annulation demandée pendant le pending", "messages": ["m13", "m14"], "evidence": "backend/modules/tickets/service.py:1224-1250"}
  ],
  "objects": [
    {"id": "ticketConfirmed", "label": "Ticket [confirmed]", "state": "lu, préexistant", "evidence": "backend/modules/tickets/models.py"},
    {"id": "scanLogValid", "label": "ScanLog [valid]", "state": "créé", "createdBy": "m16", "evidence": "backend/modules/scan/models.py"}
  ],
  "errors": [
    {"id": "eDuplicate", "label": "Doublon détecté", "origin": "redis", "target": "router", "consequence": "Journal de doublon et doublon constaté", "evidence": "backend/modules/scan/service.py:228-256"}
  ],
  "returns": [
    {"id": "r1", "from": "router", "to": "agent", "value": "Résultat de validation", "message": "m22", "evidence": "backend/modules/scan/router.py:40-55"}
  ],
  "activations": [
    {"id": "a1", "participant": "scanService", "from": "m2", "to": "m21", "note": "Orchestration complète"}
  ],
  "consistencyNotes": [
    "Événement ticket.scanned défini mais non publié par ScanService."
  ]
}
```

## Champs

| Champ | Requis | Contenu |
|---|---|---|
| `type` | oui | Toujours `"sequence"`. |
| `name` | oui | Nom du scénario (un seul par diagramme). |
| `analysisMode` | oui | `existing` / `partial` / `greenfield`. |
| `participants` | oui | Atomiques : un seul rôle chacun, avec `role` et `evidence` (pas de `Système` générique). |
| `messages` | oui | `from`, `to`, `operation` nominale, `kind` fermé, `returns`, `evidence`. Voir vocabulaire ci-dessous. |
| `fragments` | non | `alt`, `opt`, `loop`, `par`, `sd`, `ref`, `break` avec conditions et messages contenus. `ref` ajoute la cible, `break` la conséquence. |
| `objects` | oui | Créés, lus, modifiés ou détruits, avec `createdBy` (position verticale) et `destroyedBy`. |
| `errors` | non | Erreurs renvoyées : `origin`, `target`, `consequence`. |
| `returns` | oui | Réponses avec émetteur, destinataire et message associé. |
| `activations` | non | Barres d’exécution `participant` + `from` + `to` ; dérivation auto depuis les paires `sync`/`return` sinon. |
| `consistencyNotes` | oui | Écarts, hypothèses, points à confirmer. |

## Vocabulaire `kind` (fermé)

`sync` (attend le retour, bloque), `async` (sans attente), `return` (réponse en pointillés), `create` (instancie, avec `createdBy`), `destroy` (termine, avec `destroyedBy`), `event` (fait externe asynchrone). Mermaid : `->>` / `->` / `-->>` / `create participant` / `-x`.

## Règles de fermeture

- Tout `id` cité dans `fragments`, `objects`, `errors`, `returns`, `activations` existe dans `messages` ou `participants`.
- Position verticale : `createdBy` fixe la hauteur d’apparition ; sans lui, l’objet est préexistant.
- Un `handler`/`ref` pointe vers un élément déclaré ou marqué `À implémenter`.
