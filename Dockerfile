# syntax=docker/dockerfile:1

# WebSaco backend (NestJS) — the single production image of the unified
# Finanzas + Administración service (the only Dockerfile of the product).
# Multi-stage: compile with full deps, ship only prod deps + dist as non-root.
# Runtime configuration (APP_ROLE, SENTRY_DSN, NODE_OPTIONS, secrets...) comes
# from the Cloud Run service, never from the image: see
# docs/runbooks/despliegue-fusion.md for the full variable list.

# Exact Node patch, matching local dev — a floating "node:22-alpine" tag can
# silently resolve to an older patch bundling an older npm than the one that
# wrote package-lock.json, which makes `npm ci` reject valid transitive
# entries as "Missing from lock file". Bump this alongside the local Node
# version (nvm) in the same commit, never independently.
ARG NODE_VERSION=22.22.0

# ---- Builder: install everything and compile TypeScript -> dist/ ----
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app
# node:22-alpine bundles whatever npm shipped with that Node patch (currently
# 10.9.8), independent of the npm used to generate package-lock.json locally.
# npm ci on an older major than the one that wrote the lock can reject valid
# transitive entries as "Missing from lock file" — pin to match.
RUN npm install -g npm@11
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run build

# ---- Deps: a clean production-only node_modules, pruned from the builder's ----
# install instead of a second full `npm ci` (avoids re-fetching every package).
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
RUN npm prune --omit=dev

# ---- Runtime: minimal, non-root ----
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
# V8 old-space ceiling, kept below the container memory so the process fails
# with a V8 heap error (readable in the logs) instead of being OOM-killed with
# no trace. 768 MB is the value Etapa 0.2 measured the 200 MB PDF split with,
# inside the 1 GiB Cloud Run instance. It is a DEFAULT, not a fact about the
# deployed service: override it with the NODE_OPTIONS env var of the Cloud Run
# service whenever its memory limit changes (rule of thumb: ~75% of the limit).
ENV NODE_OPTIONS="--max-old-space-size=768"
WORKDIR /app

# Use the image's built-in unprivileged `node` user.
COPY --chown=node:node package*.json ./
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist

USER node
EXPOSE 3000

# Docker-level probe only (Cloud Run ignores HEALTHCHECK): GET /health pings Mongo
# and Redis and nothing else, on purpose. A restart cannot fix a missing
# per-environment setting, so the readiness check (/health/ready, which also
# validates Comptable and SendGrid settings) is wired as the Cloud Run STARTUP
# probe instead, where a failure keeps the revision out of rotation without
# restarting a healthy instance. See the runbook.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/v1/health >/dev/null 2>&1 || exit 1

CMD ["node", "dist/main"]
