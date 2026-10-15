# JSON — Diagramme d’objets (`type: object`)

Référence : `references/object.md`, règle 41 ter du skill.

## Exemple complet

```json
{
  "type": "object",
  "name": "CommandeConfirmee",
  "analysisMode": "partial",
  "sourceClasses": "docs/uml/classes/Global/GlobalSimple.md",
  "sourceScenario": "docs/uml/activities/AchatBillet/AchatBillet.md",
  "moment": "Commande confirmée et paiement réussi, billets confirmed non scannés",
  "instances": [
    {"id": "commande1", "label": "commande1: Order", "class": "Order", "slots": {"statut": "confirmed", "total": 10000}, "state": "confirmed", "evidence": "backend/modules/tickets/models.py"},
    {"id": "billet1", "label": "billet1: Ticket", "class": "Ticket", "slots": {"code": "TK-8F3K2A", "statut": "confirmed"}, "state": "confirmed", "evidence": "backend/modules/tickets/models.py"}
  ],
  "links": [
    {"id": "k7", "from": "commande1", "to": "billet1", "association": "génère", "kind": "composition", "evidence": "GlobalSimple.md : Order *-- Ticket"}
  ],
  "consistencyNotes": [
    "Valeurs d'exemple anonymisées.",
    "Remboursements et transferts hors de cet instant."
  ]
}
```

## Champs

| Champ | Requis | Contenu |
|---|---|---|
| `type` | oui | Toujours `"object"`. |
| `name` | oui | Nom de l’instantané. |
| `analysisMode` | oui | `existing` / `partial` / `greenfield`. |
| `sourceClasses` | oui | Diagramme de classes dont les classes et associations sont instanciées. |
| `sourceScenario` | oui | Activité ou séquence d’où l’instant est extrait. |
| `moment` | oui | Instant unique figé ; deux instants = deux diagrammes. |
| `instances` | oui | `label` (`nom: Classe`, instance en minuscules, nom exact de la classe), `slots` (valeurs anonymisées), `state` (état valide du cycle de vie), `evidence` (modèle). Aucune instance isolée. |
| `links` | oui | Exemplaires concrets d’associations : `from`, `to`, `association` (nom repris), `kind` (`composition`, `agrégation`, `association`), `evidence`. Navigabilité reprise : flèche = connaissance à sens unique, sans flèche = mutuelle ; rôles reportés. Jamais de lien inventé non marqué `Proposé`. |
| `consistencyNotes` | oui | Valeurs assumées, écarts, hypothèses. |
