# syntax=docker/dockerfile:1

ARG NODE_VERSION=26

# ---- dependencies: production packages only, installed from the lockfile ----
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN npm ci --omit=dev --ignore-scripts

# ---- runtime ----
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY config ./config
COPY apps/api ./apps/api
COPY packages/shared ./packages/shared

# The trace folder must be writable by the unprivileged user.
RUN mkdir -p /app/logs && chown -R node:node /app/logs
USER node

EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "apps/api/src/index.ts"]
