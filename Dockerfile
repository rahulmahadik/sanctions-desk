# syntax=docker/dockerfile:1

ARG NODE_VERSION=26

# ---- dependencies: production packages only, installed from the lockfile ----
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/payments-api/package.json apps/payments-api/
COPY packages/shared/package.json packages/shared/
COPY packages/data/package.json packages/data/
COPY packages/zetaris/package.json packages/zetaris/
COPY packages/agents/package.json packages/agents/
RUN npm ci --omit=dev --ignore-scripts

# ---- runtime: everything both services need ----
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
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
