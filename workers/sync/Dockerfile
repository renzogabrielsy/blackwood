# Blackwood sync worker — multi-stage build.
# Stage 1 (builder): install ALL deps, bundle src -> dist/index.js with esbuild.
# Stage 2 (runtime): copy dist + PRODUCTION node_modules only (runtime deps are kept
# external from the bundle because DBOS/exceljs/imapflow/mailparser have native or
# dynamic-require bits that don't survive bundling). Small final image on node:20-slim.

# ---- builder ----------------------------------------------------------------
FROM node:20-slim AS builder
WORKDIR /app

# Install deps against the lockfile for reproducibility.
COPY package.json package-lock.json* ./
RUN npm ci

# Build the bundle.
COPY tsconfig.json esbuild.config.mjs ./
COPY src ./src
RUN npm run build

# Prune to production deps for the runtime stage.
RUN npm ci --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Non-root user.
RUN useradd -r -u 10001 -m worker

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

USER worker

# Fly maps the internal service to this port (see fly.toml). The worker also opens
# the kick endpoint here.
ENV PORT=8080
EXPOSE 8080

# Healthcheck hits GET /health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||8080) +'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
