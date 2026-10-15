---
name: analyse-uml
description: "Construire une documentation UML pour une application existante ou à développer, en reliant cas d’utilisation, classes, séquences et décisions d’architecture."
---

# Analyse UML guidée par les cas d’utilisation

> **Dans Swiftma.** Une fois le JSON d'un diagramme validé (règles de fermeture du [catalogue](catalog/)), le dessiner
> avec l'outil MCP `create_uml_diagram` (`{"diagram": <JSON>}`) : Swiftma calcule la mise en page et crée une frame
> éditable (formes, textes, vecteurs) à droite du contenu du fichier ouvert. Types rendus aujourd'hui : `usecase`,
> `class`, `sequence`, `activity`. Les autres (`state`, `object`, `package`, `deployment`, `communication`,
> `interaction-overview`) restent en Markdown + JSON jusqu'à leur prise en charge. Les éléments dont `status` vaut
> « Proposé », « À confirmer » ou « À implémenter » sont dessinés en pointillé orange ; `consistencyNotes` devient une
> note jaune sous le diagramme.

Ce skill s’applique lorsqu’un projet doit produire une documentation UML pour une application déjà développée, en cours de développement ou encore à concevoir.

## Choisir le mode d’analyse

- **Application existante** : utiliser le backend comme source de vérité et documenter le comportement réel.
- **Application à développer** : utiliser les besoins métier comme source de vérité, proposer les classes et séquences nécessaires, puis produire une spécification exploitable par le développeur.
- **Application partiellement développée** : séparer dans les diagrammes ce qui est confirmé par le code de ce qui reste à implémenter.

Dans le mode conception, toute décision non fournie par les exigences doit être marquée `à décider`, `hypothèse` ou `à implémenter`. Le skill ne doit pas faire passer une proposition d’architecture pour une fonctionnalité déjà existante.

## Application des modes à tous les diagrammes

Le mode d’analyse est choisi une fois au début, puis appliqué à chaque type de diagramme : cas d’utilisation, classes, séquence, activité, état-transition, packages et déploiement.

| Mode | Source de vérité | Traitement des éléments |
|---|---|---|
| Existant | Code, configuration, modèles, routes, services et intégrations | `Confirmé` si traçable ; toute absence ou contradiction avec le code est signalée. |
| Partiel | Code disponible + exigences et décisions métier | Séparer `Confirmé`, `Proposé`, `À confirmer` et `À implémenter`. |
| Non développé | Exigences, règles métier, maquettes et décisions | Produire une spécification cible ; ne jamais présenter une proposition comme du code existant. |

Pour chaque élément important, conserver une preuve : fichier ou symbole backend en projet existant, exigence ou décision en greenfield. Si aucune preuve n’est disponible, marquer l’élément comme hypothèse et préciser la décision attendue.

Les preuves attendues sont adaptées au diagramme : acteurs et objectifs pour les use cases ; responsabilités et données pour les classes ; appels et scénarios pour les séquences ; règles et résultats pour les activités ; statuts et événements pour les états ; frontières et imports pour les packages ; configuration, ports et artefacts pour le déploiement.

## Principe central

La conception part des cas d’utilisation, et non d’un diagramme de base de données géant :

```text
Cas d’utilisation global
        ↓
Cas d’utilisation spécifique
        ├── Diagramme d’activité : processus métier global
        └── Diagramme de classes : objets nécessaires
                    ↓ (ces deux vues peuvent être produites en parallèle)
             Diagramme de séquence : scénario précis
        └── Diagramme d’état : cycle de vie d’une classe
        ↓
Fusion des vues spécifiques en diagrammes globaux
```

Une classe peut apparaître dans plusieurs diagrammes spécifiques. Cette répétition est volontaire : elle montre qu’elle participe à plusieurs fonctionnalités. Lors de la fusion globale, les doublons sont regroupés.

## Règles de travail

