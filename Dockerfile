# syntax=docker/dockerfile:1.7

###############################################################################
# Stage 1 — build TypeScript to dist/                                         #
###############################################################################
FROM node:22-bookworm-slim AS builder
ENV CI=1
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

###############################################################################
# Stage 2 — runtime with production dependencies only                         #
###############################################################################
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=builder /app/dist ./dist
# The public page. MapLibre is served straight out of node_modules, which the
# production install above already contains.
COPY public ./public

# Somewhere to keep the cached copy of the repaircafe.org directory, which is
# what turns a cafe's slug into a pin on the map.
RUN mkdir -p /data && chown node:node /data

# Never run the collector as root.
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/health || exit 1

CMD ["node", "dist/index.js"]
