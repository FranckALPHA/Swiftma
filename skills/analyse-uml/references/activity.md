# Méthode — Diagrammes d’activité

## Rôle

Le diagramme d’activité donne une vue générale d’un processus métier. Il répond à : « Comment le processus évolue-t-il du déclenchement à son résultat ? »

Chaque fichier d’activité doit aussi contenir une description textuelle complète. Elle doit expliquer le déclencheur, les responsabilités, le scénario nominal, les décisions, les erreurs, les objets et leurs états, les événements, les systèmes externes et les écarts éventuels avec le backend.
Cette description doit nommer explicitement la source et la cible de chaque flux de contrôle et de chaque flux d’objet important, avec la relation utilisée (`produces`, `consumes`, `reads` ou `updates`).
Elle doit présenter les acteurs et partitions avant le déroulement. Chaque acteur ou partition doit être atomique et porter un seul rôle : séparer notamment l’application, PostgreSQL, Redis, les workers, les notifications et les systèmes externes au lieu de les regrouper dans un couloir composite.

Il ne remplace pas le diagramme de séquence :

- **activité** : vue métier globale, décisions, flux, données et événements ;
- **séquence** : cas précis, ordre d’appel entre acteurs, services, objets et systèmes.

## Éléments à représenter

Un processus peut contenir :

- acteur ou déclencheur ;
- objet d’entrée consommé, par exemple `DemandeAchat` ;
- actions métier ;
- objet consommé, transformé ou créé ;
- décisions avec conditions métier réelles ;
- objets produits, par exemple `CommandeConfirmee` ou `Billet` ;
- événement reçu ou émis, par exemple `PaymentCompleted` ;
- système externe, comme une passerelle de paiement ;
- tâche asynchrone ou notification ;
- résultat final et état d’échec.

## Expression nominale

Les libellés d’actions et d’objets utilisent l’expression nominale métier (règle 10 duodecies) : « Réserver le quota (catégorie, quantité) », jamais `POST`, nom de fonction code ou commande SQL/Redis. Les paramètres s’ouvrent en clair avec leur nom métier. Les routes, fonctions et lignes exactes restent dans les preuves et les notes.

## Éléments UML avancés

- **Partition / swimlane** : couloir de responsabilité pour un acteur, un service, une base de données ou un système externe. La partition est la responsabilité logique ; la swimlane est sa représentation visuelle.
- **Partition atomique** : une partition représente une seule responsabilité identifiable. `PostgreSQL`, `Redis`, `Tiketi`, `Notifications` et `Worker Celery` sont des partitions distinctes lorsqu’ils participent au flux ; ne pas créer une partition `Redis et base de données` ou `Application et base`.
- **Nœud d’objet** : donnée consommée, transformée ou produite, par exemple `Order pending` ou `Ticket confirmé`.
- **Flux d’objet** : déplacement d’un objet entre deux actions ; le distinguer d’un simple flux de contrôle.
- **Fork** : séparation en branches exécutées en parallèle.
- **Join** : synchronisation de branches parallèles ; ne pas le confondre avec une fusion d’alternatives.
- **Fin locale** : termine un chemin ou une région sans terminer l’activité entière.
- **Région interruptible** : sous-processus interrompu par un événement comme une annulation, une expiration ou une erreur externe.
- **Événement** : fait instantané reçu ou émis, distinct d’une action durable et d’un objet persistant.
- **Décision/fusion** : la décision choisit une branche selon une garde ; la fusion réunit des alternatives. Ils ne représentent pas du parallélisme.
- **Provenance d’objet** : un objet ne doit jamais être posé seul dans le flux. Il doit être produit par une action, un événement reçu ou un déclencheur externe explicitement dessiné, puis consommé, lu, transformé ou détruit par une action. Le flux doit permettre de répondre à « qui a produit cette donnée ? » et « quelle action la consomme ? ».
- **Transition d’état** : lorsqu’une action modifie un objet significatif, représenter si nécessaire deux occurrences annotées, par exemple `Order [pending]` puis `Order [confirmed]`, reliées à l’action. Ne pas utiliser seulement une flèche `objet -> action` étiquetée « met à jour » si l’état après l’action est important.
- **Objet métier et état technique** : ne pas confondre une entité métier avec une valeur mise en cache, un compteur ou un verrou Redis. Si l’action modifie Redis mais pas l’entité persistante, représenter séparément le quota ou la réservation Redis et l’entité métier lue. Toute mise à jour doit être confirmée par une écriture réelle dans le backend.
- **Décision** : chaque losange doit avoir exactement un flux de contrôle entrant (sauf cas de fusion explicite), au moins deux sorties, et une garde sur chaque sortie. Les gardes doivent exprimer la condition métier réelle et couvrir les résultats possibles. Placer le losange après l’action qui calcule ou obtient la valeur testée ; ne pas faire précéder une réservation atomique d’un losange « quota suffisant » si seul Redis peut déterminer le résultat final.

