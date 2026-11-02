# FlowDesk

Crypto Open Interest & Volume Intelligence Platform tracking perpetual futures across Binance, Bybit, OKX, and Hyperliquid.

## Architecture

- **Collector**: Connects to all 4 venues (REST + WebSocket), normalizes data, writes to database
- **Engine**: Computes rolling metrics every 5s, evaluates alerts
- **API**: Express REST + WebSocket gateway
- **Web**: React + TypeScript + Vite frontend

## Quick Start

```bash
cp .env.example .env
docker compose up -d
```

- Web UI: http://localhost:3000
- API: http://localhost:8000
- API Docs: http://localhost:8000/docs

## Run Locally

**Prerequisites:** Node.js 20+, Docker

```bash
npm install
cp .env.example .env      # then set required env vars
npm run dev               # http://localhost:3000
```

Or run with Docker Compose (includes postgres, redis, collector, engine, API, web, caddy):

```bash
docker compose up -d
```

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Express + Vite HMR middleware on one port |
| `npm run build` | Vite bundle to `dist/`, esbuild server to `dist/server.cjs` |
| `npm start` | Run the production bundle (`NODE_ENV=production` required to serve `dist/`) |
| `npm run lint` | `tsc --noEmit` |
| `npm run clean` | Remove dist and server.js |

## Symbol Coverage

The ticker catalog is pulled live from Binance rather than hardcoded, so newly listed instruments are reachable without a code change:

- **Spot** — all `TRADING` USDT pairs with `isSpotTradingAllowed`.
- **Futures** — USD-margined `PERPETUAL` contracts that have no spot equivalent, pulled from `fapi`. Dated contracts are excluded because they expire.
- Merged into one list (spot wins on overlap), cached 5 minutes server-side and mirrored to `localStorage` for instant paint.
- The **ADD BINANCE CUSTOM TICKER** input accepts free-form text (`ldo`, `LDO`, `LDOUSDT`, `sol/usdt`). Unmatched input is verified against the live tape via `/api/symbol-lookup`, so a pair listed minutes ago still works. Arrow keys navigate, `Enter` accepts, `Escape` dismisses.
- The sidebar **SEARCH COIN DESK** box also falls through to the live catalog, so a new listing is findable without adding it first.
- `SYNC` (sidebar) and `RE-SYNC CATALOG` force-refresh past the TTL.

When a selected asset has less history than the requested window, the server probes its first available bar and **clamps the window to what actually exists** rather than erroring out. `asOf.historyClamped` reports when this happened, and `asOf.coverage` always carries the real first/last bar times. Below 5 overlapping bars the request fails with a `422` naming the listing date instead of a generic "insufficient data" message.

## Deployment to Railway VPS

### Option 1: Railway CLI

```bash
# 1. Install Railway CLI
npm install -g railway

# 2. Login and init
railway login
railway init

# 3. Set environment variables in Railway dashboard or .env
#    - DATABASE_URL
#    - REDIS_URL
#    - API_HOST, API_PORT, API_SECRET_KEY
#    - COLLECTOR_ENABLED_VENUES, etc.
#    - GEMINI_API_KEY (optional, for /api/report)

# 4. Deploy
railway up
```

### Option 2: Docker (standalone)

```bash
docker build -t crypto-quant-terminal .
docker run -p 8080:8080 -p 8000:8000 \\
  -e NODE_ENV=production \\
  -e PORT=8080 \\
  -e DATABASE_URL="postgresql+asyncpg://flowdesk:flowdesk@postgres:5432/flowdesk" \\
  -e REDIS_URL="redis://redis:6379/0" \\
  -e API_HOST=0.0.0.0 \\
  -e API_PORT=8000 \\
  -e API_SECRET_KEY=change-me-in-production \\
  -e COLLECTOR_ENABLED_VENUES=binance,bybit,okx,hyperliquid \\
  -e COLLECTOR_OI_POLL_INTERVAL=15 \\
  -e COLLECTOR_KLINE_POLL_INTERVAL=60 \\
  -e COLLECTOR_BACKFILL_HOURS=36 \\
  -e ENGINE_COMPUTE_INTERVAL=5 \\
  -e ENGINE_ALERT_EVAL_INTERVAL=5 \\
  -e BINANCE_RATE_LIMIT=1200 \\
  -e BYBIT_RATE_LIMIT=120 \\
  -e OKX_RATE_LIMIT=120 \\
  -e HYPERLIQUID_RATE_LIMIT=120 \\
  -e ALERT_DEFAULT_COOLDOWN_S=900 \\
  -e ALERT_MIN_PRIOR_VOL_5M=50000 \\
  -e ALERT_MIN_24H_VOL=1000000 \\
  -e LOG_LEVEL=INFO \\
  -v liq_data:/data \\
  --restart unless-stopped \
  crypto-quant-terminal
```

### Option 3: Docker Compose (full stack)

```bash
docker compose up -d
```

This starts all services: postgres, redis, collector, engine, API, web (nginx), and caddy reverse proxy.

## Health Check

- `GET /healthz` - liveness probe (does not depend on upstream services)

## Deployment Notes

- The server binds `0.0.0.0` and honours `$PORT`. Railway injects `8080`; a hardcoded port is the usual reason a container fails to start.
- `GET /healthz` is the liveness probe. It intentionally does not call Binance, so an upstream outage does not get the instance recycled.
- `SIGTERM` drains in-flight requests for up to 10s before forcing exit.
- The **liquidation tape persists across deploys**. The image writes it to the `/data` volume (never `/tmp`), and Railway provides a managed persistent disk mounted at `/data`. Boot replays the retention window so the gainers/losers baseline is not reset to zero on a new revision.
- Set `_MIN_INSTANCES=1` to keep the symbol catalog warm; at `0` each cold start re-fetches it from both venues.
- Every upstream request is to a public, unauthenticated Binance endpoint. The app is a read-only analytics client; it never places orders.
- The **Code Lab** tab runs CPython in the browser via Pyodide (WebAssembly), fetched from `cdn.jsdelivr.net`. The image contains no Python, so the tab adds no CPU, memory or image size to the service; the only server cost is `GET /api/code-series`. Users behind a proxy that blocks jsDelivr will not be able to boot the interpreter.

## Architecture

```
server.ts                 Express API + static/Vite serving, single process
src/utils/catalog.ts      ticker normalization, ranked matching, resolveTicker
src/utils/useSymbolCatalog.ts  shared live-catalog hook (TTL + localStorage)
src/utils/quant_calculations.ts Pearson, OLS, lead-lag, rolling corr, z-scores
src/utils/terminal_calculations.ts  terminal analytics engine (see below)
src/utils/pyodide.ts         browser CPython kernel (lazy, CDN-loaded)
src/components/           hand-rolled SVG charts; no chart library
```