1. Lire les cas d’utilisation existants et identifier le périmètre demandé.
2. Explorer le backend comme source de vérité : routers/endpoints, services, modèles ORM, relations, dépendances d’authentification, tâches et APIs externes.
3. Ne jamais inventer un service, une classe, une table ou un appel qui n’existe pas sans le marquer explicitement comme « à ajouter » ou « à confirmer ».
4. Pour chaque cas spécifique, produire une vue limitée aux classes qui collaborent réellement pour atteindre l’objectif.
5. Pour chaque séquence, remplacer le participant générique `Système` par les composants concrets : routeur, service, objet métier, base de données, Redis, fournisseur externe, tâche asynchrone, etc.
6. Représenter les alternatives et erreurs présentes dans le code : quota insuffisant, paiement échoué, autorisation refusée, ressource absente.
7. N’ajouter une création ou destruction d’objet que si elle correspond au comportement réel. Une transaction ou un objet persistant n’est pas automatiquement détruit à la fin du diagramme.
8. Garder les diagrammes lisibles : un diagramme spécifique n’est pas une copie de toute la base.
9. En mode conception, documenter aussi les préconditions, postconditions, règles métier, erreurs attendues et décisions laissées au développeur.
10. Pour un diagramme d’activité, représenter le processus métier de bout en bout : objets consommés, objets produits, événements reçus ou émis, décisions et tâches asynchrones.
10 bis. Compléter l’activité avec les éléments UML applicables : partitions ou swimlanes pour les responsabilités, nœuds d’objet et flux d’objet pour les données, fork/join pour le parallélisme réel, fin locale pour terminer un chemin sans terminer toute l’activité, et région interruptible pour les annulations, délais ou erreurs capables d’interrompre un sous-processus.
10 ter. Distinguer systématiquement une action d’un objet : une action réalise un traitement ou transforme une donnée ; un objet est une donnée, un artefact ou un résultat manipulé. Une action se décrit avec ses entrées, sorties, mises à jour et effets ; un objet se décrit avec son état ou son cycle de vie. Ne pas afficher une donnée d’entrée comme une classe métier sans preuve.
10 quater. Ne jamais laisser un nœud d’objet apparaître sans provenance ni destination. Tout objet représenté dans une activité doit être relié par un flux d’objet à au moins une action qui le produit, le consomme, le lit, le transforme ou le détruit. Un objet d’entrée doit être produit par une action du déclencheur, par exemple l’utilisateur soumet une demande, ou par un événement/système externe explicitement représenté ; il ne doit pas être placé directement après le nœud initial. Un objet qui change d’état doit être représenté par des occurrences annotées avant/après lorsque cette distinction est utile, par exemple `Payment [pending]` puis `Payment [success]`.
10 quinquies. Distinguer l’objet métier de la projection ou du verrou technique qui porte temporairement son état. Si une réservation modifie Redis mais pas le modèle métier, représenter `Quota Redis [disponible]`, `Réservation Redis [TTL]` et, si nécessaire, `Quota Redis [diminué]` ; ne pas déclarer que `TicketCategory` est mis à jour sans écriture backend correspondante. Toute relation `updates` doit être vérifiable dans le code et préciser l’état avant et après, ou être remplacée par `consumes`/`produces` d’occurrences d’état.
10 sexies. Un nœud de décision (losange) ne doit représenter qu’une condition métier qui sélectionne au moins deux chemins alternatifs. Il doit avoir un flux de contrôle entrant, au moins deux flux sortants, et une garde explicite sur chaque sortie ; les gardes doivent couvrir le résultat attendu, par exemple `[quota suffisant]` / `[quota insuffisant]`. Ne pas créer un losange qui duplique une validation déjà faite par l’action précédente : placer la décision au point où le résultat conditionnel est réellement connu, par exemple après une réservation atomique Redis. Ne pas utiliser un losange pour représenter un parallélisme ou une fusion.
10 septies. Chaque diagramme produit doit contenir une description textuelle complète dans son fichier Markdown, avant ou après le diagramme. Cette description doit expliquer le périmètre, le déclencheur, les acteurs ou partitions, le déroulement principal, les alternatives et erreurs, les objets consommés/produits, les événements, les états importants, les éléments externes et les écarts ou hypothèses. Pour un diagramme d’activité, elle doit aussi expliciter les flux de contrôle `source -> cible` et les flux d’objets `source -> cible [produces|consumes|reads|updates]`. Elle doit être compréhensible sans lire le code Mermaid et ne doit pas simplement répéter le titre ou la liste des nœuds.
10 octies. Pour chaque diagramme d’activité, produire dans le Markdown un bloc JSON sémantique suivant la structure de référence : `type`, `name`, `analysisMode`, `partitions`, `objects`, `actions`, `events`, `decisions`, `controlNodes`, `regions`, `controlFlows`, `objectFlows` et `consistencyNotes`. Les identifiants utilisés dans les relations doivent exister dans l’une de ces collections. Les actions portent les responsabilités et les opérations ; les objets portent les données et leurs états ; les événements portent les faits instantanés ; les décisions portent les gardes ; les régions portent les interruptions et leur portée. Le JSON doit décrire le même processus que le diagramme Mermaid et la description textuelle, sans élément inventé non marqué.
10 nonies. Les acteurs et partitions doivent être atomiques : une partition représente un seul acteur, service, système externe, worker, base de données ou infrastructure technique identifiable, avec un rôle unique. Ne jamais regrouper dans un même couloir des responsabilités distinctes comme `Redis et base de données`, `application et base`, ou `service et notifications`. Séparer au minimum l’application qui orchestre, PostgreSQL qui persiste, Redis qui cache/réserve, les systèmes externes, les workers et les notifications lorsque chacun intervient réellement. Présenter chaque acteur avec son rôle avant le diagramme.
10 decies. Pour chaque diagramme de séquence, produire dans le Markdown un bloc JSON sémantique suivant la structure de référence : `type`, `name`, `analysisMode`, `participants`, `messages`, `fragments`, `objects`, `errors`, `returns`, `consistencyNotes` et `activations` (optionnel, pour les durées non dérivables des paires `sync`/`return`). Les participants doivent être atomiques et porter leur rôle et leur preuve. Chaque message doit avoir un sens `from -> to`, une opération ou un événement explicite, un `kind` parmi `sync`, `async`, `return`, `create`, `destroy`, `event`, et si possible sa preuve backend. `sync` attend un retour et bloque l’appelant ; `async` et `event` n’attendent pas ; `return` est la réponse en pointillés ; `create` instancie une ligne de vie ; `destroy` la termine. Les fragments `alt`, `opt`, `loop`, `par`, `sd`, `ref` et `break` ne doivent être utilisés que lorsqu’ils sont justifiés par le code ou marqués comme proposés : `alt` pour Si/Sinon à régions exclusives, `opt` pour un Si seul exécuté ou ignoré, `loop` pour répéter tant que la condition est vraie, `par` pour des blocs simultanés, `sd` pour cadrer le diagramme avec son titre et son contexte, `ref` pour renvoyer à un autre diagramme existant au lieu de le dupliquer, `break` pour interrompre le scénario principal sur erreur ou exception. Les créations, destructions, réponses, erreurs, gardes et appels externes doivent être représentés sans inventer d’étape.
10 undecies. Chaque diagramme de séquence doit contenir une description textuelle complète dans son fichier Markdown, avant le diagramme. Elle doit présenter le périmètre et le scénario unique, le déclencheur, les participants atomiques et leurs rôles, le déroulement numéroté avec les sens `source -> cible`, les types de messages utilisés (`sync`, `async`, `return`, `create`, `destroy`, `event`), les lignes de vie créées et leur position verticale (`createdBy`), les objets préexistants distingués des objets créés, les cadres utilisés (`alt`, `opt`, `loop`, `par`, `sd`, `ref`, `break`) ainsi que ceux refusés avec leur justification, les objets et leurs états, les erreurs et retours, les appels externes et les écarts ou hypothèses. Elle doit être compréhensible sans lire le Mermaid ni le JSON et ne doit pas simplement répéter la liste des messages.
10 duodecies. Dans les diagrammes de séquence, d’activité et de communication, les libellés d’actions, de messages et d’opérations utilisent l’expression nominale métier, jamais l’écriture technique : ni verbe HTTP ni chemin de route (`POST /tickets/...`), ni nom de fonction avec paramètres code (`create_order(user_id, data)`), ni commande SQL, Redis ou script (`SELECT`, `SADD`, `SETEX`, `Lua`). Quand des paramètres sont nécessaires, les ouvrir en clair avec leur expression nominale, par exemple « Créer la commande (acheteur, catégories, quantités) » ou « Réserver le quota (catégorie, quantité) ». Les références techniques (fichier, route exacte, fonction, lignes) vivent dans les preuves (`evidence`), les notes et les écarts backend, jamais dans les libellés. Les noms de composants (`OrderService`, `TicketsRouter`) et les états métier (`pending`, `failed`, `sold`) restent autorisés car ils nomment, ils n’exécutent pas.
11. Pour un diagramme d’état, partir d’une classe du diagramme de classes qui possède un statut, un état périodique ou un cycle de vie significatif.
12. Dans un état composite, respecter la portée des sous-états : un pseudo-état `[*]` interne reste dans le composite, un sous-état terminal doit rejoindre le final interne, puis le composite doit disposer d’une sortie de complétion vers le final global. Ne jamais référencer un sous-état interne depuis l’extérieur.
13. Dans le cas d’utilisation global, ajouter lorsque c’est pertinent quelques collaborations métier entre acteurs : soumettre/valider une demande, demander/approuver une affectation ou déclarer/traiter un signalement.
14. Identifier les acteurs externes à la frontière du système étudié et les relier uniquement aux cas ou processus qu’ils déclenchent, consomment ou alimentent.
15. Utiliser correctement les relations entre cas d’utilisation : `include` pour un comportement obligatoire du cas principal, `extend` pour une possibilité optionnelle déclenchée sous condition, et généralisation pour spécialiser un cas parent, éventuellement abstrait.
16. Pour tout cas réservé à un acteur authentifié, représenter `S’authentifier` comme comportement inclus lorsque cette convention est utilisée dans les diagrammes du projet. Les cas publics du visiteur et `Se connecter` sont des exceptions.
17. Distinguer la généralisation des acteurs de celle des cas d’utilisation. Une généralisation d’acteurs signifie que l’acteur spécialisé hérite des capacités de l’acteur parent : `Utilisateur connecté --|> Visiteur`, puis `Ambassadeur`, `Staff`, `Organisateur` et `Administrateur` peuvent spécialiser `Utilisateur connecté`.
18. Représenter l’héritage d’acteurs dans la vue globale lorsqu’il explique les droits hérités. Pour un rôle activable ou un plugin optionnel, le sens reste `Ambassadeur --|> Utilisateur connecté` ; ne jamais inverser la relation, car cela rendrait tous les utilisateurs ambassadeurs. Ne pas redessiner inutilement les use cases hérités dans chaque vue spécifique.
19. Dans la vue globale, ne pas détailler les spécialisations des use cases par généralisation : conserver uniquement le use case mère. Réserver l’héritage des use cases et ses variantes aux diagrammes spécifiques.
20. Pour chaque diagramme spécifique, annoncer explicitement le cas d’utilisation global détaillé, puis ne conserver que ses actions concrètes. Ne pas y redessiner le cas global comme un cas abstrait ; ne pas mélanger plusieurs cas globaux dans le même fichier.
21. Nommer les fichiers spécifiques avec un nom court correspondant au cas global traité, par exemple `Promotion.md` pour « Gérer la promotion des événements », et non avec le nom générique de l’acteur.
22. Aligner les classes spécifiques sur les cas d’utilisation spécifiques : même arborescence acteur/domaine et même nom de fichier, par exemple `usecases/Ambassadeur/Promotion.md` et `classes/Ambassadeur/Promotion.md`.
23. Ranger les séquences dans la même arborescence acteur/domaine. Leur nom doit reprendre le cas traité lorsqu’elles couvrent un flux complet ; si elles décrivent une étape atomique isolée, utiliser le nom court de cette action.
24. Une séquence ne doit pas mélanger plusieurs scénarios indépendants. Si un cas global contient plusieurs actions, créer une séquence par scénario important ou indiquer clairement une alternative bornée par `alt`.
25. Dans chaque diagramme de classes spécifique, qualifier les relations structurelles : composition `*--` si le cycle de vie de l’enfant dépend du parent, agrégation `o--` si le parent regroupe un objet indépendant, dépendance `..>` si une classe ou un service est seulement utilisé, et association `-->` pour un lien métier durable simple.
26. Documenter la navigabilité des associations de classes indépendamment de leur nature : une flèche indique le sens de navigation, une relation sans flèche est non navigable ou indéterminée, et deux flèches opposées indiquent une navigation bidirectionnelle. Vérifier que ce sens correspond aux références et aux responsabilités réellement présentes dans le modèle.
27. Après chaque opération de documentation, exécuter une boucle de vérification avant de la déclarer terminée : description textuelle présente et complète, périmètre, atomicité, traçabilité, relations UML, éléments obligatoires du type de diagramme, cohérence des noms et absence d’éléments inventés non marqués.
28. Dans les diagrammes de classes, représenter l’encapsulation : attributs privés `-` par défaut, opérations publiques `+`, éléments protégés `#` et éléments de package `~` seulement si le code ou la conception le justifie.
29. Ajouter les opérations métier réellement portées par la classe ou par un service identifié dans le backend. Ne pas ajouter automatiquement des getters/setters ni déplacer une logique de service dans une entité sans justification.
30. Une classe de liaison ou un modèle persistant peut ne pas avoir d’opération propre si son comportement est porté par un service ; l’expliquer dans une note plutôt que d’inventer une méthode.
31. Pour un diagramme de packages, regrouper les classes qui collaborent fortement, représenter la contenance par l’imbrication des packages et dériver chaque dépendance d’une relation réelle entre classes, d’un import ou d’un service identifié.
32. Orienter une dépendance de `A` vers `B` lorsque `A` utilise les classes, interfaces ou services exposés par `B`. Rechercher une dépendance acyclique ; tout cycle doit être signalé puis supprimé ou isolé par une abstraction, un contrat ou un service d’application.
33. Préserver l’encapsulation des packages : exposer des interfaces ou services stables et cacher les implémentations. Un package doit dépendre de contrats abstraits lorsque cela permet d’éviter une dépendance vers un détail technique.
34. Vérifier la cohésion de chaque package, éviter les packages fourre-tout et ne pas créer une abstraction uniquement pour décorer le diagramme. Toute rupture proposée entre packages doit être marquée `Proposé`, `À confirmer` ou `À implémenter`.
34 bis. Pour chaque diagramme de packages, produire dans le Markdown un bloc JSON sémantique suivant la structure de référence : `type`, `name`, `analysisMode`, `packages`, `dependencies`, `interfaces`, `cycles` et `consistencyNotes`. Chaque package porte sa responsabilité, son contenu et sa preuve ; chaque dépendance est orientée `from -> to`, justifiée par un import, un service ou une relation entre classes (`via` parmi `import`, `service`, `association`, `inheritance`, `implementation`) et marquée `Confirmé` ou `Proposé`. Les interfaces exposées, les cycles détectés avec leur résolution et les écarts sont déclarés explicitement. Les identifiants utilisés dans `dependencies`, `interfaces` et `cycles` doivent exister dans `packages`.
35. Pour un diagramme de déploiement, distinguer les nœuds physiques ou d’exécution, les liens réseau, les artefacts déployables et les systèmes externes. Décrire ports, protocoles, multiplicité, stéréotypes et variables structurantes sans exposer de secrets.
36. Ne déduire un déploiement réel qu’à partir de Docker/Compose, Kubernetes, reverse-proxy, pipeline ou configuration explicitement présente. En phase d’analyse, séparer les nœuds `Confirmés` des nœuds `Proposés` et ne jamais présenter une répartition physique hypothétique comme existante.
37. Orienter les liens selon le sens réel des communications. Un artefact est placé sur le nœud qui l’exécute ; une API externe ou un fournisseur n’est pas un artefact interne.
37 bis. Pour chaque diagramme de déploiement, produire dans le Markdown un bloc JSON sémantique suivant la structure de référence : `type`, `name`, `analysisMode`, `nodes`, `links`, `artifacts`, `externalSystems` et `consistencyNotes`. Chaque nœud porte son stéréotype (`device`, `server`, `executionEnvironment`, `database`, `cache`, `messageBroker`, `container`), sa multiplicité, son statut `Confirmé` ou `Proposé` et sa preuve (fichier de configuration). Chaque lien est orienté `from -> to` dans le sens de la communication, avec protocole, port et preuve. Chaque artefact est rattaché au nœud qui l’exécute (`host`). Aucun secret n’est documenté. Les identifiants utilisés dans `links` doivent exister dans `nodes` ou `externalSystems`, et ceux de `artifacts` dans `nodes` ; un système externe ne figure jamais dans `artifacts`.
38. Pour un diagramme de communication, partir d’une séquence validée et conserver son scénario, ses objets, ses alternatives, ses itérations, ses appels externes et ses erreurs.
39. Représenter les objets comme des instances reliées par des liens ; placer les messages orientés sur ces liens et les numéroter selon l’ordre d’exécution (`1`, `1.1`, `1.2`, puis `1a`/`1b` pour les alternatives).
40. Utiliser `*` pour une itération, une garde pour une condition et un message réflexif lorsqu’un objet s’envoie une opération à lui-même. Les stéréotypes `<<boundary>>`, `<<control>>`, `<<entity>>` et `<<external>>` doivent refléter le rôle réel de l’objet.
41. Distinguer le lien structurel entre objets du message temporaire échangé sur ce lien. Orienter chaque message de l’émetteur vers le récepteur et vérifier qu’il correspond à la séquence ou au code backend.
42. Pour chaque diagramme de cas d’utilisation, produire dans le Markdown un bloc JSON sémantique suivant la structure de référence : `type`, `name`, `analysisMode`, `actors`, `useCases`, `relations` et `consistencyNotes`. Les acteurs portent leur rôle et leur parent de généralisation ; les cas restent atomiques ; les relations sont typées (`association`, `include`, `extend`, `generalization`) avec condition obligatoire pour `extend`. Les identifiants utilisés dans `relations` doivent exister dans `actors` et `useCases`.
43. Pour chaque diagramme de classes, produire dans le Markdown un bloc JSON sémantique suivant la structure de référence : `type`, `name`, `analysisMode`, `classes`, `relations` et `consistencyNotes`. Les classes portent attributs (privés par défaut), opérations réellement portées et preuves ; les relations portent leur type (`composition`, `aggregation`, `association`, `dependency`, `generalization`), leur navigabilité et leurs cardinalités. Les identifiants utilisés dans `relations` doivent exister dans `classes`.
44. Pour chaque diagramme d’états-transitions, produire dans le Markdown un bloc JSON sémantique suivant la structure de référence : `type`, `name`, `analysisMode`, `class`, `states`, `transitions` et `consistencyNotes`. La classe porteuse vient du diagramme de classes ; les transitions séparent événement, garde et effet ; les états composites respectent leur portée. Les identifiants utilisés dans `transitions` doivent exister dans `states`.
41 bis. Pour chaque diagramme de communication, produire dans le Markdown un bloc JSON sémantique suivant la structure de référence : `type`, `name`, `analysisMode`, `sourceSequence`, `objects`, `links`, `messages` et `consistencyNotes`. Les objets portent un stéréotype Jacobson (`boundary`, `control`, `entity`, `external`), un rôle et une preuve. Les liens sont structurels (possibilité de collaborer) et justifiés par la séquence source. Chaque message référence un lien existant, porte un numéro en arbre strict (`1`, `1.1`, `2.1.2a` avec lettre juste après l’indice du niveau où le choix se produit, jamais `2b.1`), une opération, un `kind` parmi `sync`, `async`, `return`, `create`, `destroy`, `event`, et si besoin une garde ou un marqueur d’itération (`*`). Les messages réflexifs ciblent leur propre objet via un lien réflexif et suivent l’appel qui leur a fourni la donnée. Les flux nominaux tiennent en trois niveaux maximum ; la rupture (`break`) porte la lettre pendant que la continuation nominale reste nue. Les messages respectent la matrice des interactions autorisées : `Boundary → Control`, `Control → Entity`, `Control → Boundary` et `Control → Control` sont autorisés ; `Boundary → Entity` est déconseillé sauf lecture seule justifiée ; `Entity → Control` et `Entity → Boundary` sont interdits. Les identifiants utilisés dans `links` et `messages` doivent exister dans `objects` et `links` ; aucun scénario indépendant ne doit être mélangé.
41 ter. Pour chaque diagramme d’objets, figer un instant unique d’un scénario validé : instances nommées `objet: Classe` avec attributs et états du moment, liens reprenant les associations du diagramme de classes, valeurs d’exemple anonymisées. Produire un bloc JSON sémantique (`type`, `name`, `analysisMode`, `sourceClasses`, `sourceScenario`, `moment`, `instances`, `links`, `consistencyNotes`) et une description narrative du moment, des instances et des liens. Aucune instance isolée, aucun lien inventé non marqué, aucun mélange de plusieurs instants.
41 quater. Pour chaque vue d’ensemble des interactions, orchestrer des interactions existantes avec des nœuds de contrôle (initial, final, décision, fusion, bifurcation et synchronisation seulement si parallélisme réel) et des cadres `ref` vers des diagrammes de séquence ou de communication existants. Produire un bloc JSON sémantique (`type`, `name`, `analysisMode`, `nodes`, `refs`, `flows`, `consistencyNotes`) et une description narrative du parcours. Aucun détail de message dans la vue, aucune cible de `ref` inexistante non marquée `À créer`, aucun parallélisme inventé.