En Mermaid, utiliser des `subgraph` pour les partitions, des nœuds dédiés pour les objets et événements, et des nœuds de synchronisation annotés `fork` ou `join` lorsque la syntaxe native ne permet pas de les distinguer visuellement. Chaque fork, join ou interruption doit être justifié par le backend ou, en greenfield, marqué comme proposition.

## Exemple : processus global d’achat

```text
Début
  ↓
Utilisateur : Faire une demande d’achat
  ↓
Demande d’achat [produite]
  ↓
Vérifier événement et catégories
  ↓
Réserver atomiquement le quota
  ↓
Quota suffisant ? ── [non] → Refuser la commande → Fin échec
  │ [oui]
  ↓
Créer Commande + LignesCommande + Billets en attente [produits]
  ↓
Initier Paiement
  ↓
Paiement confirmé ? ── non → Libérer le quota → Fin échec
  │ oui
  ↓
Confirmer Commande et Billets
  ↓
Émettre PaymentCompleted
  ↓
Notifier l’acheteur et produire le QR code
  ↓
Fin succès
```

## Distinction consommé / produit / événement

## Distinguer action et objet

- **Action** : traitement exécuté dans le processus, par exemple `Réserver le quota`, `Créer la commande` ou `Confirmer le paiement`. Elle peut consommer des objets, en produire, en mettre à jour et émettre un événement.
- **Objet** : donnée, artefact ou résultat manipulé, par exemple `TicketCategory`, `Réservation de quota`, `Order pending` ou `Payment`. Il peut être lu, créé, modifié ou détruit.
- **Événement** : fait instantané qui déclenche ou informe une action, par exemple `payment.complete`. Il ne doit pas être confondu avec l’objet `Payment`.

Dans le JSON, utiliser `actions`, `objects` et `events` séparément. Décrire les relations avec `consumes`, `produces`, `updates`, `reads` et `emits`. Une donnée d’entrée comme `DemandeAchat` devient un nœud `input` ; elle ne devient une classe métier que si le backend ou la conception confirme une classe persistante. Même un nœud `input` doit avoir une provenance : action de l’utilisateur, événement externe ou déclencheur explicitement représenté.

- **Objet consommé** : donnée ou objet utilisé par une action et dont l’état peut changer.
- **Objet produit** : objet créé ou résultat disponible après l’action.
- **Événement** : fait passé notifiant d’autres composants ; il ne doit pas être confondu avec un objet métier persistant.

## Contrôle des objets et des losanges

Avant de valider un diagramme d’activité, effectuer les contrôles suivants :

1. Pour chaque objet, identifier son producteur ou son déclencheur externe.
2. Pour chaque objet, identifier au moins une action qui le consomme, le lit, le transforme ou le détruit.
3. Pour chaque mise à jour, vérifier l’état avant, l’état après et l’écriture backend qui la justifie.
4. Distinguer les états d’une entité métier des compteurs, caches et réservations techniques.
5. Pour chaque losange, vérifier un flux entrant, deux sorties minimum et une garde explicite sur chaque sortie.
6. Vérifier que les gardes sont placées après l’action qui connaît réellement le résultat testé.
7. Vérifier qu’un losange n’est pas une validation redondante, une fusion ou un parallélisme déguisé.

