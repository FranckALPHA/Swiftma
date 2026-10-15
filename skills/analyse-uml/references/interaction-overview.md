# Méthode — Diagrammes de vue d’ensemble des interactions

## Rôle

Le diagramme de vue d’ensemble des interactions offre une vue macroscopique du système en orchestrant plusieurs interactions modélisées séparément. Il combine la structure logique d’un diagramme d’activités avec la précision des diagrammes de séquence. C’est une carte routière des scénarios : comment s’enchaînent les cas d’utilisation et les grandes phases de dialogue entre objets, en masquant les détails des messages pour se concentrer sur la logique globale.

Mermaid ne possède pas de type natif : utiliser `flowchart` en approximation, avec des sous-graphes ou nœuds étiquetés `ref:` pour les cadres de référence.

## Formalisme : une structure de contrôle

Le diagramme utilise les nœuds de contrôle du diagramme d’activités pour définir le flux d’exécution :

- Nœud initial et final : début et fin du processus global.
- Décision et fusion (losanges) : orientent le flux selon des gardes, pour les choix ou les boucles.
- Bifurcation et synchronisation (barres) : lancent ou regroupent des interactions parallèles — uniquement si le backend exécute réellement en parallèle, jamais pour décorer.

## Contenu : des interactions, pas des actions

Contrairement au diagramme d’activités qui manipule des actions élémentaires, la vue d’ensemble manipule des interactions globales sous deux formes :

- Les cadres de référence (`ref`) : boîtes qui renvoient à un autre diagramme d’interaction existant (le plus souvent une séquence, parfois une communication). Un `ref` n’est valide que si le diagramme cible existe ; sinon, le marquer `À créer`.
- Les interactions imbriquées : un mini-diagramme de séquence dessiné directement dans un nœud, réservé aux interactions très courtes (quelques messages).

Chaque `ref` porte le chemin du fichier cible. Les gardes des décisions restent nominales (règle 10 duodecies).

## Expression nominale

Décisions, gardes, titres de `ref` et notes en expression nominale métier. Les chemins de fichiers cibles vivent dans le JSON et les cadres, jamais noyés dans du jargon.

## Structure JSON de référence

```json
{
  "type": "interaction-overview",
  "name": "NomParcours",
  "analysisMode": "existing | partial | greenfield",
  "nodes": [],
  "refs": [],
  "flows": [],
  "consistencyNotes": []
}
```

- `nodes` : nœuds de contrôle avec `id`, `kind` (`initial`, `final`, `decision`, `merge`, `fork`, `join`) et `label`. Les gardes des décisions sont exhaustives.
- `refs` : cadres de référence avec `id`, `label`, `target` (chemin du diagramme existant), `kind` (`sequence`, `communication`) et `status` (`Confirmé`, `À créer`).
- `flows` : enchaînements orientés `from -> to` entre nœuds et `ref`, avec `guard` sur chaque sortie de décision.
- `consistencyNotes` : dépendances souples entre parcours (ex. la validation suppose un billet confirmé sans l’imposer), écarts et hypothèses.

Les identifiants utilisés dans `flows` doivent exister dans `nodes` ou `refs`. Le JSON, la description textuelle et le diagramme décrivent le même parcours.

## Description textuelle

Chaque fichier contient, avant le diagramme, une description narrative : le périmètre du parcours, l’ordre des interactions et pourquoi cet ordre, les décisions et leurs gardes, les `ref` avec leurs cibles, les dépendances souples entre parcours, puis les écarts éventuels.

## Vérification

Contrôler l’unicité du parcours (pas de mélange de processus indépendants sans décision), l’existence de chaque cible de `ref`, l’exhaustivité des gardes, l’absence de parallélisme inventé, la cohérence JSON ↔ description ↔ diagramme, et le fait qu’aucun détail de message ne fuite dans la vue d’ensemble.