## Vue globale simplifiée des classes

En complément du diagramme global fusionné détaillé, produire une vue `GlobalSimple.md` lorsque la lisibilité de l’architecture l’exige. Cette vue ne remplace pas le global détaillé : elle sert à présenter rapidement le noyau métier.

- Conserver les classes structurantes, les objets de liaison entre acteurs et les classes indispensables aux principaux processus.
- Omettre les détails secondaires comme les logs, tokens, préférences, médias ou objets techniques lorsqu’ils n’aident pas à comprendre la structure générale.
- Toute classe conservée doit posséder des attributs significatifs : au minimum son identité, ses clés de liaison, son statut ou les données qui justifient sa responsabilité.
- Ne jamais laisser une classe métier vide. Une classe abstraite, externe ou proposée peut être réduite, mais doit porter un stéréotype explicite et être expliquée dans une note.
- Conserver les relations importantes avec leur type (`*--`, `o--`, `-->`, `..>`), leur navigabilité et leurs cardinalités justifiées.
- Ne pas introduire dans la vue simplifiée une classe ou une relation absente des vues spécifiques sans la marquer `Proposé`, `À confirmer` ou `À implémenter`.
- Garder les attributs complets, opérations et relations secondaires dans les diagrammes spécifiques ou dans le global détaillé.
- Valider que chaque classe affichée participe à au moins une relation utile et que le diagramme reste lisible.

