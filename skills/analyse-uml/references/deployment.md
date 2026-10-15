# Méthode — Diagrammes de déploiement

## Rôle

Le diagramme de déploiement décrit l’architecture physique ou l’environnement d’exécution : où les artefacts sont installés et comment les nœuds communiquent.

## Éléments

- **Nœud** : appareil, serveur, machine virtuelle, conteneur ou environnement d’exécution.
- **Lien** : communication réseau orientée entre deux nœuds, avec protocole et port si connus.
- **Stéréotype** : rôle du nœud, par exemple `<<device>>`, `<<server>>`, `<<database>>`, `<<cache>>`, `<<messageBroker>>`, `<<executionEnvironment>>` ou `<<external>>`.
- **Multiplicité** : nombre d’instances, par exemple `2..*` serveurs API.
- **Artefact** : élément réellement déployable, comme une image Docker, un build frontend, un service backend ou une configuration.
- **Système externe** : fournisseur hors de la frontière, comme NotchPay, FCM ou une API de stockage.

## Règles

1. Lire les fichiers de déploiement disponibles : Docker, Compose, Kubernetes, reverse-proxy, CI/CD et `.env.example`.
2. Ne pas inventer un nœud ou un lien réel absent de la configuration.
3. En conception, marquer les nœuds et artefacts comme `Proposé`, `À confirmer` ou `À implémenter`.
4. Orienter les liens dans le sens de la communication : `API → PostgreSQL` signifie que l’API ouvre la connexion vers PostgreSQL.
5. Placer chaque artefact sur le nœud qui l’exécute.
6. Documenter les ports et protocoles, jamais les valeurs de secrets ou tokens.
7. Distinguer un artefact d’un nœud : l’artefact est déployé sur le nœud.
8. Vérifier les multiplicités, les liens entrants/sortants et la cohérence entre les variables d’environnement et les connexions affichées.

## Vérification

Contrôler la frontière du système, les nœuds, les stéréotypes, les artefacts, les ports, les protocoles, la direction des liens et le statut confirmé/proposé. Si aucune configuration de déploiement n’existe, produire uniquement une vue d’analyse explicitement hypothétique ou signaler l’absence de preuve.

## Structure JSON de référence

Chaque diagramme de déploiement inclut dans son Markdown un bloc JSON sémantique de cette forme :

```json
{
  "type": "deployment",
  "name": "NomDeploiement",
  "analysisMode": "existing | partial | greenfield",
  "nodes": [],
  "links": [],
  "artifacts": [],
  "externalSystems": [],
  "consistencyNotes": []
}
```

- `nodes` : nœuds d’exécution avec `id`, `label`, `stereotype` (`device`, `server`, `executionEnvironment`, `database`, `cache`, `messageBroker`, `container`), `multiplicity` (ex. `1`, `2..*`), `status` (`Confirmé`, `Proposé`) et `evidence` (Docker, Compose, Kubernetes, reverse-proxy, pipeline, `.env.example`).
- `links` : communications orientées `from -> to` dans le sens d’ouverture de la connexion, avec `protocol`, `port`, `status` et `evidence`. Ex. `API → PostgreSQL` signifie que l’API ouvre la connexion.
- `artifacts` : éléments déployables avec `id`, `label`, `kind` (`image`, `build`, `service`, `config`) et `host` (le nœud qui l’exécute). Jamais de secret dans les valeurs.
- `externalSystems` : fournisseurs hors frontière avec `id`, `label`, `usedVia` (lien ou intégration qui les utilise) et `evidence`.
- `consistencyNotes` : écarts entre configuration et diagramme, nœuds hypothétiques et variables structurantes sans valeur secrète.

Exemple minimal d’un lien :

```json
{
  "id": "l1",
  "from": "api",
  "to": "postgres",
  "protocol": "TCP",
  "port": 5432,
  "status": "Confirmé",
  "evidence": "docker-compose.yml"
}
```

Les identifiants utilisés dans `links` doivent exister dans `nodes` ou `externalSystems`, et ceux de `artifacts` dans `nodes`. Un système externe figure dans `externalSystems`, jamais dans `artifacts`. Le JSON, la description textuelle et le diagramme Mermaid décrivent la même architecture.
