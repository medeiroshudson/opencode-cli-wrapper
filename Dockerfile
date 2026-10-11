# syntax=docker/dockerfile:1

# --- deps -----------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- build ----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime --------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Install the OpenCode CLI, pinned to the version validated by the spikes (docs/plan.md §3).
# NOTE(P8): verify this install path resolves on Alpine/musl before shipping.
ARG OPENCODE_VERSION=1.18.31
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" && command -v opencode

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

ENV OPENCODE_BIN=opencode \
    PORT=3000 \
    HOST=0.0.0.0

EXPOSE 3000

# /health requires the Bearer token like every other route, so the probe must send
# it — without the header the check always 401s and the container reads unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health',{headers:{Authorization:'Bearer '+process.env.API_KEY}}).then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "dist/server.js"]
