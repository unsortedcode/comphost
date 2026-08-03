#!/usr/bin/env bash
# CompHost — registry installer for Ubuntu (NO source checkout).
#
# Self-contained: installs Docker, writes a compose file + .env into
# /opt/comphost, pulls the CI-built image from the GitHub Container Registry, and
# starts it. The only thing this script needs from CompHost is the image.
#
# Quick start (paste this one file onto the new box, then):
#   sudo bash install-registry.sh
# or fetch + run in one line (repo/raw must be reachable, or use a tokened URL):
#   sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/unsortedcode/comphost/develop/scripts/install-registry.sh)"
#
# Env overrides:
#   COMPHOST_IMAGE       image ref   (default ghcr.io/unsortedcode/comphost:latest)
#   COMPHOST_DIR         install dir (default /opt/comphost)
#   COMPHOST_STACKS_DIR  stacks dir  (default /opt/stacks)
#   COMPHOST_ADMIN_EMAIL / COMPHOST_ADMIN_PASSWORD / COMPHOST_DOMAIN  (skip prompts)
#   REGISTRY_USER / REGISTRY_TOKEN  non-interactive docker login for a private registry
set -euo pipefail

IMAGE="${COMPHOST_IMAGE:-ghcr.io/unsortedcode/comphost:latest}"
REGISTRY="${IMAGE%%/*}"
COMPHOST_DIR="${COMPHOST_DIR:-/opt/comphost}"

C_INFO='\033[1;36m'; C_OK='\033[1;32m'; C_WARN='\033[1;33m'; C_ERR='\033[1;31m'; C_END='\033[0m'
info() { printf "${C_INFO}❯ %s${C_END}\n" "$*"; }
ok()   { printf "${C_OK}✓ %s${C_END}\n" "$*"; }
warn() { printf "${C_WARN}! %s${C_END}\n" "$*"; }
die()  { printf "${C_ERR}✗ %s${C_END}\n" "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root: sudo bash install-registry.sh"

ask() { local p="$1" d="${2:-}" a=""; if [ -r /dev/tty ]; then read -r -p "$p" a </dev/tty || true; else read -r -p "$p" a || true; fi; printf '%s' "${a:-$d}"; }
ask_secret() { local p="$1" a=""; if [ -r /dev/tty ]; then read -rs -p "$p" a </dev/tty || true; echo >&2; else read -rs -p "$p" a || true; echo >&2; fi; printf '%s' "$a"; }

# --- 1. Docker ---------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
	info "Installing Docker Engine + compose plugin..."
	apt-get update
	apt-get install -y ca-certificates curl gnupg
	install -m 0755 -d /etc/apt/keyrings
	curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
	chmod a+r /etc/apt/keyrings/docker.asc
	echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
		> /etc/apt/sources.list.d/docker.list
	apt-get update
	apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
	systemctl enable --now docker
	ok "Docker installed: $(docker --version)"
else
	ok "Docker present: $(docker --version)"
fi
docker compose version >/dev/null 2>&1 || die "docker compose plugin missing."

# --- 2. Registry login (if needed) -------------------------------------------
if [ -n "${REGISTRY_TOKEN:-}" ]; then
	info "Logging in to $REGISTRY (non-interactive)..."
	echo "$REGISTRY_TOKEN" | docker login "$REGISTRY" -u "${REGISTRY_USER:-token}" --password-stdin \
		|| die "docker login failed."
	ok "Logged in to $REGISTRY"
elif ! docker manifest inspect "$IMAGE" >/dev/null 2>&1; then
	warn "Cannot read $IMAGE anonymously — the package is likely private."
	dolog=$(ask "Log in to $REGISTRY now? [Y/n] " "Y")
	case "$dolog" in
		n|N) warn "Skipping login; pull will fail if the package is private." ;;
		*) docker login "$REGISTRY" </dev/tty || die "docker login failed." ;;
	esac
fi

# --- 3. Guided setup ----------------------------------------------------------
mkdir -p "$COMPHOST_DIR"
ENV_FILE="$COMPHOST_DIR/.env"
if [ -f "$ENV_FILE" ] && [ "$(ask "Existing .env found — keep it? [Y/n] " "Y")" != "n" ]; then
	STACKS_DIR="$(grep -E '^COMPHOST_STACKS_DIR=' "$ENV_FILE" | cut -d= -f2- || echo /opt/stacks)"
	DOMAIN="$(grep -E '^COMPHOST_DOMAIN=' "$ENV_FILE" | cut -d= -f2- || true)"
