# Méthode — Diagrammes de cas d’utilisation

## Vue globale

La vue globale ne doit contenir que les grandes capacités métier et les acteurs principaux. Elle répond à : « Qui utilise le système et pour quelles grandes fonctions ? »

Exemple :

```text
Utilisateur connecté ── Acheter et gérer ses billets
Organisateur          ── Gérer les événements
Administrateur        ── Administrer la plateforme
```

## Vue spécifique

Chaque grande capacité est ensuite décomposée dans un diagramme spécifique :

```text
Gérer les événements
├── Créer un événement
├── Modifier un événement
├── Programmer un événement
├── Publier un événement
├── Ajouter des médias
├── Annuler un événement
└── Supprimer un brouillon
```

Ne pas mettre ces actions dans le diagramme global. Le global donne le contexte ; le spécifique donne le détail fonctionnel.

## Analyse du code

Pour chaque endpoint, relever l’acteur réel via les dépendances d’authentification, le verbe métier, les services, les systèmes externes, les tâches asynchrones et les conditions importantes.

Les endpoints CRUD simples peuvent être regroupés dans un cas métier comme « Gérer les événements » lorsque le niveau global est demandé.

Dans un diagramme spécifique, chaque cas d’utilisation détaillé reste atomique : ne pas fusionner deux actions comme « programmer ou publier », « commenter et aimer » ou « commandes et ventes ». Une relation `inclut` ou `étend` sert à relier des cas distincts, pas à les renommer en une seule action.

## Relations entre cas d’utilisation

- `include` : le comportement inclus est obligatoire dans le cas principal. Exemple : « Gérer son compte » inclut « S’authentifier » si l’utilisateur doit être authentifié.
- `extend` : le comportement est optionnel et intervient dans une situation donnée. Exemple : « Parcourir le catalogue » étend « Gérer son panier » lorsqu’un utilisateur peut rechercher un article avant de l’ajouter.
- Généralisation : un cas spécialisé reprend l’objectif d’un cas parent plus général, éventuellement abstrait. Exemple : « Payer un billet » peut être spécialisé en « Payer par Orange Money » et « Payer par Mobile Money ».

Ne pas utiliser `include` pour représenter un choix entre variantes, ni `extend` pour une étape obligatoire. Dans Mermaid, ajouter une note pour préciser la condition d’extension et le sens UML de la relation.

Dans la vue globale, conserver uniquement le cas d’utilisation mère lorsqu’il possède des variantes. Les relations de généralisation et les cas spécialisés doivent apparaître dans le diagramme spécifique concerné.

Chaque diagramme spécifique doit préciser le cas global qu’il détaille. Le cas global sert de contexte et de titre, mais ne doit pas être redessiné comme un cas abstrait dans le diagramme spécifique. Celui-ci ne contient que les actions concrètes de ce cas global et ne mélange pas plusieurs fonctionnalités globales.

L’authentification est transversale : dans les diagrammes spécifiques, les cas réservés à l’utilisateur connecté, l’ambassadeur, le staff, l’organisateur et l’administrateur incluent `S’authentifier`. Les cas publics du visiteur et `Se connecter` ne l’incluent pas.

## Généralisation des acteurs

La généralisation des acteurs est indépendante de la généralisation des cas d’utilisation. Elle signifie que l’acteur spécialisé possède les capacités de l’acteur parent :

```text
Utilisateur connecté --|> Visiteur
Ambassadeur         --|> Utilisateur connecté
Staff               --|> Utilisateur connecté
Organisateur        --|> Utilisateur connecté
Administrateur      --|> Utilisateur connecté
```

Dans Mermaid, représenter le sens par une flèche allant de l’acteur spécialisé vers l’acteur parent et l’annoter `hérite de`. Un rôle optionnel, comme l’ambassadeur lorsqu’il fonctionne comme une capacité/plugin, spécialise l’utilisateur connecté ; il ne doit pas être son parent. Dans une vue spécifique, ne pas redessiner tous les cas hérités : les documenter comme capacités héritées et détailler seulement les actions propres au cas traité.

## Collaborations entre acteurs dans la vue globale

La vue globale doit parfois montrer 2 ou 3 cas d’utilisation qui font intervenir plusieurs acteurs. Ils permettent de justifier leur présence dans le système et de rendre visibles les responsabilités partagées.

Exemples :

```text
Utilisateur ── Soumettre une candidature organisateur
Administrateur ── Valider une candidature organisateur
Ambassadeur ── Soumettre une demande de participation
Organisateur ── Valider une demande de participation
Staff ── Soumettre une demande d’affectation
Organisateur ── Valider une demande d’affectation
```

Ces cas restent des actions métier, pas des classes. Les objets persistants qui matérialisent la collaboration doivent être listés hors du diagramme :

```text
OrganizerApplication
EventAmbassadorRequest
EventStaffRequest
```

Ils seront détaillés dans les diagrammes de classes et d’état. Ne pas transformer le global en diagramme de classes ou en inventaire de tables : ajouter seulement les collaborations qui clarifient réellement les acteurs.

## Si l’application n’est pas développée

Remplacer l’analyse des endpoints par l’analyse des exigences : interviews, règles métier, maquettes, backlog ou description utilisateur. Les acteurs et cas d’utilisation sont alors proposés à partir du besoin, et les éléments incertains doivent être marqués `à décider`.

## Acteurs externes

Ajouter les systèmes externes lorsque leur interaction justifie un cas d’utilisation : passerelle de paiement, API de géolocalisation, service de notification ou fournisseur d’authentification. Ils doivent être placés hors de la frontière de l’application étudiée et reliés aux cas concernés uniquement.
Ils ne portent pas de cas d’utilisation autonomes dans la vue spécifique : par exemple, `NotchPay` est relié à « Acheter des billets » ou « Demander un retrait », et non à un cas « Traiter le paiement externe ».

## Structure JSON de référence

Chaque diagramme de cas d’utilisation inclut dans son Markdown un bloc JSON sémantique de cette forme :

```json
{
  "type": "usecase",
  "name": "NomVue",
  "analysisMode": "existing | partial | greenfield",
  "actors": [],
  "useCases": [],
  "relations": [],
  "consistencyNotes": []
}
```

- `actors` : acteurs avec `id`, `label`, `kind` (`primary`, `secondary`, `external`), `parent` (généralisation, ex. `Ambassadeur --|> Utilisateur connecté`) et `evidence`.
- `useCases` : cas avec `id`, `label`, `scope` (`global`, `specific`), préconditions éventuelles et `evidence`. Chaque cas reste atomique.
- `relations` : avec `from`, `to`, `kind` (`association`, `include`, `extend`, `generalization`) et `condition` obligatoire pour `extend`. `include` exprime un comportement obligatoire, `extend` une possibilité optionnelle déclenchée sous condition.
- `consistencyNotes` : héritage d’acteurs vérifié dans le bon sens, cas hérités non redessinés inutilement, écarts et hypothèses.

Les identifiants utilisés dans `relations` doivent exister dans `actors` et `useCases`. Le JSON, la description textuelle et le diagramme décrivent la même vue, globale ou spécifique.
