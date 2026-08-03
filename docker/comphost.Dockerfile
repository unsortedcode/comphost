# CompHost production image — SELF-BUILDING (only Docker needed on the host).
# = nginx-proxy-manager production build + the Docker CLI (so the backend can drive
# `docker compose` over a mounted docker.sock) + an in-image frontend build stage
# (so a bare Ubuntu VPS with just Docker can `docker compose up -d --build`).
#
# Build from the repo root:
#   docker build -f docker/comphost.Dockerfile -t comphost:latest .
ARG BASE_IMAGE=nginxproxymanager/nginx-full:certbot-node

# --- Frontend build stage: compile locales + build the React SPA ---------------
# lang/*.json are gitignored (compiled output), so locale-compile must run first.
FROM node:22-bookworm-slim AS frontend-builder
WORKDIR /build
COPY frontend/package.json frontend/yarn.lock ./
RUN yarn install --frozen-lockfile
COPY frontend/ ./
RUN yarn locale-compile && yarn build

FROM nginxproxymanager/testca AS testca
FROM $BASE_IMAGE

ARG TARGETPLATFORM
ARG BUILD_VERSION
ARG BUILD_COMMIT
ARG BUILD_DATE
ARG DOCKER_VERSION=27.3.1
ARG COMPOSE_VERSION=v2.30.3

ENV SUPPRESS_NO_CONFIG_WARNING=1 \
	S6_BEHAVIOUR_IF_STAGE2_FAILS=1 \
	S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0 \
	S6_FIX_ATTRS_HIDDEN=1 \
	S6_KILL_FINISH_MAXTIME=10000 \
	S6_VERBOSITY=1 \
	NODE_ENV=production \
	NPM_BUILD_VERSION="${BUILD_VERSION}" \
	NPM_BUILD_COMMIT="${BUILD_COMMIT}" \
	NPM_BUILD_DATE="${BUILD_DATE}" \
	NODE_OPTIONS="--openssl-legacy-provider" \
	UV_USE_IO_URING=0 \
	DOCKER_CONFIG=/data/.docker

RUN echo "fs.file-max = 65535" > /etc/sysctl.conf \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends jq logrotate curl ca-certificates \
		rsync openssh-client unzip \
	&& apt-get clean \
	&& rm -rf /var/lib/apt/lists/*

# rclone (S3 and many other backends) for volume backups.
RUN curl -fsSL https://rclone.org/install.sh | bash && rclone version | head -1

# Docker CLI + compose plugin (static binaries — no apt repo/codename guesswork).
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
	docker --version; docker compose version

# s6 overlay
COPY docker/scripts/install-s6 /tmp/install-s6
RUN /tmp/install-s6 "${TARGETPLATFORM}" && rm -f /tmp/install-s6

EXPOSE 80 81 443

COPY backend /app
COPY --from=frontend-builder /build/dist /app/frontend
COPY docker/rootfs /

COPY --from=testca /home/step/certs/root_ca.crt /etc/ssl/certs/NginxProxyManager.crt
WORKDIR /etc/ssl/certs
RUN ln -s NginxProxyManager.crt 1d0e3f10.0 && update-ca-certificates

WORKDIR /app
RUN yarn install && yarn cache clean

# Remove the dev-only frontend service + dev nginx config.
RUN rm -rf /etc/s6-overlay/s6-rc.d/user/contents.d/frontend /etc/nginx/conf.d/dev.conf \
	&& chmod 644 /etc/logrotate.d/nginx-proxy-manager

VOLUME [ "/data" ]
ENTRYPOINT [ "/init" ]

LABEL org.label-schema.schema-version="1.0" \
	org.label-schema.license="MIT" \
	org.label-schema.name="comphost" \
	org.label-schema.description="UI-driven reverse proxy manager with docker-compose stack hosting"