else
	echo ""; info "Initial setup (seeds the first admin account on first boot):"
	ADMIN_EMAIL="${COMPHOST_ADMIN_EMAIL:-}"
	while :; do case "$ADMIN_EMAIL" in *@*.*) break ;; esac; ADMIN_EMAIL=$(ask "  Admin email: " ""); done
	ADMIN_PASS="${COMPHOST_ADMIN_PASSWORD:-}"
	while [ -z "$ADMIN_PASS" ]; do
		p1=$(ask_secret "  Admin password (min 8): "); [ "${#p1}" -ge 8 ] || { warn "  Too short."; continue; }
		case "$p1" in *'$'*|*'"'*) warn "  Avoid \$ and \" in the initial password."; continue ;; esac
		p2=$(ask_secret "  Confirm: "); [ "$p1" = "$p2" ] && ADMIN_PASS="$p1" || warn "  Mismatch."
	done
	DOMAIN="${COMPHOST_DOMAIN:-$(ask "  Admin domain (optional, Enter to skip): " "")}"
	STACKS_DIR="${COMPHOST_STACKS_DIR:-$(ask "  Stacks directory [/opt/stacks]: " "/opt/stacks")}"
	case "$STACKS_DIR" in /*) : ;; *) die "Stacks dir must be absolute." ;; esac
	TZ_VAL="$(cat /etc/timezone 2>/dev/null || echo UTC)"
	umask 077
	cat > "$ENV_FILE" <<EOF
# CompHost configuration. Keep private.
COMPHOST_IMAGE=$IMAGE
COMPHOST_ADMIN_EMAIL=$ADMIN_EMAIL
COMPHOST_ADMIN_PASSWORD=$ADMIN_PASS
COMPHOST_STACKS_DIR=$STACKS_DIR
COMPHOST_DOMAIN=$DOMAIN
TZ=$TZ_VAL
EOF
	chmod 600 "$ENV_FILE"
	ok "Wrote $ENV_FILE (mode 600)"
fi
mkdir -p "$STACKS_DIR"

# --- 4. Write the registry compose file --------------------------------------
cat > "$COMPHOST_DIR/docker-compose.yml" <<'YAML'
services:
  comphost:
    image: "${COMPHOST_IMAGE:-ghcr.io/unsortedcode/comphost:latest}"
    container_name: comphost
    restart: unless-stopped
    pull_policy: always
    ports:
      - "80:80"
      - "443:443"
      - "81:81"
    environment:
      TZ: "${TZ:-UTC}"
      INITIAL_ADMIN_EMAIL: "${COMPHOST_ADMIN_EMAIL:-admin@example.com}"
      INITIAL_ADMIN_PASSWORD: "${COMPHOST_ADMIN_PASSWORD:-changeme}"
      COMPHOST_STACKS_DIR: "${COMPHOST_STACKS_DIR:-/opt/stacks}"
      DISABLE_IPV6: "true"
    volumes:
      - ./data:/data
      - ./letsencrypt:/etc/letsencrypt
      - /var/run/docker.sock:/var/run/docker.sock
      - "${COMPHOST_STACKS_DIR:-/opt/stacks}:${COMPHOST_STACKS_DIR:-/opt/stacks}"
    networks:
      - default
      - comphost
networks:
  comphost:
    name: comphost
YAML
ok "Wrote $COMPHOST_DIR/docker-compose.yml"

# --- 5. Port check + pull + start --------------------------------------------
for p in 80 443 81; do
	ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}\$" && warn "Port $p already in use — CompHost needs 80/443/81."
done

cd "$COMPHOST_DIR"
info "Pulling $IMAGE ..."
docker compose pull || die "Pull failed. If the package is private: docker login $REGISTRY , then re-run."
info "Starting CompHost..."
docker compose up -d

info "Waiting for the admin API..."
ready=0
for _ in $(seq 1 60); do
	[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:81/api/ || echo 000)" = "200" ] && { ready=1; break; }
	sleep 3
done
[ "$ready" -eq 1 ] || die "Backend not ready — check: docker compose -f $COMPHOST_DIR/docker-compose.yml logs"

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
	case "$(ask "ufw is active — allow 80, 443, 81? [Y/n] " "Y")" in
		n|N) : ;; *) ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 81/tcp && ok "ufw rules added." ;;
	esac
fi

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo ""; ok "CompHost is running (from $IMAGE)."
cat <<EOF

  Admin UI:   http://${IP:-<server-ip>}:81   (log in with the admin creds you set)
  Ports:      80 (HTTP/ACME) · 443 (HTTPS) · 81 (admin)
  Stacks dir: $STACKS_DIR
  Config:     $COMPHOST_DIR/.env  +  $COMPHOST_DIR/docker-compose.yml

Update:   cd $COMPHOST_DIR && docker compose pull && docker compose up -d
EOF
if [ -n "${DOMAIN:-}" ]; then
	echo "Next: point $DOMAIN at ${IP:-this server}, then Settings → Secure Admin Panel for HTTPS; afterwards close 81 (ufw delete allow 81/tcp)."
else
	echo "Next: point a domain here, then Settings → Secure Admin Panel to get HTTPS on 443."
fi
