# JSON — Diagramme de communication (`type: communication`)

Référence : `references/communication.md`, règles 41 bis et 10 duodecies du skill.

## Exemple complet

```json
{
  "type": "communication",
  "name": "TransfertBillet",
  "analysisMode": "existing",
  "sourceSequence": "docs/uml/sequences/UtilisateurConnecte/TransfertBillet.md",
  "objects": [
    {"id": "expediteur", "label": "Expéditeur", "stereotype": "actor", "role": "Initie et annule", "evidence": "tickets/router.py:543-552"},
    {"id": "service", "label": "TicketTransferService", "stereotype": "control", "role": "Gardes et transitions", "evidence": "tickets/service.py:1057-1250"},
    {"id": "postgres", "label": "Base de données (PostgreSQL)", "stereotype": "entity", "role": "Magasin persistant : billets, transferts", "evidence": "tickets/models.py:125-187"},
    {"id": "fcm", "label": "FCM", "stereotype": "external", "role": "Push", "external": true, "evidence": "notifications/fcm.py"}
  ],
  "links": [
    {"id": "l3", "from": "router", "to": "service", "evidence": "Délégation métier"},
    {"id": "l9", "from": "service", "to": "service", "evidence": "Lien réflexif : traitement local"}
  ],
  "messages": [
    {"id": "c2", "number": "1.1", "from": "router", "to": "service", "link": "l3", "operation": "Initier le transfert (demande)", "kind": "sync", "evidence": "tickets/service.py:1067-1145"},
    {"id": "c22", "number": "1.1.2", "from": "service", "to": "service", "link": "l9", "operation": "Évaluer les gardes et valider l'éligibilité", "kind": "sync", "evidence": "tickets/service.py:1085-1108"},
    {"id": "c12", "number": "2.1.3a", "from": "service", "to": "postgres", "link": "l4", "operation": "Mettre à jour : Billet [confirmed] + Transfert [accepted]", "kind": "sync", "guard": "code valide", "evidence": "tickets/service.py:1183-1206"},
    {"id": "c17", "number": "2.1.3b", "from": "service", "to": "postgres", "link": "l4", "operation": "Mettre à jour : Transfert [expired] + Billet [confirmed]", "kind": "sync", "guard": "réclamation après l'échéance", "evidence": "tickets/service.py:1166-1173"}
  ],
  "consistencyNotes": [
    "L'expiration est constatée lors d'une réclamation tardive, sans tâche planifiée."
  ]
}
```

## Champs

| Champ | Requis | Contenu |
|---|---|---|
| `type` | oui | Toujours `"communication"`. |
| `name` | oui | Nom du scénario (même que la séquence source). |
| `analysisMode` | oui | `existing` / `partial` / `greenfield`. |
| `sourceSequence` | oui | Séquence validée d’où le scénario est dérivé ; rien que la séquence ne justifie. |
| `objects` | oui | `stereotype` Jacobson (`actor`, `boundary`, `control`, `entity`, `external`), `role`, `evidence`. Libellé métier d’abord (`Base de données (PostgreSQL)`). Magasins ≠ entités métier, entités contenues nommées dans `role`. |
| `links` | oui | Possibilités structurelles (`from`, `to`, `evidence`) ; un lien sert aux deux sens ; lien réflexif (`from` égal à `to`) pour les auto-invocations. |
| `messages` | oui | `number` en arbre strict, `from`, `to`, `link` existant, opération nominale, `kind` fermé, `guard`/`iteration` si besoin. Réflexif après l’appel fournisseur. |
| `consistencyNotes` | oui | Simplifications assumées (retours omis, bus factorisé), écarts, hypothèses. |

## Numérotation et matrice (rappels)

- Lettres au niveau du choix (`2.1.2a`/`2.1.2b`, jamais `2b.1`), sous-messages incrémentés (`2.1.3a`), 3 niveaux max, `break` lettré + continuation nue.
- Matrice : `Boundary→Control`, `Control→Entity`, `Control→Boundary`, `Control→Control`, `Control→External`, `External→Boundary`, `External→Actor`, `Actor→Boundary`, `Control→Actor` autorisés ; `Boundary→Entity` déconseillé ; `Entity→Control/Boundary` interdits ; `Entity→Entity` persistance seule ; `return` toujours permis en sens inverse.
- Verbes : `Récupérer` (lectures), `Évaluer/Vérifier/Valider` (contrôles), `Mettre à jour : X [état]` (écritures), `Créer` (créations), `Annoncer` (événements).
