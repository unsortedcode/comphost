# Migrating from Nginx Proxy Manager

CompHost *is* Nginx Proxy Manager with extra tables and columns, so an upgrade is
mostly "point it at the same volumes". Your proxy hosts, redirections, 404 hosts,
streams, certificates, access lists, users and permissions all come across, and
your existing logins keep working.

**Verified:** a stock `jc21/nginx-proxy-manager:latest` (2.15.1) instance with an
access list (two users + a CIDR rule), three proxy hosts — one behind that access
list — a 404 host and a second user was migrated to CompHost. Migrations applied
cleanly, the admin logged in with the original password, the protected host still
answered `401` without credentials, and the 404 host still answered `404`.

---

## Before you start

- **Back up.** `docker compose down`, then copy the whole `data/` and
  `letsencrypt/` directories somewhere else. This is the rollback.
- **Note your NPM version.** Anything from the 2.x line migrates — CompHost
  inherits upstream's full migration chain, so older databases step forward
  through every intermediate migration.
- **The upgrade is one-way.** CompHost's migrations add tables (`stack`,
  `comphost_setting`, `backup_target`, `registry_credential`) and columns
  (`proxy_host.stack_id`, `stream.stack_id`, `user_permission.stacks`). Going
  back to stock NPM means restoring your backup — stock NPM won't remove them,
  but it also won't know about them.

---

## The trap: bring the whole `/data` volume

Host configs are written to `/data/nginx/` when a host is saved. They are **not**
derived from the database at boot. If you copy only `database.sqlite`, every host
appears in the UI while nginx serves none of them — which looks like data loss
but isn't.

CompHost now regenerates any *missing* config at startup (existing files are
never overwritten), so a database-only migration recovers by itself. Even so:
**copy the whole `/data` volume**, because it also holds your certificates'
private keys, the htpasswd files for access lists, custom snippets, and
`keys.json` — which is what your session tokens are signed with.

---

## Docker → Docker

1. Stop the old stack:
   ```bash
   docker compose down
   ```

2. Swap the image and add the two new mounts. Everything else stays:

   ```diff
    services:
   -  app:
   -    image: 'docker.io/jc21/nginx-proxy-manager:latest'
   +  comphost:
   +    image: 'ghcr.io/unsortedcode/comphost:latest'
        restart: unless-stopped
        ports:
          - '80:80'
          - '81:81'
          - '443:443'
        volumes:
          - ./data:/data
          - ./letsencrypt:/etc/letsencrypt
   +      - /var/run/docker.sock:/var/run/docker.sock
   +      - /opt/stacks:/opt/stacks
   +    environment:
   +      COMPHOST_STACKS_DIR: /opt/stacks
   ```

   `/opt/stacks` **must be the same path on both sides** — see below.

3. Create the stacks directory with the right ownership (defaults are `1000:1000`
   unless you set `PUID`/`PGID`):
   ```bash
   sudo mkdir -p /opt/stacks && sudo chown 1000:1000 /opt/stacks
   ```

4. Start, and watch the migrations run:
   ```bash
   docker compose up -d && docker compose logs -f
   ```
   You should see `[Migrate] … Migrating Up` for each CompHost migration, then
   the usual startup. Log in with your existing credentials and confirm your
   hosts are listed and still serving.

## MySQL / MariaDB or Postgres

No difference in procedure — the same additive migrations run against your
existing database. Take a `mysqldump`/`pg_dump` first anyway.

---

## Why the stacks path must match on both sides

CompHost runs `docker compose` against the **host's** Docker daemon via the
mounted socket. When a stack's compose file says `./config:/config`, the daemon
resolves `./config` on the *host* filesystem, not inside the CompHost container.
If CompHost writes stacks to `/opt/stacks` internally but that's `/srv/data` on
the host, every relative bind mount in every stack silently points at the wrong
place — usually creating empty directories rather than failing loudly.

Mounting `/opt/stacks:/opt/stacks` makes the two views identical, which is why
it's a hard requirement rather than a convention.

---

## After the upgrade

Your existing hosts keep working untouched. To start using the new half:

- **Adopt what's already running.** Stacks → *Adopt existing*. The **Detected**
  tab lists compose projects the Docker daemon knows about; the **Browse** tab
  walks the filesystem so you can adopt projects that are currently stopped
  (those never appear in `docker compose ls`). Adoption registers a project *in
  place* — no files are moved, nothing is restarted.

- **Existing proxy hosts are not linked to adopted stacks.** They keep working
  exactly as before, still pointing at whatever IP and port you configured. They
  just won't show in the stack's "Exposed as" column, because nothing associates
  them yet. If you want that link — and the automatic re-attachment after
  redeploys that comes with it — re-expose the service from the stack and remove
  the old host.

- **Set up a backup target** (Settings → Backup) before you need one.

- **Add your Cloudflare token** (Settings → Cloudflare) if you want DNS records
  created when you add a host.

---

## Rolling back

```bash
docker compose down
rm -rf data letsencrypt
cp -a data.backup data && cp -a letsencrypt.backup letsencrypt
# restore the old image in docker-compose.yml
docker compose up -d
```

The extra tables in a CompHost-migrated database are inert under stock NPM, so
in practice pointing the old image at the migrated data usually works too — but
restoring the backup is the supported path.