## Ordre de production recommandé

L’ordre de référence est :

```text
Cas d’utilisation global
        ↓
Cas d’utilisation spécifiques
        ↓
┌──────────────────────┬─────────────────────┐
│ Diagrammes d’activité │ Diagrammes de classes│
│ (processus métier)    │ (objets nécessaires) │
└──────────────────────┴─────────────────────┘
        ↓
Diagrammes de séquence
        ↓
Diagrammes d’état-transition
        ↓
Fusion des vues globales
```

Après les cas spécifiques, les diagrammes d’activité et de classes peuvent être réalisés en parallèle. Les séquences utilisent les objets et responsabilités identifiés dans ces deux vues. Les états sont produits à partir des classes dont le cycle de vie est significatif. La fusion intervient uniquement après la validation de toutes les vues spécifiques.

## Livrables

- `docs/uml/usecases/` : vue globale puis vues spécifiques par acteur ou domaine.
- `docs/uml/classes/` : classes spécifiques par cas d’utilisation, puis diagramme global fusionné.
- `docs/uml/sequences/` : séquences spécifiques des flux importants, basées sur l’ordre réel des appels.
- `docs/uml/activities/` : processus métier généraux avec objets consommés/produits et événements.
- `docs/uml/objects/` : instantanés d’instances et de liens à un moment précis d’un scénario validé.
- `docs/uml/overview/` : vues d’ensemble orchestrant les interactions via nœuds de contrôle et cadres `ref`.
- `docs/uml/states/` : cycles de vie des objets métier ayant des états significatifs.
- `docs/uml/packages/` : organisation des classes en packages, contenance et dépendances acycliques.
- `docs/uml/deployment/` : nœuds physiques/d’exécution, liens réseau et artefacts déployés.
- `docs/uml/decisions/` ou une section dédiée dans chaque fichier : hypothèses et décisions à confirmer lorsque l’application n’est pas encore développée.

