# ---- deps: install dependencies (with build tools for native modules) ----
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: compile TypeScript ----
FROM deps AS build
WORKDIR /app
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

# ---- runtime: minimal final image ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs expressjs
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /app/data && chown -R expressjs:nodejs /app
USER expressjs
EXPOSE 3001

# node is the only HTTP-capable binary in this image: node:20-bookworm-slim
# ships neither wget nor curl (both are Alpine/full-Debian conveniences), so
# a wget- or curl-based check fails to execute at all and Docker reports the
# container unhealthy no matter how healthy the app is. Node 20 has a global
# fetch, so the check needs no dependencies beyond the runtime itself.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then(r => \
  process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
