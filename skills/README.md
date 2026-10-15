# Skills

Instructions réutilisables pour les agents IA (Claude Code et compatibles) qui travaillent avec Swiftma.

| Skill | Rôle |
|---|---|
| [`analyse-uml`](analyse-uml/SKILL.md) | Documenter une application (existante, partielle ou à concevoir) en UML guidé par les cas d'utilisation, puis dessiner les diagrammes dans Swiftma avec `create_uml_diagram`. Issu d'Easy Analyst. |

## Installer un skill

Pour tous vos projets :

```bash
mkdir -p ~/.claude/skills && cp -r skills/analyse-uml ~/.claude/skills/
```

Ou seulement dans le projet à analyser : `.claude/skills/analyse-uml/`. Branchez aussi le serveur MCP de Swiftma
(voir le README) : l'agent lit votre code, écrit la documentation UML et dessine les diagrammes dans le fichier
Swiftma ouvert, où vous pouvez les retoucher.

Le format JSON de chaque diagramme est décrit dans [`analyse-uml/catalog/`](analyse-uml/catalog/) ; des exemples
complets sont dans [`examples/uml/`](../examples/uml/).