Le format Mermaid dans les fichiers Markdown suffit par défaut. Générer des PNG uniquement si l’utilisateur le demande.

Dans un diagramme de cas d’utilisation, les objets de liaison ne sont pas dessinés comme des classes. Ils sont documentés à part et relient le cas d’utilisation aux diagrammes de classes et d’état correspondants.

Un acteur externe peut être un utilisateur d’un autre système, une API tierce, un fournisseur de paiement, un service de notification, une API de géolocalisation ou un sous-système interne placé hors de la frontière étudiée. Il est représenté comme acteur/système externe, jamais comme une classe métier interne.

## Relations entre cas d’utilisation

Les cas d’utilisation restent atomiques même lorsqu’ils sont reliés par `include`, `extend` ou généralisation. Une relation ne doit pas servir à fusionner deux actions dans un même intitulé.

La vue globale reste volontairement synthétique : lorsqu’un cas possède des variantes spécialisées, elle montre seulement le cas mère. Les relations de généralisation et les cas enfants sont documentés dans la vue spécifique correspondante.

- `include` exprime un comportement obligatoire du cas principal. Exemple : « Gérer son compte » inclut « S’authentifier » lorsque l’authentification est nécessaire.
- `extend` exprime une possibilité optionnelle déclenchée dans une situation donnée. Exemple : « Parcourir le catalogue » étend « Gérer son panier » si l’utilisateur peut rechercher un article avant de l’ajouter.
- La généralisation spécialise un cas parent plus général, éventuellement abstrait. Exemple : « Payer un billet » peut être spécialisé par « Payer par Orange Money » et « Payer par Mobile Money ».

