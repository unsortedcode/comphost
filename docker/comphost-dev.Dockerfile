# Extends the NPM dev image (comphost-dev:core) with the Docker CLI + compose
# plugin so the backend can drive `docker compose` over the mounted docker.sock.
# Uses the official static binaries (no apt repo / Debian-codename guesswork).
#
# Build order (see docker/comphost-dev.yml which automates it):
#   1) docker build -f docker/dev/Dockerfile -t comphost-dev:core docker/
#   2) this file  ->  comphost-dev:full
FROM comphost-dev:core

ARG DOCKER_VERSION=27.3.1
ARG COMPOSE_VERSION=v2.30.3

# Backup tooling — mirrors the production image so volume backups work in dev too.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends rsync openssh-client \
	&& apt-get clean && rm -rf /var/lib/apt/lists/* \
	&& curl -fsSL https://rclone.org/install.sh | bash \
	&& rclone version | head -1

RUN set -eux; \
	ARCH="$(uname -m)"; \
	curl -fsSL "https://download.docker.com/linux/static/stable/${ARCH}/docker-${DOCKER_VERSION}.tgz" -o /tmp/docker.tgz; \
	tar -xzf /tmp/docker.tgz -C /tmp; \
	install -m 0755 /tmp/docker/docker /usr/local/bin/docker; \
	mkdir -p /usr/local/lib/docker/cli-plugins; \
	curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${ARCH}" \
		-o /usr/local/lib/docker/cli-plugins/docker-compose; \
	chmod +x /usr/local/lib/docker/cli-plugins/docker-compose; \
	rm -rf /tmp/docker.tgz /tmp/docker; \
	docker --version; \
	docker compose version
