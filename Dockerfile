# syntax=docker/dockerfile:1
# Nyota en un seul conteneur :
#  - le hub Rust : API, projets, collaboration temps réel, et l'éditeur compilé servi en /
#  - le service MCP/IA (Node) : serveur MCP et agent « capture d'écran → design », relayé par le hub
# Données : volume /data (SQLite). Port : 4000.

# 1. Éditeur compilé + dépendances Node du service MCP/IA
FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/editor/package.json apps/editor/
COPY apps/server/package.json apps/server/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY apps/editor apps/editor
COPY apps/server apps/server
RUN npm run build -w @nyota/editor

# 2. Hub Rust
FROM rust:1-bookworm AS hub
WORKDIR /src
COPY apps/hub/Cargo.toml apps/hub/Cargo.lock ./
COPY apps/hub/src src
RUN cargo build --release --locked

# 3. Image finale
FROM node:22-bookworm-slim
# Certificats racine : le hub (rustls) et Node en ont besoin pour les connexions HTTPS sortantes (API Claude…)
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4000 \
    NYOTA_DB=/data/nyota.db \
    NYOTA_STATIC=/app/apps/editor/dist \
    NYOTA_MCP_URL=http://127.0.0.1:4001 \
    NYOTA_HUB_URL=http://127.0.0.1:4000
COPY --from=web /app /app
COPY --from=hub /src/target/release/nyota-hub /usr/local/bin/nyota-hub
COPY docker/entrypoint.sh /usr/local/bin/nyota
RUN chmod +x /usr/local/bin/nyota && mkdir -p /data
VOLUME /data
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:4000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["nyota"]
