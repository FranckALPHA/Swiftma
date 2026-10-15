# JSON — Diagramme de classes (`type: class`)

Référence : `references/class.md`, règle 43 du skill.

## Exemple complet

```json
{
  "type": "class",
  "name": "Achat",
  "analysisMode": "existing",
  "classes": [
    {"id": "order", "label": "Order", "attributes": [{"name": "status", "type": "String", "visibility": "-"}, {"name": "total_amount", "type": "Integer", "visibility": "-"}], "operations": [{"name": "confirm", "visibility": "+"}], "status": "Confirmé", "evidence": "backend/modules/tickets/models.py"},
    {"id": "ticket", "label": "Ticket", "attributes": [{"name": "status", "type": "String", "visibility": "-"}], "operations": [{"name": "generateQr", "visibility": "+"}], "status": "Confirmé", "evidence": "backend/modules/tickets/models.py"}
  ],
  "relations": [
    {"id": "r1", "from": "order", "to": "ticket", "kind": "composition", "navigability": "forward", "cardinality": "1 -> 0..*", "role": "génère", "evidence": "GlobalSimple.md : Order *-- Ticket"}
  ],
  "consistencyNotes": [
    "Seules les classes collaborant réellement au cas traité ; détails dans les vues spécifiques."
  ]
}
```

## Champs

| Champ | Requis | Contenu |
|---|---|---|
| `type` | oui | Toujours `"class"`. |
| `name` | oui | Nom de la vue (cas traité, jamais nom d’acteur générique). |
| `analysisMode` | oui | `existing` / `partial` / `greenfield`. |
| `classes` | oui | Attributs avec `visibility` (`-` privé par défaut, `#`, `~`), opérations réellement portées (`+` public), `stereotype` si abstraite/externe/proposée, `status`, `evidence`. Jamais de classe métier vide sans stéréotype ; pas de getters/setters inventés. |
| `relations` | oui | `kind` (`composition` `*--` cycle de vie dépendant, `aggregation` `o--` regroupement indépendant, `association` `-->` lien durable, `dependency` `..>` simple usage, `generalization`), `navigability` (`forward`, `backward`, `both`, `none`), cardinalités, rôle, `evidence`. |
| `consistencyNotes` | oui | Classes de liaison sans opération expliquées en note, écarts, hypothèses. |

## Règles de fermeture

- Tout `id` cité dans `relations` existe dans `classes`.
- Navigabilité vérifiée contre les références réelles du modèle.
- Vue limitée aux classes collaborant au cas ; fusion globale à part.
