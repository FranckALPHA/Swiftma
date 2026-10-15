# Mode conception — Application non développée

Ce mode est utilisé lorsqu’il n’existe pas encore de backend fiable à explorer. Les diagrammes deviennent une spécification de conception destinée au développeur.

## Ordre de production

1. Recueillir les acteurs, objectifs et règles métier.
2. Produire le diagramme de cas d’utilisation global.
3. Décomposer chaque grande fonctionnalité en cas spécifiques.
4. Pour chaque cas spécifique, identifier les classes métier, services, ports externes et objets persistants nécessaires.
5. Définir le diagramme d’activité du processus global : objets consommés, objets produits et événements émis, en parallèle de l’identification détaillée des classes.
6. Définir le diagramme de séquence nominal et les alternatives importantes à partir des activités et des classes validées.
7. Définir les diagrammes d’état des classes possédant un cycle de vie : états, transitions, gardes, effets et activités `do/`.
8. Déduire les contrats techniques : données d’entrée, sorties, statuts, erreurs et transactions.
9. Fusionner les vues validées en architecture globale.

## Ce qu’il faut donner au développeur

Chaque cas spécifique doit préciser :

- acteur principal et acteurs secondaires ;
- préconditions ;
- scénario nominal ;
- scénarios alternatifs et erreurs ;
- classes impliquées et responsabilité de chacune ;
- données à persister ;
- appels externes et événements asynchrones ;
- objets consommés, objets produits et événements émis/reçus ;
- états, transitions, événements, conditions, effets et activités exécutées dans l’état ;
- postconditions ;
- décisions encore ouvertes.

## Exemple : acheter un billet

### Classes proposées

```text
Utilisateur
Événement
CatégorieBillet
Commande
LigneCommande
Billet
Paiement
MoyenPaiement <<interface>>
Facture
```

### Séquence proposée

```text
Utilisateur → API : choisir une catégorie et une quantité
API → ServiceCommande : créerCommande()
ServiceCommande → Stock : réserverQuota()
ServiceCommande → Commande : créer()
ServiceCommande → Paiement : initier()
Paiement → MoyenPaiement : débiter()
MoyenPaiement → Paiement : succès ou échec
Paiement → ServiceCommande : confirmerCommande()
ServiceCommande → Billet : générer()
ServiceCommande → Facture : générer()
ServiceCommande → Utilisateur : retourner billets et facture
```

Dans une application non développée, `Facture` peut être une classe légitime même si aucun code ne l’implémente encore. Elle doit alors être marquée comme **à implémenter** dans la documentation.

## Règles de conception

- Ne pas créer un diagramme global gigantesque avant d’avoir validé les cas spécifiques.
- Ne pas déduire automatiquement une table par classe : certaines classes sont des services, interfaces, DTO ou objets externes.
- Définir les agrégats et frontières transactionnelles pour les cas sensibles comme paiement, réservation ou suppression.
- Représenter les interfaces pour les dépendances remplaçables, par exemple `MoyenPaiement` avec `MobileMoney` et `CarteBancaire`.
- Définir les identifiants, statuts et contraintes indispensables au scénario, sans figer trop tôt les détails d’implémentation.

## Marquage obligatoire

Utiliser ces marqueurs dans les fichiers Markdown :

- `Confirmé` : exigence explicitement fournie ou comportement déjà présent dans le code.
- `Proposé` : choix de conception recommandé pour permettre le développement.
- `À décider` : choix nécessitant une validation du propriétaire du projet.
- `À implémenter` : élément prévu mais absent du code.