Un diagramme doit être rejeté ou annoté `Proposé` si un objet est flottant, si une transition d’état n’est pas traçable ou si une décision ne correspond pas à une branche réelle du code ou à une règle métier explicitement définie.

## Structure JSON de référence

Chaque activité doit inclure un bloc JSON sémantique respectant cette structure minimale :

```json
{
  "type": "activity",
  "name": "NomProcessus",
  "analysisMode": "existing | partial | greenfield",
  "partitions": [],
  "objects": [],
  "actions": [],
  "events": [],
  "decisions": [],
  "controlNodes": [],
  "regions": [],
  "controlFlows": [],
  "objectFlows": [],
  "consistencyNotes": []
}
```

Les collections suivent les responsabilités suivantes :

- `partitions` : acteurs, services, bases, workers ou systèmes externes responsables d’une action.
- `objects` : données, artefacts et occurrences d’état ; chaque objet doit avoir une provenance ou un déclencheur et une destination.
- `actions` : traitements exécutés ; elles déclarent leur `partition`, leurs `consumes`, `produces`, `reads`, `updates` et `emits` lorsque nécessaire.
- `events` : faits instantanés reçus ou émis ; ils déclarent notamment `emittedBy` et éventuellement leur partition.
- `decisions` : losanges métier ; ils déclarent leur emplacement logique et leurs gardes exhaustives.
- `controlNodes` : nœuds initial, final, fin locale et attente d’événement.
- `regions` : régions interruptibles ; elles déclarent `contains` et leurs interruptions avec un handler existant.
- `controlFlows` : enchaînements orientés entre actions et nœuds de contrôle, avec une garde pour chaque branche.
- `objectFlows` : relations orientées entre actions et objets, avec `produces`, `consumes`, `reads` ou `updates`.
- `consistencyNotes` : écarts entre code, besoin métier et diagramme, ainsi que les hypothèses ou points à confirmer.

Les identifiants utilisés dans `controlFlows`, `objectFlows`, `decisions` et `regions` doivent être définis dans le JSON. Un handler d’interruption doit être une action déclarée, située dans une partition explicite, ou être marqué `À implémenter`.

Exemple : `Order` est produit lors de la commande, `PaymentCompleted` est émis après confirmation, et `Ticket` devient produit confirmé après le paiement.

## Application existante

Explorer les services, conditions, événements internes, tâches Celery/RabbitMQ, écritures en base, Redis et appels externes. Reprendre les conditions métier réellement présentes. Ne pas ajouter un parallélisme si le code ne lance pas d’exécution concurrente.

## Application non développée

Le diagramme décrit le processus cible. Marquer chaque élément comme `Confirmé`, `Proposé`, `À décider` ou `À implémenter`. Ajouter les règles de gestion, les données consommées et produites, ainsi que les événements que le développeur devra créer.

## Format Mermaid conseillé

Utiliser `flowchart` avec :

- `([Début])` et `([Fin])` ;
- rectangles pour les actions ;
- losanges pour les décisions ;
- nœuds de données pour les objets consommés/produits ;
- nœuds dédiés pour les événements ;
- sous-graphes pour les couloirs acteur, application, base et systèmes externes.

La vérification finale doit contrôler la présence des partitions pertinentes, la distinction entre flux de contrôle et flux d’objet, la fermeture correcte des forks/joins, les fins locales, les régions interruptibles et les événements reçus ou émis. Ne pas ajouter ces éléments pour décorer le diagramme : ils doivent représenter une responsabilité, un parallélisme ou une interruption réelle.

Un service externe doit être représenté dans un couloir distinct. Montrer ce qui est envoyé, ce qui est reçu et l’événement produit : par exemple `NotchPay` reçoit une demande de paiement et émet `payment.complete`.
