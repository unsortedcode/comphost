#!/command/with-contenv bash
# shellcheck shell=bash
# CompHost: ensure the docker-compose stacks directory exists and is owned by the
# app user (PUID:PGID), so the backend (which runs setuidgid) can create stacks.
# Runs as root during prepare, before services start.

set -e

STACKS_DIR="${COMPHOST_STACKS_DIR:-/opt/stacks}"

log_info "Preparing stacks directory: ${STACKS_DIR} ..."

mkdir -p "$STACKS_DIR"

have="$(stat -c '%u:%g' "$STACKS_DIR")"
if [ "$have" != "$PUID:$PGID" ]; then
	# Only chown the directory itself (not -R): stack subdirs may contain large
	# bind-mounted volume data we must not recursively re-own.
	chown "$PUID:$PGID" "$STACKS_DIR"
fi

# Grant the app group access to the Docker socket (when mounted). The backend runs
# via s6-setuidgid PUID:PGID with NO supplementary groups, so the socket's *group*
# must be PGID for `docker compose` to work. This is what makes CompHost able to
# manage stacks. (Security note: socket access ~= host root;
# a docker-socket-proxy is the hardening path.)
DOCKER_SOCK="${DOCKER_SOCK:-/var/run/docker.sock}"
if [ -S "$DOCKER_SOCK" ]; then
	sock_grp="$(stat -c '%g' "$DOCKER_SOCK")"
	if [ "$sock_grp" != "$PGID" ]; then
		log_info "Granting app group ($PGID) access to ${DOCKER_SOCK} ..."
		chgrp "$PGID" "$DOCKER_SOCK" 2>/dev/null || log_info "  (could not chgrp docker.sock; stack management may be unavailable)"
		chmod g+rw "$DOCKER_SOCK" 2>/dev/null || true
	fi
else
	log_info "No Docker socket at ${DOCKER_SOCK}; stack management will be unavailable until mounted."
fi
