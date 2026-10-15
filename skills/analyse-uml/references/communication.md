# Méthode — Diagrammes de communication

## Rôle

Le diagramme de communication décrit la collaboration entre objets pendant un scénario. Il met l’accent sur les liens et les messages, tandis que le diagramme de séquence met l’accent sur l’axe temporel.

## Description textuelle

Chaque fichier de communication contient, avant le diagramme, une description narrative complète et compréhensible sans lire le Mermaid ni le JSON. Elle présente le scénario et sa séquence source, les collaborateurs et leurs rôles, le déroulement dans l’ordre de la numérotation en nommant qui collabore avec qui, les variantes et gardes, les simplifications assumées par rapport à la séquence (retours omis, bus factorisé) et les écarts avec le backend. Elle ne répète pas simplement la liste des messages : elle explique la topologie de la collaboration.

## Expression nominale

Les libellés de messages et d’opérations utilisent l’expression nominale métier (règle 10 duodecies) : « Soumettre la demande de transfert (billet, destinataire) », jamais `POST /tickets/{id}/transfer` ni nom de fonction code. Les paramètres s’ouvrent en clair avec leur nom métier. Les routes, fonctions et lignes exactes restent dans `evidence` et les notes.

Les libellés d’objets mènent par le terme métier, précision technique entre parenthèses : « Base de données (PostgreSQL) », « Cache (Redis) », « API de paiement (NotchPay) ». On ne fusionne jamais deux magasins sous le même terme générique : si PostgreSQL et Redis collaborent dans le même scénario, leurs libellés restent distincts. Les identifiants (`id`) restent techniques et stables.

## Construction

1. Partir d’un diagramme de séquence validé.
2. Reprendre uniquement les objets qui participent au scénario.
3. Dessiner les liens entre objets capables de communiquer.
4. Placer les messages sur les liens et les orienter de l’émetteur vers le récepteur.
5. Numéroter les messages dans l’ordre : `1`, `1.1`, `1.2`, puis `1.1.1` pour les sous-appels.
6. Utiliser `1a` et `1b` pour des alternatives, une garde `[condition]` pour une condition et `*` pour une itération.
7. Représenter un appel interne par un message réflexif, par exemple `service → service : 1.3 calculerTotal()`.

## Stéréotypes Jacobson

- `<<boundary>>` (Interface / Frontière) : gère les interactions entre le système et le monde extérieur, utilisateurs ou autres systèmes. Exemples : écran de saisie, API, page web, routeur HTTP qui reçoit une requête.
- `<<control>>` (Contrôle / Gestionnaire) : contient la logique métier, coordonne les actions et fait la liaison entre l’interface et les données. Exemples : gestionnaire de panier, contrôleur d’authentification, service qui orchestre le scénario.
- `<<entity>>` (Entité / Données) : représente les données persistantes du système et les informations métier basiques. Exemples : utilisateur, produit, commande, billet, journal de scan.
- `<<external>>` : système ou fournisseur hors de la frontière (paiement, push, bus externe). Il n’est jamais une classe métier interne.

Les stéréotypes décrivent le rôle de l’objet dans le scénario, pas nécessairement son type de classe permanent : un routeur FastAPI est `boundary` même si c’est du code applicatif, et un service est `control` même s’il ne porte qu’une partie de l’orchestration.

Un magasin persistant (PostgreSQL, Redis) porte le stéréotype `entity`, mais il n’est pas une entité métier comme Billet ou Événement : il joue le rôle de collaborateur de données persistantes — il conserve l’état, répond aux lectures et applique les écritures, sans jamais initier. Pour lever toute ambiguïté, son `role` doit nommer les entités métier contenues (ex. « Magasin persistant : billets, transferts, échéances »). Éclater chaque table en objet propre resterait possible, mais cela dupliquerait le diagramme de classes et rendrait la collaboration illisible : le magasin agrège, les classes détaillent.

## Syntaxe des messages

```text
1 : acheterBillet(data)
1.1 : validerCommande()
1.2* : vérifierQuota(catégorie)
1.3 : calculerTotal()
1.4a : confirmerPaiement()
1.4b : signalerÉchec()
```

Le lien entre objets indique une possibilité de collaboration ; le message indique une interaction particulière exécutée pendant le scénario. Il ne faut pas confondre le lien avec le message.

## Matrice des interactions autorisées

Pour maintenir une architecture propre, les objets ne communiquent pas n’importe comment. Le stéréotype de l’émetteur et celui du destinataire déterminent si le message est valide :

