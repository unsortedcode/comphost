# Installing CompHost

CompHost runs in a single container (nginx + certbot + backend via s6, inheriting
nginx-proxy-manager's packaging) and manages your docker-compose stacks over the
host's Docker socket. It exposes:

- **80** — HTTP + Let's Encrypt ACME challenges
- **443** — HTTPS (proxied hosts, and the admin panel once secured)
- **81** — admin UI (initially; secure it on 443 and firewall this off)

## Option 0 — Registry deploy, no source (recommended for new machines)

CI publishes the image to the container registry, so a fresh machine needs
**only Docker + a compose file** — no repo checkout, no build.

**Scripted (guided):** copy `scripts/install-registry.sh` onto the box (or curl it)
and run it. It installs Docker, logs in if the package is private, writes
`/opt/comphost/docker-compose.yml` + `.env`, pulls the image and starts it:

```bash
sudo bash install-registry.sh
# private registry, non-interactive login:
sudo REGISTRY_USER=you REGISTRY_TOKEN=<pat-with-read:package> bash install-registry.sh
```

**Manual:** three files, no clone:

```bash
mkdir -p /opt/comphost && cd /opt/comphost
docker login ghcr.io                          # only if the package is private
curl -fsSL -o docker-compose.yml \
  https://raw.githubusercontent.com/unsortedcode/comphost/develop/docker-compose.yml
curl -fsSL -o .env \
  https://raw.githubusercontent.com/unsortedcode/comphost/develop/.env.example
nano .env                                     # set the admin password at minimum
chmod 600 .env && mkdir -p /opt/stacks
docker compose pull && docker compose up -d
```

Admin UI on `http://<server-ip>:81`. Update later:
`cd /opt/comphost && docker compose pull && docker compose up -d`.

## Option A — Build from source (Docker Compose)

Requires only Docker + the compose plugin. The image builds its own frontend, so
nothing else is needed on the host.

```bash
git clone https://github.com/unsortedcode/comphost.git && cd comphost
cp .env.example .env      # set the admin password and stacks directory
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

Then open `http://<server-ip>:81`.

⚠️ **Stacks-dir path identity**: the
`/opt/stacks:/opt/stacks` mount must be the *same absolute path* on both sides, or
relative volume mounts inside your stacks resolve to the wrong place on the host.

## Option B — Fresh Ubuntu VPS (guided one-script install)

A plain Ubuntu 22.04/24.04 server (≥2 GB RAM recommended for the in-image
frontend build). The installer installs Docker + compose, clones CompHost into
`/opt/comphost`, walks you through initial setup (admin email/password, domain,
stacks dir → written to `/opt/comphost/.env`), builds, starts, and waits until
the admin API answers:

```bash
git clone https://github.com/unsortedcode/comphost.git /opt/comphost
sudo bash /opt/comphost/scripts/install-ubuntu.sh
```

The script can also bootstrap itself — it clones the repo for you:

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/unsortedcode/comphost/develop/scripts/install-ubuntu.sh)"
```

Non-interactive installs: pre-set `COMPHOST_ADMIN_EMAIL` and
`COMPHOST_ADMIN_PASSWORD` (plus optionally `COMPHOST_DOMAIN`,
`COMPHOST_STACKS_DIR`) and no prompts are shown.

### Fast path: use the CI-built image (no local build)

CI publishes the image to the container registry on every push to `main`. To deploy with a pull instead of a
build (faster, works on low-RAM boxes), set `COMPHOST_IMAGE` before running the
installer — it lands in `.env` and the installer pulls instead of building:

```bash
sudo COMPHOST_IMAGE=ghcr.io/unsortedcode/comphost:latest \
  bash /opt/comphost/scripts/install-ubuntu.sh
```

If the registry is private, `docker login ghcr.io` first (a token with
`read:package` works as the password). Updating later:

```bash
cd /opt/comphost && git pull && docker compose pull comphost && docker compose up -d --no-build
```

### Why not a fully Docker-less install?

CompHost inherits nginx-proxy-manager's runtime, which is tightly coupled to its
container: hardcoded `/data` paths, a purpose-built `nginx-full` (OpenResty)
image, an s6 process supervisor, and a certbot virtualenv at `/opt/certbot`.
Reproducing all of that directly on a host is fragile and unsupported upstream, so
v1 standardises on "Docker on the VPS." A native systemd/nginx/certbot port is a
possible future item, tracked in the roadmap.

## Securing the admin panel with Let's Encrypt

Once a domain points at the server and port 80 is reachable:

1. **Settings → Secure Admin Panel** → enter the domain → **Request Certificate & Secure**.
   This requests an LE cert (HTTP-01) and creates a proxy host forwarding the
   domain to `127.0.0.1:81` with SSL forced.
2. Verify `https://your-domain` serves the admin UI.
3. Firewall port **81** to localhost (e.g. `ufw deny 81`) — administer via 443.

The same works for wildcard/DNS-01 certs: create the certificate via
**Certificates** (86 DNS providers supported, incl. Cloudflare) and pick it in the
Secure Admin flow or on the proxy host.

## Databases

Defaults to SQLite at `/data/database.sqlite`. For MySQL/Postgres set the
`DB_MYSQL_*` / `DB_POSTGRES_*` environment variables (see `backend/lib/config.js`).

## Updating

Pulling the published image (normal path):

```bash
cd /opt/comphost && docker compose pull && docker compose up -d
```

Building from source instead:

```bash
git pull
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

Migrations run automatically on boot.
