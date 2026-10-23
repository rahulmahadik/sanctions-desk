# syntax=docker/dockerfile:1

ARG NODE_VERSION=26

# ---- dependencies: production packages only, installed from the lockfile ----
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/payments-api/package.json apps/payments-api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/data/package.json packages/data/
COPY packages/zetaris/package.json packages/zetaris/
COPY packages/engines/package.json packages/engines/
COPY packages/agents/package.json packages/agents/
RUN npm ci --omit=dev --ignore-scripts

# ---- runtime: everything both services need ----
FROM node:${NODE_VERSION}-alpine AS runtime
# Inside a container the API must listen on every interface to be reachable through the published port. Outside a
# container the default stays 127.0.0.1. Services on the host are reached at http://host.docker.internal:<port>.
ENV NODE_ENV=production HOST=0.0.0.0
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY config ./config
COPY apps ./apps
COPY packages ./packages
# Sample mode replays these saved answers; the policy and business definitions are in config and the sample.
COPY data/sample/query-cache.json data/sample/business_definition.json ./data/sample/

# The trace folder must be writable by the unprivileged user.
RUN mkdir -p /app/logs && chown -R node:node /app/logs
# The package manager is only needed to install; the running service does not use it. Removing it drops the
# vulnerable copies of its own dependencies that ship with the base image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
USER node

# ---- the payments service: read-only JSON over the synthetic payments ----
FROM runtime AS payments-api
ENV PORT=8100
EXPOSE 8100
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8100)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "apps/payments-api/src/index.ts"]

# ---- the review API (default target) ----
FROM runtime AS api
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "apps/api/src/index.ts"]

# ---- the review desk interface: built once, served by a small self-contained Next.js server ----
FROM node:${NODE_VERSION}-alpine AS web-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/payments-api/package.json apps/payments-api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/data/package.json packages/data/
COPY packages/zetaris/package.json packages/zetaris/
COPY packages/engines/package.json packages/engines/
COPY packages/agents/package.json packages/agents/
RUN npm ci --ignore-scripts
COPY tsconfig.base.json ./
COPY apps/web apps/web
# The browser reaches the API at this address; it is fixed when the interface is built.
ARG NEXT_PUBLIC_API_URL=http://localhost:8000
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @sanctions-desk/web

FROM node:${NODE_VERSION}-alpine AS web
ENV NODE_ENV=production PORT=3001 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=web-build /app/apps/web/.next/standalone ./
COPY --from=web-build /app/apps/web/.next/static ./apps/web/.next/static
# The package manager is only needed to install; the running service does not use it. Removing it drops the
# vulnerable copies of its own dependencies that ship with the base image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
