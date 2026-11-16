#!/usr/bin/env bash
# CompHost — installer for a fresh Ubuntu or Debian server (no source checkout).
# Tested on Ubuntu 24.04 and 26.04 and Debian 12.
#
# Installs Docker Engine + the compose plugin, asks for every CompHost setting
# (pre-filled with sensible defaults, or with your current values when re-run),
# writes them to /opt/comphost/.env next to a docker-compose.yml, pulls the
# published image and starts it.
#
#   sudo bash install-registry.sh
# or in one line:
#   sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/unsortedcode/comphost/develop/scripts/install-registry.sh)"
#
# Re-running is safe: it offers your current settings as defaults, rewrites the
# two files and restarts CompHost on the new image. Your data stays where it is.
#
# Unattended: set COMPHOST_YES=1 to accept every default without prompting. Any
# setting can be preset in the environment (it then becomes the default):
#   COMPHOST_DIR  COMPHOST_IMAGE  COMPHOST_ADMIN_EMAIL  COMPHOST_ADMIN_PASSWORD
#   COMPHOST_DOMAIN  COMPHOST_STACKS_DIR  COMPHOST_DATA_DIR
#   COMPHOST_LETSENCRYPT_DIR  COMPHOST_ADMIN_PORT  COMPHOST_DNS_WAIT_MS  TZ
# A private registry: REGISTRY_USER / REGISTRY_TOKEN log in without a prompt.
set -euo pipefail

C_INFO='\033[1;36m'; C_OK='\033[1;32m'; C_WARN='\033[1;33m'; C_ERR='\033[1;31m'; C_DIM='\033[2m'; C_END='\033[0m'
info() { printf "${C_INFO}❯ %s${C_END}\n" "$*" >&2; }
ok()   { printf "${C_OK}✓ %s${C_END}\n" "$*" >&2; }
warn() { printf "${C_WARN}! %s${C_END}\n" "$*" >&2; }
note() { printf "${C_DIM}  %s${C_END}\n" "$*" >&2; }
die()  { printf "${C_ERR}✗ %s${C_END}\n" "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root: sudo bash install-registry.sh"

INTERACTIVE=1
if [ "${COMPHOST_YES:-}" = "1" ]; then
	INTERACTIVE=0
elif [ ! -r /dev/tty ]; then
	die "No terminal to ask on. Run it from a shell, or set COMPHOST_YES=1 to accept the defaults."
fi

# --- prompting ----------------------------------------------------------------

# ask <question> <default> → the answer, or the default on Enter. Reads from the
# terminal even when this script itself arrives through a pipe.
ask() {
	local q="$1" def="${2:-}" a=""
	if [ "$INTERACTIVE" -eq 0 ]; then printf '%s' "$def"; return; fi
	if [ -n "$def" ]; then
		read -r -p "  $q [$def]: " a </dev/tty || true
	else
		read -r -p "  $q: " a </dev/tty || true
	fi
	printf '%s' "${a:-$def}"
}

ask_secret() {
	local q="$1" a=""
	read -rs -p "  $q: " a </dev/tty || true
	echo >&2
	printf '%s' "$a"
}

yes_no() { # yes_no <question> <Y|N> → exit status
	local a
	a=$(ask "$1 (y/n)" "$2")
	case "$a" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

# Values go into .env single-quoted, so compose takes them literally ($, ", spaces
# and all). The one character that can't be written that way is the quote itself.
no_quote() {
	case "$1" in *"'"*) warn "  Single quotes (') can't be used here."; return 1 ;; esac
}

# --- 1. Can this machine get Docker? --------------------------------------------

[ -r /etc/os-release ] || die "Can't tell which Linux this is (no /etc/os-release)."
. /etc/os-release
case "${ID:-}" in
	ubuntu) DOCKER_DISTRO=ubuntu; CODENAME="${VERSION_CODENAME:-}" ;;
	debian) DOCKER_DISTRO=debian; CODENAME="${VERSION_CODENAME:-}" ;;
	*)
		case " ${ID_LIKE:-} " in
			*" ubuntu "*) DOCKER_DISTRO=ubuntu; CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}" ;;
			*" debian "*) DOCKER_DISTRO=debian; CODENAME="${VERSION_CODENAME:-}" ;;
			*) DOCKER_DISTRO="" ;;
		esac
		;;
esac