Ne pas utiliser `extend` pour une étape obligatoire ni `include` pour un choix entre variantes. Dans Mermaid, préciser dans une note le sens de la relation et la condition d’extension.

## Navigabilité des relations de classes

La navigabilité indique quelle classe peut accéder ou parcourir l’autre dans le modèle :

```text
A --> B       navigation de A vers B
A <-- B       navigation de B vers A
A -- B        aucune navigation explicitement définie
A --> B
B --> A       navigation bidirectionnelle
A --× B        navigation explicitement interdite de B vers A
A ×-- B        navigation explicitement interdite de A vers B
```

La croix `×` placée à une extrémité indique explicitement que cette extrémité n’est pas navigable. Elle est différente de l’absence de flèche, qui laisse la navigabilité non précisée. La navigabilité ne remplace pas le type de relation. Mermaid ne gère pas toujours la croix nativement ; dans ce cas, la documenter dans une note ou une annotation du diagramme.

Pour une dépendance `..>`, la flèche indique déjà l’utilisation de la cible. Ne pas ajouter une navigabilité bidirectionnelle à une simple dépendance de service.

L’authentification est un cas transversal : les fonctionnalités de l’utilisateur connecté, de l’ambassadeur, du staff, de l’organisateur et de l’administrateur peuvent donc inclure `S’authentifier`. Ne pas l’ajouter aux fonctionnalités publiques du visiteur ni au cas `Se connecter` lui-même.

