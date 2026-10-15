# Méthode — Diagrammes de classes par cas d’utilisation

Un diagramme de classes spécifique représente les classes nécessaires à un cas d’utilisation, pas toutes les tables de la base.

Pour chaque classe retenue, préciser selon le besoin les attributs utiles, les opérations métier réellement utilisées, les relations et cardinalités déduites du modèle, ainsi que les statuts et contraintes qui influencent le scénario.

## Encapsulation et opérations

Utiliser les visibilités UML suivantes :

```text
- attribut privé       + opération publique
# élément protégé      ~ élément du package
```

Les attributs sont privés par défaut afin de protéger les invariants de l’objet. Les méthodes publiques représentent les opérations métier réellement exposées par la classe ou par un service identifié dans le backend. Ne pas ajouter automatiquement des getters/setters. Une classe de liaison ou un modèle persistant sans comportement propre peut rester sans méthode lorsque la logique est portée par un service ; le documenter dans une note.

## Types de relations

Qualifier les relations selon le cycle de vie réel :

```text
Parent *-- Enfant       composition : l’enfant dépend du parent et disparaît avec lui
Parent o-- Élément      agrégation : le parent regroupe un élément indépendant
Service ..> Dépendance  dépendance : utilisation ponctuelle d’un service ou fournisseur
Classe --> Classe       association : lien métier structurel simple
```

Ne pas utiliser la composition uniquement parce qu’une classe possède une clé étrangère. Vérifier `cascade`, `delete-orphan`, `ondelete` et la responsabilité métier. Ne pas forcer un type de relation si le cas ne le justifie pas.

## Navigabilité

La navigabilité précise le sens d’accès entre classes et est indépendante de l’association, de l’agrégation ou de la composition :

```text
A --> B       navigation de A vers B
A -- B        navigation non définie
A --> B
B --> A       navigation bidirectionnelle
A --× B        navigation explicitement interdite de B vers A
A ×-- B        navigation explicitement interdite de A vers B
```

La croix `×` placée à une extrémité indique explicitement que cette extrémité n’est pas navigable. Mermaid ne la rend pas toujours nativement ; dans ce cas, la documenter dans une note. Pour une relation `*--` ou `o--`, indiquer aussi la navigabilité ; pour `..>`, la flèche représente déjà l’utilisation de la cible. Ne pas inventer une navigation inverse sans référence ou responsabilité correspondante dans le backend.

Les objets récurrents peuvent être réutilisés dans plusieurs diagrammes : `User`, `Event`, `Order`, `Ticket` ou `Payment`.

## Exemple : acheter un billet

```text
User
  └── Order
        ├── OrderItem ── TicketCategory ── Event
        ├── Ticket ── Event
        └── Payment
```

La logique peut inclure la réservation du quota, la commande en attente, les lignes de commande, les billets en attente, le paiement, la confirmation, le QR code et la mise à jour du nombre vendu.

## Fidélité au backend

Si le code contient `Order`, `OrderItem`, `Ticket`, `TicketCategory` et `Payment`, reprendre ces noms réels. Si la demande parle de `Facture` mais qu’aucun modèle ou service de facture n’existe, écrire clairement :

```text
Facture : élément métier attendu, non implémenté dans le backend actuel.
```

Ne pas la présenter comme une classe déjà existante.

## Si l’application n’est pas développée

Les classes peuvent être proposées à partir du scénario. Distinguer explicitement :

- entité métier persistante ;
- objet valeur ;
- service applicatif ;
- interface vers un système externe ;
- DTO de transport.

Une classe proposée doit avoir une responsabilité claire et être reliée à une règle du cas d’utilisation. Les classes non confirmées portent le statut `Proposé` ou `À implémenter`.

## Fusion

Fusionner les classes de même responsabilité, conserver les relations confirmées, résoudre les noms divergents, distinguer modèles persistants, services et objets externes, et déplacer les détails dans les diagrammes spécifiques si le global devient illisible.

## Structure JSON de référence

Chaque diagramme de classes inclut dans son Markdown un bloc JSON sémantique de cette forme :

```json
{
  "type": "class",
  "name": "NomVue",
  "analysisMode": "existing | partial | greenfield",
  "classes": [],
  "relations": [],
  "consistencyNotes": []
}
```

- `classes` : avec `id`, `label`, `stereotype` éventuel (`abstraite`, `externe`, `proposée`), `attributes` (`name`, `type`, `visibility`, avec `-` privé par défaut), `operations` (`name`, `visibility`, `+` public par défaut), `status` et `evidence`. Aucune classe métier vide sans stéréotype explicite.
- `relations` : avec `from`, `to`, `kind` (`composition`, `aggregation`, `association`, `dependency`, `generalization`), `navigability` (`forward`, `backward`, `both`, `none`), cardinalités, rôle éventuel et `evidence`.
- `consistencyNotes` : opérations réellement portées par la classe ou un service identifié (sans getters/setters inventés), classes de liaison sans opération expliquées en note, écarts et hypothèses.

Les identifiants utilisés dans `relations` doivent exister dans `classes`. Le JSON, la description textuelle et le diagramme décrivent les mêmes classes réellement nécessaires au cas traité.
