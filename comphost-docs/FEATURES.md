# Features

Everything CompHost does today, grouped by area. Upstream Nginx Proxy Manager
features (proxy hosts, redirections, 404 hosts, streams, access lists,
certificates with 80+ DNS providers, multi-user RBAC, audit log) all work
unchanged and aren't repeated here — this is what the fork adds or fixes.

---

## Domains

- **One list of everything served.** Proxy, redirection and 404 hosts, one row
  per domain, plus stream ports. Each row shows its type, where it goes (stack ▸
  service for hosts that belong to a stack), its SSL state with days left, and
  whether nginx is actually serving it. Upstream's four separate host pages are
  gone; their old URLs open the matching filtered view.
- **Filters** for type, SSL state, stack and "needs attention" (expiring or
  expired certificate, nginx rejected the config, drift, an unlinked stack
  target). They live in the URL, so the dashboard and stack pages link straight
  to a view.
- **From a row**: edit the host, open its stack, enable/disable or delete it.
  The Add menu covers every host type, plus exposing a stack service.
- **Linking existing hosts to stacks.** A host set up before its stack was
  adopted (typically targeting a container name or IP) gets a link suggestion
  when its target matches exactly one stack service. Linking records the
  association only: the host's target and nginx config stay as they are.
- **Stack pages**: each stack has a page with its status, actions, services,
  drift findings and the domains it serves.
- **Permissions**: each host type is filtered by its own permission, so a user
  sees exactly the hosts they could see before. A denied permission check now
  returns 403; it used to fall through to a 404 (an upstream bug).

---

## Stacks

**Managing compose files**
- Stacks list with live status, YAML editor, create / edit / delete.
- Compose validated on save — create and update run `compose config -q`, so a bad
  file is rejected with the parser's own message and rolled back rather than
  failing later at deploy time.
- `docker run` → compose import (composerize), for pasting commands out of a
  project's README.
- Per-stack `.env` editor that reads the variables the compose file actually
  references (`${VAR}`, `${VAR:-default}`), shows each inline default, and flags
  the ones missing from `.env`. Names and values are validated server-side (no
  line breaks, valid env-var names) so a bad entry can't corrupt the file.

**Lifecycle**
- Deploy / restart / stop / down / update, each streaming live `docker compose`
  output into a modal with a spinner and the exit status — not a blind wait.
- Logs: `compose logs -f` streamed as SSE into an xterm view.
- Console: interactive `compose exec` terminal over WebSocket (node-pty).

**Status**
- Status is parsed from per-container counts, with a **Partial** state for "some
  services up, some not" — a one-shot init container that exits 0 by design no
  longer makes a healthy stack read as Exited. The badge tooltip shows compose's
  own wording.
- Per-stack **ignore list**: exclude named services (init/migration containers)
  from the status calculation entirely.
- Adopted stacks resolve status via their compose file path, not just their name
  — compose derives the project name from the directory, which needn't match the
  name a stack was adopted under.

**Drift watch**
- Every two minutes, and a few seconds after any relevant docker event, each
  stack is checked against what CompHost set up.
- A service behind a host that dropped off the `comphost` network or lost its
  alias (e.g. `docker compose up` run on the box recreated it) is **re-attached
  automatically**.
- Reported, not changed: the compose file edited outside CompHost (with an
  Accept action that makes the current file the new baseline), a missing compose
  file, a service behind an enabled host that isn't running, and a host whose
  target IP the service no longer has. Aliases on `comphost` that no host uses
  are listed for information.
- Findings show on the affected Domains rows, as a badge in the Stacks list and
  on the stack page; each is written to the audit log once, each repair
  separately. Stacks without a baseline (anything from before 0.10) get one on
  the first scan, so upgrading raises no false alarms.

**Adoption**
- Discover compose projects already running on the host and adopt them *in place*
  (`compose_dir`), so an existing box migrates without moving files or disturbing
  running containers.
- Browse tab: walk the directories CompHost can see and adopt a project that is
  currently **down** — those never appear in `docker compose ls`. Directory names
  only, never file contents, gated on `stacks:create`; already-managed
  directories are marked, the stack name is suggested from the folder, and the
  compose file may live outside the stacks directory.

---

## Publishing services

- **Auto-expose** — attach a service to the shared `comphost` network with a DNS
  alias and create a proxy host targeting `alias:port`. Optionally in one step:
  request a Let's Encrypt certificate, create the Cloudflare DNS record, and put
  HTTP basic auth in front. Re-attaches automatically after redeploys.
- **Port and alias discovery** from compose `ports`/`expose`, falling back to the
  image's own exposed ports. Aliases declared in the user's compose file win over
  generated ones and are preserved.
- **TCP/UDP exposure** — publish a non-HTTP service (game server, database) as an
  nginx stream host over the same alias mechanism, with ports pre-filled from the
  container's exposed ports.
- **"Exposed as" column** — proxy domains (with a lock icon when SSL is on) and
  stream ports listed inline per stack, linking to the stack's Domains view.
- **Cascade cleanup** — deleting a stack removes the proxy hosts *and* stream
  hosts CompHost created for it. Adopted stacks keep their directory.

---

## Mail relay

- Hosted services send mail to **`smtp`, port 25 or 587**, on the `comphost`
  network, with no login and no TLS. Nothing is published on the host.
- CompHost picks one of the configured **upstream servers by sender address**:
  an exact address, then `@domain`, then `*`. A sender with no route is refused
  with a 550, so the app sees a real error.
