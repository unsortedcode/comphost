# CompHost

**A fork of [Nginx Proxy Manager](https://github.com/NginxProxyManager/nginx-proxy-manager)
where a proxy host can *be* a Docker Compose stack.**

Nginx Proxy Manager gives you a beautiful UI for routing traffic to things that
already exist. CompHost adds the other half: create the thing, from the same UI.
Paste a compose file, deploy it, and publish it on a domain with a Let's Encrypt
certificate — without touching a terminal.

> Not affiliated with jc21 or the Nginx Proxy Manager project. Please report
> issues here, not upstream.

---

## What this adds to Nginx Proxy Manager

Everything upstream does — proxy hosts, redirections, 404 hosts, streams, access
lists, certificates with 80+ DNS providers, multi-user RBAC — works unchanged.
On top of that:

### Stacks are first-class

- **Compose editor in the UI** with validation on save: a bad file is rejected
  with the parser's own message, not at deploy time.
- **Lifecycle actions** — deploy, restart, stop, down, update — each streaming
  live `docker compose` output into the UI rather than a blind spinner.
- **Logs**: `compose logs -f` streamed to a terminal in the browser.
- **Console**: an interactive shell into any service (`compose exec`).
- **`docker run` → compose** converter for pasting commands from a README.
- **Per-stack `.env` editor** that reads the variables your compose file actually
  references, shows their inline defaults, and flags the ones you haven't set.
- **Adopt existing projects** in place — including stopped ones, via a directory
  browser. Nothing is moved, so relative bind mounts keep working.

### One-click publishing

Pick a service and a domain. CompHost attaches the container to a shared Docker
network with a DNS alias, points nginx at `alias:port`, and optionally in the
same step: requests a Let's Encrypt certificate, creates the Cloudflare DNS
record, and puts HTTP basic auth in front. Exposures survive redeploys.

Non-HTTP services (game servers, databases) get the same treatment as TCP/UDP
stream hosts.

### Operations

- **Image update checking** — compares local image digests against the registry
  and badges stacks that have updates.
- **Backups** — config backup (database, keys, nginx configs, per-stack
  compose/.env) plus per-volume and per-bind-mount backups to S3 (rclone) or SSH
  (rsync), with real cron scheduling. Volumes are found by compose label, so a
  *stopped* stack still backs up. SSH targets get a generated keypair and a
  connection test.
- **Private registry logins** managed in the UI and shared with stack pulls.
- **Cloudflare integration** — accepts either an API Token or a legacy Global API
  Key and works out which you pasted.
- **Audit log filters** by object, event, stack and domain.
- **Self-hosting** — CompHost can request a certificate for its own admin panel
  and serve it over HTTPS.

### Fixes that came out of building this

Some are upstream behaviours worth knowing about:

- **Certificate failures used to surface as "Internal Error."** certbot's real
  reason (challenge blocked by a CDN, NXDOMAIN, rate limit, bad account email)
  is now extracted and shown.
- **DNS is checked before a certificate is requested.** Asking a CA to validate a
  name that doesn't resolve can't succeed, and the failed lookup gets cached on
  *their* side — so the retry fails too. CompHost refuses early, and after
  creating a DNS record it waits for the authoritative nameservers to answer
  before continuing.
- **Missing nginx configs are rebuilt at boot.** Host configs are written on
  save, not derived from the database, so an instance started against an existing
  database without its `/data/nginx` directory used to list every host in the UI
  while serving none of them.

---

## Quick start

```bash
git clone https://github.com/unsortedcode/comphost.git && cd comphost
cp .env.example .env      # set the admin password and stacks directory
docker compose up -d
```

Or without a checkout — copy `docker-compose.yml` and `.env.example` onto the
host, edit the `.env`, and `docker compose up -d`. The image is pulled; nothing
is built.

Then open `http://<host>:81` and create the first admin account.

There is also a guided installer for Ubuntu that installs Docker, prompts for the
admin account, domain and stacks directory, and waits for readiness — see
[INSTALL.md](comphost-docs/INSTALL.md).

### Two rules that matter

1. **Mount the stacks directory at the same path on both sides**
   (`/opt/stacks:/opt/stacks`). Compose talks to the host's Docker daemon, so any
   relative bind mount inside a stack is resolved by the host, not the container.
   A mismatched path breaks volumes in ways that are hard to diagnose.
2. **The Docker socket is root-equivalent.** Anyone who can manage a stack can
   run any container on the host. Treat admin accounts accordingly. The
   `docker-socket-proxy` overlay narrows what the socket exposes.

---

## Upgrading from Nginx Proxy Manager

Your data comes across as-is — CompHost *is* NPM, plus migrations that only add
tables and columns. Point it at your existing `/data` and `/etc/letsencrypt`
volumes and your proxy hosts, certificates, access lists and users are all
there, with the same logins.

See [MIGRATING-FROM-NPM.md](comphost-docs/MIGRATING-FROM-NPM.md) for the
step-by-step, including the one trap worth knowing about (bring the whole `/data`
volume, not just the database).

---

## Documentation

| | |
|---|---|
| [FEATURES.md](comphost-docs/FEATURES.md) | Everything CompHost adds, grouped by area |
| [INSTALL.md](comphost-docs/INSTALL.md) | Installing on Docker or Ubuntu |
| [MIGRATING-FROM-NPM.md](comphost-docs/MIGRATING-FROM-NPM.md) | Upgrading an existing NPM box |

---

## Known limitations

- **Docker is required.** There is no bare-metal install; upstream's runtime is
  container-coupled (hardcoded `/data`, a custom nginx build, s6, a certbot venv).
- **Single host.** No multi-node support yet.
- **Stored credentials are encoded, not encrypted.** Cloudflare tokens, registry
  logins and generated SSH keys live in the database in the clear (masked in API
  responses). Same posture as upstream.
- **amd64 only so far.** The Dockerfile is architecture-aware but arm64 hasn't
  been built.
- **Based on upstream `develop`**, not a stable tag — because the stable 2.9.x
  line is the previous UI. Upstream may move under us.

Everything that *is* built is listed in [FEATURES.md](comphost-docs/FEATURES.md).

---

## Credits

This is a fork of **[Nginx Proxy Manager](https://github.com/NginxProxyManager/nginx-proxy-manager)**
by [jc21](https://github.com/jc21) and its contributors, which is the entire
foundation here — the nginx templating, certbot integration, database layer, RBAC
and UI are all theirs. If this is useful to you, consider
[buying jc21 a coffee](https://www.buymeacoffee.com/jc21).

The compose orchestration logic was ported from
**[Dockge](https://github.com/louislam/dockge)** by [louislam](https://github.com/louislam)
(MIT) — the status model, port parsing and `docker compose` handling started
there before being converted to this codebase's conventions.

Licensed under the [MIT License](LICENSE), as is upstream.
