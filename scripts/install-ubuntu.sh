#!/usr/bin/env bash
# CompHost — guided one-script installer for Ubuntu (22.04 / 24.04).
#
# What it does:
#   1. Installs Docker Engine + the compose plugin (if missing).
#   2. Clones (or updates) CompHost into /opt/comphost.
#      (A source checkout is required for now: no prebuilt image is published
#       yet, so the image is built on this machine — self-contained, only
#       Docker needed. ~2 GB RAM recommended for the in-image frontend build.)
#   3. Walks you through initial setup (admin email/password, domain, stacks
#      dir) and writes /opt/comphost/.env.
#   4. Builds + starts CompHost and waits until the admin API answers.
#
# Usage (interactive):
#   sudo bash scripts/install-ubuntu.sh
# or, if the repo is public / you have a tokened URL:
#   sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/unsortedcode/comphost/develop/scripts/install-ubuntu.sh)"
#
# Non-interactive: pre-set COMPHOST_ADMIN_EMAIL and COMPHOST_ADMIN_PASSWORD
# (plus optionally COMPHOST_DOMAIN, COMPHOST_STACKS_DIR) in the environment and
# no prompts are shown.
#
# Overridable env vars:
#   COMPHOST_DIR        install dir            (default /opt/comphost)
#   COMPHOST_REPO_URL   git repo to clone      (default the CompHost repo)
#   COMPHOST_BRANCH     branch                 (default main)
#   COMPHOST_STACKS_DIR stacks dir             (default /opt/stacks)
set -euo pipefail

COMPHOST_DIR="${COMPHOST_DIR:-/opt/comphost}"
REPO_URL="${COMPHOST_REPO_URL:-https://github.com/unsortedcode/comphost.git}"
BRANCH="${COMPHOST_BRANCH:-main}"

C_INFO='\033[1;36m'; C_OK='\033[1;32m'; C_WARN='\033[1;33m'; C_ERR='\033[1;31m'; C_END='\033[0m'
info() { printf "${C_INFO}❯ %s${C_END}\n" "$*"; }
ok()   { printf "${C_OK}✓ %s${C_END}\n" "$*"; }
warn() { printf "${C_WARN}! %s${C_END}\n" "$*"; }
die()  { printf "${C_ERR}✗ %s${C_END}\n" "$*" >&2; exit 1; }

# --- preconditions -----------------------------------------------------------

[ "$(id -u)" -eq 0 ] || die "Run as root: sudo bash scripts/install-ubuntu.sh"

if [ -r /etc/os-release ]; then
	. /etc/os-release
	case "${ID:-}" in
		ubuntu) : ;;
		debian) warn "Detected Debian — installer targets Ubuntu but should work; continuing." ;;
		*) warn "Detected '${ID:-unknown}' — installer targets Ubuntu 22.04/24.04; continuing anyway." ;;
	esac
fi

# Read from the terminal even when the script body is piped into bash.
ask() { # ask <prompt> <default> -> stdout
	local prompt="$1" def="${2:-}" ans=""
	if [ -r /dev/tty ]; then
		read -r -p "$prompt" ans </dev/tty || true
	else
		read -r -p "$prompt" ans || true
	fi
	printf '%s' "${ans:-$def}"
}

ask_secret() { # ask_secret <prompt> -> stdout
	local prompt="$1" ans=""
	if [ -r /dev/tty ]; then
		read -rs -p "$prompt" ans </dev/tty || true; echo >&2
	else
		read -rs -p "$prompt" ans || true; echo >&2
	fi
	printf '%s' "$ans"
}

# --- 1. Docker Engine + compose plugin ---------------------------------------

if ! command -v docker >/dev/null 2>&1; then
	info "Installing Docker Engine + compose plugin..."
	apt-get update
	apt-get install -y ca-certificates curl gnupg git
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
command -v git >/dev/null 2>&1 || { info "Installing git..."; apt-get update && apt-get install -y git; }
docker compose version >/dev/null 2>&1 || die "docker compose plugin missing — install docker-compose-plugin and re-run."