- **Send as**: a route can replace the sender with the address the upstream
  accepts. The original sender goes into `Reply-To` (an existing one can be
  kept) and `X-Original-From`. Only the headers change; the body passes through
  byte for byte.
- **Pass-through**: a message is accepted only once the upstream accepted it,
  and the upstream's error is relayed otherwise. Nothing is queued or stored.
- Settings → Mail relay: upstream servers with a connection test, routes, a
  test message, and the last 50 deliveries.
- Only the `comphost` subnet is admitted. New installs get the `smtp` alias from
  `docker-compose.yml`; running installs get it at startup, unless another
  container already answers to `smtp`. Stream hosts on 25/587 and the relay
  refuse each other.

---

## DNS and certificates

- **Cloudflare integration** — accepts an API Token *or* a legacy Global API Key
  and works out which was pasted, instead of making the user declare it.
  Validated on save with the actual error surfaced.
- **DNS records on host creation** — proxy, 404 and redirection hosts can create
  their Cloudflare A record when saved. Existing records are never repointed; the
  form warns before saving if the name already resolves elsewhere, or isn't in a
  zone the token can see.
- **Grey-clouded during issuance** — a proxied record makes Cloudflare answer the
  ACME challenge instead of us, so the record is created unproxied while a
  certificate is being issued.
- **Propagation wait** — after creating a record, CompHost polls the zone's
  authoritative nameservers (bypassing local negative caching) before requesting
  a certificate. If the CA's first lookup misses, that NXDOMAIN is cached on
  *their* side and the retry fails too, so this is done up front.
- **DNS-01 with the saved token** — a Cloudflare DNS-challenge certificate
  uses the token from Settings → Cloudflare unless it is given credentials of
  its own. Nothing is copied into the certificate: the credentials file is
  rebuilt before every issue and renewal, so rotating the token in Settings
  covers every such certificate. Auto-expose can request its certificate this
  way too, so a service can get HTTPS on a box whose port 80 isn't reachable.
- **DNS pre-flight** — refuses to spend a Let's Encrypt attempt on a name that
  doesn't resolve at all, with a message that names the fix. Skipped for DNS-01
  and wildcards.
- **Real certbot errors** — certbot fails with a non-public `CommandError`, so
  the API used to replace the reason with "Internal Error". The actual cause
  (challenge blocked by a CDN, NXDOMAIN, rate limit, bad account email) is now
  extracted from both stdout and stderr and returned.

---

## Backups

- **Config backup** — one-click zip of the database, keys, nginx configs and each
  stack's compose file and `.env`.
- **Volume backups** — named volumes *and* bind mounts, with a per-mount choice
  of target and method (tar snapshot vs rsync). Volumes are located by compose
  project label, so a **stopped** stack still backs up.
- **Backup targets** — S3 (rclone) and SSH (rsync), with generated ed25519
  keypairs (the public key is shown for installing on the remote host) and a
  Test button that really connects.
- **Cron scheduling** — real cron expressions, validated on save, on a one-minute
  tick.

---

## Operations

- **Image update checking** — compares local image digests against the registry
  and badges stacks that have updates. The count is cached on the row so the list
  doesn't make a per-stack registry round trip; a modal shows per-service local
  vs registry digests with a re-check button.
- **Private registry logins** — validated via `docker login` and persisted to a
  shared `DOCKER_CONFIG`, so stack pulls and update checks authenticate.
- **Audit log** — stack lifecycle, expose, backup, shell and log-view events with
  proper labels and icons, plus filters by object type, event, stack and domain.
  Filter dropdowns are populated from values actually present in the log.
- **Missing nginx configs rebuilt at boot** — host configs are written on save,
  not derived from the database, so an instance started against an existing
  database without its `/data/nginx` directory used to list every host in the UI
  while serving none of them. Only missing files are written; existing ones are
  never overwritten.

---

## Deployment and security

- **Production image** — self-building (the frontend is compiled in-image), with
  the Docker CLI, compose, rclone, rsync and ssh included.
- **CI** — builds and publishes to the container registry on every push to
  `develop` (`:latest` + `:<sha>`) and on version tags (`:vX.Y.Z`).
- **Registry deploy** — a build-free compose file plus `install-registry.sh`,
  which installs Docker on Ubuntu or Debian, asks for every setting (current
  values offered when re-run), writes `.env`, pulls and starts CompHost.
  `COMPHOST_ADMIN_PORT=127.0.0.1:81` keeps the admin UI off the network.
- **Guided Ubuntu installer** — installs Docker, prompts for the admin account,
  domain and stacks directory, writes `.env`, builds or pulls, waits for
  readiness, and optionally configures ufw.
- **Secure Admin Panel** — request a certificate for the admin UI itself and
  serve it over HTTPS.
- **docker-socket-proxy overlay** — optional hardening so the raw Docker socket
  isn't mounted.
- **RBAC** — a `stacks` permission section wired into upstream's existing model.
- **Cookie sessions** — the admin UI's token lives in an `HttpOnly` cookie rather
  than `localStorage`, so script on the origin can't read it. Cookie-authenticated
  writes carry a double-submit CSRF token. `Authorization: Bearer` is unchanged
  for API clients.
- **Hardened admin surface** — CSP and security headers on the admin interface
  only, login rate limiting, single-use tickets for the terminal WebSocket
  instead of a token in the URL, and TOTP QR codes generated in the browser.
