# JSON — Diagramme de cas d’utilisation (`type: usecase`)

Référence : `references/usecase.md`, règle 42 du skill.

## Exemple complet

```json
{
  "type": "usecase",
  "name": "AcheterBillet",
  "analysisMode": "existing",
  "actors": [
    {"id": "visiteur", "label": "Visiteur", "kind": "primary", "evidence": "Parcours public du catalogue"},
    {"id": "connecte", "label": "Utilisateur connecté", "kind": "primary", "parent": "visiteur", "evidence": "Hérite des capacités visiteur + compte"},
    {"id": "notchpay", "label": "NotchPay", "kind": "external", "evidence": "Fournisseur de paiement hors frontière"}
  ],
  "useCases": [
    {"id": "acheter", "label": "Acheter un billet", "scope": "global", "evidence": "backend/modules/tickets/router.py"},
    {"id": "auth", "label": "S'authentifier", "scope": "global", "evidence": "Convention transversale du projet"}
  ],
  "relations": [
    {"from": "connecte", "to": "acheter", "kind": "association", "evidence": "Endpoint authentifié"},
    {"from": "acheter", "to": "auth", "kind": "include", "evidence": "Achat réservé au connecté"},
    {"from": "notchpay", "to": "acheter", "kind": "association", "evidence": "Webhook consommé par l'achat"}
  ],
  "consistencyNotes": [
    "NotchPay relié au cas qu'il alimente, sans cas autonome externe."
  ]
}
```

## Champs

| Champ | Requis | Contenu |
|---|---|---|
| `type` | oui | Toujours `"usecase"`. |
| `name` | oui | Nom de la vue (globale ou cas spécifique). |
| `analysisMode` | oui | `existing` / `partial` / `greenfield`. |
| `actors` | oui | `kind` (`primary`, `secondary`, `external`), `parent` pour la généralisation (sens hérité : spécialisé `--\|>` parent, jamais l’inverse), `evidence`. Externes hors frontière. |
| `useCases` | oui | Cas atomiques, `scope` (`global`, `specific`), préconditions éventuelles, `evidence`. |
| `relations` | oui | `kind` : `association` (acteur↔cas), `include` (obligatoire), `extend` (optionnel + `condition` obligatoire), `generalization` (spécialisation, variantes en vue spécifique). |
| `consistencyNotes` | oui | Héritage vérifié dans le bon sens, cas hérités non redessinés inutilement, écarts. |

## Règles de fermeture

- Tout `id` cité dans `relations` existe dans `actors` ou `useCases`.
- `extend` sans `condition` refusé ; `include` jamais pour un choix entre variantes.
- Vue globale synthétique (cas mères) ; variantes en vues spécifiques.