## Boucle de vérification et de conformité

Cette boucle est obligatoire après chaque livrable, quel que soit le mode du projet :

```text
Produire → Contrôler → Corriger → Recontrôler → Valider
```

### Contrôles communs

1. Le périmètre correspond exactement au cas ou processus demandé.
2. Le diagramme est atomique et ne mélange pas plusieurs fonctionnalités indépendantes.
3. Les noms correspondent aux usecases, classes, séquences et états associés.
4. Les relations ont le bon type, le bon sens et une cardinalité ou une condition justifiée.
5. Les éléments incertains sont marqués `Proposé`, `À décider`, `À confirmer` ou `À implémenter`.
6. Les acteurs externes sont hors frontière et ne sont pas transformés en classes métier.
7. Les fichiers sont dans le bon dossier, sans doublon ni ancien nom concurrent.
8. Le Markdown et la syntaxe Mermaid sont valides.

### Preuve selon le mode

- **Projet existant** : chaque élément important doit être traçable à un router, service, modèle, enum, migration, tâche ou intégration backend. Toute différence avec le code est signalée.
- **Projet en analyse ou greenfield** : chaque élément doit être traçable à une exigence, règle métier, maquette ou décision. Les classes, services, événements et états non confirmés sont explicitement marqués ; aucune proposition ne doit être présentée comme implémentée.
- **Projet partiellement développé** : séparer les éléments confirmés de ceux proposés ou restant à implémenter.