| Source | Cible | Autorisé ? | Justification |
|---|---|---|---|
| `Boundary` | `Control` | ✅ | L’interface transmet l’action de l’utilisateur au gestionnaire. |
| `Boundary` | `Entity` | ❌ / déconseillé | Toléré uniquement en lecture seule directe et justifiée. |
| `Control` | `Entity` | ✅ | Le contrôleur modifie ou récupère les données de l’entité. |
| `Control` | `Boundary` | ✅ | Le contrôleur demande à l’interface de s’actualiser ou d’afficher un message. |
| `Entity` | `Control` | ❌ | Une entité pure ne pilote jamais la logique d’un contrôleur. |
| `Entity` | `Boundary` | ❌ | Une entité ne s’adresse jamais directement à l’interface. |
| `Control` | `Control` | ✅ | Délégation et orchestration entre services (ex. paiement → commande). |
| `Control` | `External` | ✅ | Appel sortant vers un fournisseur, initié par la logique métier. |
| `External` | `Boundary` | ✅ | Webhook ou callback entrant reçu par le point d’entrée. |
| `External` | `Actor` | ✅ | Notification consultable par l’utilisateur (via push). |
| `Actor` | `Boundary` | ✅ | L’acteur déclenche le scénario par l’interface. |
| `Control` | `Actor` | ✅ | Le contrôleur notifie directement l’acteur (email, push), sans repasser par l’interface d’origine. |
| `Entity` | `Entity` | ⚠️ persistance seule | Uniquement la persistance de son propre état (ex. `ScanLog → INSERT`), jamais du pilotage. |

Règles transverses :

- Un message de `kind: return` est toujours autorisé en sens inverse sur le même lien : c’est la réponse à l’appel, pas un nouveau pilotage.
- Les messages `event` suivent les mêmes rôles : un événement ne permet pas à une entité de piloter un contrôleur.
- Tout écart à la matrice doit être justifié dans `consistencyNotes` ou le message doit être re-routé (ex. passer par le contrôleur au lieu d’un accès direct `Boundary → Entity`).

## Messages réflexifs

Un message réflexif modélise une auto-invocation : traitement logique local, calcul ou validation de règles métier exécutés par un composant après avoir reçu les données nécessaires.

- Règle d’or : l’émetteur (`from`) et le récepteur (`to`) sont strictement identiques, via un lien réflexif déclaré (`from` égal à `to`).
- Emplacement typique : sur un `control` (évaluation de gardes, validation de format), sur une `entity` (auto-calcul de cohérence, ex. date d’expiration).
- Séquencement : toujours après le message synchrone qui a fourni la donnée brute. Ne jamais mélanger lecture et validation dans le même libellé : splitter en appel `sync` puis réflexif.
- En Mermaid, arête bouclée (`S -->|"1.1.2 : ..." | S`) ; en JSON, `kind: sync` sauf justification contraire.

## Numérotation alternative

Quand le système bifurque à partir d’un même point de décision, la numérotation reflète le parallélisme sans rupture d’arbre :

- Suffixes alphabétiques juste après l’indice du niveau où le choix se produit : `2.1.2a` et `2.1.2b`, jamais `2b.1` qui sort de nulle part et casse l’arborescence du parent.
- Chaque branche porte une `guard` explicite (condition d’activation).
- Arborescence stricte : les sous-messages d’une branche incrémentent le dernier indice en gardant la lettre (`2.1.2a` → `2.1.3a`, `2.1.4a` ; branche parallèle `2.1.3b`, `2.1.4b`).
- La rupture (`break`) porte la lettre (`3a`) pendant que la continuation nominale reste nue (`3.1`, `3.2`).
- Limite empirique : trois niveaux maximum pour les flux nominaux (`1`, `1.1`, `1.1.1`). Tout niveau supplémentaire est réservé à une exception technique absolue ou à un message réflexif très court.

## Expressivité des textes

Les libellés évitent le jargon vague (`vérification`, `save`, `process`) au profit de verbes métier :

| Contexte | Type d’appel | Gabarit | Exemple |
|---|---|---|---|
| Lecture base | Synchrone | Récupérer l’état actuel de [Entité] | « Récupérer l’état actuel du billet » |
| Validation interne | Réflexif | Évaluer les gardes et valider [Action] | « Évaluer les gardes et valider l’éligibilité » |
| Écriture base | Synchrone / mutation | Mettre à jour : [Entité] [état] | « Mettre à jour : Transfert [expired] + Billet [confirmed] » |
| Création | Création | Créer [Objet] [état] | « Créer le transfert en attente » |
| Notification | Événement | Annoncer [Événement métier] | « Annoncer l’acceptation du transfert » |
| Contrôle | Synchrone | Vérifier / Valider / Calculer [Objet] | « Vérifier la correspondance du code » |

