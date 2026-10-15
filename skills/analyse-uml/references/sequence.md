# Méthode — Diagrammes de séquence par cas d’utilisation

## Participants

Remplacer le participant générique `Système` par les intervenants réels :

```text
Acteur → Router/API → Service métier → Objet métier → Base de données
                                      ↘ Redis / API externe / tâche async
```

Un modèle ORM peut apparaître comme participant lorsqu’il est créé ou modifié. La base de données reste un participant distinct pour les lectures et écritures.

## Expression nominale

Les libellés de messages et d’opérations utilisent l’expression nominale métier (règle 10 duodecies) : « Soumettre la commande (catégories, quantités) », jamais `POST /tickets/orders` ni `create_order(user_id, data)`. Les paramètres s’ouvrent en clair avec leur nom métier. Les routes, fonctions et lignes exactes restent dans `evidence` et les notes.

## Description textuelle

Chaque fichier de séquence contient, avant le diagramme, une description textuelle complète et compréhensible sans lire le Mermaid ni le JSON. Elle présente dans l’ordre : le périmètre et le scénario unique, le déclencheur, les participants atomiques et leurs rôles, le déroulement numéroté avec les sens `source -> cible`, les types de messages utilisés (`sync`, `async`, `return`, `create`, `destroy`, `event`), les lignes de vie créées et leur position verticale (`createdBy`) en distinguant les objets préexistants, les cadres utilisés (`alt`, `opt`, `loop`, `par`, `sd`, `ref`, `break`) ainsi que ceux refusés avec leur justification, les objets et leurs états, les erreurs et retours, les appels externes et les écarts avec le backend. Elle ne répète pas simplement la liste des messages : elle explique qui attend quoi, qui est créé quand, ce qui interrompt le scénario et ce qui reste à confirmer.

## Exemple : achat d’un billet

Rechercher dans le code l’ordre réel : création de commande, vérification de l’événement et des catégories, réservation Redis, persistance de `Order` et `OrderItem`, création des `Ticket` en attente, initiation du paiement, webhook, confirmation de `Payment`, appel de `OrderService.confirm_order()`, confirmation des billets, QR codes, commissions, points et notifications.

Représenter une branche `alt` pour les erreurs explicitement gérées : quota insuffisant, événement indisponible, paiement échoué ou commande déjà traitée.

## Types de messages

Chaque message du JSON porte un `kind` fermé :

- `sync` : appel synchrone, l’appelant attend le retour et reste bloqué (ex. `router -> service`, `service -> postgres`). Mermaid : `A->>B: op` puis `B-->>A: retour`.
- `async` : message asynchrone, sans attente (ex. publication RabbitMQ, push FCM). Mermaid : `A->B: événement`.
- `return` : réponse à un `sync`, toujours en pointillés. Mermaid : `B-->>A: résultat`.
- `create` : instanciation réelle d’un objet ou d’une ressource (ex. `INSERT Order`, `SETEX` Redis). L’objet correspondant doit apparaître dans `objects` avec `createdBy` pointant vers ce message. Mermaid : message `<<create>>` ou `create participant`.
- `destroy` : suppression réelle ou fin d’une ressource temporaire (ex. `DEL ticket_reservation`, `SREM` de nettoyage). L’objet doit porter `destroyedBy`. Mermaid : `A-xB` / `A--xB` (croix). Ne jamais détruire une commande ou un billet confirmé pour terminer artificiellement le scénario.
- `event` : fait externe asynchrone (webhook NotchPay, `payment.completed`). Comportement non bloquant comme `async`, mais origine externe et preuve du contrat (route, signature, payload).

Règles : tout `sync` significatif attend un `return` documenté (dans `messages` ou `returns`) ; un `async`/`event` n’en attend jamais ; un `create`/`destroy` n’est utilisé que si le code instancie ou supprime réellement ; les anciennes valeurs libres (`call`, `read`, `update`, `persist`, `commit`, `state-transition`) se normalisent en `sync` avec l’opération précise dans `operation`.

## Création et destruction

Utiliser `create` seulement lorsque le code instancie réellement l’objet. Utiliser `destroy` uniquement lorsqu’un objet est effectivement supprimé ou lorsqu’il s’agit d’une ressource temporaire. Ne pas détruire une commande ou un billet confirmé pour terminer artificiellement le scénario.

## Position verticale et créations dans le temps

Les `participants` sont les lignes de vie initiales : ils existent dès le haut du diagramme (acteurs, routeurs, services, bases, systèmes externes). Les `objects` porteurs d’un `createdBy` sont des lignes de vie créées en cours de scénario : le générateur doit les faire apparaître à hauteur du message créateur, donc plus bas que les participants initiaux, et les ordonner entre eux selon l’ordre des messages `createdBy` (un objet créé par `m5` apparaît au-dessus d’un objet créé par `m11`). Un objet sans `createdBy` est supposé préexistant et se rend en haut comme un participant. Symétriquement, un objet porteur d’un `destroyedBy` voit sa ligne de vie se terminer à hauteur de ce message (croix). En Mermaid, rendre cela par `create participant` au point de création, ce qui positionne automatiquement le rectangle plus bas que les participants déclarés en tête.

## Rigueur

Un endpoint purement CRUD sur une seule table ne mérite généralement pas un diagramme de séquence détaillé. Prioriser les flux qui coordonnent plusieurs services, une base et un système externe.

## Si l’application n’est pas développée

Le diagramme décrit la séquence cible que le développeur devra implémenter. Utiliser des participants conceptuels explicites (`ServiceCommande`, `MoyenPaiement`, `Stock`) et marquer les choix d’architecture `Proposé` ou `À décider`. Ajouter les contrats attendus et les erreurs métier même s’ils ne sont pas encore codés.

