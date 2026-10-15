# Méthode — Diagrammes d’objets

## Rôle

Le diagramme d’objets fige un instantané d’exécution : des **instances** nommées reliées par les **associations** du diagramme de classes, avec leurs valeurs et états à cet instant. Exemple : `vente1: Vente` contient `ligne1: LigneDeVente` et `ligne2: LigneDeVente`. Il ne remplace ni le diagramme de classes (structure permanente) ni le diagramme de séquence (ordre temporel) : il montre *qui est lié à qui, avec quelles valeurs, à un moment précis*.

Mermaid ne possède pas de type natif pour les diagrammes d’objets : utiliser `flowchart` en approximation, avec des nœuds `nom: Classe` et des arêtes étiquetées par le nom de l’association.

## Instantané

Chaque diagramme déclare explicitement le moment figé : un instant du scénario source (activité ou séquence), jamais un mélange de plusieurs instants. Exemples : « commande confirmée, avant le scan », « transfert accepté, QR régénéré », « stand vendu, après webhook ». Deux instants différents exigent deux diagrammes.

## Instances

- Nommage : `objet1: Classe`, en minuscule pour l’instance, avec le nom exact de la classe du diagramme de classes (`billet1: Ticket`, `commande1: Order`).
- Chaque instance porte ses attributs significatifs à l’instant figé (`slots`) : identifiants de liaison, statut, montants, quantités. Valeurs d’exemple réalistes mais anonymisées, jamais de vraies données personnelles ni de secrets.
- L’état affiché doit exister dans le cycle de vie de la classe (`pending`, `confirmed`, `scanned`, `sold`) et correspondre au moment déclaré.
- Aucune instance sans lien : tout objet du diagramme participe à au moins une association.

## Liens

Un lien est un exemplaire concret d’une association définie dans le diagramme de classes : il relie des objets précis entre eux à un moment donné de l’exécution du système.

- Chaque lien reprend une association du diagramme de classes (nom, sens, composition/agrégation/association) : `commande1 —contient→ ligne1`, `billet1 —concerne→ événement1`.
- Sens et navigabilité : si l’association d’origine possède une flèche, le lien indique que l’objet source connaît l’objet cible et peut accéder à lui ; sans flèche, le lien fonctionne dans les deux sens et les deux objets se connaissent mutuellement.
- Rôles : les noms de rôles de l’association (ex. employeur et employé) précisent le sens logique de la relation et se reportent sur le lien.
- Ne jamais inventer un lien absent du diagramme de classes sans le marquer `Proposé`.
- Ne pas confondre le lien structurel (durable, issu des classes) avec un flux temporaire (réservé aux activités et séquences).

## Expression nominale

Les libellés d’instances et de liens utilisent l’expression nominale métier (règle 10 duodecies) : `billet1: Billet`, lien `contient`, jamais de nom de table, de colonne SQL ou de clé Redis dans les libellés. Les références techniques (table, colonne, fichier modèle) vivent dans `evidence`.

## Structure JSON de référence

```json
{
  "type": "object",
  "name": "NomInstantane",
  "analysisMode": "existing | partial | greenfield",
  "sourceClasses": "chemin/vers/DiagrammeDeClasses.md",
  "sourceScenario": "chemin/vers/SequenceOuActivite.md",
  "moment": "description de l'instant figé",
  "instances": [],
  "links": [],
  "consistencyNotes": []
}
```

- `sourceClasses` : le diagramme de classes dont les classes et associations sont instanciées.
- `sourceScenario` : l’activité ou la séquence dont l’instant est extrait ; le moment doit s’y retrouver.
- `instances` : `id`, `label` (`nom: Classe`), `class`, `slots` (attributs et valeurs à l’instant), `state` et `evidence` (modèle backend).
- `links` : `from`, `to`, `association` (nom repris des classes), `kind` (`composition`, `agrégation`, `association`) et `evidence`.
- `consistencyNotes` : valeurs d’exemple assumées, écarts et hypothèses.

Les identifiants utilisés dans `links` doivent exister dans `instances`. Le JSON, la description textuelle et le diagramme décrivent le même instantané.

## Description textuelle

Chaque fichier contient, avant le diagramme, une description narrative : le scénario source, le moment exact figé et pourquoi lui, les instances présentes avec leurs états et valeurs marquantes, les liens et ce qu’ils signifient métier, puis les écarts éventuels avec le backend.

## Vérification

Contrôler le moment unique, la conformité des classes et associations avec le diagramme source, le nommage `objet: Classe`, les états valides, les valeurs anonymisées, l’absence d’instance isolée et de lien inventé, ainsi que la cohérence JSON ↔ description ↔ diagramme.