Les écritures indiquent toujours l’état cible entre crochets ; les lectures précisent l’état attendu.

## Audit de la numérotation

Après la création du diagramme, sélectionner l’ensemble des numéros de messages et valider l’ordre chronologique :

1. Trier les numéros et vérifier l’arbre strict : chaque niveau incrémenté existe (`1.1`, `1.2` après `1`), sans trou dans le tronc nominal.
2. Vérifier que chaque lettre est placée au niveau où le choix se produit, avec sa garde explicite.
3. Vérifier que les branches jumelles sont au même niveau (ex. succès `3.2a` et échec `3.2b`, jamais `3a` face à `3.2.1b`).
4. Vérifier que les sous-messages d’une branche incrémentent le dernier indice en gardant la lettre (`3.2a` → `3.3a`, `3.4a`).
5. Vérifier trois niveaux maximum sur les flux nominaux.
6. Vérifier que la rupture interrompt : aucun message ne continue sa branche après un `break`.
7. Rejeter les suffixes composites (`3.2a_invalid`) et les gardes exprimées en constantes code (`TRANSACTION_APPROVED`) au profit de gardes nominales.

## Arbre de numérotation

Le `flowchart` Mermaid ne montrant pas l’ordre, chaque diagramme présente son arborescence de numéros en bloc texte avant le diagramme, avec les opérations nominales courtes :

```text
2 Réclamer le billet
└── 2.1 Traiter la réclamation
    ├── 2.1.1 Récupérer l'état
    ├── 2.1.2a Code valide
    │   ├── 2.1.3a Mise à jour acceptée
    │   └── 2.1.4a Annonce
    └── 2.1.2b Échéance dépassée
        └── 2.1.3b Mise à jour expirée
```

L’arbre reprend exactement les numéros du JSON, dans l’ordre chronologique : tronc nu, lettres au niveau du choix, réflexifs à leur position, rupture marquée. Il sert de support à l’audit de la numérotation.

## Vérification

Contrôler la correspondance avec la séquence source, la direction de chaque message, la numérotation, les gardes, les itérations, les messages réflexifs, les stéréotypes, les objets externes et l’absence de scénario indépendant mélangé dans le même diagramme.

## Structure JSON de référence

Chaque diagramme de communication inclut dans son Markdown un bloc JSON sémantique de cette forme :

```json
{
  "type": "communication",
  "name": "NomScenario",
  "analysisMode": "existing | partial | greenfield",
  "sourceSequence": "chemin/vers/SequenceSource.md",
  "objects": [],
  "links": [],
  "messages": [],
  "consistencyNotes": []
}
```

- `sourceSequence` : le diagramme de séquence validé d’où le scénario est dérivé ; la communication ne doit rien contenir que la séquence ne justifie.
- `objects` : collaborateurs avec `id`, `label`, `stereotype` (`boundary`, `control`, `entity`, `external`), `role` et `evidence`. Acteurs admis sans stéréotype.
- `links` : possibilités structurelles de collaboration avec `id`, `from`, `to` et `evidence` (pourquoi ces objets peuvent communiquer). Un lien sert aux deux sens ; ne pas dupliquer un lien par direction.
- `messages` : interactions exécutées avec `id`, `number` (`1`, `1.1`, `1a`/`1b` pour les alternatives), `from`, `to`, `link`, `operation`, `kind` (`sync`, `async`, `return`, `create`, `destroy`, `event`), et si besoin `guard` ou `iteration` (`*`). Un message réflexif a `from` égal à `to`.
- `consistencyNotes` : simplifications assumées par rapport à la séquence (retours omis, bus factorisé), écarts et hypothèses.

Exemple minimal d’un message :

```json
{
  "id": "c1",
  "number": "1.1",
  "from": "router",
  "to": "service",
  "link": "l2",
  "operation": "create_order(data)",
  "kind": "sync",
  "evidence": "backend/modules/tickets/router.py"
}
```

Les identifiants utilisés dans `links` et `messages` doivent exister dans `objects` et `links`. Le JSON, la description textuelle et le diagramme décrivent le même scénario, dans l’ordre de la séquence source.
