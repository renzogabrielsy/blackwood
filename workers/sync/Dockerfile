# Blackwood sync worker — multi-stage build.
# Stage 1 (builder): install ALL deps, bundle src -> dist/index.js with esbuild.
# Stage 2 (runtime): copy dist + PRODUCTION node_modules only (runtime deps are kept
# external from the bundle because DBOS/exceljs/imapflow/mailparser have native or
# dynamic-require bits that don't survive bundling). Small final image on node:22-slim.
# NOTE: Node 22+ is REQUIRED — @supabase/supabase-js (realtime-js) needs the native
# global WebSocket, which Node 20 lacks (createClient throws on boot otherwise).
#
# ---------------------------------------------------------------------------------
# THE BUILD CONTEXT IS THE REPO ROOT, NOT THIS FOLDER (2026-08-08).
#
# `src/reports/excel/findingsBridge.ts` imports the app's finding flattener with a real
# relative path that leaves the worker package:
#     ../../../../../lib/sync/findings
#     ../../../../../app/(app)/sync/types
# That crossing is deliberate and documented (CLAUDE.md: ONE definition of the finding
# list, shared so the Excel workbook can never disagree with the Sync panel). It also
# means the container MUST contain those files — with a `workers/sync/` context they were
# simply absent, esbuild could not resolve them, and `fly deploy` failed at `npm run
# build` while every local gate stayed green (the local gates read them off the dev disk).
#
# Two consequences, both load-bearing:
#   1. The context is the repo root, and this file is invoked as
#        flyctl deploy . --config workers/sync/fly.toml --dockerfile workers/sync/Dockerfile
#      (or just `npm run deploy` from workers/sync, which spells that out).
#   2. The image MIRRORS the repo layout — WORKDIR is /repo/workers/sync, and the shared
#      files land at /repo/lib/... and /repo/app/(app)/... . Flattening the worker to
#      /app would push `../../../../../lib` above the filesystem root and the relative
#      path could never resolve. The layout IS the contract.
#
# `.dockerignore` at the repo root is deny-all-then-allow, so a root context still ships
# only these files (~1 MB), not the whole monorepo. Keep the two files in step: anything
# added to a COPY below must also be un-ignored there, and `npm run verify:container-build`
# parses BOTH and fails if the resulting file set cannot build.
# ---------------------------------------------------------------------------------

# ---- builder ----------------------------------------------------------------
FROM node:22-slim AS builder
WORKDIR /repo/workers/sync

# Install deps against the lockfile for reproducibility.
COPY workers/sync/package.json workers/sync/package-lock.json* ./
RUN npm ci

# Build inputs.
COPY workers/sync/tsconfig.json workers/sync/esbuild.config.mjs ./
COPY workers/sync/src ./src

# The ONE worker->app crossing, and its COMPLETE transitive closure — FOUR files:
#   lib/sync/findings.ts      imports ./cases-fold + ./portable-hash + app/(app)/sync/types
#   lib/sync/cases-fold.ts    imports app/(app)/sync/types              (nothing else)
#   lib/sync/portable-hash.ts ZERO imports (that is the whole point of it)
#   app/(app)/sync/types.ts   ZERO imports
# If that closure ever grows, this COPY and .dockerignore must grow with it; the
# verify:container-build gate is what makes forgetting that a red build instead of a
# broken deploy — and on 2026-08-19 it did exactly that: `portable-hash.ts` joined the
# closure with the finding-ACK fingerprint and neither this COPY nor .dockerignore
# followed, so the gate was already failing before the BUG-026 work started.
COPY lib/sync/findings.ts lib/sync/cases-fold.ts lib/sync/portable-hash.ts /repo/lib/sync/
COPY ["app/(app)/sync/types.ts", "/repo/app/(app)/sync/"]

# Build identity. Passed in by the deploy wrapper (`--build-arg BUILD_SHA=$(git rev-parse
# --short HEAD)`) because the .git directory is NOT in the context — without this the
# startup banner would read `build unknown` and could not prove which commit is live.
ARG BUILD_SHA=unknown
ENV BUILD_SHA=${BUILD_SHA}

RUN npm run build

# Prune to production deps for the runtime stage.
RUN npm ci --omit=dev

# ---- runtime ----------------------------------------------------------------
# The runtime stage needs NO repo layout: dist/index.js is a single self-contained
# bundle, so the shared app files exist only in the builder.
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Non-root user.
RUN useradd -r -u 10001 -m worker

COPY --from=builder /repo/workers/sync/node_modules ./node_modules
COPY --from=builder /repo/workers/sync/dist ./dist
COPY workers/sync/package.json ./

USER worker

# Fly maps the internal service to this port (see fly.toml). The worker also opens
# the kick endpoint here.
ENV PORT=8080
EXPOSE 8080

# Healthcheck hits GET /health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||8080) +'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
