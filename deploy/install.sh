#!/usr/bin/env bash
# Installe ou met à jour Swiftma sur un serveur Linux (Ubuntu / Debian), en HTTPS avec Caddy.
# Idempotent : relancer ce script met à jour le code sans toucher aux données (volume Docker « swiftma_swiftma-data »).
#
# Usage, en root, depuis le dossier du code (copié par le workflow « Déployer » dans /opt/swiftma/src) :
#   SWIFTMA_DOMAIN=design.exemple.org SWIFTMA_ADMIN_EMAIL=moi@exemple.org bash deploy/install.sh
#
# Variables :
#   SWIFTMA_DOMAIN       domaine public (DNS A vers ce serveur). Sans domaine : <ip-avec-tirets>.sslip.io
#   SWIFTMA_ADMIN_EMAIL  premier compte (administrateur), créé si l'instance n'a encore aucun compte ;
#                        son mot de passe provisoire est écrit dans /etc/swiftma/admin.txt (jamais dans les journaux)
#   SWIFTMA_SIGNUP       closed (défaut) ou open
#   ANTHROPIC_API_KEY    facultatif : agent IA intégré (le MCP fonctionne sans)
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF=/etc/swiftma
ENV_FILE="$CONF/swiftma.env"
COMPOSE=(docker compose -p swiftma --project-directory "$SRC" --env-file "$ENV_FILE" --profile https)

log() { printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "À lancer en root (sudo)."
[ -f "$SRC/docker-compose.yml" ] || die "docker-compose.yml introuvable dans $SRC"

# Entrées transmises par le workflow (fichier temporaire, lisible par root seulement)
if [ -f "$CONF/deploy-input.env" ]; then
  # shellcheck disable=SC1091
  . "$CONF/deploy-input.env"
  rm -f "$CONF/deploy-input.env"
fi

public_ip() { curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}'; }

# --- Paquets de base et Docker ---
log "Paquets de base"
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl iproute2 >/dev/null
fi

if ! command -v docker >/dev/null; then
  log "Installation de Docker"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "Le plugin « docker compose » manque (paquet docker-compose-plugin)."
systemctl enable --now docker >/dev/null 2>&1 || true

# --- Mémoire : la compilation (Rust + éditeur) demande ~3 Go ---
mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
swap_mb=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$((mem_mb + swap_mb))" -lt 3500 ] && [ ! -f /swapfile-swiftma ]; then
  log "Peu de mémoire (${mem_mb} Mo) : ajout d'un fichier d'échange de 4 Go"
  fallocate -l 4G /swapfile-swiftma && chmod 600 /swapfile-swiftma && mkswap /swapfile-swiftma >/dev/null && swapon /swapfile-swiftma
  grep -q swapfile-swiftma /etc/fstab || echo "/swapfile-swiftma none swap sw 0 0" >> /etc/fstab
fi

# --- Ports 80 et 443 : libres, ou déjà tenus par notre Caddy ---
log "Ports 80 et 443"
for port in 80 443; do
  holder=$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'users:(("[^"]*"' | head -1 | cut -d'"' -f2 || true)
  if [ -n "$holder" ] && [ "$holder" != "docker-proxy" ]; then
    die "Le port $port est déjà utilisé par « $holder ». Arrête-le (ex. systemctl disable --now $holder) ou dis-le pour configurer Swiftma derrière lui."
  fi
done
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
fi

# --- Configuration (/etc/swiftma/swiftma.env, conservée d'un déploiement à l'autre) ---
log "Configuration"
install -d -m 700 "$CONF"
touch "$ENV_FILE" && chmod 600 "$ENV_FILE"
get() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
set_var() {
  local key=$1 value=$2
  if grep -qE "^$key=" "$ENV_FILE"; then sed -i "s|^$key=.*|$key=$value|" "$ENV_FILE"; else echo "$key=$value" >> "$ENV_FILE"; fi
}
domain="${SWIFTMA_DOMAIN:-$(get SWIFTMA_DOMAIN)}"
[ -n "$domain" ] || domain="$(public_ip | tr . -).sslip.io"
set_var SWIFTMA_DOMAIN "$domain"
set_var SWIFTMA_PUBLIC_URL "https://$domain"
set_var SWIFTMA_SECURE_COOKIES 1
set_var SWIFTMA_SIGNUP "${SWIFTMA_SIGNUP:-$(get SWIFTMA_SIGNUP)}"
[ -n "$(get SWIFTMA_SIGNUP)" ] || set_var SWIFTMA_SIGNUP closed
# Le hub n'écoute qu'en local : tout le trafic public passe par Caddy (HTTPS)
set_var SWIFTMA_PORT 127.0.0.1:4000
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then set_var ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"; fi
echo "Domaine : $domain"

# --- Construction et démarrage ---
log "Construction de l'image et démarrage (la première fois : 5 à 15 minutes)"
"${COMPOSE[@]}" up -d --build --remove-orphans
docker image prune -f >/dev/null 2>&1 || true

log "Attente du hub"
for _ in $(seq 1 90); do
  curl -fsS http://127.0.0.1:4000/api/health >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS http://127.0.0.1:4000/api/health >/dev/null || { "${COMPOSE[@]}" logs --tail 80 swiftma; die "Le hub ne répond pas."; }

# --- Premier compte (administrateur) : créé ici pour que personne d'autre ne le prenne ---
config=$(curl -fsS http://127.0.0.1:4000/api/auth/config)
if echo "$config" | grep -q '"hasUsers":false'; then
  if [ -n "${SWIFTMA_ADMIN_EMAIL:-}" ]; then
    log "Création du compte administrateur ${SWIFTMA_ADMIN_EMAIL}"
    password=$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | cut -c1-20)
    body=$(printf '{"email":"%s","name":"Administrateur","password":"%s"}' "$SWIFTMA_ADMIN_EMAIL" "$password")
    curl -fsS -o /dev/null -H 'Content-Type: application/json' -d "$body" http://127.0.0.1:4000/api/auth/register \
      || die "Création du compte administrateur impossible."
    umask 077
    printf 'Swiftma — compte administrateur\nAdresse : https://%s\nEmail : %s\nMot de passe provisoire : %s\n(à changer : menu du compte → Mon compte)\n' \
      "$domain" "$SWIFTMA_ADMIN_EMAIL" "$password" > "$CONF/admin.txt"
    echo "Identifiants écrits dans $CONF/admin.txt (lisible par root seulement)."
  else
    echo "⚠ Aucun compte : le premier inscrit sur https://$domain deviendra administrateur. Inscris-toi tout de suite."
  fi
fi

log "Swiftma est en ligne : https://$domain"
echo "Certificat HTTPS : obtenu automatiquement par Caddy dans la minute qui suit le premier accès."
echo "Journaux : docker compose -p swiftma logs -f    ·    Mot de passe perdu : docker exec swiftma-swiftma-1 swiftma-hub reset-password <email>"
