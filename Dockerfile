# syntax=docker/dockerfile:1

# WebSaco backend (NestJS) — production image.
# Multi-stage: compile with full deps, ship only prod deps + dist as non-root.

# ---- Builder: install everything and compile TypeScript -> dist/ ----
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run build

# ---- Deps: a clean production-only node_modules, pruned from the builder's ----
# install instead of a second full `npm ci` (avoids re-fetching every package).
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
RUN npm prune --omit=dev

# ---- Runtime: minimal, non-root ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Use the image's built-in unprivileged `node` user.
COPY --chown=node:node package*.json ./
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist

USER node
EXPOSE 3000

# Liveness/readiness probe against the terminus health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/v1/health >/dev/null 2>&1 || exit 1

CMD ["node", "dist/main"]
