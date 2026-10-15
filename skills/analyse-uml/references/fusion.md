# Méthode — Fusion des diagrammes

La fusion intervient après la validation des diagrammes spécifiques.

## Procédure

1. Lister toutes les classes de tous les cas d’utilisation.
2. Regrouper les classes portant le même nom et la même responsabilité.
3. Comparer leurs attributs, statuts et relations.
4. Identifier les conflits : noms différents, cardinalités contradictoires, classe attendue mais absente du code.
5. Construire un diagramme global par domaine ou une vue globale simplifiée.
6. Garder les détails opérationnels dans les diagrammes spécifiques.

## Vue globale simplifiée

Une vue complémentaire `GlobalSimple.md` peut être produite pour présenter l’architecture à un lecteur qui n’a pas besoin de tous les détails. Elle ne remplace pas `Global.md`.

Elle conserve le noyau métier, les classes qui relient les principaux acteurs aux fonctionnalités et les objets structurants des processus. Les classes secondaires peuvent être omises, mais toute classe conservée doit avoir des attributs significatifs : identité, clé de liaison, statut ou données qui expliquent sa responsabilité. Une classe métier vide est interdite ; une abstraction ou un système externe réduit doit être stéréotypé et justifié.

Les relations conservées doivent garder leur type, leur sens de navigation et leurs cardinalités. Les détails complets restent dans les diagrammes spécifiques et dans le global détaillé.

## Exemple de regroupement

```text
AcheterBillets       : User, Event, Order, Ticket, Payment
GererVentesPaiements : User, Event, Order, Payment, Refund
GererAcces           : User, Event, Ticket, ScanLog
                       ↓
Global               : User, Event, Order, Ticket, Payment, Refund, ScanLog
```

Le diagramme global doit être une synthèse des diagrammes spécifiques et du backend, pas une nouvelle conception. Toute classe ajoutée pour un besoin futur doit être marquée `à confirmer` ou `à implémenter`.
