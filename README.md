<<<<<<< HEAD
# FlowDesk

Crypto Open Interest & Volume Intelligence Platform tracking perpetual futures across Binance, Bybit, OKX, and Hyperliquid.

## Architecture

- **Collector**: Connects to all 4 venues (REST + WebSocket), normalizes data, writes to database
- **Engine**: Computes rolling metrics every 5s, evaluates alerts
- **API**: FastAPI REST + WebSocket gateway
- **Web**: React + TypeScript + Vite frontend

## Quick Start

```bash
cp .env.example .env
docker compose up -d
```

- Web UI: http://localhost:3000
- API: http://localhost:8000
- API Docs: http://localhost:8000/docs
=======
<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Crypto Quant Correlation Terminal

Cross-asset correlation, beta, lead-lag, and pairs-spread analysis against
Bitcoin, on 1h and 15m timeframes, plus a per-coin **Quant Terminal** for
deeper asymmetry, stability, residual and session work. React 19 + Vite 6 front
end, Express API server, Binance public market data, optional Gemini memo
generation.

View in AI Studio: https://ai.studio/apps/bc2e588e-1688-4833-ad23-3cd797c3df4a

## Run Locally

**Prerequisites:** Node.js 20+

```bash
npm install
cp .env.example .env      # then set GEMINI_API_KEY (optional)
npm run dev               # http://localhost:3000
```

| Script | Purpose |
| --- | --- |
| `npm run dev` | Express + Vite HMR middleware on one port |
| `npm run build` | Vite bundle to `dist/`, esbuild server to `dist/server.cjs` |
| `npm start` | Run the production bundle (`NODE_ENV=production` required to serve `dist/`) |
| `npm run lint` | `tsc --noEmit` |

`npm run clean` uses `rm -rf`, which is unavailable in PowerShell/cmd — use
`Remove-Item -Recurse -Force dist, server.js` on Windows.

## Symbol Coverage

The ticker catalog is pulled live from Binance rather than hardcoded, so newly
listed instruments are reachable without a code change:

- **Spot** — all `TRADING` USDT pairs with `isSpotTradingAllowed`.
- **Futures** — USD-margined `PERPETUAL` contracts that have no spot equivalent,
  pulled from `fapi`. Dated contracts are excluded because they expire.
- Merged into one list (spot wins on overlap), cached 5 minutes server-side and
  mirrored to `localStorage` for instant paint.
- The **ADD BINANCE CUSTOM TICKER** input accepts free-form text (`ldo`, `LDO`,
  `LDOUSDT`, `sol/usdt`). Unmatched input is verified against the live tape via
  `/api/symbol-lookup`, so a pair listed minutes ago still works. Arrow keys
  navigate, `Enter` accepts, `Escape` dismisses.
- The sidebar **SEARCH COIN DESK** box also falls through to the live catalog, so
  a new listing is findable without adding it first.
- `SYNC` (sidebar) and `RE-SYNC CATALOG` force-refresh past the TTL.

When a selected asset has less history than the requested window, the server
probes its first available bar and **clamps the window to what actually exists**
rather than erroring. `asOf.historyClamped` reports when this happened, and
`asOf.coverage` always carries the real first/last bar times. Below 5 overlapping
bars the request fails with a `422` naming the listing date instead of a generic
"insufficient data" message.

## Deploy to Google Cloud Run

`Dockerfile` is multi-stage: the build stage runs Vite + esbuild and is
discarded; the runtime image carries production dependencies and `dist/` only,
and runs as the unprivileged `node` user.

```bash
# 1. One-time setup
export PROJECT_ID="your-project"
export REGION="us-central1"
export SERVICE="crypto-quant-terminal"

gcloud config set project $PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

gcloud artifacts repositories create $REGION-$PROJECT_ID \
  --repository-format=docker --location=$REGION

# 2. (Optional) attach the Gemini key as a runtime secret
echo -n "$GEMINI_API_KEY" | gcloud secrets create GEMINI_API_KEY --data-file=-

# 3. Build, push, deploy
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_REGION=$REGION,_SERVICE=$SERVICE,_PROJECT=$PROJECT_ID
```

Or run the container directly:

```bash
docker build -t crypto-quant-terminal .
docker run --rm -p 8080:8080 -e NODE_ENV=production -e PORT=8080 \
  -e GEMINI_API_KEY="$GEMINI_API_KEY" crypto-quant-terminal
```

### Deployment notes

- `GEMINI_API_KEY` is never baked into the image. Without it, `/api/report`
  returns a local heuristic memo and everything else works normally.
- The server binds `0.0.0.0` and honours `$PORT`. Cloud Run injects `8080`; a
  hardcoded port is the usual reason a container fails to start here.
- `GET /healthz` is the liveness probe. It intentionally does not call Binance,
  so an upstream outage does not get the instance recycled.
