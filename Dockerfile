# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 - build
# Full toolchain (TypeScript, Vite, esbuild) is needed only to produce
# dist/. It is discarded so it never ships in the final image.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Copy manifests first so `npm ci` is cached until dependencies actually change.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Produces dist/index.html + dist/assets (Vite) and dist/server.cjs (esbuild).
# esbuild runs with --packages=external, so the runtime stage must install
# production dependencies itself.
RUN npm run build


# ---------------------------------------------------------------------------
# Stage 2 - runtime
# Production dependencies + the built assets only. No compiler, no dev deps.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# Liquidation collectors run 24/7 in this process and append hourly JSONL to
# LIQ_DATA_DIR, which boot replays back into the store so a restart (deploy,
# OOM-kill, host reboot) does not reset the multi-window baseline to zero.
#
# The tape lives at /data/liq, NOT under /tmp: /tmp is wiped on every container
# replacement, so a redeploy would drop the whole history. /data is declared a
# volume below and, on Cloud Run, is backed by a GCS bucket (see
# cloudbuild.yaml) that survives deploys and instance replacements. When no
# volume is provided the directory still exists in the image; a local
#   docker run -v liq_data:/data ...
# keeps it, and if the path is ever read-only the server falls back to a
# writable temp dir instead of stalling.
#
# The automated scanner (server.ts, /api/auto-scanner) is likewise always on:
# it sweeps the saved universe on every candle close, so it wants a warm
# instance (min-instances=1) and a single writer (max-instances=1). Both its
# config (config.json: symbols + params) and its per-symbol kline cache
# (klines.json) are persisted under the same /data mount via AUTO_SCAN_DIR, so a
# redeploy resumes the universe and appends only new candles instead of
# re-paginating every window; a series that returns no new bars for a closed
# candle is rebuilt from scratch rather than left frozen. Set AUTO_SCAN=0 at
# runtime to boot without the loop.
ENV NODE_ENV=production \
    PORT=8080 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    LIQ_DATA_DIR=/data/liq \
    COINGECKO_DATA_FILE=/data/coingecko.json \
    AUTO_SCAN_DIR=/data/auto-scanner

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Both the static bundle and the server bundle are emitted into dist/.
COPY --from=build /app/dist ./dist

# Persistent data root. Created here so a bare `docker run` (no mount) has a
# writable path, and declared a volume so `docker run -v ...:/data` and the
# Cloud Run GCS mount both land in the same place. Owned by `node` because the
# container runs unprivileged.
RUN mkdir -p /data/liq /data/auto-scanner && chown -R node:node /data

# Run unprivileged. node:slim already ships a `node` user (uid 1000).
USER node

# Cloud Run probes this path; it must not depend on Binance being reachable.
EXPOSE 8080

# Bind 0.0.0.0 and listen on $PORT - Cloud Run only routes to $PORT.
CMD ["node", "dist/server.cjs"]
