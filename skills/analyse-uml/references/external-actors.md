# Méthode — Acteurs externes

## Définition

Un acteur externe est un élément situé hors de la frontière du système actuellement étudié, mais qui échange avec lui. Il peut s’agir de :

- acteur humain appartenant à une autre organisation ;
- système tiers ou fournisseur externe ;
- API distante ;
- service technique externe ;
- bloc précis ou mini-système interne volontairement exclu du périmètre.

Exemples : `NotchPay`, `Google OAuth`, `API de géolocalisation`, `FCM`, `RabbitMQ`, un service de stockage ou un module interne documenté séparément.

## Règle de frontière

La qualification dépend du périmètre, pas du fait que le composant soit hébergé sur le même serveur :

```text
Système étudié : Tiketi
  ├── User, Event, Order, Ticket : éléments internes
  └── NotchPay, FCM, API GPS : acteurs externes
```

Si le périmètre devient « plateforme Tiketi + service de notification », ce service n’est plus externe pour ce diagramme et sa frontière doit être redessinée.

## Dans les diagrammes

### Cas d’utilisation

Représenter l’acteur externe hors de la frontière du système et le relier à un cas d’utilisation métier. Ne pas le relier à toutes les fonctionnalités techniques.

```text
NotchPay ── Confirmer ou refuser un paiement
API GPS  ── Fournir une position d’événement
FCM      ── Distribuer une notification push
```

Le cas d’utilisation doit rester formulé du point de vue du système, par exemple « Traiter le paiement », et non « Appeler NotchPay ».

### Diagramme de séquence

Créer une ligne de vie distincte pour l’acteur externe et montrer les messages réels : requête, réponse, callback, webhook, erreur ou délai. Un webhook est un événement entrant ; un appel API est une interaction sortante.

### Diagramme d’activité

Représenter l’acteur ou service externe dans un couloir séparé. Distinguer l’objet envoyé, l’objet reçu, l’événement entrant ou sortant et l’effet interne produit après réception.

Exemple : `NotchPay` émet `payment.complete`, Tiketi consomme l’événement, confirme `Payment`, puis produit les billets.

### Diagramme de classes

Ne pas modéliser une API externe comme une entité métier persistante. Utiliser plutôt une interface, un port ou un adaptateur :

```text
MoyenPaiement <<interface>>
NotchPayAdapter <<adapter externe>>
```

Les DTO externes peuvent apparaître dans un diagramme technique spécifique, mais pas dans le modèle métier global sauf s’ils ont une responsabilité métier réelle.

## Application existante

Rechercher les clients HTTP, SDK, webhooks, callbacks, files de messages, tâches et variables de configuration. Documenter le nom réel du fournisseur, le sens de l’échange et les erreurs effectivement gérées.

## Application non développée

Marquer les intégrations comme `Proposée`, `À décider` ou `À implémenter`. Définir au minimum l’opération, les données envoyées et reçues, l’événement, le timeout, la reprise et le comportement en cas d’indisponibilité.

## Ne pas confondre

- `Base de données` : acteur externe uniquement si elle est hors du système étudié ; sinon c’est un composant interne d’architecture.
- `Service interne` : acteur externe uniquement s’il est hors de la frontière du diagramme courant.
- `Objet métier` : ne devient jamais un acteur externe parce qu’il échange des données.