# --- 2. Fetch CompHost into /opt/comphost -------------------------------------

if [ -d "$COMPHOST_DIR/.git" ]; then
	info "Updating existing checkout in $COMPHOST_DIR ..."
	git -C "$COMPHOST_DIR" pull --ff-only origin "$BRANCH"
elif [ -e "$COMPHOST_DIR" ] && [ -n "$(ls -A "$COMPHOST_DIR" 2>/dev/null)" ]; then
	die "$COMPHOST_DIR exists and is not a CompHost checkout — move it aside and re-run."
else
	info "Cloning $REPO_URL ($BRANCH) into $COMPHOST_DIR ..."
	info "(private repo? git will prompt for credentials, or use a tokened URL via COMPHOST_REPO_URL)"
	git clone --branch "$BRANCH" "$REPO_URL" "$COMPHOST_DIR"
fi
ok "Source ready in $COMPHOST_DIR"

# --- 3. Guided initial setup ---------------------------------------------------

ENV_FILE="$COMPHOST_DIR/.env"
WRITE_ENV=1
if [ -f "$ENV_FILE" ]; then
	keep=$(ask "An existing .env was found — keep it? [Y/n] " "Y")
	case "$keep" in n|N|no|NO) WRITE_ENV=1 ;; *) WRITE_ENV=0 ;; esac
fi