### Contrôles par diagramme

- **Cas d’utilisation** : acteur principal, frontière, cas global ou spécifique, atomicité, `include`, `extend`, généralisation et acteurs externes.
- **Classes** : classes réellement nécessaires, attributs utiles, opérations, cardinalités, association, agrégation, composition, dépendance et navigabilité dans le bon sens.
- **Séquence** : description textuelle, scénario unique, participants atomiques et leurs rôles, ordre des messages `from -> to`, objets réels, créations/destructions justifiées, fragments `alt`/`opt`/`loop`/`par`, alternatives, erreurs, réponses et appels externes, avec JSON sémantique standardisé.
- **Activité** : présentation des acteurs atomiques et de leurs rôles, début/fin, actions, décisions, gardes, flux, objets consommés/produits avec provenance, transitions d’état avant/après, événements émis/reçus et tâches asynchrones. Vérifier chaque losange : entrée, sorties alternatives gardées, condition réelle et absence de doublon avec une validation.
- **États** : classe porteuse du cycle de vie, état initial/final, états durables, événement, garde, effet, activité `do`, états composites et historique seulement si justifié.
- **Packages** : contenance, classes regroupées, dépendances orientées, interfaces exposées, détails cachés et absence de cycle.
- **Déploiement** : nœuds, liens, stéréotypes, multiplicité, labels réseau, artefacts, ports et distinction confirmé/proposé.
- **Communication** : objets, liens, messages orientés, numérotation, gardes, itérations, alternatives et messages réflexifs.

La boucle n’est validée que si les contrôles applicables passent. En cas d’échec, corriger le livrable et recommencer la vérification ; ne pas déclarer l’opération terminée sur la seule base de la génération du fichier.

## Références

- [usecase.md](references/usecase.md) — cas d’utilisation globaux et spécifiques
- [class.md](references/class.md) — classes nécessaires par cas
- [sequence.md](references/sequence.md) — séquences basées sur le backend
- [activity.md](references/activity.md) — processus métier, objets et événements
- [state.md](references/state.md) — états, transitions, événements, gardes et effets
- [fusion.md](references/fusion.md) — fusion des vues spécifiques
- [deployment.md](references/deployment.md) — architecture physique, nœuds et artefacts
- [communication.md](references/communication.md) — objets, liens et messages d’un scénario
- [object.md](references/object.md) — objets, instances et liens d’un instantané
- [interaction-overview.md](references/interaction-overview.md) — vue macroscopique orchestrant les interactions
- [greenfield.md](references/greenfield.md) — mode conception pour une application non développée
- [external-actors.md](references/external-actors.md) — frontière système et acteurs externes