- `SIGTERM` drains in-flight requests for up to 10s before forcing exit.
- The **liquidation tape persists across deploys**. The image writes it to the
  `/data` volume (never `/tmp`), and the Cloud Build deploy mounts a GCS bucket
  there by default (auto-created as `<project>-crypto-quant-liq`, backed by
  `--execution-environment=gen2`). Boot replays the retention window so the
  gainers/losers baseline is not reset to zero on a new revision. Set
  `_LIQ_BUCKET=<name|gs://name>` to use your own bucket or `_LIQ_BUCKET=none`
  to opt out (in-instance, ephemeral). If the mounted path is ever read-only the
  server falls back to a temp dir instead of stalling collection. Note the tape
  is a single shared log — keep `_MAX_INSTANCES=1` while it is mounted.
- Set `_MIN_INSTANCES=1` to keep the symbol catalog warm; at `0` each cold
  start re-fetches it from both venues.
- The service is deployed `--allow-unauthenticated` because it proxies public
  Binance data. Add IAM or Cloud Armor if that is not appropriate.
- Every upstream request is to a public, unauthenticated Binance endpoint. The
  app is a read-only analytics client; it never places orders.
- The **Code Lab** tab runs CPython in the browser via Pyodide (WebAssembly),
  fetched from `cdn.jsdelivr.net`. The image contains no Python, so the tab adds
  no CPU, memory or image size to the service; the only server cost is
  `GET /api/code-series`. Users behind a proxy that blocks jsDelivr will not be
  able to boot the interpreter.

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

## Quant Terminal

The **Quant Terminal** tab replaces the old arbitrage backtester. It is a
per-coin deep-dive served by `GET /api/terminal`, with its own timeframe,
lookback, lag-range and rolling-window controls independent of the dashboard.

| Param | Range | Notes |
| --- | --- | --- |
| `symbol` / `baseAsset` | — | subject and benchmark, both resolved live |
| `interval` | `15m`, `1h`, `4h`, `1d` | bar size for every calculation |
| `lookbackDays` | 7–365 | clamped to 45d for `15m`/`1h`, 180d for `4h`, 365d for `1d` |
| `maxLag` | 1–96 | lead/lag scan depth, trimmed to `floor(bars / 8)` |
| `rollingWindow` | 5–500 | stability and volatility window, trimmed to `floor(bars / 3)` |

Panels, in order:

1. **Lead/lag cross-correlation** — scans every offset and shades each bar by
   significance. Thresholds are Fisher critical values tested against the null
   `ρ = 0`, not bands around the observed correlation: a plain 95% value
   (`tanh(1.96·se)`) and a family-wise value corrected for all `2·maxLag+1`
   lags being tested at once. Only the family-wise clear counts as a real lead.
2. **Downside beta & correlation** — conditional regressions restricted to
   benchmark up/down bars, the worst decile, and the worst 5%, plus capture
   ratios and downside semideviation.
3. **Correlation stability** — rolling correlation series, ±1 sd envelope,
   histogram, and quartile drift, scored 0–100. Answers whether quoting a
   single correlation is honest.
4. **Residual z-scores** — return residual (idiosyncratic events) and
   log-price residual (cointegration gap) with AR(1) half-life.
5. **Volatility regime** — annualized rolling vol on percentiles of each
   asset's own history, plus a regime timeline and vol ratio.
6. **Sessions / time of day** — fixed UTC sessions (Asia, Europe, US, Late)
   and a boundary-free 24-hour profile. The fixed split shifts by an hour
   across a DST change; the hourly view does not.

The page opens with a CRT boot sequence. It is skippable (click or `Escape`)
and replayable via **REBOOT**. Parameter changes recompute without replaying it.

## Code Lab

The **Code Lab** tab is a Python console over the selected pair. CPython runs in
the browser as WebAssembly (Pyodide 314.0.7 / Python 3.14.2), so code typed in
the editor is never sent to the server — the deployed instance cannot be turned
into a code-execution host by anything entered there.

Data comes from `GET /api/code-series`, which takes the same
`symbol`/`baseAsset`/`interval`/`lookbackDays` params as `/api/terminal` but
returns **raw** candles rather than derived statistics, so every calculation is
reproducible in the console. Rows are aligned across the two venues on bar time
and returned columnar (`columns` + `rows`) to keep a 45-day 15m pull small.

```python
# df columns: time (UTC index), close_time, hour_utc,
#   subject_open/high/low/close/volume/return
#   subject_taker_buy            aggressive (market) BUY base volume per bar
#   subject_taker_buy_share      taker_buy / volume -> who wins the tape war
#   bench_open/high/low/close/volume/return
#   log_ratio
df.subject_return.corr(df.bench_return)
df.groupby(df.time.dt.hour).subject_return.std()
df.subject_taker_buy_share.mean() > 0.5   # buyers out-muscled sellers on average
plt.plot(df.subject_close / df.bench_close); plt.show()
```

`numpy`, `pandas`, `matplotlib.pyplot`, `math`, `statistics` and `textwrap` are
preloaded. A trailing bare expression prints its value notebook-style;
matplotlib figures render inline below the output. `Ctrl+Enter`/`Cmd+Enter`
runs, **Reset kernel** drops the frame and imported names.

Limitations, by design: no filesystem and no network from inside the sandbox,
no arbitrary `pip install` of native wheels, and an infinite loop will hang the
tab until it is reloaded.
>>>>>>> 03f407ed2bf4075f5e51f7d1da74495da19273c6