if [ "$WRITE_ENV" -eq 1 ]; then
	echo ""
	info "Initial setup — these seed the first admin account (only used on first boot):"

	ADMIN_EMAIL="${COMPHOST_ADMIN_EMAIL:-}"
	while :; do
		[ -n "$ADMIN_EMAIL" ] && case "$ADMIN_EMAIL" in *@*.*) break ;; esac
		ADMIN_EMAIL=$(ask "  Admin email: " "")
		case "$ADMIN_EMAIL" in *@*.*) break ;; *) warn "  Please enter a valid email address." ;; esac
	done

	ADMIN_PASS="${COMPHOST_ADMIN_PASSWORD:-}"
	while [ -z "$ADMIN_PASS" ]; do
		p1=$(ask_secret "  Admin password (min 8 chars): ")
		if [ "${#p1}" -lt 8 ]; then warn "  Too short."; continue; fi
		case "$p1" in *'$'*|*'"'*) warn "  Avoid \$ and \" in the initial password (compose env quirks) — you can change it after login."; continue ;; esac
		p2=$(ask_secret "  Confirm password: ")
		[ "$p1" = "$p2" ] && ADMIN_PASS="$p1" || warn "  Passwords do not match, try again."
	done

	DOMAIN="${COMPHOST_DOMAIN:-}"
	if [ -z "$DOMAIN" ]; then
		DOMAIN=$(ask "  Admin domain (optional, e.g. comphost.example.com — Enter to skip): " "")
	fi

	STACKS_DIR="${COMPHOST_STACKS_DIR:-}"
	if [ -z "$STACKS_DIR" ]; then
		STACKS_DIR=$(ask "  Stacks directory [/opt/stacks]: " "/opt/stacks")
	fi
	case "$STACKS_DIR" in /*) : ;; *) die "Stacks directory must be an absolute path." ;; esac

	TZ_VAL="$(cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null || echo UTC)"

	umask 077
	cat > "$ENV_FILE" <<EOF
# CompHost configuration (used by docker-compose.yml). Keep this file private.
COMPHOST_ADMIN_EMAIL=$ADMIN_EMAIL
COMPHOST_ADMIN_PASSWORD=$ADMIN_PASS
COMPHOST_STACKS_DIR=$STACKS_DIR
COMPHOST_DOMAIN=$DOMAIN
TZ=$TZ_VAL
${COMPHOST_IMAGE:+COMPHOST_IMAGE=$COMPHOST_IMAGE}
EOF
	chmod 600 "$ENV_FILE"
	ok "Wrote $ENV_FILE (mode 600)"
else
	STACKS_DIR="$(grep -E '^COMPHOST_STACKS_DIR=' "$ENV_FILE" | cut -d= -f2- || true)"
	STACKS_DIR="${STACKS_DIR:-/opt/stacks}"
	DOMAIN="$(grep -E '^COMPHOST_DOMAIN=' "$ENV_FILE" | cut -d= -f2- || true)"
fi

mkdir -p "$STACKS_DIR"
ok "Stacks directory: $STACKS_DIR"

# --- sanity checks -------------------------------------------------------------

mem_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$mem_kb" -gt 0 ] && [ "$mem_kb" -lt 1800000 ]; then
	warn "Only $((mem_kb / 1024)) MB RAM — the in-image frontend build may OOM. 2 GB+ (or swap) recommended."
	cont=$(ask "Continue anyway? [y/N] " "N")
	case "$cont" in y|Y) : ;; *) die "Aborted." ;; esac
fi

for p in 80 443 81; do
	if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}\$"; then
		warn "Port $p is already in use — CompHost needs 80/443/81. Fix and re-run, or expect a bind error."
	fi
done

# --- 4. Build + start -----------------------------------------------------------

cd "$COMPHOST_DIR"
# Prefer a prebuilt image when COMPHOST_IMAGE is set (env or .env) — much faster
# and works on low-RAM boxes. Otherwise build from source on this machine.
IMAGE_REF="${COMPHOST_IMAGE:-$(grep -E '^COMPHOST_IMAGE=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)}"
if [ -n "$IMAGE_REF" ]; then
	info "Pulling prebuilt image $IMAGE_REF ..."
	docker compose pull comphost || die "Pull failed — if the registry is private, run: docker login ${IMAGE_REF%%/*}"
	docker compose up -d --no-build
else
	info "Building and starting CompHost (first build takes a few minutes)..."
	docker compose up -d --build
fi

info "Waiting for the admin API to come up..."
ready=0
for _ in $(seq 1 100); do
	code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:81/api/ || echo 000)
	if [ "$code" = "200" ]; then ready=1; break; fi
	sleep 3
done
[ "$ready" -eq 1 ] || die "Backend did not become ready — check: docker compose -f $COMPHOST_DIR/docker-compose.yml logs"

# --- firewall (optional) ---------------------------------------------------------

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
	echo ""
	warn "ufw is active. CompHost needs 80 + 443 open; 81 is the admin UI (close it after securing the panel on 443)."
	dofw=$(ask "Allow 80, 443 and 81 through ufw now? [Y/n] " "Y")
	case "$dofw" in
		n|N) info "Skipped. Later: ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 81/tcp" ;;
		*) ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 81/tcp; ok "ufw rules added." ;;
	esac
fi

# --- done ------------------------------------------------------------------------

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo ""
ok "CompHost is running."
cat <<EOF

  Admin UI:     http://${IP:-<server-ip>}:81
  Login:        (the admin email + password you just set)
  HTTP/ACME:    port 80        HTTPS: port 443
  Stacks dir:   $STACKS_DIR
  Config:       $COMPHOST_DIR/.env

Next steps:
  1. Log in and change anything you like (Users → your profile).
EOF
if [ -n "${DOMAIN:-}" ]; then
	cat <<EOF
  2. DNS: point $DOMAIN at ${IP:-this server}, then Settings → Secure Admin Panel → request a Let's Encrypt cert.
  3. Once https://$DOMAIN works, firewall port 81:  ufw delete allow 81/tcp
EOF
else
	cat <<EOF
  2. Point a domain at this server, then Settings → Secure Admin Panel to get HTTPS on 443.
EOF
fi
cat <<EOF

Update later:   cd $COMPHOST_DIR && git pull && docker compose up -d --build
EOF
