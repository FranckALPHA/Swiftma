# JSON — Diagramme de déploiement (`type: deployment`)

Référence : `references/deployment.md`, règle 37 bis du skill.

## Exemple complet

```json
{
  "type": "deployment",
  "name": "Tiketi",
  "analysisMode": "partial",
  "nodes": [
    {"id": "appServer", "label": "Serveur applicatif", "stereotype": "server", "multiplicity": "1", "status": "Proposé", "evidence": "backend/Makefile:5 (runtime dev, placement non décrit)"},
    {"id": "postgres", "label": "PostgreSQL", "stereotype": "database", "multiplicity": "1", "status": "Confirmé", "evidence": "backend/config.py:61 (port 5432)"},
    {"id": "rabbitmq", "label": "RabbitMQ", "stereotype": "messageBroker", "multiplicity": "1", "status": "Confirmé", "evidence": "backend/config.py:135 (port 5672)"}
  ],
  "links": [
    {"id": "l2", "from": "appServer", "to": "postgres", "protocol": "TCP", "port": 5432, "status": "Confirmé", "evidence": "backend/config.py:61"},
    {"id": "l4", "from": "appServer", "to": "rabbitmq", "protocol": "AMQP", "port": 5672, "status": "Confirmé", "evidence": "backend/config.py:135"}
  ],
  "artifacts": [
    {"id": "a1", "label": "Tiketi API (Uvicorn :9113)", "kind": "service", "host": "appServer", "status": "Confirmé", "evidence": "backend/Makefile:5"}
  ],
  "externalSystems": [
    {"id": "notchpay", "label": "NotchPay", "usedVia": "l5", "status": "Confirmé", "evidence": "backend/config.py:131"}
  ],
  "consistencyNotes": [
    "Aucun Docker Compose ni manifeste Kubernetes : topologie physique Proposée."
  ]
}
```

## Champs

| Champ | Requis | Contenu |
|---|---|---|
| `type` | oui | Toujours `"deployment"`. |
| `name` | oui | Nom du déploiement. |
| `analysisMode` | oui | `existing` / `partial` / `greenfield`. |
| `nodes` | oui | `stereotype` fermé (`device`, `server`, `executionEnvironment`, `database`, `cache`, `messageBroker`, `container`), `multiplicity` (`1`, `2..*`), `status` (`Confirmé`, `Proposé`), `evidence` (Docker, Compose, K8s, reverse-proxy, pipeline, `.env.example`). |
| `links` | oui | Orientés dans le sens d’ouverture de la connexion : `protocol`, `port`, `status`, `evidence`. |
| `artifacts` | oui | `kind` (`image`, `build`, `service`, `config`), `host` (nœud exécutant). Jamais de secret. |
| `externalSystems` | non | Fournisseurs hors frontière avec `usedVia` (lien utilisateur). Jamais dans `artifacts`. |
| `consistencyNotes` | oui | Nœuds hypothétiques, variables sans valeurs secrètes, écarts. |

## Règles de fermeture

- `links` référence `nodes` ou `externalSystems` ; `artifacts` référence `nodes`.
- Rien que la configuration ne prouve ; sinon `Proposé` explicite.
