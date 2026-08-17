# Node.js API image for the Regional Health service.
#
# Multi-stage build:
#   deps    - installs production dependencies. Only stage that needs npm
#             (and any native-module build toolchain it pulls in).
#   runtime - final image. Non-root, minimal apt footprint, digest-pinned
#             base so trivy image scans and reviewers get a reproducible ref.

FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS deps
# node:20-slim

WORKDIR /usr/src/app

COPY package.json ./
RUN npm install --omit=dev


FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runtime
# node:20-slim

# The seed script (run inside this container) needs the mysql CLI.
# ca-certificates is needed for outbound TLS (e.g. AWS Secrets Manager calls
# from secrets.js). No bash: /bin/sh is enough for CMD and node's
# child_process, and dropping it shrinks the image and the attack surface.
RUN apt-get update \
    && apt-get install -y --no-install-recommends default-mysql-client ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Fixed UID/GID non-root user so file ownership is stable across rebuilds.
RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app

WORKDIR /usr/src/app
RUN chown app:app /usr/src/app

COPY --from=deps --chown=app:app /usr/src/app/node_modules ./node_modules

# The rest of the app source. Respects api/.dockerignore, which excludes
# node_modules, the Dockerfile itself, dotfiles, logs, etc.
COPY --chown=app:app . .

# The seed script lives in ../data-seed and is bind-mounted at runtime by
# docker-compose to /usr/local/bin/seed.sh (it is outside this build context,
# so it cannot be COPYed here).

USER app

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/healthz', \
      r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', \
      () => process.exit(1))"

CMD ["node", "server.js"]
