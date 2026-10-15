# Catalogue — Diagramme de cas d’utilisation

Source : `analyse-uml/docs/usecase.md` (Règle 42) + `analyse-uml/references/usecase.md`.
Principe : le JSON du catalogue est la vérité ; `parser.py` est le seul endroit qui écrit `shape=…`. Pas dans le prompt IA.

## Tableau id catalogue → JSON → style draw.io

| id catalogue | JSON analyse-uml / backend | Style draw.io (`parser.STYLES` via `smart_elements.STYLES`) |
|---|---|---|
| `actor` | `actors[]` → `type: "uml:actor"` `kind: "primary" \| "secondary" \| "external"` `parent?` pour généralisation | `shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;` — identique à « Exemple UML » `frontend/src/features/editor/data.ts:7` |
| `usecase` | `useCases[]` → `type: "uml:usecase"` `scope: "global" \| "specific"` | `ellipse;whiteSpace=wrap;html=1;fillColor=#1e1b4b;strokeColor=#7c3aed;fontColor=#e8eaf0;fontSize=12;` |
| `boundary` | frontière système (englobe les `usecase`) | `swimlane;startSize=30;fillColor=none;strokeColor=#5c677d;dashed=1;dashPattern=8 8;fontColor=#a0aec0;fontSize=14;fontStyle=1;` |
| `association` | `relations[]` `kind: "association"` `from: actorId` `to: useCaseId` | `edgeStyle=orthogonalEdgeStyle;html=1;strokeColor=#9ca3af;endArrow=open;endFill=0;` |
| `include` | `kind: "include"` `from: useCase` `to: includedUseCase` | `edgeStyle=orthogonalEdgeStyle;dashed=1;endArrow=open;endFill=0;html=1;strokeColor=#a78bfa;fontColor=#a78bfa;fontSize=11;` + label `«include»` (`parser.py:104`) |
| `extend` | `kind: "extend"` + `condition` obligatoire `from: extension` `to: base` | même style que `include` (`stroke #34d399`) + label `«extend»` (`parser.py:106`) |
| `generalization` | `kind: "generalization"` `from: specialized` `to: general` — pour `actors[].parent` et `useCases` spécialisés | `edgeStyle=orthogonalEdgeStyle;html=1;strokeColor=#9ca3af;endArrow=block;endFill=0;endSize=12;` (triangle vide `--|>`) |

## JSON — Diagramme de cas d’utilisation (`type: usecase`)

Référence : `references/usecase.md`, règle 42 du skill.

### Exemple complet

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

### Champs

| Champ | Requis | Contenu |
|---|---|---|
| `type` | oui | Toujours `"usecase"`. |
| `name` | oui | Nom de la vue (globale ou cas spécifique). |
| `analysisMode` | oui | `existing` / `partial` / `greenfield`. |
| `actors` | oui | `kind` (`primary`, `secondary`, `external`), `parent` pour la généralisation (sens hérité : spécialisé `--|>` parent, jamais l’inverse), `evidence`. Externes hors frontière. |
| `useCases` | oui | Cas atomiques, `scope` (`global`, `specific`), préconditions éventuelles, `evidence`. |
| `relations` | oui | `kind` : `association` (acteur↔cas), `include` (obligatoire), `extend` (optionnel + `condition` obligatoire), `generalization` (spécialisation, variantes en vue spécifique). |
| `consistencyNotes` | oui | Héritage vérifié dans le bon sens, cas hérités non redessinés inutilement, écarts. |

### Règles de fermeture

- Tout `id` cité dans `relations` existe dans `actors` ou `useCases`.
- `extend` sans `condition` refusé ; `include` jamais pour un choix entre variantes.
- Vue globale synthétique (cas mères) ; variantes en vues spécifiques.

## Détails à respecter

- **Acteur `kind`** : `primary` (humain initiateur), `secondary` (système qui répond), `external` (hors frontière, ex `NotchPay`, `evidence` hors système).
- **Généralisation acteurs** : `actors[].parent` → arête `generalization` `specialized --|> parent`.
- **Preuves** : `evidence` obligatoire.
- **Parser** : `smart_elements.py:22-60` est l’unique source des `shape=` ; `parser.py` n’écrit aucun `shape=` en dur hors `STYLES`.
