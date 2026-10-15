#!/bin/sh
# Lance le service MCP/IA (port 4001, interne) puis le hub (port 4000) ; s'arrête proprement avec le conteneur.
set -e
mkdir -p "$(dirname "$SWIFTMA_DB")"

cd /app/apps/server
PORT=4001 node /app/node_modules/tsx/dist/cli.mjs src/index.ts &
mcp=$!

cd /app
swiftma-hub &
hub=$!

# Arrêt du conteneur : le hub sauvegarde tout avant de quitter
trap 'kill -TERM $hub 2>/dev/null; wait $hub; kill -TERM $mcp 2>/dev/null' TERM INT
wait $hub
kill -TERM $mcp 2>/dev/null || true