if ! command -v docker >/dev/null 2>&1 && { [ -z "$DOCKER_DISTRO" ] || [ -z "${CODENAME:-}" ]; }; then
	die "This installer sets up Docker on Ubuntu and Debian. Install Docker Engine and the compose plugin yourself (https://docs.docker.com/engine/install/), then re-run."
fi


# --- 2. Settings ----------------------------------------------------------------

COMPHOST_DIR="${COMPHOST_DIR:-/opt/comphost}"
ENV_FILE="$COMPHOST_DIR/.env"

# Current value of a setting: environment first, then the existing .env, then
# the built-in default.
current() { # current <KEY> <default>
	local key="$1" def="${2:-}" val=""
	val="$(printenv "$key" || true)"
	if [ -z "$val" ] && [ -f "$ENV_FILE" ]; then
		val="$(grep -E "^${key}=" "$ENV_FILE" | tail -n1 | cut -d= -f2-)"
		val="${val#\'}"; val="${val%\'}"; val="${val#\"}"; val="${val%\"}"
	fi
	printf '%s' "${val:-$def}"
}

abs_path() { # relative paths are taken relative to the install dir
	case "$1" in /*) printf '%s' "$1" ;; *) printf '%s' "$COMPHOST_DIR/${1#./}" ;; esac
}

DETECTED_TZ="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)"
GENERATED_PASSWORD=""

ask_settings() {
	echo >&2
	info "CompHost settings — press Enter to keep the value in [brackets]."

	echo >&2
	note "Image to run. 'latest' follows every release; pin a version such as"
	note "ghcr.io/unsortedcode/comphost:v0.10.0 to update only when you choose."
	while :; do
		IMAGE=$(ask "Image" "$(current COMPHOST_IMAGE ghcr.io/unsortedcode/comphost:latest)")
		no_quote "$IMAGE" && [ -n "$IMAGE" ] && break
	done

	echo >&2
	note "The first admin account. It is created on the first start only, while"
	note "the database has no users; change it later in the admin UI."
	if [ -f "$(abs_path "$(current COMPHOST_DATA_DIR ./data)")/database.sqlite" ]; then
		warn "  A database already exists, so these won't change the login of this install."
	fi
	while :; do
		ADMIN_EMAIL=$(ask "Admin email" "$(current COMPHOST_ADMIN_EMAIL)")
		case "$ADMIN_EMAIL" in *@*.*) no_quote "$ADMIN_EMAIL" && break ;; *) warn "  Enter an email address." ;; esac
		[ "$INTERACTIVE" -eq 1 ] || die "Set COMPHOST_ADMIN_EMAIL for an unattended install."
	done

	local existing_pw p1 p2
	existing_pw="$(current COMPHOST_ADMIN_PASSWORD)"
	if [ "$INTERACTIVE" -eq 0 ]; then
		ADMIN_PASS="$existing_pw"
	else
		while :; do
			if [ -n "$existing_pw" ]; then
				p1=$(ask_secret "Admin password (Enter keeps the current one)")
				[ -z "$p1" ] && { ADMIN_PASS="$existing_pw"; break; }
			else
				p1=$(ask_secret "Admin password (min 8 characters, Enter to generate one)")
				[ -z "$p1" ] && { ADMIN_PASS=""; break; }
			fi
			[ "${#p1}" -ge 8 ] || { warn "  At least 8 characters."; continue; }
			no_quote "$p1" || continue
			p2=$(ask_secret "Repeat the password")
			[ "$p1" = "$p2" ] && { ADMIN_PASS="$p1"; break; }
			warn "  The passwords don't match."
		done
	fi
	if [ -z "$ADMIN_PASS" ]; then
		# head reads a fixed amount and cut consumes everything, so nothing in this
		# pipeline is killed by SIGPIPE (which pipefail would turn into an exit).
		ADMIN_PASS="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-20)"
		GENERATED_PASSWORD="$ADMIN_PASS"
		note "A password will be generated and shown once at the end."
	fi

	echo >&2
	note "Domain for the admin UI, e.g. comphost.example.com (optional). If it already"
	note "points at this server, CompHost can get its certificate and serve the admin"
	note "UI on https://<domain> right away."
	while :; do
		DOMAIN=$(ask "Admin domain (Enter to skip)" "$(current COMPHOST_DOMAIN)")
		case "$DOMAIN" in *" "* | *"/"* | *":"*) warn "  Just the name, e.g. comphost.example.com." ;; *) no_quote "$DOMAIN" && break ;; esac
	done
	SECURE_ADMIN=0
	if [ -n "$DOMAIN" ]; then
		yes_no "Set up HTTPS for $DOMAIN now? (its DNS must already point here)" Y && SECURE_ADMIN=1
	fi

	echo >&2
	note "Admin UI port. '81' is reachable from anywhere; '127.0.0.1:81' only from"
	note "this server (use an SSH tunnel, or the HTTPS admin domain once it's set up)."
	while :; do
		ADMIN_PORT=$(ask "Admin UI port" "$(current COMPHOST_ADMIN_PORT 81)")
		case "$ADMIN_PORT" in
			[0-9]* | 127.0.0.1:[0-9]* | [0-9]*.[0-9]*.[0-9]*.[0-9]*:[0-9]*) break ;;
			*) warn "  A port (81) or address:port (127.0.0.1:81)." ;;
		esac
	done
	CLOSE_ADMIN_PORT=0
	if [ "$SECURE_ADMIN" -eq 1 ]; then
		case "$ADMIN_PORT" in
			127.0.0.1:*) : ;;
			*) yes_no "Once https://$DOMAIN works, limit port ${ADMIN_PORT##*:} to this server?" Y && CLOSE_ADMIN_PORT=1 ;;
		esac
	fi

	echo >&2
	note "Where your stacks' compose files live. It is mounted at the same path"
	note "inside CompHost, so relative volumes in your stacks resolve correctly."
	while :; do
		STACKS_DIR=$(ask "Stacks directory" "$(current COMPHOST_STACKS_DIR /opt/stacks)")
		case "$STACKS_DIR" in /*) no_quote "$STACKS_DIR" && break ;; *) warn "  Must be an absolute path." ;; esac
	done

	echo >&2
	note "Where CompHost keeps its database, nginx config and keys, and its certificates."
	while :; do
		DATA_DIR=$(abs_path "$(ask "Data directory" "$(abs_path "$(current COMPHOST_DATA_DIR ./data)")")")
		no_quote "$DATA_DIR" && break
	done
	while :; do
		LE_DIR=$(abs_path "$(ask "Certificate directory" "$(abs_path "$(current COMPHOST_LETSENCRYPT_DIR ./letsencrypt)")")")
		no_quote "$LE_DIR" && break
	done

	echo >&2
	while :; do
		TZ_VAL=$(ask "Time zone" "$(current TZ "$DETECTED_TZ")")
		no_quote "$TZ_VAL" && break
	done

	echo >&2
	note "After CompHost creates a DNS record (Cloudflare), how long to wait for it"
	note "to be answerable before asking Let's Encrypt for a certificate."
	local wait_ms
	wait_ms="$(current COMPHOST_DNS_WAIT_MS 120000)"
	while :; do
		DNS_WAIT_S=$(ask "DNS wait in seconds" "$((wait_ms / 1000))")
		case "$DNS_WAIT_S" in '' | *[!0-9]*) warn "  A number of seconds." ;; *) break ;; esac
	done

	UFW_PORTS=""
	OPEN_UFW=0
	if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
		UFW_PORTS="80/tcp 443/tcp"
		case "$ADMIN_PORT" in 127.0.0.1:*) : ;; *) UFW_PORTS="$UFW_PORTS ${ADMIN_PORT##*:}/tcp" ;; esac
		echo >&2
		yes_no "ufw is active. Allow $UFW_PORTS through it?" Y && OPEN_UFW=1
	fi
}

show_settings() {
	cat >&2 <<EOF

  Install dir       $COMPHOST_DIR
  Image             $IMAGE
  Admin email       $ADMIN_EMAIL
  Admin password    $([ -n "$GENERATED_PASSWORD" ] && echo "(generated)" || echo "(set)")
  Admin domain      ${DOMAIN:-—}$([ "$SECURE_ADMIN" -eq 1 ] && echo " (HTTPS set up now)")
  Admin UI port     $ADMIN_PORT$([ "$CLOSE_ADMIN_PORT" -eq 1 ] && echo " → 127.0.0.1:${ADMIN_PORT##*:} once HTTPS works")
  Stacks directory  $STACKS_DIR
  Data directory    $DATA_DIR
  Certificates      $LE_DIR
  Time zone         $TZ_VAL
  DNS wait          ${DNS_WAIT_S}s
  Firewall (ufw)    $([ -z "$UFW_PORTS" ] && echo "not active" || { [ "$OPEN_UFW" -eq 1 ] && echo "allow $UFW_PORTS" || echo "leave as is"; })
EOF
}

while :; do
	ask_settings
	show_settings
	[ "$INTERACTIVE" -eq 0 ] && break
	echo >&2
	yes_no "Write these settings and start CompHost?" Y && break
	info "Going through them again."
	GENERATED_PASSWORD=""
done

# --- 3. Docker (after the questions, so nobody waits for the first prompt) -------

if command -v docker >/dev/null 2>&1; then
	ok "Docker present: $(docker --version)"
else
	info "Installing Docker Engine and the compose plugin from download.docker.com ..."
	export DEBIAN_FRONTEND=noninteractive
	apt-get update -q
	apt-get install -y -q ca-certificates curl
	install -m 0755 -d /etc/apt/keyrings
	curl -fsSL "https://download.docker.com/linux/$DOCKER_DISTRO/gpg" -o /etc/apt/keyrings/docker.asc
	chmod a+r /etc/apt/keyrings/docker.asc
	echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$DOCKER_DISTRO $CODENAME stable" \
		>/etc/apt/sources.list.d/docker.list
	apt-get update -q
	apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
	systemctl enable --now docker
	ok "Docker installed: $(docker --version)"
fi
docker compose version >/dev/null 2>&1 || die "The docker compose plugin is missing — install docker-compose-plugin and re-run."
command -v curl >/dev/null 2>&1 || { apt-get update -q && apt-get install -y -q curl; }

# --- 4. Files -------------------------------------------------------------------

mkdir -p "$COMPHOST_DIR" "$STACKS_DIR" "$DATA_DIR" "$LE_DIR"
[ -f "$ENV_FILE" ] && cp -p "$ENV_FILE" "$ENV_FILE.bak"

umask 077
cat >"$ENV_FILE" <<EOF
# CompHost settings, written by install-registry.sh — re-run it to change them,
# or edit here and run: docker compose up -d
# Keep this file private: it holds the first admin's password.
COMPHOST_IMAGE='$IMAGE'
COMPHOST_ADMIN_EMAIL='$ADMIN_EMAIL'
COMPHOST_ADMIN_PASSWORD='$ADMIN_PASS'
COMPHOST_DOMAIN='$DOMAIN'
COMPHOST_ADMIN_PORT='$ADMIN_PORT'
COMPHOST_STACKS_DIR='$STACKS_DIR'
COMPHOST_DATA_DIR='$DATA_DIR'
COMPHOST_LETSENCRYPT_DIR='$LE_DIR'
TZ='$TZ_VAL'
COMPHOST_DNS_WAIT_MS='$((DNS_WAIT_S * 1000))'
EOF
chmod 600 "$ENV_FILE"
umask 022
ok "Wrote $ENV_FILE"

# Same as docker-compose.yml in the repository; every setting comes from .env.
cat >"$COMPHOST_DIR/docker-compose.yml" <<'YAML'
# CompHost, written by install-registry.sh. Settings live in .env next to it.
services:
  comphost:
    image: "${COMPHOST_IMAGE:-ghcr.io/unsortedcode/comphost:latest}"
    container_name: comphost
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "${COMPHOST_ADMIN_PORT:-81}:81"
    environment:
      TZ: "${TZ:-UTC}"
      INITIAL_ADMIN_EMAIL: "${COMPHOST_ADMIN_EMAIL:-admin@example.com}"
      INITIAL_ADMIN_PASSWORD: "${COMPHOST_ADMIN_PASSWORD:-changeme}"
      COMPHOST_STACKS_DIR: "${COMPHOST_STACKS_DIR:-/opt/stacks}"
      COMPHOST_DNS_WAIT_MS: "${COMPHOST_DNS_WAIT_MS:-120000}"
      DISABLE_IPV6: "true"
    volumes:
      - "${COMPHOST_DATA_DIR:-./data}:/data"
      - "${COMPHOST_LETSENCRYPT_DIR:-./letsencrypt}:/etc/letsencrypt"
      - /var/run/docker.sock:/var/run/docker.sock
      - "${COMPHOST_STACKS_DIR:-/opt/stacks}:${COMPHOST_STACKS_DIR:-/opt/stacks}"
    networks:
      default:
      comphost:
        aliases: [smtp]

networks:
  comphost:
    name: comphost
YAML
ok "Wrote $COMPHOST_DIR/docker-compose.yml"

# --- 5. Pull and start ----------------------------------------------------------

REGISTRY="${IMAGE%%/*}"
if [ -n "${REGISTRY_TOKEN:-}" ]; then
	echo "$REGISTRY_TOKEN" | docker login "$REGISTRY" -u "${REGISTRY_USER:-token}" --password-stdin >/dev/null ||
		die "docker login to $REGISTRY failed."
fi

# A port someone else holds would only fail later, inside docker compose.
running_here() { docker ps --format '{{.Names}}' 2>/dev/null | grep -qx comphost; }
for p in 80 443 "${ADMIN_PORT##*:}"; do
	if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}\$" && ! running_here; then
		warn "Port $p is already in use; CompHost needs it."
	fi
done

cd "$COMPHOST_DIR"
info "Pulling $IMAGE ..."
docker compose pull ||
	die "Pull failed. For a private registry: docker login $REGISTRY (or set REGISTRY_USER/REGISTRY_TOKEN), then re-run."
info "Starting CompHost ..."
docker compose up -d

info "Waiting for CompHost to answer ..."
ready=0
for _ in $(seq 1 60); do
	code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${ADMIN_PORT##*:}/api/" || true)
	[ "$code" = "200" ] && { ready=1; break; }
	sleep 3
done
[ "$ready" -eq 1 ] || die "CompHost didn't come up. See: docker compose -f $COMPHOST_DIR/docker-compose.yml logs"

# --- 6. Firewall ----------------------------------------------------------------

if [ "$OPEN_UFW" -eq 1 ]; then
	for p in $UFW_PORTS; do ufw allow "$p" >/dev/null; done
	ok "ufw: allowed $UFW_PORTS"
elif [ -n "$UFW_PORTS" ]; then
	note "ufw left as is. To open it later: $(for p in $UFW_PORTS; do printf 'ufw allow %s; ' "$p"; done)"
fi

# --- 7. HTTPS for the admin domain ----------------------------------------------

# The same two steps as Settings → Secure Admin Panel: a Let's Encrypt
# certificate for the domain, and a proxy host sending it to the admin UI.
ADMIN_HTTPS=""
if [ "$SECURE_ADMIN" -eq 1 ]; then
	echo >&2
	info "Setting up https://$DOMAIN ..."

	# Let's Encrypt has to reach this server under the domain, so check DNS first
	# rather than spend a certificate attempt that can't succeed.
	public_ip="$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || curl -4 -fsS --max-time 8 https://ifconfig.me 2>/dev/null || true)"
	# getent exits 2 for an unknown name; under pipefail that would end the script.
	domain_ips="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
	dns_ok=1
	if [ -z "$domain_ips" ]; then
		warn "$DOMAIN doesn't resolve yet."
		dns_ok=0
	elif [ -n "$public_ip" ] && ! printf ' %s' "$domain_ips" | grep -q " $public_ip "; then
		warn "$DOMAIN points at ${domain_ips% }, but this server is $public_ip."
		note "(Fine if a proxy such as Cloudflare sits in front and passes plain HTTP through.)"
		yes_no "Try anyway?" N || dns_ok=0
	fi

	if [ "$dns_ok" -eq 1 ]; then
		# Runs inside the container with its own Node, so the server needs no extra
		# tools; the login travels in the environment, not on a command line.
		result="$(docker exec -i \
			-e CH_EMAIL="$ADMIN_EMAIL" -e CH_PASSWORD="$ADMIN_PASS" -e CH_DOMAIN="$DOMAIN" \
			comphost node --input-type=module - 2>&1 <<'NODE' || true
const api = "http://127.0.0.1:81/api";
const call = async (method, url, body, token) => {
	const res = await fetch(api + url, {
		method,
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	const json = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
	return json;
};
const { CH_EMAIL: identity, CH_PASSWORD: secret, CH_DOMAIN: domain } = process.env;
try {
	let token;
	try {
		({ token } = await call("POST", "/tokens", { identity, secret }));
	} catch {
		throw new Error("couldn't log in with the admin email and password from .env (changed in the UI since?)");
	}
	const hosts = await call("GET", "/nginx/proxy-hosts", null, token);
	if (hosts.some((h) => h.meta?.comphost_admin_panel && h.domain_names.includes(domain))) {
		console.log("EXISTS");
	} else {
		const cert = await call(
			"POST",
			"/nginx/certificates",
			{ provider: "letsencrypt", domain_names: [domain], meta: { key_type: "ecdsa" } },
			token,
		);
		await call(
			"POST",
			"/nginx/proxy-hosts",
			{
				domain_names: [domain],
				forward_scheme: "http",
				forward_host: "127.0.0.1",
				forward_port: 81,
				certificate_id: cert.id,
				ssl_forced: true,
				block_exploits: true,
				allow_websocket_upgrade: true,
				http2_support: true,
				access_list_id: 0,
				caching_enabled: false,
				hsts_enabled: false,
				hsts_subdomains: false,
				advanced_config: "",
				locations: [],
				meta: { comphost_admin_panel: true },
			},
			token,
		);
		console.log("CREATED");
	}
} catch (err) {
	console.log(`FAILED ${err.message}`);
}
NODE
		)"
		case "$result" in
			*EXISTS*) ok "https://$DOMAIN was already set up." ;;
			*CREATED*) ok "Certificate issued and proxy host created for $DOMAIN." ;;
			*) warn "HTTPS setup didn't complete: ${result##*FAILED }" ;;
		esac

		# Only count it once it actually answers.
		case "$result" in
			*EXISTS* | *CREATED*)
				for _ in $(seq 1 10); do
					if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://$DOMAIN/api/" || true)" = "200" ]; then
						ADMIN_HTTPS="https://$DOMAIN"
						break
					fi
					sleep 3
				done
				[ -n "$ADMIN_HTTPS" ] || warn "https://$DOMAIN doesn't answer from this server yet; check it in your browser."
				;;
		esac
	fi
	[ -n "$ADMIN_HTTPS" ] || note "You can finish this later in Settings → Secure Admin Panel."

	# Close the plain admin port only once the HTTPS route is confirmed working.
	if [ -n "$ADMIN_HTTPS" ] && [ "$CLOSE_ADMIN_PORT" -eq 1 ]; then
		port="${ADMIN_PORT##*:}"
		ADMIN_PORT="127.0.0.1:$port"
		sed -i "s|^COMPHOST_ADMIN_PORT=.*|COMPHOST_ADMIN_PORT='$ADMIN_PORT'|" "$ENV_FILE"
		(cd "$COMPHOST_DIR" && docker compose up -d >/dev/null 2>&1)
		if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qE "^$port/tcp +ALLOW"; then
			ufw delete allow "$port/tcp" >/dev/null || true
		fi
		ok "Port $port now only answers on this server; use $ADMIN_HTTPS."
	fi
fi

# --- done -----------------------------------------------------------------------

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo >&2
ok "CompHost is running ($IMAGE)."
case "$ADMIN_PORT" in
	127.0.0.1:*) ADMIN_URL="http://127.0.0.1:${ADMIN_PORT##*:} (from this server, e.g. ssh -L ${ADMIN_PORT##*:}:127.0.0.1:${ADMIN_PORT##*:} you@${IP:-server})" ;;
	*) ADMIN_URL="http://${IP:-<server-ip>}:${ADMIN_PORT##*:}" ;;
esac
[ -n "$ADMIN_HTTPS" ] && ADMIN_URL="$ADMIN_HTTPS   (also $ADMIN_URL)"
cat <<EOF

  Admin UI   $ADMIN_URL
  Login      $ADMIN_EMAIL
EOF
if [ -n "$GENERATED_PASSWORD" ]; then
	cat <<EOF
  Password   $GENERATED_PASSWORD
             (generated — it is also in $ENV_FILE until you change it in the UI)
EOF
fi
cat <<EOF

  Settings   $ENV_FILE
  Update     cd $COMPHOST_DIR && docker compose pull && docker compose up -d
  Change     re-run this installer

EOF
if [ -n "$ADMIN_HTTPS" ]; then
	echo "The admin UI is on $ADMIN_HTTPS."
elif [ -n "${DOMAIN:-}" ]; then
	echo "Next: point $DOMAIN at ${IP:-this server}, then Settings → Secure Admin Panel for HTTPS."
else
	echo "Next: point a domain at this server, then Settings → Secure Admin Panel for HTTPS."
fi