Un système externe possède sa propre ligne de vie : API de paiement, fournisseur OAuth, service de notification, stockage ou API GPS. Documenter les requêtes, réponses, callbacks/webhooks et erreurs réels, sans le représenter comme une classe métier interne.

## Structure JSON de référence

Chaque diagramme de séquence doit inclure dans son Markdown un bloc JSON sémantique de cette forme :

```json
{
  "type": "sequence",
  "name": "NomScenario",
  "analysisMode": "existing | partial | greenfield",
  "participants": [],
  "messages": [],
  "fragments": [],
  "objects": [],
  "errors": [],
  "returns": [],
  "consistencyNotes": []
}
```

Les collections ont les responsabilités suivantes :

- `participants` : acteurs, routeurs, services, objets métier, bases, caches, workers et systèmes externes ; un participant porte un seul rôle et une preuve.
- `messages` : appels ou événements orientés avec `from`, `to`, `operation`, `kind`, `guard`, `returns` et `evidence` lorsque disponibles.
- `fragments` : cadres `alt`, `opt`, `loop`, `par`, `sd`, `ref` et `break`, avec leurs conditions et messages contenus. `ref` porte en plus le diagramme cible (`ref` : nom du scénario référencé) ; `break` porte la conséquence (sortie du scénario principal).
- `objects` : objets créés, lus, modifiés ou détruits pendant le scénario, avec leur état, le message créateur (`createdBy`, qui fixe leur position verticale) et le message destructeur (`destroyedBy`, qui termine leur ligne de vie).
- `errors` : erreurs métier ou techniques réellement renvoyées, leur origine, leur cible et leur conséquence.
- `returns` : réponses HTTP, résultats de service, callbacks ou événements retournés, avec leur émetteur et leur destinataire.
- `activations` (optionnel) : occurrences d’exécution explicites, avec le participant, le message d’entrée (`from`) et le message de sortie (`to`). À n’utiliser que lorsque la dérivation automatique ne suffit pas.
- `consistencyNotes` : écarts, hypothèses, éléments proposés et différences entre le code, le diagramme et le scénario métier.

Exemple minimal d’un message :

```json
{
  "id": "m1",
  "from": "router",
  "to": "orderService",
  "operation": "create_order(data)",
  "kind": "call",
  "returns": "orderPending",
  "evidence": "backend/modules/tickets/router.py"
}
```

## Cadres de fragments

- `alt` (Alternative) : condition Si/Sinon. Divise le cadre en régions exclusives, une seule s’exécute. Mermaid : `alt` / `else`.
- `opt` (Optionnel) : condition Si seule. Le bloc s’exécute si elle est vraie, sinon il est ignoré. Mermaid : `opt`.
- `loop` (Boucle) : répète les messages tant que la condition est vraie (ex. pour chaque élément d’une liste). Mermaid : `loop`.
- `par` (Parallèle) : les blocs s’exécutent simultanément. Mermaid : `par` / `and`.
- `sd` (Sequence Diagram) : entoure l’ensemble du diagramme pour lui donner un titre et définir son contexte. Mermaid : le diagramme lui-même, avec son titre (`title:`) ; un seul `sd` par fichier, égal au `name` du JSON.
- `ref` (Référence) : renvoie à un autre diagramme de séquence existant pour éviter de surcharger le diagramme actuel. Mermaid ne possède pas de mot-clé natif : représenter par un message d’appel nommé vers le scénario référencé accompagné d’une note contenant le lien vers son fichier.
- `break` (Rupture) : interrompt le scénario principal si une condition d’erreur ou d’exception survient (équivalent d’un `break` ou d’une exception en code) ; la suite du scénario principal ne s’exécute pas. Mermaid : `break`.

Ne pas confondre `opt` (zéro ou une exécution) avec `alt` (exactement une région parmi plusieurs), ni `break` (sortie du scénario) avec `alt` d’erreur (branche qui se termine puis rend la main).

## Activations et durées des lignes de vie

L’activation (barre d’exécution) montre pendant combien de temps un participant traite activement :

- Un message `sync` active son destinataire : l’activation commence à la réception du message et se termine au `return` correspondant. L’appelant reste lui-même actif pendant l’attente (activations empilées en cas d’appels imbriqués).
- Un message `async` ou `event` n’active pas l’émetteur au-delà de l’envoi et n’impose aucune durée au destinataire : pas de barre bloquante côté appelant.
- Un message `create` commence aussi la ligne de vie de l’objet créé ; un message `destroy` la termine (la barre ne dépasse jamais la croix).
- Les traitements internes sans message (calcul, temporisation) ne créent pas d’activation sauf s’ils structurent le scénario : les représenter alors par une auto-invocation explicite, jamais par une barre flottante.
- Par défaut, les activations se dérivent des paires `sync`/`return` du JSON et n’ont pas besoin d’être déclarées. La collection `activations` ne sert qu’aux cas non dérivables (auto-traitement, chevauchements particuliers), avec `from` et `to` référençant des messages existants.
- En Mermaid, rendre les activations par les suffixes `+`/`-` (`A->>+B` … `B-->>-A`) ou par `activate`/`deactivate`. Ne pas empiler plus de niveaux que les appels imbriqués réels du code.

Les identifiants utilisés par `messages`, `fragments`, `objects`, `errors` et `returns` doivent être définis dans le JSON. Le JSON, la description textuelle et le diagramme Mermaid doivent décrire le même scénario et le même ordre d’exécution.
