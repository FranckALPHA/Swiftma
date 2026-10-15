# Méthode — Diagrammes de packages

## Rôle

Le diagramme de packages présente l’organisation des classes en modules cohérents. Il ne remplace pas le diagramme de classes : il montre la structure des groupes et les dépendances entre groupes.

## Règles

- Regrouper dans un même package les classes qui collaborent fortement autour d’une responsabilité.
- Utiliser la contenance pour montrer qu’un package contient des sous-packages ou des classes.
- Orienter `A ..> B` de l’utilisateur vers le package dont il utilise les classes, interfaces ou services.
- Déduire les dépendances des associations, dépendances, héritages, implémentations, imports et services réellement identifiés.
- Une dépendance n’est pas une association métier : elle signifie que le package source connaît ou utilise le package cible.
- Éviter les cycles `A → B → A`. Pour les supprimer, déplacer un contrat dans un package abstrait, inverser la dépendance avec une interface ou déplacer l’orchestration dans un package d’application.
- Exposer les interfaces et services stables ; garder les implémentations techniques dans un package d’infrastructure.
- Ne pas créer un package `Common` ou `Utils` comme fourre-tout. Chaque package doit avoir une responsabilité et une cohésion lisibles.

## Sens et notation

```text
PackageA ..> PackageB
```

Se lit : « PackageA dépend de PackageB ». Une modification de l’API exposée par `PackageB` peut nécessiter une adaptation de `PackageA`.

La contenance se représente par un package englobant ou par un package parent contenant des sous-packages. Les relations entre packages sont principalement des dépendances ; les associations et héritages restent détaillés dans les diagrammes de classes.

## Vérification

Contrôler la cohésion des packages, le sens des flèches, la traçabilité de chaque dépendance, les interfaces exposées, les détails cachés et l’absence de cycle. Si le diagramme propose une architecture différente du code existant, séparer les dépendances confirmées des dépendances `Proposées`.

## Structure JSON de référence

Chaque diagramme de packages inclut dans son Markdown un bloc JSON sémantique de cette forme :

```json
{
  "type": "package",
  "name": "NomOrganisation",
  "analysisMode": "existing | partial | greenfield",
  "packages": [],
  "dependencies": [],
  "interfaces": [],
  "cycles": [],
  "consistencyNotes": []
}
```

- `packages` : modules ou couches avec `id`, `label`, `responsibility`, `contains` (sous-packages ou classes), `status` (`Confirmé`, `Proposé`, `À confirmer`, `À implémenter`) et `evidence` (dossiers, imports, services).
- `dependencies` : relations orientées avec `from`, `to`, `via` (`import`, `service`, `association`, `inheritance`, `implementation`), `status` et `evidence`. `from` utilise `to` ; jamais l’inverse sans preuve.
- `interfaces` : contrats stables exposés avec `id`, `package`, `exposes` et `evidence`.
- `cycles` : cycles détectés avec `path` (ex. `A -> B -> A`), `status` et `resolution` (abstraction, interface, déplacement d’orchestration). Un diagramme sans cycle porte un tableau vide, pas un cycle inventé.
- `consistencyNotes` : écarts entre code et diagramme, hypothèses et ruptures proposées.

Exemple minimal d’une dépendance :

```json
{
  "id": "d1",
  "from": "tickets",
  "to": "events",
  "via": "service",
  "status": "Confirmé",
  "evidence": "backend/modules/tickets/service.py"
}
```

Les identifiants utilisés dans `dependencies`, `interfaces` et `cycles` doivent exister dans `packages`. Le JSON, la description textuelle et le diagramme Mermaid décrivent la même organisation.
