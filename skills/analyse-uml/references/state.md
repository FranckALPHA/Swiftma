# Méthode — Diagrammes d’état-transition

## Rôle

Le diagramme d’état décrit le cycle de vie d’un objet métier du diagramme de classes. Il répond à : « Dans quels états cet objet peut-il se trouver et comment passe-t-il d’un état à l’autre ? »

Il ne faut pas créer un diagramme pour chaque classe. Retenir uniquement les classes qui ont un statut, un état périodique ou un cycle de vie métier significatif : `Order`, `Payment`, `Ticket`, `Event`, `Refund`, `AmbassadorPayout`, etc.

## Éléments obligatoires

Chaque diagramme doit identifier :

- **état initial** : point de départ de la machine ;
- **états** : situations durables de l’objet ;
- **état final** : fin irréversible ou fin du cycle documenté ;
- **transition** : passage d’un état vers un autre ;
- **événement** : déclencheur instantané de la transition ;
- **garde/condition** : règle qui autorise ou refuse la transition ;
- **effet** : traitement exécuté au moment du passage ;
- **activité d’état** : traitement qui se déroule pendant que l’objet reste dans l’état.

## Différence événement, effet et activité

Ne pas les confondre :

```text
Événement                 : instantané, déclenche la transition
[condition]               : garde qui doit être vraie
/ effet                   : action exécutée pendant la transition
do / activité             : traitement qui dure pendant l’état
```

Exemple :

```text
En préparation
  -- ajouterArticle / mettre à jour le stock -->
Panier constitué
  do / calculerTotal()
```

`ajouterArticle` est un événement instantané. `mettre à jour le stock` est un effet de transition. `calculerTotal()` est une activité exécutée tant que le panier reste dans l’état `Panier constitué`.

## Syntaxe de transition

Utiliser une notation explicite :

```text
événement [garde] / effet
```

Exemple métier :

```text
confirmerPaiement [payment.status = success] / confirmerBillets(), générerQR()
```

Ne pas utiliser un événement qui dure dans le temps. Si un traitement est continu ou périodique, le représenter en `do/` dans l’état ou comme événement planifié déclenchant une transition.

## États composites

Utiliser un état composite lorsqu’un état contient ses propres sous-états.

Exemple :

```text
Commande active
├── Paiement en attente
├── Paiement en cours
└── Paiement confirmé
```

Le diagramme doit montrer l’entrée dans l’état composite, l’état initial interne, les transitions internes et la sortie vers les états externes.

La portée des pseudo-états doit rester cohérente : un `[*]` placé dans un état composite est local à ce composite. Un sous-état terminal doit rejoindre le `[*]` final interne, puis le composite doit avoir une transition de complétion vers le `[*]` global. Ne pas écrire à l’extérieur une transition qui cible directement un sous-état interne.

## Pseudo-état historique

Utiliser `H` lorsque la réentrée dans un état composite doit reprendre le dernier sous-état actif. Utiliser `H*` si les sous-états imbriqués doivent également être restaurés.

Ne jamais ajouter un historique uniquement pour décorer le diagramme : il doit correspondre à une reprise réelle après interruption, suspension ou retour dans un processus.

## Analyse d’une application existante

Rechercher les valeurs de statut dans les modèles, enums, services, routes, tâches et migrations. Pour chaque transition, retrouver le code qui modifie réellement le statut et le traitement associé. Si une transition est seulement déduite d’un besoin mais absente du backend, la marquer `À implémenter`.

## Analyse d’une application à développer

Définir les états à partir des règles métier, puis documenter pour chaque transition : déclencheur, garde, effet et résultat. Marquer les choix non validés `Proposé` ou `À décider`.

## Exemple : cycle de vie d’une commande

```text
[*] --> EN_ATTENTE : créerCommande / réserverQuota()
EN_ATTENTE --> CONFIRMEE : paiementConfirme [commande pending] / générerQR()
EN_ATTENTE --> ECHOUEE : paiementEchoue / libérerQuota()
EN_ATTENTE --> EXPIREE : expiration15Minutes / libérerQuota()
CONFIRMEE --> REMBOURSEE : remboursementAccepte / invaliderBillets()
REMBOURSEE --> [*]
ECHOUEE --> [*]
EXPIREE --> [*]
```

Dans cet exemple, `paiementConfirme`, `paiementEchoue` et `expiration15Minutes` sont des événements instantanés ; `réserverQuota()`, `générerQR()` et `libérerQuota()` sont des effets de transition. Une activité durable comme `do / attendreConfirmationPaiement()` appartient à l’état `EN_ATTENTE`.

## Vérification de fin

Avant de valider un diagramme d’état, vérifier systématiquement : classe porteuse du statut identifiée, états confirmés par le backend, état initial et final présents, transitions accessibles, événement/condition/effet séparés, activités `do` distinguées des effets, états composites justifiés et historique `H` ou `H*` ajouté uniquement lorsqu’une reprise réelle est nécessaire.

## Structure JSON de référence

Chaque diagramme d’états-transitions inclut dans son Markdown un bloc JSON sémantique de cette forme :

```json
{
  "type": "state",
  "name": "NomCycleDeVie",
  "analysisMode": "existing | partial | greenfield",
  "class": "ClassePorteuse",
  "states": [],
  "transitions": [],
  "consistencyNotes": []
}
```

- `class` : la classe porteuse du cycle de vie, issue du diagramme de classes.
- `states` : états avec `id`, `label`, `kind` (`initial`, `simple`, `composite`, `final`), activité `do` éventuelle et `evidence`. États initiaux et finaux présents, composites justifiés, historique seulement si reprise réelle.
- `transitions` : avec `from`, `to`, `event` (fait instantané), `guard` (condition), `effect` (action de transition) et `evidence`. Événement, garde et effet toujours séparés ; activité `do` distinguée des effets.
- `consistencyNotes` : portée des sous-états respectée (pseudo-état interne jamais référencé depuis l’extérieur), écarts et hypothèses.

Les identifiants utilisés dans `transitions` doivent exister dans `states`. Le JSON, la description textuelle et le diagramme décrivent le même cycle de vie.
