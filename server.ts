/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import fs from "fs";
import path from "path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import {
  AlignedDataPoint,
  AUTO_SCAN_MAX_SYMBOLS,
  AutoScanConfig,
  AutoScanConfigResponse,
  AutoScanInterval,
  AutoScanMeta,
  AutoScanParams,
  AutoScanSnapshot,
  AutoScanUniverseStats,
  CodeSeriesResponse,
  CodeSeriesLiqColumn,
  CodeSeriesLiquidations,
  Interval,
  Kline,
  LiqHeatmapCandle,
  LiqHeatmapEvent,
  LiqHeatmapLevel,
  LiqHeatmapResponse,
  SCAN_MAX_SYMBOLS,
  ScanExtra,
  ScanParams,
  ScanResponse,
  ScanResultItem,
  ScanStability,
  ScanVolRegime,
  TerminalResponse,
  type ZScoreMode,
  type LiqWindow,
  type MoveProbabilityBrief,
  type MoveProbabilityResponse,
  type ProbabilityParams,
} from "./src/types";
import { alignAndProcessData, computeCorrelationMetrics, computeTodayZScoreExtremes } from "./src/utils/quant_calculations";
import { computeMoveProbability, MIN_MOVE_WINDOWS } from "./src/utils/move_probability";
import {
  buildProbabilityBrief,
  buildProbabilityResponse,
  prepareProbabilityDataset,
  PROBABILITY_DEFAULTS,
  PROBABILITY_MAX_LOOKBACK_DAYS,
  type PreparedProbabilityDataset,
} from "./src/utils/probability_engine";
import {
  MAX_LOOKBACK_DAYS,
  MIN_TERMINAL_BARS,
  buildTerminalBars,
  computeBetaAsymmetry,
  computeCorrelationStability,
  computeCrossCorrelationSpectrum,
  computeResidualAnalysis,
  computeReturnResidualZ,
  computeRollingCoupling,
  computeSessionEffects,
  computeVolatilityRegime,
  defaultLookbackDays,
  defaultRollingWindow,
} from "./src/utils/terminal_calculations";
import {
  LIQ_WINDOWS,
  liquidationStore,
  liqMaxEvents,
  liqRetentionMs,
  normalizeLiqSymbol,
  parseLiqWindow,
} from "./src/utils/liquidation_store";
import {
  startLiquidationCollectors,
  stopLiquidationCollectors,
} from "./src/utils/liquidation_collectors";
import {
  liquidationPersistenceInfo,
  startLiquidationPersistence,
  stopLiquidationPersistence,
} from "./src/utils/liquidation_persistence";
import {
  clearGeckoOverride,
  coinGeckoStatus,
  refreshCoinGeckoIdMap,
  resolveGeckoMcap,
  setGeckoOverride,
  startCoinGeckoIdMap,
} from "./src/utils/coingecko_id_map";
import {
  computePositionAnalysis,
  type PositionAnalystInputs,
  type PositionDepthRaw,
  type PositionFuturesRaw,
} from "./src/utils/position_analyst";
import type {
  PositionAnalysisResponse,
  PositionInput,
  PositionMarketType,
  PositionSide,
  PositionVenueSnapshot,
  PositionVenueStatus,
} from "./src/types";

// Initialize environment variables
dotenv.config();

const app = express();
// Cloud Run (and most PaaS) inject PORT, defaulting to 8080. Honour it or the
// container never receives traffic; 3000 stays the local-dev default.
const PORT = Number(process.env.PORT) || 3000;

// Enable JSON bodies
app.use(express.json());

/**
 * Gzip for large JSON responses.
 *
 * The heavy endpoints (auto-scanner snapshots, terminal, correlation) ship
 * hundreds of KB of numeric arrays that compress roughly 10x. Express has no
 * built-in compression and we deliberately avoid pulling in a dependency, so
 * this shims `res.json` to gzip anything past a small threshold when the caller
 * advertises gzip support. Bodies below the threshold take Express's normal
 * path: the framing overhead is not worth it for tiny control payloads.
 */
const COMPRESS_MIN_BYTES = 1024;
const gzipAsync = promisify(zlib.gzip);

app.use((req, res, next) => {
  const acceptsGzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
  if (!acceptsGzip) return next();

  const originalJson = res.json.bind(res);
  res.json = ((body: any) => {
    let text: string;
    try {
      text = JSON.stringify(body);
    } catch {
      return originalJson(body);
    }
    if (text.length < COMPRESS_MIN_BYTES) {
      return originalJson(body);
    }
    gzipAsync(Buffer.from(text))
      .then((buf) => {
        if (res.headersSent) return;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Content-Encoding", "gzip");
        res.setHeader("Content-Length", String(buf.length));
        res.setHeader("Vary", "Accept-Encoding");
        res.end(buf);
      })
      .catch(() => {
        if (!res.headersSent) originalJson(body);
      });
    return res;
  }) as typeof res.json;
  next();
});

// Initialize Gemini Client server-side ONLY.
// Avoid exposing the key to the client.
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || "",
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

// Supported coins of the terminal
const SUPPORTED_COINS = [
  {
    symbol: "ETHUSDT",
    baseAsset: "ETH",
    name: "Ethereum",
    category: "Layer-1",
    description: "The primary smart contract network and largest altcoin.",
  },
  {
    symbol: "SOLUSDT",
    baseAsset: "SOL",
    name: "Solana",
    category: "Layer-1",
    description: "High-performance L1 blockchain engineered for speed and scale.",
  },
  {
    symbol: "BNBUSDT",
    baseAsset: "BNB",
    name: "BNB",
    category: "Layer-1",
    description: "Native token of the BNB Chain ecosystem.",
  },
  {
    symbol: "XRPUSDT",
    baseAsset: "XRP",
    name: "Ripple",
    category: "Layer-1",
    description: "Digital asset designed for global payment settlement.",
  },
  {
    symbol: "ADAUSDT",
    baseAsset: "ADA",
    name: "Cardano",
    category: "Layer-1",
    description: "Research-driven decentralized PoS third-generation chain.",
  },
  {
    symbol: "AVAXUSDT",
    baseAsset: "AVAX",
    name: "Avalanche",
    category: "Layer-1",
    description: "EVM-compatible subnet architecture with finality sub-second speeds.",
  },
  {
    symbol: "LINKUSDT",
    baseAsset: "LINK",
    name: "Chainlink",
    category: "Oracles",
    description: "Decentralized oracle network feeding real-world data to smart contracts.",
  },
  {
    symbol: "DOTUSDT",
    baseAsset: "DOT",
    name: "Polkadot",
    category: "Layer-1",
    description: "Sharded multichain protocol facilitating interoperable apps.",
  },
  {
    symbol: "DOGEUSDT",
    baseAsset: "DOGE",
    name: "Dogecoin",
    category: "Meme",
    description: "The original internet meme coin with robust institutional visibility.",
  },
  {
    symbol: "NEARUSDT",
    baseAsset: "NEAR",
    name: "Near Protocol",
    category: "Layer-1",
    description: "Usability-first, sharded cloud platform supporting AI computation.",
  },
  {
    symbol: "SUIUSDT",
    baseAsset: "SUI",
    name: "Sui",
    category: "Layer-1",
    description: "Next-gen Move-based blockchain built for asset ownership.",
  },
  {
    symbol: "PEPEUSDT",
    baseAsset: "PEPE",
    name: "Pepe Coin",
    category: "Meme",
    description: "Liquidity-heavy culture asset reflecting market beta trends.",
  },
  {
    symbol: "TONUSDT",
    baseAsset: "TON",
    name: "Toncoin",
    category: "Layer-1",
    description: "Decentralized L1 blockchain integrated natively into Telegram Messenger.",
  },
  {
    symbol: "FTMUSDT",
    baseAsset: "FTM",
    name: "Fantom",
    category: "Layer-1",
    description: "Directed Acyclic Graph (DAG) fast execution L1 network.",
  },
];

/**
 * Quote assets the terminal can analyse against. Both catalogs are sourced
 * from USDT markets, so USDT is always added back after stripping a suffix.
 */
const CATALOG_QUOTE_ASSET = "USDT";

/**
 * Which venue a symbol's price series is served from. Spot wins when a symbol
 * trades in both places, so a pair that exists in both markets analyses on the
 * deeper spot tape by default.
 */
export type Market = "spot" | "futures";

const VENUE_KLINE_URL: Record<Market, string> = {
  spot: "https://api.binance.com/api/v3/klines",
  futures: "https://fapi.binance.com/fapi/v1/klines",
};

const VENUE_EXCHANGE_INFO: Record<Market, string> = {
  spot: "https://api.binance.com/api/v3/exchangeInfo",
  futures: "https://fapi.binance.com/fapi/v1/exchangeInfo",
};

/**
 * How long a fetched exchange catalog stays fresh. Kept short on purpose:
 * the whole point of the live catalog is that freshly listed pairs show up
 * within minutes rather than after a server restart.
 */
const CATALOG_TTL_MS = 5 * 60 * 1000;

export interface CatalogEntry {
  symbol: string; // e.g. ETHUSDT
  baseAsset: string; // e.g. ETH
  name: string;
  category: string;
  description: string;
  /** Venue the price series for this symbol is served from. */
  market: Market;
  /** Binance contract type; "PERPETUAL" for futures entries. */
  contractType?: string;
  /** Epoch ms the symbol began trading, where the venue publishes it. */
  firstBarTime?: number | null;
}

export interface CatalogPayload {
  symbols: CatalogEntry[];
  fetchedAt: number;
  stale: boolean;
  count: number;
  // Surfaces upstream problems (rate limits, geo-blocks) without failing the request
  warning: string | null;
}

let cachedCatalog: CatalogEntry[] | null = null;
let catalogFetchedAt = 0;
let catalogWarning: string | null = null;
// De-duplicates concurrent refreshes: without this, N parallel requests each
// hit Binance's exchangeInfo rate limit and they all get throttled together.
let catalogInFlight: Promise<CatalogEntry[]> | null = null;

/**
 * Leveraged / structured ETF tickers quote a derivative of the base asset and
 * carry no independent return series, so they are useless as correlation
 * subjects. Binance suffixes them predictably.
 */
function isLeveragedTokenSymbol(symbol: string): boolean {
  return /(UPUSDT|DOWNUSDT|BULLUSDT|BEARUSDT)$/.test(symbol);
}

/**
 * Spot tradable USDT pairs.
 *
 * `isSpotTradingAllowed` is the only reliable spot guard: exchangeInfo's
 * `permissions` array is empty on the current API build (it moved to a nested
 * `permissionSets` object), so filtering on it would empty the whole catalog.
 */
function parseSpotSymbols(raw: any): CatalogEntry[] {
  return raw
    .filter(
      (sym: any) =>
        sym.status === "TRADING" &&
        sym.quoteAsset === CATALOG_QUOTE_ASSET &&
        sym.isSpotTradingAllowed === true &&
        sym.symbol !== "BTCUSDT" &&
        !isLeveragedTokenSymbol(sym.symbol)
    )
    .map((sym: any) => ({
      symbol: sym.symbol,
      baseAsset: sym.baseAsset,
      name: sym.baseAsset,
      category: "Altcoin",
      market: "spot" as Market,
      description: `Spot asset (${sym.baseAsset}/${CATALOG_QUOTE_ASSET}) synced live from the Binance exchange catalog.`,
    }));
}

/**
 * USDT-margined perpetual futures.
 *
 * Only PERPETUAL contracts are usable as a correlation subject: dated
 * contracts expire, so their series terminates and the aligned sample would
 * shrink to nothing near delivery.
 */
function parseFuturesSymbols(raw: any): CatalogEntry[] {
  return raw
    .filter(
      (sym: any) =>
        sym.contractType === "PERPETUAL" &&
        sym.status === "TRADING" &&
        sym.quoteAsset === CATALOG_QUOTE_ASSET &&
        sym.symbol !== "BTCUSDT" &&
        !isLeveragedTokenSymbol(sym.symbol)
    )
    .map((sym: any) => ({
      symbol: sym.symbol,
      baseAsset: sym.baseAsset,
      name: sym.baseAsset,
      category: "Perpetual",
      market: "futures" as Market,
      contractType: sym.contractType,
      // The futures feed publishes onboardDate; spot does not.
      firstBarTime: Number.isFinite(sym.onboardDate) ? Number(sym.onboardDate) : null,
      description: `USD-margined perpetual future (${sym.baseAsset}/${CATALOG_QUOTE_ASSET}) with no spot market, synced live from Binance futures.`,
    }));
}

/**
 * Union of spot and futures listings.
 *
 * A partial venue outage degrades the catalog to the other venue rather than
 * failing the whole refresh: a spot-only list is far better than none.
 */
async function fetchCatalogFromBinance(): Promise<CatalogEntry[]> {
  const loadVenue = async (market: Market): Promise<CatalogEntry[]> => {
    const response = await fetchUpstream(VENUE_EXCHANGE_INFO[market]);
    if (!response.ok) {
      await cancelBody(response);
      throw new Error(`Binance ${market} exchangeInfo returned HTTP status ${response.status}`);
    }
    const data = await response.json();
    if (!data || !Array.isArray(data.symbols)) {
      throw new Error(`Binance ${market} exchangeInfo returned an unexpected payload`);
    }
    return market === "spot" ? parseSpotSymbols(data.symbols) : parseFuturesSymbols(data.symbols);
  };

  const settled = await Promise.allSettled([loadVenue("spot"), loadVenue("futures")]);

  const spot = settled[0].status === "fulfilled" ? settled[0].value : null;
  const futures = settled[1].status === "fulfilled" ? settled[1].value : null;

  if (spot === null && futures === null) {
    const reasons = settled.map((s) => (s.status === "rejected" ? s.reason?.message : "empty")).join("; ");
    throw new Error(`Both exchange catalogs failed - ${reasons}`);
  }
  if (spot === null || futures === null) {
    const failedVenue = spot === null ? "spot" : "futures";
    catalogWarning = `Binance ${failedVenue} catalog unavailable; serving ${failedVenue === "spot" ? "spot" : "futures"} listings only.`;
    console.warn(catalogWarning);
  }

  // Spot first, then only the futures pairs that have no spot equivalent, so
  // each symbol appears exactly once and defaults to the spot tape.
  const spotSymbols = new Set((spot || []).map((s) => s.symbol));
  const futuresOnly = (futures || []).filter((s) => !spotSymbols.has(s.symbol));

  return [...(spot || []), ...futuresOnly];
}

/**
 * Returns the tradable symbol catalog, fetching at most once per TTL.
 * `force` bypasses the TTL so the UI can pull a genuinely fresh listing.
 * A failed refresh keeps serving the previous catalog rather than failing.
 */
async function getSymbolCatalog(force = false): Promise<CatalogPayload> {
  const now = Date.now();
  const fresh = cachedCatalog !== null && now - catalogFetchedAt < CATALOG_TTL_MS;

  if (fresh && !force) {
    return {
      symbols: cachedCatalog!,
      fetchedAt: catalogFetchedAt,
      stale: false,
      count: cachedCatalog!.length,
      warning: catalogWarning,
    };
  }

  if (!catalogInFlight) {
    catalogInFlight = fetchCatalogFromBinance()
      .then((entries) => {
        cachedCatalog = entries;
        catalogFetchedAt = Date.now();
        catalogWarning = null;
        return entries;
      })
      .catch((error: any) => {
        catalogWarning = `Binance catalog refresh failed: ${error.message}. Serving the last known catalog.`;
        console.error(catalogWarning);
        return cachedCatalog || [];
      })
      .finally(() => {
        catalogInFlight = null;
      });
  }

  const entries = await catalogInFlight;

  return {
    symbols: entries,
    fetchedAt: catalogFetchedAt,
    // Empty result means we never managed to build a catalog at all
    stale: entries.length === 0 || Date.now() - catalogFetchedAt >= CATALOG_TTL_MS,
    count: entries.length,
    warning: catalogWarning,
  };
}

/**
 * Resolves a symbol against the live catalog, or falls back to the curated
 * static list so a curated asset still analyses during a catalog outage.
 */
async function resolveCoinConfig(symbol: string): Promise<CatalogEntry | null> {
  const { symbols } = await getSymbolCatalog();
  const live = symbols.find((c) => c.symbol === symbol);
  if (live) return live;

  const curated = SUPPORTED_COINS.find((c) => c.symbol === symbol);
  // Curated entries predate the market field; they are all spot pairs
  return curated ? { ...curated, market: "spot" as Market } : null;
}

/**
 * Which venue serves a symbol's candles. Reads the catalog when it can, and
 * falls back to spot on a miss so a bare symbol is never routed to an endpoint
 * that would reject it.
 */
async function resolveMarket(symbol: string): Promise<Market> {
  const { symbols } = await getSymbolCatalog();
  return symbols.find((c) => c.symbol === symbol)?.market ?? "spot";
}

/**
 * Resolves the venue for the benchmark asset, matching the subject's venue so
 * the two series come off the same tape. Correlating a futures subject against
 * a spot benchmark mixes two different instruments; when the base has no
 * contract on the subject's venue we keep spot rather than fail the request.
 */
async function resolveBaseMarket(baseSymbol: string, subjectMarket: Market): Promise<Market> {
  if (subjectMarket === "spot") return "spot";
  const baseMarket = await resolveMarket(baseSymbol);
  return baseMarket;
}

/**
 * Candle duration per supported interval, in milliseconds.
 * The main dashboard uses only 1h/15m; the quant terminal also reaches for
 * 4h and 1d, where volatility regimes and correlation stability need more
 * sample to mean anything.
 */
const INTERVAL_MS: Record<Interval, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};

/**
 * Longest lookback the terminal will request per interval, in milliseconds.
 * Applied to the most recent edge so feeds always terminate at the live tape.
 * Daily and 4h frames get a longer cap because 45 days would only buy 45 bars.
 */
function maxLookbackMs(interval: Interval): number {
  return MAX_LOOKBACK_DAYS[interval] * 24 * 60 * 60 * 1000;
}

/**
 * Binance always appends the currently-forming candle to kline responses.
 * A candle opening at `t` is confirmed only once `t + barMs` has passed, so
 * discard the open bar to keep every metric on settled data.
 */
function dropOpenCandle(klines: Kline[], interval: Interval): Kline[] {
  const confirmedCutoff = Date.now() - INTERVAL_MS[interval];
  return klines.filter((k) => k.time <= confirmedCutoff);
}

/**
 * Parses a Binance kline response. The spot and futures kline payloads are
 * byte-identical for the first six fields, so one mapper serves both venues.
 */
function mapKlines(data: any[]): Kline[] {
  return data.map((item: any) => ({
    time: Number(item[0]),
    open: Number(item[1]),
    high: Number(item[2]),
    low: Number(item[3]),
    close: Number(item[4]),
    volume: Number(item[5]),
    // Field 9: taker-buy base volume. Drives the CVD features of the
    // probability engine; harmless elsewhere (optional on Kline).
    takerBuy: Number(item[9]),
  }));
}

/**
 * Hard ceiling on a single upstream request. Node's global fetch has no default
 * timeout, so a socket that opens but never answers would otherwise hang the
 * caller forever - which for the automated scanner means the sweep never
 * finishes and the loop never reschedules.
 */
const UPSTREAM_TIMEOUT_MS = 15000;
const UPSTREAM_RETRIES = 3;
const UPSTREAM_BACKOFF_MS = 400;
/** Ceiling on a single retry sleep, so a hostile Retry-After cannot wedge us. */
const UPSTREAM_MAX_BACKOFF_MS = 8000;

type FetchInit = Parameters<typeof fetch>[1];

/**
 * Minimum spacing between requests to a host, enforced across every caller in
 * the process. The app runs several independent traffic generators at once
 * (correlation, terminal prefetch, the automated scanner's fan-out, the
 * liquidation collectors, CoinGecko), all sharing one egress IP. Without a
 * shared pacer they burst into Binance's weight limits and CoinGecko's public
 * tier and get throttled, which the retry loop alone cannot recover from.
 */
const HOST_MIN_INTERVAL_MS: Record<string, number> = {
  "api.binance.com": 120,
  "fapi.binance.com": 120,
  "dapi.binance.com": 120,
  "api.coingecko.com": 1200,
  "pro-api.coingecko.com": 300,
};
const hostNextAllowedAt = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Serialises calls to a host so several sweeps cannot stampede it together. */
async function throttleHost(url: string): Promise<void> {
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    return;
  }
  const min = HOST_MIN_INTERVAL_MS[host];
  if (!min) return;
  const now = Date.now();
  const next = hostNextAllowedAt.get(host) ?? 0;
  if (next > now) {
    await sleep(next - now);
  }
  hostNextAllowedAt.set(host, Math.max(now, hostNextAllowedAt.get(host) ?? 0) + min);
}

/**
 * Reads the retry delay a throttled upstream is asking for. Binance answers
 * 429/418 with a `Retry-After` header (seconds); CoinGecko does the same. Falls
 * back to the caller's default when the header is missing or malformed.
 */
function retryAfterMs(response: Response, fallbackMs: number): number {
  const header = response.headers.get("retry-after");
  if (!header) return fallbackMs;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, UPSTREAM_MAX_BACKOFF_MS);
  }
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    return Math.min(Math.max(0, date - Date.now()), UPSTREAM_MAX_BACKOFF_MS);
  }
  return fallbackMs;
}

/** Discards an unconsumed body so the connection returns to the pool. */
async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* already released */
  }
}

/** fetch with an AbortController deadline so a stalled socket cannot wedge us. */
async function fetchWithTimeout(
  url: string,
  init: FetchInit = {},
  timeoutMs: number = UPSTREAM_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...(init as any), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fetchWithTimeout with bounded retries + short backoff. Transient upstream
 * blips ("fetch failed", resets, timeouts) are common on the public Binance and
 * CoinGecko endpoints; retrying in place lets a single sweep ride them out
 * instead of abandoning a half-built series.
 */
async function fetchUpstream(
  url: string,
  init: FetchInit = {},
  timeoutMs: number = UPSTREAM_TIMEOUT_MS
): Promise<Response> {
  let lastError: any;
  const maxAttempts = UPSTREAM_RETRIES + 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await throttleHost(url);
    try {
      const response = await fetchWithTimeout(url, init, timeoutMs);
      // Throttle responses (429) and Cloudflare bans (418) carry an explicit
      // delay. Honour it and try again rather than handing the caller a body
      // that looks like data but is really a rate-limit notice.
      if ((response.status === 429 || response.status === 418) && attempt < maxAttempts) {
        const wait = retryAfterMs(response, UPSTREAM_BACKOFF_MS * attempt);
        console.warn(
          `Upstream ${response.status} from ${url}; backing off ${wait}ms ` +
            `(attempt ${attempt}/${maxAttempts}).`
        );
        // Release the connection before waiting, or the pool leaks sockets and
        // every later request starts failing with "fetch failed".
        await cancelBody(response);
        await sleep(wait);
        continue;
      }
      // Transient 5xx: retry with backoff.
      if (response.status >= 500 && attempt < maxAttempts) {
        await cancelBody(response);
        await sleep(UPSTREAM_BACKOFF_MS * attempt);
        continue;
      }
      return response;
    } catch (error: any) {
      lastError = error;
      if (attempt < maxAttempts) {
        await sleep(UPSTREAM_BACKOFF_MS * attempt);
      }
    }
  }
  throw lastError ?? new Error(`Upstream request failed: ${url}`);
}

/**
 * Robust fetch for historical Kline data from Binance public API
 */
async function fetchKlines(
  symbol: string,
  interval: Interval,
  limit: number,
  market: Market = "spot"
): Promise<Kline[]> {
  try {
    const url = `${VENUE_KLINE_URL[market]}?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
    const response = await fetchUpstream(url);
    if (!response.ok) {
      await cancelBody(response);
      throw new Error(`Binance ${market} returned HTTP status ${response.status}`);
    }
    const data = await response.json();
    if (!Array.isArray(data)) {
      throw new Error(`Data is not an array format`);
    }

    return dropOpenCandle(mapKlines(data), interval);
  } catch (error: any) {
    console.error(`Error fetching ${market} klines for ${symbol} on ${interval}:`, error.message);
    throw error;
  }
}

/**
 * Robust fetch for helper range historical Kline data from Binance public API with pagination
 */
async function fetchKlinesRange(
  symbol: string,
  interval: Interval,
  startTime: number,
  endTime: number,
  market: Market = "spot",
  /** Override for the lookback cap (days). Defaults to MAX_LOOKBACK_DAYS. */
  maxLookbackDays?: number,
  /**
   * When true, a page that fails after retries throws instead of truncating the
   * result. Callers that must distinguish "no more history exists" from "the
   * network died halfway" (the automated scanner's incremental refresh) set
   * this; the tolerant default keeps the read-only views from 500-ing on a
   * single bad page.
   */
  strict = false
): Promise<Kline[]> {
  const allKlines: Kline[] = [];
  const limit = 1000;

  // Never request beyond the live tape.
  const now = Date.now();
  let targetEnd = Math.min(endTime, now);
  let currentStart = Math.min(startTime, targetEnd);

  // Overlong ranges keep the MOST RECENT window: clamp the start forward so the
  // feed still terminates at today instead of stalling on ancient history.
  const cap = (maxLookbackDays ?? MAX_LOOKBACK_DAYS[interval]) * 24 * 60 * 60 * 1000;
  if (targetEnd - currentStart > cap) {
    currentStart = targetEnd - cap;
    console.warn(
      `Range for ${symbol} exceeds the ${cap / 86400000}d ${interval} lookback cap; ` +
        `narrowing to ${new Date(currentStart).toISOString()} -> ${new Date(targetEnd).toISOString()}`
    );
  }

  while (currentStart < targetEnd) {
    const url =
      `${VENUE_KLINE_URL[market]}?symbol=${encodeURIComponent(symbol)}` +
        `&interval=${interval}&startTime=${currentStart}&endTime=${targetEnd}&limit=${limit}`;
    try {
      const response = await fetchUpstream(url);

      if (!response.ok) {
        await cancelBody(response);
        throw new Error(`Binance ${market} returned HTTP status ${response.status}`);
      }
      const data = await response.json();
      if (!Array.isArray(data) || data.length === 0) {
        break;
      }

      const chunk = mapKlines(data);
      allKlines.push(...chunk);

      const lastTime = chunk[chunk.length - 1].time;
      if (lastTime <= currentStart) {
        break;
      }
      currentStart = lastTime + 1;

      if (chunk.length < limit) {
        break;
      }
    } catch (err: any) {
      console.error(`Error in range fetch for ${symbol}:`, err.message);
      // A strict caller would rather retry the whole range next sweep than
      // persist a short series that silently freezes its metrics.
      if (strict) throw err;
      break;
    }
  }

  return dropOpenCandle(allKlines, interval);
}

/**
 * Minimum overlapping bars required before a timeframe's metrics are
 * considered meaningful. Below this, correlation/beta/r2 are noise.
 */
const MIN_OVERLAP_BARS = 5;

const firstBarCache = new Map<string, number | null>();

/**
 * Finds the earliest bar Binance still has for a symbol, via a single
 * `startTime=0&limit=1` probe, which returns the oldest available candle.
 * Memoized per symbol+interval; a null result (no history) is cached too so a
 * bad symbol is not re-probed on every request.
 */
async function fetchFirstBarTime(
  symbol: string,
  interval: Interval,
  market: Market = "spot"
): Promise<number | null> {
  const cacheKey = `${market}:${symbol}:${interval}`;
  if (firstBarCache.has(cacheKey)) {
    return firstBarCache.get(cacheKey)!;
  }

  let firstBar: number | null = null;
  try {
    const response = await fetchUpstream(
      `${VENUE_KLINE_URL[market]}?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=1&startTime=0`
    );
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data) && data.length > 0) {
        const openTime = Number(data[0][0]);
        if (Number.isFinite(openTime) && openTime > 0) {
          firstBar = openTime;
        }
      }
    } else {
      await cancelBody(response);
    }
  } catch (error: any) {
    // A probe failure is non-fatal: the caller falls back to the requested window
    console.error(`First-bar probe failed for ${symbol} on ${interval}:`, error.message);
  }

  firstBarCache.set(cacheKey, firstBar);
  return firstBar;
}

/**
 * A newly listed asset cannot fill a 45-day window, and asking for one simply
 * returns the handful of bars that do exist. Clamp the requested start forward
 * to the asset's first available bar so the feed always terminates at the live
 * tape with the largest usable sample instead of erroring out.
 *
 * Returns the effective start plus whether the clamp actually narrowed anything.
 */
async function clampStartToHistory(
  symbol: string,
  interval: Interval,
  requestedStart: number,
  endTime: number,
  market: Market = "spot"
): Promise<{ start: number; clamped: boolean; firstBarTime: number | null }> {
  const firstBarTime = await fetchFirstBarTime(symbol, interval, market);

  if (firstBarTime === null || firstBarTime <= requestedStart) {
    return { start: requestedStart, clamped: false, firstBarTime };
  }

  // Keep one bar of context so the first return in the sample is computable
  const effectiveStart = Math.min(firstBarTime - INTERVAL_MS[interval], endTime);
  console.log(
    `Clamped ${symbol} ${market} ${interval} window: requested ${new Date(requestedStart).toISOString()} -> ` +
      `${new Date(effectiveStart).toISOString()} (first bar exists from ${new Date(firstBarTime).toISOString()})`
  );

  return { start: effectiveStart, clamped: true, firstBarTime };
}

interface HistoryClamp {
  start: number;
  clamped: boolean;
  firstBarTime: number | null;
}

/**
 * Builds the user-facing message for a window too short to analyse.
 *
 * There are two unrelated causes that demand opposite advice, so they must not
 * be conflated:
 *
 *   1. The asset is younger than the requested window. The listing date is the
 *      useful fact; waiting or picking another asset is the fix.
 *   2. The requested window is itself narrower than the minimum, on an asset
 *      that has plenty of history. The listing date is irrelevant noise here -
 *      reporting it produces nonsense like "ETHUSDT only started trading in
 *      2017" for a one-hour request. The fix is to widen the range.
 *
 * `clamp.clamped` is the discriminator: it is only true when the asset's age
 * actually narrowed the window, which is case 1.
 */
function insufficientHistoryError(
  symbol: string,
  interval: Interval,
  clamp: HistoryClamp,
  baseSymbol: string,
  market: Market = "spot",
  requestedRange?: { start: number; end: number }
): string {
  const venue = market === "futures" ? "Binance futures" : "Binance spot";
  const minSpanMs = MIN_OVERLAP_BARS * INTERVAL_MS[interval];
  const minSpanHours = minSpanMs / 3600000;

  // Case 2: nothing was clamped, so the asset is old enough - the request is
  // the constraint. Checked before case 1 so a narrow range wins even when the
  // asset happens to be young too.
  if (
    !clamp.clamped &&
    clamp.firstBarTime !== null &&
    requestedRange !== undefined &&
    requestedRange.end - requestedRange.start < minSpanMs
  ) {
    const spanHours = Math.max(0, (requestedRange.end - requestedRange.start) / 3600000);
    return `The selected range spans only ${spanHours < 1 ? "<1h" : `${Math.round(spanHours)}h`}, which is too narrow ` +
      `for a reliable ${interval} reading. Widen it to at least ${MIN_OVERLAP_BARS} ${interval} bars ` +
      `(~${minSpanHours}h) so ${symbol} and ${baseSymbol} overlap meaningfully.`;
  }

  // Case 1: the asset is the limiting factor. Name the real listing date.
  if (clamp.firstBarTime !== null) {
    return `${symbol} only started trading on ${venue} at ${new Date(clamp.firstBarTime).toISOString().slice(0, 16).replace("T", " ")} UTC. ` +
      `At least ${MIN_OVERLAP_BARS} ${interval} bars are required for reliable correlation against ${baseSymbol} ` +
      `(~${minSpanHours}h). Try again once more history accumulates, or pick an older asset.`;
  }

  return `No ${interval} history is available for ${symbol} on ${venue}, or the ticker is not a valid symbol.`;
}

// REST API Endpoints

// 1. Get List of Supported Coins
// Seeds the sidebar workspace with curated defaults. Deliberately NOT the full
// exchange catalog: with ~500 live USDT pairs an unfiltered sidebar is unusable.
// New listings are reached through the searchable catalog (see
// /api/binance-symbols) rather than by bloating this list.
app.get("/api/coins", async (_req, res) => {
  try {
    const { symbols, warning } = await getSymbolCatalog();
    // Drop curated entries that are no longer trading, so a delisting does not
    // leave a permanently broken tile in the workspace.
    const live = new Set(symbols.map((s) => s.symbol));
    const active = SUPPORTED_COINS.filter((c) => live.has(c.symbol));
    res.json(active.length > 0 ? active : SUPPORTED_COINS);
    if (warning) {
      console.warn(warning);
    }
  } catch (error: any) {
    // Never block the sidebar on a catalog outage
    console.error("Catalog validation failed, serving curated coins only:", error.message);
    res.json(SUPPORTED_COINS);
  }
});

// 1b. Live exchange catalog for the custom ticker autocomplete.
// `?force=1` bypasses the TTL so freshly listed pairs can be pulled on demand.
app.get("/api/binance-symbols", async (req, res) => {
  try {
    const force = req.query.force === "1" || req.query.force === "true";
    res.json(await getSymbolCatalog(force));
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to load Binance symbols" });
  }
});

// 1b-2. Validate a single ticker without adding it to the workspace.
// Lets the custom ticker accept a symbol typed by hand even when the client's
// cached catalog predates the listing.
app.get("/api/symbol-lookup", async (req, res) => {
  try {
    const raw = String(req.query.symbol || "").trim().toUpperCase();
    if (!raw) {
      return res.status(400).json({ error: "A `symbol` query parameter is required." });
    }
    const symbol = raw.endsWith(CATALOG_QUOTE_ASSET) ? raw : `${raw}${CATALOG_QUOTE_ASSET}`;

    const { symbols } = await getSymbolCatalog(true);
    const match = symbols.find((c) => c.symbol === symbol);
    if (match) {
      return res.json({ found: true, ...match });
    }

    // Not in the catalog. Distinguish "delisted / never existed" from
    // "listed so recently the catalog lagged", by probing both tapes directly.
    // A futures-only pair 404s on spot, so both venues must be tried.
    const [spotFirstBar, futuresFirstBar] = await Promise.all([
      fetchFirstBarTime(symbol, "1h", "spot"),
      fetchFirstBarTime(symbol, "1h", "futures"),
    ]);
    const market: Market = spotFirstBar !== null ? "spot" : futuresFirstBar !== null ? "futures" : "spot";
    const firstBar1h = spotFirstBar ?? futuresFirstBar;

    if (firstBar1h !== null) {
      const baseAsset = symbol.slice(0, -CATALOG_QUOTE_ASSET.length);
      return res.json({
        found: true,
        symbol,
        baseAsset,
        name: baseAsset,
        category: market === "futures" ? "Perpetual" : "Altcoin",
        market,
        contractType: market === "futures" ? "PERPETUAL" : undefined,
        description:
          market === "futures"
            ? "Newly listed perpetual future accepted directly from the futures tape."
            : "Newly listed asset accepted directly from the spot tape.",
        provisional: true,
        firstBarTime: firstBar1h,
      });
    }

    res.json({ found: false, symbol });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Symbol lookup failed" });
  }
});

// 1c. Parse and bound a query integer. Every terminal parameter is user-facing,
// so an out-of-range value is clamped rather than trusted: a lag of 5000 or a
// lookback of 0 should degrade to something meaningful, not error or hang.
function boundedInt(
  raw: unknown,
  fallback: number,
  low: number,
  high: number
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(high, Math.max(low, Math.round(parsed)));
}

const TERMINAL_INTERVALS: Interval[] = ["15m", "1h", "4h", "1d"];

function parseInterval(raw: unknown): Interval {
  const value = String(raw ?? "").toLowerCase();
  return (TERMINAL_INTERVALS as string[]).includes(value) ? (value as Interval) : "1h";
}

/**
 * Every endpoint that accepts a Z-score mode funnels through here so an
 * unknown value degrades to the same default instead of silently switching
 * semantics between pages.
 */
function parseZScoreMode(raw: unknown): ZScoreMode {
  return raw === "rolling" || raw === "batch" ? raw : "expanding";
}

/**
 * Quant Terminal: the heavy in-depth panel for one asset.
 *
 * Everything here is derived from ONE aligned log-return sample so the numbers
 * agree with each other. Reusing the light dashboard's separate 1h/15m fetches
 * would let the "residual z-score" describe a different period than the
 * "correlation stability" next to it.
 */
app.get("/api/terminal", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "ETHUSDT").toUpperCase();
    const interval = parseInterval(req.query.interval);
    const baseAsset = String(req.query.baseAsset || "BTC")
      .toUpperCase()
      .replace(/USDT$/, "");
    const baseSymbol = `${baseAsset}USDT`;

    if (!/^[A-Z0-9]{2,20}$/.test(baseAsset)) {
      return res.status(400).json({ error: `\`${baseAsset}\` is not a usable benchmark ticker.` });
    }
    if (symbol === baseSymbol) {
      return res.status(400).json({
        error: `The subject and benchmark cannot both be ${symbol}. Pick a different benchmark.`,
      });
    }

    const requestedMaxLag = boundedInt(req.query.maxLag, 12, 1, 96);
    const requestedRollingWindow = boundedInt(req.query.rollingWindow, defaultRollingWindow(interval), 5, 500);
    const zscoreMode = parseZScoreMode(req.query.zscoreMode);
    const lookbackDays = boundedInt(
      req.query.lookbackDays,
      defaultLookbackDays(interval),
      2,
      MAX_LOOKBACK_DAYS[interval]
    );

    const coinConfig = await resolveCoinConfig(symbol);
    if (!coinConfig) {
      return res.status(400).json({
        error: `Symbol ${symbol} is not tradeable on Binance spot or USD-margined futures markets. It may be delisted, or the ticker may be misspelled.`,
      });
    }

    const market: Market = coinConfig.market ?? "spot";
    const baseMarket = await resolveBaseMarket(baseSymbol, market);

    const endTime = Date.now();
    const requestedStart = endTime - lookbackDays * 24 * 60 * 60 * 1000;
    const clamp = await clampStartToHistory(symbol, interval, requestedStart, endTime, market);

    console.log(
      `Terminal: ${symbol} vs ${baseSymbol} on ${market} @ ${interval}, ${lookbackDays}d lookback, ` +
        `maxLag ${requestedMaxLag}, rolling ${requestedRollingWindow}, zscore ${zscoreMode}`
    );

    const [baseKlines, coinKlines] = await Promise.all([
      fetchKlinesRange(baseSymbol, interval, clamp.start, endTime, baseMarket),
      fetchKlinesRange(symbol, interval, clamp.start, endTime, market),
    ]);

    const bars = buildTerminalBars(baseKlines, coinKlines);

    if (bars.length < MIN_TERMINAL_BARS) {
      return res.status(422).json({
        error: insufficientHistoryError(symbol, interval, clamp, baseSymbol, market, {
          start: requestedStart,
          end: endTime,
        }),
        symbol,
        market,
        interval,
        overlappingBars: bars.length,
        requiredBars: MIN_TERMINAL_BARS,
        firstBarTime: clamp.firstBarTime,
        requestedStartTime: requestedStart,
        effectiveStartTime: clamp.start,
        clamped: clamp.clamped,
      });
    }

    // A 300-bar sample cannot support a +/-48 bar lag scan: the overlapping
    // pairs at the extremes would be a handful of observations dressed up as a
    // result. Trim to what the sample can carry and say so in the response.
    const warnings: string[] = [];
    const maxLag = Math.min(requestedMaxLag, Math.max(1, Math.floor(bars.length / 8)));
    if (maxLag < requestedMaxLag) {
      warnings.push(
        `Lead/lag range trimmed from +/-${requestedMaxLag} to +/-${maxLag} bars: only ${bars.length} aligned bars are available.`
      );
    }
    const rollingWindow = Math.min(
      requestedRollingWindow,
      Math.max(5, Math.floor(bars.length / 3))
    );
    if (rollingWindow < requestedRollingWindow) {
      warnings.push(
        `Rolling window trimmed from ${requestedRollingWindow} to ${rollingWindow} bars to fit the available sample.`
      );
    }

    const spectrum = computeCrossCorrelationSpectrum(bars, maxLag);
    const asymmetry = computeBetaAsymmetry(bars);
    const stability = computeCorrelationStability(bars, rollingWindow, interval);
    const residual = computeResidualAnalysis(bars, rollingWindow, interval, zscoreMode);
    const volatility = computeVolatilityRegime(bars, rollingWindow, interval);
    const rolling = computeRollingCoupling(bars, rollingWindow, interval);
    const sessions = computeSessionEffects(bars, interval);

    if (asymmetry.marketExtremeDown.observations < 10) {
      warnings.push(
        `Only ${asymmetry.marketExtremeDown.observations} bars fall in the benchmark's worst 5%, so the extreme-tail beta is indicative only.`
      );
    }

    const lastBar = bars[bars.length - 1];
    const asOfTimestamp = lastBar.time + INTERVAL_MS[interval];

    const payload: TerminalResponse = {
      symbol,
      name: coinConfig.name,
      baseAsset,
      baseSymbol,
      market,
      baseMarket,
      interval,
      maxLag,
      requestedMaxLag,
      rollingWindow,
      requestedRollingWindow,
      zscoreMode,
      bars: bars.length,
      spectrum,
      asymmetry,
      stability,
      residual,
      volatility,
      rolling,
      sessions,
      asOf: {
        timestamp: asOfTimestamp,
        iso: new Date(asOfTimestamp).toISOString(),
        lagMinutes: Math.max(0, Math.round((Date.now() - asOfTimestamp) / 60000)),
        serverTime: Date.now(),
        barCount: bars.length,
        firstBarTime: bars[0].time,
        lookbackDays,
        maxLookbackDays: MAX_LOOKBACK_DAYS[interval],
        historyClamped: clamp.clamped,
        firstBarTimeAsset: clamp.firstBarTime,
      },
      warnings,
    };

    res.json(payload);
  } catch (error: any) {
    console.error("Quant terminal calculation failed:", error);
    res.status(500).json({ error: error.message || "Terminal calculation failure" });
  }
});

const CODE_LIQ_EVENT_CAP = 20_000;

/**
 * Slices the live liquidation tape into the Code Lab payload. Rows are
 * receive-ordered, so Python sees a chronological `liq` frame. The cap keeps
 * the newest events during a cascade; the frame's own `retentionHours` tells
 * the user why a 45-day OHLCV pull carries only a day or two of force-orders.
 */
function buildCodeLabLiquidations(
  symbol: string,
  startMs: number,
  endMs: number
): CodeSeriesLiquidations {
  const normalized = normalizeLiqSymbol(symbol);
  const events = normalized
    ? liquidationStore.eventsFor(normalized, startMs, endMs, CODE_LIQ_EVENT_CAP)
    : [];
  const columns: CodeSeriesLiqColumn[] = [
    "time",
    "event_time",
    "exchange",
    "position",
    "price",
    "qty",
    "notional",
  ];
  let notional = 0;
  const rows = events.map((event) => {
    notional += Number.isFinite(event.notional) ? event.notional : 0;
    return [
      event.receivedAtMs,
      event.eventTimeMs,
      event.exchange,
      event.position,
      Number.isFinite(event.price) ? event.price : null,
      Number.isFinite(event.qty) ? event.qty : null,
      Number.isFinite(event.notional) ? event.notional : null,
    ];
  });
  return {
    symbol: normalized,
    count: events.length,
    notional,
    firstEventTime: events.length > 0 ? events[0].receivedAtMs : null,
    lastEventTime: events.length > 0 ? events[events.length - 1].receivedAtMs : null,
    retentionHours: liqRetentionMs() / 3_600_000,
    columns,
    rows,
  };
}

/**
 * Aligned OHLCV for the Code Lab tab.
 *
 * Same subject/benchmark/interval resolution as /api/terminal, but it returns
 * the RAW candles instead of the derived statistics: the point is to let the
 * user recompute everything themselves in Python, so returning only log
 * returns would quietly prevent half the analysis. Rows are aligned on `time`
 * across the two venues and rounded to 8dp, which keeps a 45-day 15m pull
 * (the heaviest request) well under the size a JSON body should carry.
 */
app.get("/api/code-series", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "ETHUSDT").toUpperCase();
    const interval = parseInterval(req.query.interval);
    const baseAsset = String(req.query.baseAsset || "BTC")
      .toUpperCase()
      .replace(/USDT$/, "");
    const baseSymbol = `${baseAsset}USDT`;

    if (!/^[A-Z0-9]{2,20}$/.test(baseAsset)) {
      return res.status(400).json({ error: `\`${baseAsset}\` is not a usable benchmark ticker.` });
    }
    if (symbol === baseSymbol) {
      return res.status(400).json({
        error: `The subject and benchmark cannot both be ${symbol}. Pick a different benchmark.`,
      });
    }

    const lookbackDays = boundedInt(
      req.query.lookbackDays,
      defaultLookbackDays(interval),
      2,
      MAX_LOOKBACK_DAYS[interval]
    );

    const coinConfig = await resolveCoinConfig(symbol);
    if (!coinConfig) {
      return res.status(400).json({
        error: `Symbol ${symbol} is not tradeable on Binance spot or USD-margined futures markets. It may be delisted, or the ticker may be misspelled.`,
      });
    }

    const market: Market = coinConfig.market ?? "spot";
    const baseMarket = await resolveBaseMarket(baseSymbol, market);

    const endTime = Date.now();
    const requestedStart = endTime - lookbackDays * 24 * 60 * 60 * 1000;
    const clamp = await clampStartToHistory(symbol, interval, requestedStart, endTime, market);

    console.log(
      `Code series: ${symbol} vs ${baseSymbol} on ${market} @ ${interval}, ${lookbackDays}d lookback`
    );

    const [baseKlines, coinKlines] = await Promise.all([
      fetchKlinesRange(baseSymbol, interval, clamp.start, endTime, baseMarket),
      fetchKlinesRange(symbol, interval, clamp.start, endTime, market),
    ]);

    const intervalMs = INTERVAL_MS[interval];
    const baseMap = new Map<number, Kline>();
    for (const k of baseKlines) baseMap.set(k.time, k);

    const warnings: string[] = [];
    const rows: number[][] = [];

    // Drop the first aligned bar for each venue's log return: a return needs a
    // predecessor. Returns are NaN rather than dropped so the index of `time`
    // still lines up with the exchange's bar list.
    let prevCoin: Kline | undefined;
    let prevBase: Kline | undefined;

    for (const coin of coinKlines) {
      const base = baseMap.get(coin.time);
      if (!base) continue;
      if (coin.close <= 0 || base.close <= 0) continue;

      const coinReturn = prevCoin ? Math.log(coin.close / prevCoin.close) : NaN;
      const baseReturn = prevBase ? Math.log(base.close / prevBase.close) : NaN;

      rows.push([
        coin.time,
        coin.time + intervalMs,
        new Date(coin.time).getUTCHours(),
        coin.open,
        coin.high,
        coin.low,
        coin.close,
        coin.volume,
        Number.isFinite(coin.takerBuy) ? coin.takerBuy : null,
        coin.volume > 0 && Number.isFinite(coin.takerBuy) ? coin.takerBuy / coin.volume : null,
        coinReturn,
        base.open,
        base.high,
        base.low,
        base.close,
        base.volume,
        baseReturn,
        Math.log(coin.close) - Math.log(base.close),
      ]);

      prevCoin = coin;
      prevBase = base;
    }

    if (rows.length < MIN_TERMINAL_BARS) {
      return res.status(422).json({
        error: insufficientHistoryError(symbol, interval, clamp, baseSymbol, market, {
          start: requestedStart,
          end: endTime,
        }),
        overlappingBars: rows.length,
        requiredBars: MIN_TERMINAL_BARS,
      });
    }

    if (coinKlines.length === 0 || baseKlines.length === 0) {
      warnings.push(
        "One venue returned no candles over the requested window; check the benchmark ticker."
      );
    }
    if (clamp.clamped) {
      warnings.push(
        `Requested ${lookbackDays}d, but ${symbol} only lists from ${new Date(
          clamp.firstBarTime ?? clamp.start
        ).toISOString()}. The window was shortened to the available history.`
      );
    }

    const lastRow = rows[rows.length - 1];
    const asOfTimestamp = lastRow[1];

    const payload: CodeSeriesResponse = {
      symbol,
      name: coinConfig.name,
      baseAsset,
      baseSymbol,
      market,
      baseMarket,
      interval,
      lookbackDays,
      barCount: rows.length,
      columns: [
        "time",
        "close_time",
        "hour_utc",
        "subject_open",
        "subject_high",
        "subject_low",
        "subject_close",
        "subject_volume",
        "subject_taker_buy",
        "subject_taker_buy_share",
        "subject_return",
        "bench_open",
        "bench_high",
        "bench_low",
        "bench_close",
        "bench_volume",
        "bench_return",
        "log_ratio",
      ],
      rows: rows.map((row) =>
        row.map((v) => (Number.isFinite(v) ? Number(v.toFixed(8)) : null))
      ),
      meta: {
        asOfTimestamp,
        asOfIso: new Date(asOfTimestamp).toISOString(),
        lagMinutes: Math.max(0, Math.round((Date.now() - asOfTimestamp) / 60000)),
        serverTime: Date.now(),
        firstBarTime: rows[0][0],
        intervalMs,
        historyClamped: clamp.clamped,
      },
      liquidations: buildCodeLabLiquidations(symbol, clamp.start, endTime),
      warnings,
    };

    res.json(payload);
  } catch (error: any) {
    console.error("Code series fetch failed:", error);
    res.status(500).json({ error: error.message || "Code series fetch failure" });
  }
});

// 2. Fetch data & calculate mathematical correlations and metrics
app.get("/api/correlation", async (req, res) => {
  try {
    const symbol = (req.query.symbol as string) || "ETHUSDT";
    const coinConfig = await resolveCoinConfig(symbol);

    if (!coinConfig) {
      return res.status(400).json({
        error: `Symbol ${symbol} is not tradeable on Binance spot or USD-margined futures markets. It may be delisted, or the ticker may be misspelled.`,
      });
    }

    // Fetch in parallel for ultimate efficiency or custom anchor selection
    const anchorDate = req.query.anchorDate as string;
    const zscoreMode = parseZScoreMode(req.query.zscoreMode);
    const baseAsset = (req.query.baseAsset as string) || "BTC";
    const baseSymbol = baseAsset.endsWith("USDT") ? baseAsset : `${baseAsset}USDT`;
    let btc1h: Kline[], coin1h: Kline[], btc15m: Kline[], coin15m: Kline[];
    let clamp1h = { start: 0, clamped: false, firstBarTime: null as number | null };
    let clamp15m = { start: 0, clamped: false, firstBarTime: null as number | null };

    // Keep the subject and the benchmark on one venue. A futures-only subject
    // (no spot market) is correlated against the futures BTC contract, not spot.
    const market: Market = coinConfig.market ?? "spot";
    const baseMarket = await resolveBaseMarket(baseSymbol, market);

    const anchorIsValid = Boolean(anchorDate && anchorDate.match(/^\d{4}-\d{2}-\d{2}$/));
    const anchorStartMs = anchorIsValid
      ? new Date(anchorDate + "T00:00:00Z").getTime()
      : 0;
    const anchorInFuture = anchorIsValid && anchorStartMs >= Date.now();
    const useAnchoredWindow = anchorIsValid && !anchorInFuture;

    if (anchorInFuture) {
      console.warn(`Anchor ${anchorDate} is in the future for ${symbol}; falling back to the standard live lookback.`);
    }

    // Hoisted so the anchored fetches and the insufficient-history message below
    // describe the identical window.
    const endTime = Date.now();

    if (useAnchoredWindow) {
      // A 45-day anchor on a coin listed last week returns ~7 bars. Probe the
      // subject asset's real history first and clamp both intervals to it, so
      // the sample is as long as the asset can supply instead of failing.
      [clamp1h, clamp15m] = await Promise.all([
        clampStartToHistory(symbol, "1h", anchorStartMs, endTime, market),
        clampStartToHistory(symbol, "15m", anchorStartMs, endTime, market),
      ]);

      console.log(
        `Analyzing anchored correlation since ${new Date(clamp1h.start).toISOString().slice(0, 10)} ` +
          `(requested ${anchorDate}) for ${symbol} vs ${baseSymbol} on ${market} (zscoreMode: ${zscoreMode})...`
      );
      [btc1h, coin1h, btc15m, coin15m] = await Promise.all([
        fetchKlinesRange(baseSymbol, "1h", clamp1h.start, endTime, baseMarket),
        fetchKlinesRange(symbol, "1h", clamp1h.start, endTime, market),
        fetchKlinesRange(baseSymbol, "15m", clamp15m.start, endTime, baseMarket),
        fetchKlinesRange(symbol, "15m", clamp15m.start, endTime, market),
      ]);
    } else {
      const limit1h = 200;
      const limit15m = 750;
      console.log(`Analyzing standard correlation for ${symbol} vs ${baseSymbol} on ${market} (zscoreMode: ${zscoreMode})...`);
      [btc1h, coin1h, btc15m, coin15m] = await Promise.all([
        fetchKlines(baseSymbol, "1h", limit1h, baseMarket),
        fetchKlines(symbol, "1h", limit1h, market),
        fetchKlines(baseSymbol, "15m", limit15m, baseMarket),
        fetchKlines(symbol, "15m", limit15m, market),
      ]);
    }

    // Align timestamps with selected zscoreMode
    const aligned1h = alignAndProcessData(btc1h, coin1h, zscoreMode);
    const aligned15m = alignAndProcessData(btc15m, coin15m, zscoreMode);

    if (aligned1h.length < MIN_OVERLAP_BARS || aligned15m.length < MIN_OVERLAP_BARS) {
      // Name the interval that actually ran out of data, and how long the
      // asset has existed, instead of one generic "insufficient data" string.
      const failing = aligned1h.length < MIN_OVERLAP_BARS
        ? { interval: "1h" as const, bars: aligned1h.length, clamp: clamp1h }
        : { interval: "15m" as const, bars: aligned15m.length, clamp: clamp15m };

      return res.status(422).json({
        error: insufficientHistoryError(
          symbol,
          failing.interval,
          failing.clamp,
          baseSymbol,
          market,
          useAnchoredWindow ? { start: anchorStartMs, end: endTime } : undefined
        ),
        symbol,
        market,
        timeframe: failing.interval,
        overlappingBars: failing.bars,
        requiredBars: MIN_OVERLAP_BARS,
        firstBarTime: failing.clamp.firstBarTime,
        requestedStartTime: useAnchoredWindow ? anchorStartMs : null,
        effectiveStartTime: failing.clamp.start,
        clamped: failing.clamp.clamped,
      });
    }

    // Calculate details for each timeframe
    const metrics1h = computeCorrelationMetrics(aligned1h, "1h", defaultRollingWindow("1h"));
    const metrics15m = computeCorrelationMetrics(aligned15m, "15m", defaultRollingWindow("15m"));

    // Unified scoring and analysis
    const absPrice1h = Math.abs(metrics1h.priceCorrelation);
    const absPrice15m = Math.abs(metrics15m.priceCorrelation);
    const avgPriceCorr = (absPrice1h + absPrice15m) / 2;

    const absVol1h = Math.abs(metrics1h.volumeCorrelation);
    const absVol15m = Math.abs(metrics15m.volumeCorrelation);
    const avgVolCorr = (absVol1h + absVol15m) / 2;

    const absVlt1h = Math.abs(metrics1h.volatilityCorrelation);
    const absVlt15m = Math.abs(metrics15m.volatilityCorrelation);
    const avgVltCorr = (absVlt1h + absVlt15m) / 2;

    const avgR2 = (metrics1h.r2 + metrics15m.r2) / 2;

    // Unified coupling score runs from 0 to 100
    // Price return correlation accounts for 50%
    // Volatility correlation accounts for 20%
    // Volume core correlation accounts for 15%
    // Explained Variance R2 accounts for 15%
    const scoreVal = (avgPriceCorr * 0.50 + avgVltCorr * 0.20 + avgVolCorr * 0.15 + avgR2 * 0.15) * 100;
    const unifiedScore = Math.min(100, Math.max(0, Math.round(scoreVal)));

    // Price coupling category
    let priceCoupling: "High" | "Moderate" | "Low" | "Inverse" = "Moderate";
    if (avgPriceCorr > 0.75) {
      priceCoupling = "High";
    } else if (avgPriceCorr < 0.30) {
      priceCoupling = "Low";
    }

    if (metrics1h.priceCorrelation < -0.2) {
      priceCoupling = "Inverse";
    }

    // Determine Market Regime
    const avgBeta = (metrics1h.beta + metrics15m.beta) / 2;
    let marketRegime = "Standard Beta Tracker";
    let summaryText = "";

    if (avgPriceCorr > 0.75) {
      if (avgBeta > 1.25) {
        marketRegime = "High-Beta Systematic Mirror";
        summaryText = `${coinConfig.baseAsset} exhibits a leveraged systemic relationship with ${baseAsset}. Moves in ${baseAsset} are magnified significantly in ${coinConfig.baseAsset} with high directional fidelity. Ideal only during macro bull expansion series.`;
      } else if (avgBeta < 0.75) {
        marketRegime = "Low-Beta Conservative Tracker";
        summaryText = `${coinConfig.baseAsset} trades in strong direction sync with ${baseAsset}, but with dampened return amplitudes. Indicates strong systemic attachment with lower operational tracking risk.`;
      } else {
        marketRegime = "Beta-Balanced Market Shadow";
        summaryText = `${coinConfig.baseAsset} displays high-fidelity market tracking. Beta is highly centered, mirroring ${baseAsset} liquidities almost exactly.`;
      }
    } else if (avgPriceCorr >= 0.40) {
      marketRegime = "Highly Semi-Idiosyncratic Asset";
      summaryText = `Substantial correlation with ${baseAsset} exists, but significant local token-specific dynamics dominate. High suitability for mean-reverting pairs spread-trading using active Z-Scores.`;
    } else {
      if (avgPriceCorr <= 0.15) {
        marketRegime = "Fully Decoupled Sovereign Diversifier";
        summaryText = `${coinConfig.baseAsset} matches zero parallel correlation to ${baseAsset}, trading almost exclusively on proprietary flow. High hedge values for portfolio asset diversification.`;
      } else {
        marketRegime = "Mildly Interdependent Outperformer";
        summaryText = `Weak correlated link to ${baseAsset}. Driven principally by isolated liquidity catalyst cycles, showing unique independent setups while only lightly following ${baseAsset} macro gravity.`;
      }
    }

    // Hedge Ratio: units to sell to hedge 1 unit of Altcoin to minimize portfolio market variance.
    // Optimal Hedge Ratio = Beta * (Price of Altcoin / Price of Base Asset)
    const lastBTCPrice = aligned1h[aligned1h.length - 1]?.btcClose || 1;
    const lastCoinPrice = aligned1h[aligned1h.length - 1]?.coinClose || 1;
    const hedgeRatio = avgBeta * (lastCoinPrice / lastBTCPrice);

    const describeCoverage = (aligned: AlignedDataPoint[], barMs: number) => {
      if (aligned.length === 0) return null;
      const first = aligned[0];
      const last = aligned[aligned.length - 1];
      const lastBarClose = last.time + barMs;
      return {
        barCount: aligned.length,
        firstBarTime: first.time,
        lastBarOpenTime: last.time,
        // Close time of the newest confirmed candle = true data-as-of
        asOf: lastBarClose,
        spanHours: Math.round(((lastBarClose - first.time) / (60 * 60 * 1000)) * 10) / 10,
      };
    };

    const coverage1h = describeCoverage(aligned1h, INTERVAL_MS["1h"]);
    const coverage15m = describeCoverage(aligned15m, INTERVAL_MS["15m"]);
    const primaryAsOf = coverage1h ? coverage1h.asOf : coverage15m ? coverage15m.asOf : null;

    res.json({
      symbol,
      baseAsset: coinConfig.baseAsset,
      name: coinConfig.name,
      market,
      baseMarket,
      metrics1h,
      metrics15m,
      unified: {
        unifiedScore,
        priceCoupling,
        marketRegime,
        hedgeRatio,
        overallSummary: summaryText,
      },
      asOf: {
        timestamp: primaryAsOf,
        iso: primaryAsOf ? new Date(primaryAsOf).toISOString() : null,
        lagMinutes: primaryAsOf ? Math.max(0, Math.round((Date.now() - primaryAsOf) / 60000)) : null,
        serverTime: Date.now(),
        maxLookbackDays: maxLookbackMs("1h") / 86400000,
        anchorApplied: useAnchoredWindow,
        anchorDate: useAnchoredWindow ? anchorDate : null,
        // True when the requested window was longer than the asset's history
        // and the sample was silently narrowed to fit. Consumers should not
        // present the resulting metrics as a full-length sample.
        historyClamped: clamp1h.clamped || clamp15m.clamped,
        requestedStartTime: useAnchoredWindow ? anchorStartMs : null,
        effectiveStartTime: useAnchoredWindow ? Math.min(clamp1h.start, clamp15m.start) : null,
        firstBarTime: clamp1h.firstBarTime ?? clamp15m.firstBarTime ?? null,
        coverage: {
          "1h": coverage1h,
          "15m": coverage15m,
        },
      },
    });
  } catch (error: any) {
    console.error("API correlation calculation failed:", error);
    res.status(500).json({ error: error.message || "Metrics calculation failure" });
  }
});

/* ------------------------------------------------------------------------- *
 * Batch Scanner
 *
 * One POST sweeps up to SCAN_MAX_SYMBOLS subjects against a single benchmark.
 * The benchmark series is fetched once and shared across every subject, so the
 * fan-out is N+1 kline pulls rather than 2N.
 * ------------------------------------------------------------------------- */

/** Binance's rolling 24h stats ticker, per symbol. */
const VENUE_TICKER_24H_URL: Record<Market, string> = {
  spot: "https://api.binance.com/api/v3/ticker/24hr",
  futures: "https://fapi.binance.com/fapi/v1/ticker/24hr",
};

interface Ticker24h {
  lastPrice: number;
  quoteVolumeUsd: number;
}

/**
 * Last price and 24h quote volume for one symbol.
 *
 * Quote volume is the USDT notional traded in the window, which is directly
 * comparable across symbols. Raw base volume is not: 1 billion PEPE and 1
 * thousand BTC are the same number and mean nothing to each other.
 *
 * Returns nulls rather than throwing: size and turnover are decoration on a
 * scan row, so a ticker failure must not sink the whole request.
 */
async function fetchTicker24h(symbol: string, market: Market): Promise<Ticker24h | null> {
  try {
    const url = `${VENUE_TICKER_24H_URL[market]}?symbol=${encodeURIComponent(symbol)}`;
    const response = await fetchUpstream(url);
    if (!response.ok) {
      await cancelBody(response);
      return null;
    }
    const data: any = await response.json();
    if (!data || typeof data !== "object") return null;

    const lastPrice = Number(data.lastPrice);
    const quoteVolumeUsd = Number(data.quoteVolume);
    return {
      lastPrice: Number.isFinite(lastPrice) ? lastPrice : null as any,
      quoteVolumeUsd: Number.isFinite(quoteVolumeUsd) ? quoteVolumeUsd : null as any,
    };
  } catch {
    return null;
  }
}

/**
 * Every 24h ticker on a venue in a single request, indexed by symbol.
 *
 * The always-on sweep tracks up to AUTO_SCAN_MAX_SYMBOLS subjects, so calling
 * the single-symbol endpoint once per subject is 100 round-trips on every bar.
 * The whole board is one request, and failures are non-fatal: an empty index
 * just leaves turnover blank for that sweep.
 */
async function fetchAllTickers24h(market: Market): Promise<Map<string, Ticker24h>> {
  const index = new Map<string, Ticker24h>();
  try {
    const response = await fetchUpstream(VENUE_TICKER_24H_URL[market]);
    if (!response.ok) {
      await cancelBody(response);
      return index;
    }
    const data: any = await response.json();
    if (!Array.isArray(data)) return index;

    for (const row of data) {
      const symbol = String(row?.symbol || "");
      if (!symbol) continue;
      const lastPrice = Number(row.lastPrice);
      const quoteVolumeUsd = Number(row.quoteVolume);
      index.set(symbol, {
        lastPrice: Number.isFinite(lastPrice) ? lastPrice : (null as any),
        quoteVolumeUsd: Number.isFinite(quoteVolumeUsd) ? quoteVolumeUsd : (null as any),
      });
    }
  } catch {
    // Decoration only; the sweep proceeds with blank turnover.
  }
  return index;
}

/**
 * CoinGecko's top-of-book snapshot, indexed by ticker symbol.
 *
 * Binance publishes no market cap, so this is the only free source that can
 * answer the question. It matches on ticker alone, and tickers are not unique
 * off-exchange (there are several "SAND"), so every hit is flagged
 * `symbolMatch` for the UI to disclose rather than present as fact.
 *
 * The whole scan needs this once, so it is one request for the full page range
 * and cached. Failure is non-fatal: caps come back null and the scan proceeds.
 */
const MCAP_URL = "https://api.coingecko.com/api/v3/coins/markets";
const MCAP_TTL_MS = 10 * 60 * 1000;
const MCAP_PAGES = 2;
const MCAP_PAGE_SIZE = 250;

interface McapEntry {
  marketCap: number | null;
  totalVolume: number | null;
  symbolMatch: boolean;
}

let mcapCache: Map<string, McapEntry> | null = null;
let mcapFetchedAt = 0;
let mcapInFlight: Promise<Map<string, McapEntry>> | null = null;

async function fetchMcapSnapshot(): Promise<Map<string, McapEntry>> {
  if (mcapCache && Date.now() - mcapFetchedAt < MCAP_TTL_MS) {
    return mcapCache;
  }

  if (!mcapInFlight) {
    mcapInFlight = (async () => {
      const index = new Map<string, McapEntry>();

      for (let page = 1; page <= MCAP_PAGES; page += 1) {
        const url =
          `${MCAP_URL}?vs_currency=usd&order=market_cap_desc&per_page=${MCAP_PAGE_SIZE}` +
          `&page=${page}&sparkline=false`;
        const response = await fetchUpstream(url);
        if (!response.ok) {
          await cancelBody(response);
          throw new Error(`CoinGecko markets returned HTTP status ${response.status}`);
        }
        const page1: any = await response.json();
        if (!Array.isArray(page1)) {
          throw new Error("CoinGecko markets returned an unexpected payload");
        }

        // Market-cap rank is the disambiguator: a ticker already in the index
        // from a higher-ranked coin is the better match, so never overwrite.
        for (const coin of page1) {
          const symbol = String(coin.symbol || "").toUpperCase();
          if (!symbol || index.has(symbol)) continue;

          const marketCap = Number(coin.market_cap);
          const totalVolume = Number(coin.total_volume);
          index.set(symbol, {
            marketCap: Number.isFinite(marketCap) ? marketCap : null,
            totalVolume: Number.isFinite(totalVolume) ? totalVolume : null,
            symbolMatch: true,
          });
        }

        if (page1.length < MCAP_PAGE_SIZE) break;
      }

      if (index.size === 0) {
        throw new Error("CoinGecko markets returned no usable rows");
      }

      mcapCache = index;
      mcapFetchedAt = Date.now();
      return index;
    })()
      .catch((error: any) => {
        console.warn(`Market-cap snapshot unavailable: ${error.message}. Scan continues without caps.`);
        // Serve the previous snapshot rather than nothing: stale caps beat no caps.
        return mcapCache || new Map<string, McapEntry>();
      })
      .finally(() => {
        mcapInFlight = null;
      });
  }

  return mcapInFlight;
}

/** Coerces scan params, rejecting anything outside the supported ladder. */
function parseScanParams(raw: any): ScanParams {
  const interval: Interval = raw?.interval === "15m" ? "15m" : "1h";
  const zscoreMode = parseZScoreMode(raw?.zscoreMode);

  const lookbackCap = maxLookbackMs(interval) / 86400000;
  const lookbackDays = Math.min(
    lookbackCap,
    Math.max(1, boundedInt(raw?.lookbackDays, defaultLookbackDays(interval), 1, lookbackCap))
  );

  // The rolling window is in bars, so it has to fit inside the requested
  // lookback or the stability/regime series would be computed off one window.
  const maxBars = Math.floor((lookbackDays * 86400000) / INTERVAL_MS[interval]);
  const rollingWindow = Math.min(
    maxBars,
    boundedInt(raw?.rollingWindow, defaultRollingWindow(interval), 5, 1000)
  );

  const compareAsset = String(raw?.compareAsset || "BTC")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12) || "BTC";

  return {
    compareAsset,
    interval: interval as ScanParams["interval"],
    rollingWindow,
    zscoreMode,
    lookbackDays,
    includeMcap: raw?.includeMcap !== false,
    include24hVol: raw?.include24hVol !== false,
  };
}

/**
 * Taker-buy tape (kline field 9): who is crossing the spread, on both the
 * newest closed bar and across the rolling window. `takerBuy` is the base
 * volume filled by aggressive (market) BUY orders; the remainder of the bar's
 * volume was aggressive selling. Absent on venues that do not publish it, in
 * which case every field stays null rather than being fabricated.
 */
function computeTakerFlow(coinKlines: Kline[], window: number): ScanExtra {
  const out: ScanExtra = {};
  if (coinKlines.length === 0) return out;

  const last = coinKlines[coinKlines.length - 1];
  const takerBuy = last.takerBuy;
  if (takerBuy != null && last.volume > 0) {
    out.takerBuyShare = takerBuy / last.volume;
    const sell = last.volume - takerBuy;
    out.buySellRatio = sell > 0 ? takerBuy / sell : null;
    out.takerDeltaUsd = (2 * takerBuy - last.volume) * last.close;
  }

  const w = Math.max(1, Math.min(window, coinKlines.length));
  const slice = coinKlines.slice(coinKlines.length - w);
  let takerSum = 0;
  let volumeSum = 0;
  let haveTaker = false;
  for (const k of slice) {
    if (k.takerBuy != null) {
      takerSum += k.takerBuy;
      haveTaker = true;
    }
    volumeSum += k.volume;
  }
  if (haveTaker && volumeSum > 0) out.takerBuyShareWindow = takerSum / volumeSum;

  return out;
}

/**
 * Fills a seeded scan row with every derived metric from an already-aligned
 * pair of kline series.
 *
 * Shared by the on-demand /api/scan fan-out and the always-on automated engine
 * so one symbol reads identically in both. Throws when the overlapping sample
 * is too short for a correlation; both callers turn that into a per-row error
 * rather than failing the whole sweep.
 */
function applyScanMetrics(
  row: ScanResultItem,
  baseSymbol: string,
  baseKlines: Kline[],
  coinKlines: Kline[],
  params: ScanParams
): void {
  row.barCount = coinKlines.length;

  // Newest CONFIRMED close, which is the "data as of" the user reads.
  const newestCoinBar = coinKlines[coinKlines.length - 1].time;
  row.asOf = newestCoinBar + INTERVAL_MS[params.interval];
  row.asOfIso = new Date(row.asOf).toISOString();

  const aligned = alignAndProcessData(baseKlines, coinKlines, params.zscoreMode);
  if (aligned.length < MIN_OVERLAP_BARS) {
    throw new Error(
      `${row.symbol} overlaps ${baseSymbol} on only ${aligned.length} closed bars ` +
        `(${params.interval}); ${MIN_OVERLAP_BARS} are required for a usable correlation.`
    );
  }
  row.observations = aligned.length;

  const metrics = computeCorrelationMetrics(aligned, params.interval, params.rollingWindow);
  row.priceCorrelation = metrics.priceCorrelation;
  row.beta = metrics.beta;
  row.alpha = metrics.alpha;
  row.r2 = metrics.r2;
  row.trackingError = metrics.trackingError;
  row.volumeCorrelation = metrics.volumeCorrelation;
  row.volatilityCorrelation = metrics.volatilityCorrelation;
  row.currentRatio = metrics.currentRatio;
  row.rollingCorrelation = metrics.rollingCorrelation;
  row.rollingWindow = metrics.rollingWindow;
  row.leadLag = metrics.lagHistory.map((l) => ({
    lag: l.lag,
    coefficient: l.coefficient,
    interpretation: metrics.leadLagOptimal.interpretation,
  }));

  // The Z-Score column and the "±2 today" breach mirror the terminal's
  // return-residual z exactly: the subject's move minus what the benchmark
  // explains, standardised on the user's rolling window and z-score mode, so
  // the same pair reads identically on the scanner and the terminal when the
  // window and mode match. The log-price frame it shares is also where the
  // volatility regime and correlation stability below are computed.
  const bars = buildTerminalBars(baseKlines, coinKlines);
  if (bars.length >= MIN_TERMINAL_BARS) {
    const residual = computeReturnResidualZ(bars, params.rollingWindow, params.zscoreMode);
    const latestResidual = residual.series[residual.series.length - 1];
    row.currentZScore = latestResidual ? latestResidual.zScore : 0;
    row.todayZ = computeTodayZScoreExtremes(
      residual.series.map((p) => ({ time: p.time, zscore: p.zScore })),
      2,
      Date.now()
    );
    row.spreadSignal =
      row.currentZScore > 1.8
        ? "SELL_COIN_BUY_BTC"
        : row.currentZScore < -1.8
          ? "BUY_COIN_SELL_BTC"
          : "EQUILIBRIUM";

    const regime = computeVolatilityRegime(bars, params.rollingWindow, params.interval);
    const stability = computeCorrelationStability(bars, params.rollingWindow, params.interval);

    const volRegime: ScanVolRegime = {
      coinAnnualized: regime.coin.annualizedVol,
      baseAnnualized: regime.base.annualizedVol,
      ratio: regime.ratio.value,
      ratioPercentile: regime.ratio.percentile,
      coinFullSample: regime.coin.realizedVol,
      baseFullSample: regime.base.realizedVol,
      maxDrawdown: regime.coin.maxDrawdown,
      label: regime.label,
      interpretation: regime.interpretation,
    };
    row.volatilityRegime = volRegime;

    const stabilityOut: ScanStability = {
      window: stability.window,
      current: stability.current,
      mean: stability.mean,
      stdDev: stability.stdDev,
      min: stability.min,
      max: stability.max,
      percentile: stability.percentile,
      score: stability.stabilityScore,
      positiveSharePct: stability.positiveSharePct,
      strongSharePct: stability.strongSharePct,
      regimeShiftZ: stability.regimeShiftZ,
      trendSlopePerBar: stability.trendSlopePerBar,
      label: stability.label,
      interpretation: stability.interpretation,
    };
    row.stability = stabilityOut;
  } else {
    row.currentZScore = 0;
    row.todayZ = null;
    row.spreadSignal = "EQUILIBRIUM";
    row.error = null;
    row.volatilityRegime = null;
    row.stability = null;
  }

  // Taker flow rides along on every row, batch or automated.
  row.extra = { ...row.extra, ...computeTakerFlow(coinKlines, params.rollingWindow) };
}

/**
 * Runs the analysis for one subject against an already-fetched benchmark.
 *
 * Split out so the fan-out can map over it with a concurrency bound: 20
 * unconstrained subjects each paginating klines would trip Binance's rate
 * limit and get the whole scan throttled together.
 */
async function scanOneSymbol(
  symbol: string,
  baseSymbol: string,
  baseKlines: Kline[],
  baseMarket: Market,
  params: ScanParams
): Promise<ScanResultItem> {
  // Seeded from the SUBJECT via seedScanRow, not the benchmark: a row that
  // fails before it resolves its own config must not keep the benchmark's
  // ticker and report the benchmark's market cap against a bogus symbol.
  const row: ScanResultItem = seedScanRow(symbol);
  row.baseMarket = baseMarket;

  try {
    const coinConfig = await resolveCoinConfig(symbol);
    if (!coinConfig) {
      throw new Error(
        `${symbol} is not tradeable on Binance spot or USD-margined futures. It may be delisted.`
      );
    }

    const market: Market = coinConfig.market ?? "spot";
    row.market = market;
    row.baseAsset = coinConfig.baseAsset;
    row.name = coinConfig.name || coinConfig.baseAsset;

    const endTime = Date.now();
    const requestedStart = endTime - params.lookbackDays * 86400000;
    const clamp = await clampStartToHistory(symbol, params.interval, requestedStart, endTime, market);
    row.historyClamped = clamp.clamped;

    const coinKlines = await fetchKlinesRange(symbol, params.interval, clamp.start, endTime, market);

    if (coinKlines.length < MIN_OVERLAP_BARS) {
      // Deliberately does not assert a listing date. The oldest-bar probe this
      // could quote is not reliable enough upstream to state as fact, and
      // telling a user a long-listed asset "only started trading" in 2024 is
      // worse than saying what was actually observed.
      const observed =
        coinKlines.length > 0
          ? `Binance returned ${coinKlines.length} closed ${params.interval} bar(s), oldest ${new Date(
              coinKlines[0].time
            ).toISOString()}`
          : `Binance returned no closed ${params.interval} bars for the requested ${params.lookbackDays}d window`;
      throw new Error(
        `${observed} against ${baseSymbol}. ${MIN_OVERLAP_BARS} overlapping bars are required for a usable correlation. ` +
          `Widen the lookback, pick an older asset, or retry if the feed was briefly unavailable.`
      );
    }

    applyScanMetrics(row, baseSymbol, baseKlines, coinKlines, params);

    return row;
  } catch (error: any) {
    // One bad symbol must not sink the other 19, so the failure is captured on
    // the row and the scan continues.
    row.error = error.message || "Scan failed for this symbol.";
    return row;
  }
}

/** Maps `tasks` with at most `limit` in flight, preserving input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

app.post("/api/scan", async (req, res) => {
  const startedAt = Date.now();
  const warnings: string[] = [];

  try {
    const rawSymbols = Array.isArray(req.body?.symbols) ? req.body.symbols : [];
    if (rawSymbols.length === 0) {
      return res.status(400).json({ error: "Provide at least one symbol to scan." });
    }
    if (rawSymbols.length > SCAN_MAX_SYMBOLS) {
      return res.status(400).json({
        error: `A scan covers at most ${SCAN_MAX_SYMBOLS} symbols; ${rawSymbols.length} were sent.`,
      });
    }

    // Normalize and de-duplicate so the same ticker typed twice does not spend
    // two slots or produce two identical rows.
    const seen = new Set<string>();
    const symbols: string[] = [];
    for (const raw of rawSymbols) {
      const normalized = String(raw || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      symbols.push(normalized);
    }

    if (symbols.length === 0) {
      return res.status(400).json({ error: "None of the supplied symbols were readable." });
    }

    const params = parseScanParams(req.body?.params);
    const baseSymbol = params.compareAsset.endsWith("USDT")
      ? params.compareAsset
      : `${params.compareAsset}USDT`;

    if (symbols.includes(baseSymbol)) {
      return res.status(400).json({
        error: `${baseSymbol} is the benchmark for this scan. Remove it from the subject list.`,
      });
    }

    // The benchmark series is shared by every row, but its VENUE is not: a spot
    // subject is correlated against spot BTC, a futures subject against the
    // futures contract, exactly as the dashboard and terminal resolve it
    // per-subject. Deriving the venue from the first subject alone (the former
    // behaviour) quietly re-priced every other row against the wrong instrument.
    // Only two venues can occur, so the benchmark is fetched at most twice.
    const subjects = await Promise.all(symbols.map((s) => resolveCoinConfig(s)));
    const subjectMarkets = subjects.map((c) => c?.market ?? "spot");
    const subjectVenues = Array.from(new Set(subjectMarkets)) as Market[];
    const baseVenueForSubject = new Map<Market, Market>();
    await Promise.all(
      subjectVenues.map(async (subjectVenue) => {
        baseVenueForSubject.set(subjectVenue, await resolveBaseMarket(baseSymbol, subjectVenue));
      })
    );
    const baseVenues = Array.from(new Set(Array.from(baseVenueForSubject.values())));

    const endTime = Date.now();
    const requestedStart = endTime - params.lookbackDays * 86400000;

    const baseKlinesByVenue = new Map<Market, Kline[]>();
    const shortVenues: Market[] = [];
    for (const venue of baseVenues) {
      const baseClamp = await clampStartToHistory(
        baseSymbol,
        params.interval,
        requestedStart,
        endTime,
        venue
      );
      const klines = await fetchKlinesRange(
        baseSymbol,
        params.interval,
        baseClamp.start,
        endTime,
        venue
      );
      baseKlinesByVenue.set(venue, klines);
      if (klines.length < MIN_OVERLAP_BARS) shortVenues.push(venue);
    }

    if (shortVenues.length === baseVenues.length) {
      const venue = baseVenues[0];
      const baseClamp = await clampStartToHistory(
        baseSymbol,
        params.interval,
        requestedStart,
        endTime,
        venue
      );
      return res.status(422).json({
        error: insufficientHistoryError(
          baseSymbol,
          params.interval,
          baseClamp,
          baseSymbol,
          venue,
          { start: requestedStart, end: endTime }
        ),
      });
    }
    if (shortVenues.length > 0) {
      warnings.push(
        `${baseSymbol} has too little history on ${shortVenues.join(", ")} for this lookback; ` +
          `rows on that venue will report no correlation.`
      );
    }

    const results = await mapWithConcurrency(symbols, 4, (symbol, index) => {
      const venue = baseVenueForSubject.get(subjectMarkets[index] ?? "spot") ?? "spot";
      return scanOneSymbol(symbol, baseSymbol, baseKlinesByVenue.get(venue) ?? [], venue, params);
    });

    // Size and turnover, once for the whole scan rather than per row.
    const mcapIndex = params.includeMcap ? await fetchMcapSnapshot() : null;
    if (params.includeMcap && mcapIndex.size === 0) {
      warnings.push(
        "Market cap source unavailable, so every cap reads as blank. Correlation metrics are unaffected."
      );
    }

    const tickerTargets = params.include24hVol
      ? results.map((r) => ({ symbol: r.symbol, market: r.market }))
      : [];
    // The benchmark's 24h volume is quoted per venue too, so the denominator
    // behind `vol24hRatio` matches the tape each row's price came from.
    const baseTickerByVenue = new Map<
      Market,
      NonNullable<Awaited<ReturnType<typeof fetchTicker24h>>>
    >();
    if (params.include24hVol) {
      await Promise.all(
        baseVenues.map(async (venue) => {
          const ticker = await fetchTicker24h(baseSymbol, venue);
          if (ticker) baseTickerByVenue.set(venue, ticker);
        })
      );
    }
    const tickers = await mapWithConcurrency(tickerTargets, 6, (target) =>
      fetchTicker24h(target.symbol, target.market)
    );

    for (let i = 0; i < results.length; i += 1) {
      const row = results[i];
      const extra: ScanExtra = { ...(row.extra ?? {}) };

      if (mcapIndex) {
        const entry = mcapIndex.get(row.baseAsset);
        if (entry) {
          extra.mcapUsd = entry.marketCap;
          extra.mcapSource = "coingecko";
          extra.mcapSymbolMatch = entry.symbolMatch;
        }
      }

      if (params.include24hVol) {
        const ticker = tickers[i];
        if (ticker) {
          extra.lastPriceUsd = ticker.lastPrice;
          extra.vol24hUsd = ticker.quoteVolumeUsd;
        }
        const baseTicker = baseTickerByVenue.get(row.baseMarket) ?? null;
        if (baseTicker) {
          extra.vol24hBaseUsd = baseTicker.quoteVolumeUsd;
          // Only meaningful against a real base figure: dividing by a missing
          // denominator would print a confident, meaningless ratio.
          if (
            ticker &&
            ticker.quoteVolumeUsd !== null &&
            baseTicker.quoteVolumeUsd > 0
          ) {
            extra.vol24hRatio = ticker.quoteVolumeUsd / baseTicker.quoteVolumeUsd;
          }
        }
      }

      row.extra = extra;
    }

    const succeeded = results.filter((r) => r.error === null);
    const closes = succeeded
      .map((r) => r.asOf)
      .filter((t): t is number => typeof t === "number");

    // The oldest close among the rows, so the reported as-of is one every row
    // actually covers rather than the luckiest row's.
    const oldestClose = closes.length > 0 ? Math.min(...closes) : null;

    const payload: ScanResponse = {
      results,
      completed: succeeded.length,
      failed: results.length - succeeded.length,
      total: results.length,
      params,
      benchmarkSymbol: baseSymbol,
      benchmarkBaseAsset: baseSymbol.replace(/USDT$/, ""),
      asOf: {
        timestamp: oldestClose,
        iso: oldestClose ? new Date(oldestClose).toISOString() : null,
        lagMinutes: oldestClose ? Math.max(0, Math.round((Date.now() - oldestClose) / 60000)) : null,
        serverTime: Date.now(),
      },
      warnings,
    };

    console.log(
      `Scan of ${results.length} symbol(s) vs ${baseSymbol} on ${params.interval}: ` +
        `${payload.completed} ok, ${payload.failed} failed in ${Date.now() - startedAt}ms`
    );

    res.json(payload);
  } catch (error: any) {
    console.error("API scan failed:", error);
    res.status(500).json({ error: error.message || "Scan failed" });
  }
});

/* ------------------------------------------------------------------------- *
 * Automated Scanner engine
 *
 * The always-on counterpart to /api/scan. It owns a persistent universe of up
 * to AUTO_SCAN_MAX_SYMBOLS subjects. Each subject is backfilled once into an
 * in-memory kline series; from then on every candle close of the chosen frame
 * it fetches ONLY the newly closed bars, appends them and recomputes the row,
 * so a 100-symbol universe costs one small request per symbol per bar rather
 * than a full history pagination. The symbol list and parameters are written to
 * disk, so a restart (deploy, OOM) resumes the same universe instead of being
 * reset to empty.
 * ------------------------------------------------------------------------- */

/** Env kill-switch, mirroring LIQ_COLLECT. AUTO_SCAN=0 boots without the loop. */
const AUTO_SCAN_ENABLED = process.env.AUTO_SCAN !== "0";
const AUTO_SCAN_DATA_DIR =
  process.env.AUTO_SCAN_DIR || path.join(process.cwd(), "data", "auto-scanner");
/** Wait past the bar boundary before sweeping so the exchange has published it. */
const AUTO_SWEEP_SETTLE_MS = 4000;
const AUTO_FETCH_CONCURRENCY = 8;

/** A blank row in the shape every scan row must have before metrics land. */
function seedScanRow(symbol: string): ScanResultItem {
  return {
    symbol,
    baseAsset: symbol.replace(/USDT$/, ""),
    name: symbol.replace(/USDT$/, ""),
    market: "spot",
    baseMarket: "spot",
    asOf: null,
    asOfIso: null,
    historyClamped: false,
    barCount: 0,
    observations: 0,
    rollingWindow: 0,
    error: null,
    priceCorrelation: null,
    beta: null,
    alpha: null,
    r2: null,
    trackingError: null,
    volumeCorrelation: null,
    volatilityCorrelation: null,
    currentRatio: null,
    currentZScore: null,
    todayZ: null,
    spreadSignal: null,
    rollingCorrelation: [],
    leadLag: [],
    volatilityRegime: null,
    stability: null,
    extra: {},
    updatedAt: null,
  };
}

function defaultAutoScanParams(): AutoScanParams {
  return {
    compareAsset: "BTC",
    interval: "1h",
    rollingWindow: defaultRollingWindow("1h"),
    zscoreMode: "expanding",
    lookbackDays: defaultLookbackDays("1h"),
    zThreshold: 2,
    includeMcap: true,
    include24hVol: true,
  };
}

/** Coerces arbitrary request input into a supported AutoScanParams. */
function normalizeAutoParams(raw: any): AutoScanParams {
  const interval: AutoScanInterval = raw?.interval === "15m" ? "15m" : "1h";
  const zscoreMode = parseZScoreMode(raw?.zscoreMode);

  const lookbackCap = maxLookbackMs(interval) / 86400000;
  const lookbackDays = Math.min(
    lookbackCap,
    Math.max(1, boundedInt(raw?.lookbackDays, defaultLookbackDays(interval), 1, lookbackCap))
  );

  const maxBars = Math.floor((lookbackDays * 86400000) / INTERVAL_MS[interval]);
  const rollingWindow = Math.min(
    maxBars,
    boundedInt(raw?.rollingWindow, defaultRollingWindow(interval), 5, 1000)
  );

  const compareAsset =
    String(raw?.compareAsset || "BTC").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "BTC";

  const zThreshold = Math.min(6, Math.max(0.5, Number(raw?.zThreshold) || 2));

  return {
    compareAsset,
    interval,
    rollingWindow,
    zscoreMode,
    lookbackDays,
    zThreshold,
    includeMcap: raw?.includeMcap !== false,
    include24hVol: raw?.include24hVol !== false,
  };
}

/** Upper-cases, de-dupes, USDT-suffices and caps a free-form symbol list. */
function normalizeAutoSymbolList(rawSymbols: unknown): string[] {
  const list = Array.isArray(rawSymbols) ? rawSymbols : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    let symbol = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!symbol) continue;
    if (!symbol.endsWith("USDT")) symbol = `${symbol}USDT`;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    out.push(symbol);
    if (out.length >= AUTO_SCAN_MAX_SYMBOLS) break;
  }
  return out;
}

let autoConfig: AutoScanConfig = { symbols: [], params: defaultAutoScanParams() };

function autoBaseSymbol(): string {
  const asset = autoConfig.params.compareAsset;
  return asset.endsWith("USDT") ? asset : `${asset}USDT`;
}

function loadAutoScanConfig(): void {
  try {
    const file = path.join(AUTO_SCAN_DATA_DIR, "config.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const params = normalizeAutoParams(parsed?.params);
    const baseSymbol = params.compareAsset.endsWith("USDT")
      ? params.compareAsset
      : `${params.compareAsset}USDT`;
    const symbols = normalizeAutoSymbolList(parsed?.symbols).filter((s) => s !== baseSymbol);
    autoConfig = { symbols, params };
  } catch {
    // No saved config yet (first boot) or it is unreadable: keep the defaults.
  }
}

function saveAutoScanConfig(): void {
  try {
    fs.mkdirSync(AUTO_SCAN_DATA_DIR, { recursive: true });
    const file = path.join(AUTO_SCAN_DATA_DIR, "config.json");
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(autoConfig, null, 2));
    fs.renameSync(tmp, file);
  } catch (error: any) {
    console.warn(`Automated scanner: config not persisted (${error.message}).`);
  }
}

/** On-disk kline cache so a restart resumes incrementally, not from zero. */
const AUTO_KLINES_FILE_VERSION = 1;
const AUTO_KLINES_SAVE_MIN_MS = 30 * 1000;
let autoKlinesSavedAt = 0;

interface AutoKlineCacheEntry {
  market: Market;
  resetKey: string;
  historyClamped: boolean;
  klines: Kline[];
}

/** Config signature a stored series is only valid for. */
function autoResetKey(params: AutoScanParams, market: Market): string {
  return `${params.interval}|${params.lookbackDays}|${params.compareAsset}|${market}`;
}

/**
 * Rehydrates each subject's series from disk so a restart (deploy, OOM, host
 * reboot) resumes incrementally instead of re-paginating the whole window. A
 * series whose resetKey no longer matches the live params is discarded and
 * rebuilt fresh, so a timeframe/lookback change cannot serve stale bars.
 */
function loadAutoKlines(): void {
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(AUTO_SCAN_DATA_DIR, "klines.json"), "utf8"));
  } catch {
    return;
  }
  if (!parsed || parsed.version !== AUTO_KLINES_FILE_VERSION || typeof parsed.series !== "object") {
    return;
  }

  let restored = 0;
  for (const symbol of autoConfig.symbols) {
    const entry = parsed.series[symbol];
    if (!entry || !Array.isArray(entry.klines) || entry.klines.length === 0) continue;
    const market: Market = entry.market === "futures" ? "futures" : "spot";
    const resetKey = autoResetKey(autoConfig.params, market);
    if (entry.resetKey !== resetKey) continue;

    const state = ensureAutoState(symbol);
    state.market = market;
    state.resetKey = resetKey;
    state.historyClamped = Boolean(entry.historyClamped);
    state.coinKlines = entry.klines.map((k: any) => ({
      time: Number(k.time),
      open: Number(k.open),
      high: Number(k.high),
      low: Number(k.low),
      close: Number(k.close),
      volume: Number(k.volume),
      takerBuy: k.takerBuy == null ? undefined : Number(k.takerBuy),
    }));
    state.ready = true;
    restored += 1;
  }
  if (restored > 0) {
    console.log(`Automated scanner: restored ${restored} cached kline series from disk.`);
  }
}

/** Writes the in-memory series to disk, throttled so a burst of sweeps is cheap. */
function saveAutoKlines(force = false): void {
  const now = Date.now();
  if (!force && now - autoKlinesSavedAt < AUTO_KLINES_SAVE_MIN_MS) return;
  autoKlinesSavedAt = now;
  try {
    fs.mkdirSync(AUTO_SCAN_DATA_DIR, { recursive: true });
    const series: Record<string, AutoKlineCacheEntry> = {};
    for (const symbol of autoConfig.symbols) {
      const state = autoSymbols.get(symbol);
      if (!state || !state.ready || state.coinKlines.length === 0) continue;
      series[symbol] = {
        market: state.market,
        resetKey: state.resetKey,
        historyClamped: state.historyClamped,
        klines: state.coinKlines,
      };
    }
    const file = path.join(AUTO_SCAN_DATA_DIR, "klines.json");
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: AUTO_KLINES_FILE_VERSION, savedAt: now, series }));
    fs.renameSync(tmp, file);
  } catch (error: any) {
    console.warn(`Automated scanner: kline cache not persisted (${error.message}).`);
  }
}

interface AutoSymbolState {
  symbol: string;
  baseAsset: string;
  name: string;
  market: Market;
  /** Config key the stored series was built for; a change forces a backfill. */
  resetKey: string;
  coinKlines: Kline[];
  historyClamped: boolean;
  ready: boolean;
  /** Live catalog lookup completed (true even when it failed to resolve). */
  resolved: boolean;
  lastError: string | null;
  row: ScanResultItem;
}

const autoSymbols = new Map<string, AutoSymbolState>();
const autoBaseKlines = new Map<string, Kline[]>();
const autoBaseMarketByVenue = new Map<Market, Market>();

let autoMeta: AutoScanMeta = {
  running: false,
  active: false,
  intervalMs: INTERVAL_MS[autoConfig.params.interval],
  nextSweepAt: null,
  nextCloseAt: null,
  lastSweepStartedAt: null,
  lastSweepFinishedAt: null,
  lastSweepDurationMs: null,
  lastSweepOk: 0,
  lastSweepFailed: 0,
  lastSweepError: null,
  consecutiveFailures: 0,
  sweeps: 0,
};
let autoRevision = 0;
let autoWarnings: string[] = [];
let autoTimer: NodeJS.Timeout | null = null;
let autoRunning = false;

function ensureAutoState(symbol: string): AutoSymbolState {
  let state = autoSymbols.get(symbol);
  if (!state) {
    state = {
      symbol,
      baseAsset: symbol.replace(/USDT$/, ""),
      name: symbol.replace(/USDT$/, ""),
      market: "spot",
      resetKey: "",
      coinKlines: [],
      historyClamped: false,
      ready: false,
      resolved: false,
      lastError: null,
      row: seedScanRow(symbol),
    };
    autoSymbols.set(symbol, state);
  }
  return state;
}

/** Merges two ascending kline series by open time, newest write winning. */
function mergeKlines(existing: Kline[], incoming: Kline[]): Kline[] {
  if (incoming.length === 0) return existing;
  const byTime = new Map<number, Kline>();
  for (const k of existing) byTime.set(k.time, k);
  for (const k of incoming) byTime.set(k.time, k);
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

/** Keeps only the bars the requested window needs, plus one for the first return. */
function trimToWindow(klines: Kline[], params: AutoScanParams, endTime: number): Kline[] {
  const bars = Math.ceil((params.lookbackDays * 86400000) / INTERVAL_MS[params.interval]) + 2;
  return klines.length > bars ? klines.slice(klines.length - bars) : klines;
}

/**
 * Brings one subject's stored series up to the live tape. First call after a
 * config change paginates the full window; every call after that asks only for
 * bars newer than the newest stored one.
 */
async function refreshAutoSymbol(
  state: AutoSymbolState,
  params: AutoScanParams
): Promise<void> {
  const endTime = Date.now();
  const resetKey = autoResetKey(params, state.market);
  if (state.resetKey !== resetKey) {
    state.coinKlines = [];
    state.ready = false;
    state.resetKey = resetKey;
  }

  // Incremental path: pull only the bars newer than the newest stored one. When
  // the tail refuses to advance, fall through to a full rebuild instead of
  // re-reporting a frozen series. This is the difference between "the tape is
  // quiet" (impossible right after a candle close) and "the delta fetch silently
  // failed" - the old code treated both as success, so a single upstream blip
  // froze every metric on the row for as long as the instance stayed up.
  if (state.ready && state.coinKlines.length > 0) {
    const lastTime = state.coinKlines[state.coinKlines.length - 1].time;
    const delta = await fetchKlinesRange(
      state.symbol,
      params.interval,
      lastTime + 1,
      endTime,
      state.market,
      undefined,
      true
    );
    const expectedClose =
      Math.floor(endTime / INTERVAL_MS[params.interval]) * INTERVAL_MS[params.interval];
    if (delta.length === 0 && lastTime < expectedClose) {
      console.warn(
        `Automated scanner: no new bars for ${state.symbol} since ` +
          `${new Date(lastTime).toISOString()}; rebuilding the series.`
      );
      state.coinKlines = [];
      state.ready = false;
    } else {
      state.coinKlines = trimToWindow(mergeKlines(state.coinKlines, delta), params, endTime);
      return;
    }
  }

  const requestedStart = endTime - params.lookbackDays * 86400000;
  const clamp = await clampStartToHistory(
    state.symbol,
    params.interval,
    requestedStart,
    endTime,
    state.market
  );
  state.historyClamped = clamp.clamped;
  const fetched = await fetchKlinesRange(
    state.symbol,
    params.interval,
    clamp.start,
    endTime,
    state.market,
    undefined,
    true
  );
  // A truncated backfill (strict fetch would have thrown, but a genuinely short
  // history does not) is only a failure when the asset is old enough to have
  // the bars: treat an obviously incomplete, unclamped backfill as a failure and
  // let the next sweep retry it.
  const expectedBars = Math.floor((endTime - clamp.start) / INTERVAL_MS[params.interval]);
  if (!clamp.clamped && expectedBars >= 50 && fetched.length < expectedBars * 0.6) {
    throw new Error(
      `Backfill for ${state.symbol} returned ${fetched.length}/${expectedBars} bars; retrying next sweep.`
    );
  }
  state.coinKlines = fetched;
  state.ready = true;
}

/** Same incremental handling for the shared benchmark series, one per venue. */
async function refreshAutoBase(
  baseSymbol: string,
  market: Market,
  params: AutoScanParams
): Promise<Kline[]> {
  const key = `${baseSymbol}:${market}`;
  const endTime = Date.now();
  let klines = autoBaseKlines.get(key);

  if (!klines || klines.length === 0) {
    const requestedStart = endTime - params.lookbackDays * 86400000;
    const clamp = await clampStartToHistory(baseSymbol, params.interval, requestedStart, endTime, market);
    klines = await fetchKlinesRange(
      baseSymbol,
      params.interval,
      clamp.start,
      endTime,
      market,
      undefined,
      true
    );
  } else {
    const lastTime = klines[klines.length - 1].time;
    const delta = await fetchKlinesRange(
      baseSymbol,
      params.interval,
      lastTime + 1,
      endTime,
      market,
      undefined,
      true
    );
    // The benchmark must advance on the same schedule as its subjects. If it
    // does not, a stale base silently biases every residual on the row, so a
    // no-op delta is treated as a failure and re-backfilled next sweep.
    const expectedClose =
      Math.floor(endTime / INTERVAL_MS[params.interval]) * INTERVAL_MS[params.interval];
    if (delta.length === 0 && lastTime < expectedClose) {
      throw new Error(
        `Benchmark ${baseSymbol} on ${market} produced no new bars since ` +
          `${new Date(lastTime).toISOString()}; will rebuild next sweep.`
      );
    }
    klines = trimToWindow(mergeKlines(klines, delta), params, endTime);
  }

  autoBaseKlines.set(key, klines);
  return klines;
}

function computeAutoRow(
  state: AutoSymbolState,
  baseSymbol: string,
  baseKlines: Kline[],
  params: ScanParams
): void {
  const row = seedScanRow(state.symbol);
  row.market = state.market;
  row.baseAsset = state.baseAsset;
  row.name = state.name;
  row.historyClamped = state.historyClamped;
  try {
    applyScanMetrics(row, baseSymbol, baseKlines, state.coinKlines, params);
    row.error = null;
    state.lastError = null;
  } catch (error: any) {
    row.error = error.message || "Automated scan failed for this symbol.";
    state.lastError = row.error;
  }
  row.updatedAt = Date.now();
  state.row = row;
}

function buildAutoUniverseStats(): AutoScanUniverseStats {
  let ready = 0;
  let warming = 0;
  let failed = 0;
  let bars = 0;
  let oldest: number | null = null;
  let newest: number | null = null;

  for (const state of autoSymbols.values()) {
    if (!autoConfig.symbols.includes(state.symbol)) continue;
    if (state.lastError) failed += 1;
    else if (state.ready) ready += 1;
    else warming += 1;

    bars += state.coinKlines.length;
    if (state.coinKlines.length > 0) {
      const first = state.coinKlines[0].time;
      const last = state.coinKlines[state.coinKlines.length - 1].time;
      if (oldest === null || first < oldest) oldest = first;
      if (newest === null || last > newest) newest = last;
    }
  }

  let baseBars = 0;
  for (const series of autoBaseKlines.values()) baseBars += series.length;

  return {
    total: autoConfig.symbols.length,
    ready,
    warming,
    failed,
    barsStored: bars,
    baseBarsStored: baseBars,
    oldestBarTime: oldest,
    newestBarTime: newest,
  };
}

/**
 * Points kept per rolling-correlation series in the list snapshot. The expanded
 * row draws these as a 200px sparkline, so anything denser than a couple of
 * pixels per point is dead weight multiplied by the whole universe on every
 * poll. The on-disk series keeps full resolution; only the wire copy is capped.
 */
const AUTO_SERIES_MAX_POINTS = 180;

/** Evenly thins a series to at most `max` points, always keeping the last one. */
function downsampleSeries<T>(series: T[], max: number): T[] {
  if (series.length <= max) return series;
  const out: T[] = [];
  const step = (series.length - 1) / (max - 1);
  for (let i = 0; i < max; i += 1) {
    out.push(series[Math.round(i * step)]);
  }
  return out;
}

/**
 * The wire form of a row. `leadLag` is only ever rendered by the manual scan
 * table, and the rolling-correlation series only as a sparkline, so the always-on
 * universe ships without the former and with a thinned latter. Everything else
 * (scalars, regime/stability objects, extras) stays byte-for-byte.
 */
function thinAutoRow(row: ScanResultItem): ScanResultItem {
  return {
    ...row,
    leadLag: [],
    rollingCorrelation: downsampleSeries(row.rollingCorrelation, AUTO_SERIES_MAX_POINTS),
  };
}

// The thinned rows are pure functions of (autoRevision, autoConfig). Caching
// them means the client's 20s poll reuses the same objects instead of rebuilding
// and re-serialising every row; a sweep or config change bumps the revision and
// drops the cache.
let autoSnapshotRows: { revision: number; symbols: string; rows: ScanResultItem[] } | null = null;

function buildAutoSnapshot(): AutoScanSnapshot {
  const baseSymbol = autoBaseSymbol();
  const cacheKey = `${autoRevision}|${autoConfig.symbols.join(",")}`;
  if (!autoSnapshotRows || `${autoSnapshotRows.revision}|${autoSnapshotRows.symbols}` !== cacheKey) {
    const rows = autoConfig.symbols.map((symbol) => {
      const state = autoSymbols.get(symbol);
      return thinAutoRow(state ? state.row : seedScanRow(symbol));
    });
    autoSnapshotRows = { revision: autoRevision, symbols: autoConfig.symbols.join(","), rows };
  }
  const rows = autoSnapshotRows.rows;

  const closes = rows
    .filter((r) => r.error === null && typeof r.asOf === "number")
    .map((r) => r.asOf as number);
  const oldestClose = closes.length > 0 ? Math.min(...closes) : null;

  return {
    config: autoConfig,
    rows,
    benchmarkSymbol: baseSymbol,
    benchmarkBaseAsset: baseSymbol.replace(/USDT$/, ""),
    universe: buildAutoUniverseStats(),
    meta: { ...autoMeta },
    asOf: {
      timestamp: oldestClose,
      iso: oldestClose ? new Date(oldestClose).toISOString() : null,
      lagMinutes: oldestClose ? Math.max(0, Math.round((Date.now() - oldestClose) / 60000)) : null,
      serverTime: Date.now(),
    },
    revision: autoRevision,
    warnings: autoWarnings,
  };
}

/** Applies a validated config, resetting only what the change actually invalidates. */
function applyAutoConfig(symbols: string[], params: AutoScanParams): string[] {
  const warnings: string[] = [];
  const prev = autoConfig.params;
  const windowChanged =
    prev.interval !== params.interval ||
    prev.lookbackDays !== params.lookbackDays ||
    prev.compareAsset !== params.compareAsset;

  autoConfig = { symbols, params };
  // The cached snapshot rows are keyed on the symbol list, but drop them here
  // too so a resize never serves a stale-length array before the next sweep.
  autoSnapshotRows = null;

  for (const key of [...autoSymbols.keys()]) {
    if (!symbols.includes(key)) autoSymbols.delete(key);
  }

  if (windowChanged) {
    autoBaseKlines.clear();
    for (const state of autoSymbols.values()) {
      state.coinKlines = [];
      state.ready = false;
      state.resetKey = "";
      state.historyClamped = false;
    }
  }

  saveAutoScanConfig();
  return warnings;
}

/** Resolves every symbol against the live catalog; returns the unresolvable ones. */
async function validateAutoSymbols(symbols: string[]): Promise<string[]> {
  const rejected: string[] = [];
  await mapWithConcurrency(symbols, 6, async (symbol) => {
    const config = await resolveCoinConfig(symbol);
    if (!config) rejected.push(symbol);
  });
  return rejected.sort();
}

async function runAutoSweep(reason: string): Promise<void> {
  if (autoRunning) return;
  autoRunning = true;
  autoMeta.running = true;
  const startedAt = Date.now();
  autoMeta.lastSweepStartedAt = startedAt;

  const params = autoConfig.params;
  const baseSymbol = autoBaseSymbol();
  const warnings: string[] = [];
  let ok = 0;
  let failed = 0;

  try {
    const states = autoConfig.symbols.map((symbol) => ensureAutoState(symbol));

    // 1. Resolve any subject the catalog has not settled on yet. A failed lookup
    //    is retried next sweep rather than cached, in case it was a catalog blip.
    await mapWithConcurrency(states, AUTO_FETCH_CONCURRENCY, async (state) => {
      if (state.resolved) return;
      const config = await resolveCoinConfig(state.symbol);
      if (!config) {
        state.lastError = `${state.symbol} is not tradeable on Binance spot or USD-margined futures.`;
        state.row.error = state.lastError;
        state.row.updatedAt = Date.now();
        return;
      }
      state.market = config.market ?? "spot";
      state.baseAsset = config.baseAsset;
      state.name = config.name || config.baseAsset;
      state.resolved = true;
    });

    // 2. Fetch the shared benchmark once per venue a subject actually needs.
    const subjectVenues = Array.from(
      new Set(states.filter((s) => s.resolved).map((s) => s.market))
    );
    autoBaseMarketByVenue.clear();
    await Promise.all(
      subjectVenues.map(async (venue) => {
        autoBaseMarketByVenue.set(venue, await resolveBaseMarket(baseSymbol, venue));
      })
    );
    const baseVenues = Array.from(new Set(autoBaseMarketByVenue.values()));
    for (const venue of baseVenues) {
      try {
        await refreshAutoBase(baseSymbol, venue, params);
      } catch (error: any) {
        warnings.push(`Benchmark ${baseSymbol} on ${venue} could not be refreshed: ${error.message}`);
      }
    }

    // 3. Refresh + recompute every subject, incrementally.
    await mapWithConcurrency(states, AUTO_FETCH_CONCURRENCY, async (state) => {
      if (!state.resolved) return;
      const baseMarket = autoBaseMarketByVenue.get(state.market) ?? "spot";
      const baseKlines = autoBaseKlines.get(`${baseSymbol}:${baseMarket}`) ?? [];
      try {
        await refreshAutoSymbol(state, params);
        computeAutoRow(state, baseSymbol, baseKlines, params);
      } catch (error: any) {
        state.lastError = error.message || "Automated scan failed for this symbol.";
        state.row.error = state.lastError;
        state.row.updatedAt = Date.now();
      }
    });

    // 4. Size, turnover and the benchmark-relative volume ratio, once per sweep.
    //    Best-effort by design: this decoration must never abort the sweep or
    //    skip the revision bump that publishes the freshly computed rows.
    try {
      const mcapIndex = params.includeMcap ? await fetchMcapSnapshot() : null;
      if (params.includeMcap && mcapIndex && mcapIndex.size === 0) {
        warnings.push("Market cap source unavailable, so caps read blank. Correlation metrics are unaffected.");
      }

      // One request per venue covers every subject, rather than one per subject.
      const tickerBoards = new Map<Market, Map<string, Ticker24h>>();
      if (params.include24hVol) {
        const venues = Array.from(new Set<Market>([...subjectVenues, ...baseVenues]));
        await Promise.all(
          venues.map(async (venue) => {
            tickerBoards.set(venue, await fetchAllTickers24h(venue));
          })
        );
      }

      for (const state of states) {
        if (!state.resolved) continue;
        const row = state.row;
        const extra: ScanExtra = { ...(row.extra ?? {}) };

        if (mcapIndex) {
          const entry = mcapIndex.get(state.baseAsset);
          if (entry) {
            extra.mcapUsd = entry.marketCap;
            extra.mcapSource = "coingecko";
            extra.mcapSymbolMatch = entry.symbolMatch;
          }
        }

        if (params.include24hVol) {
          const ticker = tickerBoards.get(state.market)?.get(state.symbol) ?? null;
          if (ticker) {
            extra.lastPriceUsd = ticker.lastPrice;
            extra.vol24hUsd = ticker.quoteVolumeUsd;
          }
          const baseMarket = autoBaseMarketByVenue.get(state.market) ?? "spot";
          const baseTicker = tickerBoards.get(baseMarket)?.get(baseSymbol) ?? null;
          if (baseTicker) {
            extra.vol24hBaseUsd = baseTicker.quoteVolumeUsd;
            if (ticker && ticker.quoteVolumeUsd !== null && baseTicker.quoteVolumeUsd > 0) {
              extra.vol24hRatio = ticker.quoteVolumeUsd / baseTicker.quoteVolumeUsd;
            }
          }
        }

        row.extra = extra;
      }
    } catch (error: any) {
      warnings.push(`Size/turnover enrichment skipped this sweep: ${error.message}`);
    }

    for (const state of states) {
      if (state.row.error) failed += 1;
      else if (state.ready) ok += 1;
    }

    autoWarnings = warnings;
    autoMeta.consecutiveFailures = 0;
    autoMeta.lastSweepError = null;
  } catch (error: any) {
    autoMeta.consecutiveFailures += 1;
    autoMeta.lastSweepError = error.message || "Automated sweep failed.";
    autoWarnings = [...warnings, autoMeta.lastSweepError];
    console.error("Automated scanner sweep failed:", error);
  } finally {
    // Always publish a new snapshot so the UI reflects the latest attempt/errors.
    autoSnapshotRows = null;
    autoRevision += 1;

    autoRunning = false;
    autoMeta.running = false;
    autoMeta.lastSweepFinishedAt = Date.now();
    autoMeta.lastSweepDurationMs = Date.now() - startedAt;
    autoMeta.lastSweepOk = ok;
    autoMeta.lastSweepFailed = failed;
    autoMeta.sweeps += 1;
    saveAutoKlines();
    scheduleNextAutoSweep();
    console.log(
      `Automated sweep (${reason}) of ${autoConfig.symbols.length} symbol(s) vs ${baseSymbol} @ ` +
        `${params.interval}: ${ok} ok, ${failed} failed in ${autoMeta.lastSweepDurationMs}ms`
    );
  }
}

/** Schedules the next sweep for the moment the active candle closes. */
function scheduleNextAutoSweep(): void {
  if (autoTimer) {
    clearTimeout(autoTimer);
    autoTimer = null;
  }
  const intervalMs = INTERVAL_MS[autoConfig.params.interval];
  const now = Date.now();
  const nextClose = Math.floor(now / intervalMs) * intervalMs + intervalMs;
  const delay = Math.max(1000, nextClose - now + AUTO_SWEEP_SETTLE_MS);

  autoMeta.intervalMs = intervalMs;
  autoMeta.nextCloseAt = nextClose;
  autoMeta.nextSweepAt = now + delay;

  // Deliberately NOT unref'd: this timer is the engine's heartbeat, and the
  // HTTP listener already keeps the loop alive, so it must be allowed to fire.
  autoTimer = setTimeout(() => {
    void runAutoSweep("candle-close");
  }, delay);
}

function startAutoScanner(): void {
  if (!AUTO_SCAN_ENABLED) {
    console.log("Automated scanner disabled (AUTO_SCAN=0).");
    return;
  }
  loadAutoScanConfig();
  for (const symbol of autoConfig.symbols) ensureAutoState(symbol);
  // Warm from the on-disk series so boot only fetches the delta.
  loadAutoKlines();
  autoMeta.active = true;
  console.log(
    `Automated scanner online: ${autoConfig.symbols.length}/${AUTO_SCAN_MAX_SYMBOLS} symbol(s) vs ` +
      `${autoBaseSymbol()} @ ${autoConfig.params.interval}, sweeping on every candle close.`
  );
  // First build, then scheduleNextAutoSweep keeps the loop alive.
  void runAutoSweep("boot");
}

function stopAutoScanner(): void {
  if (autoTimer) {
    clearTimeout(autoTimer);
    autoTimer = null;
  }
  autoMeta.active = false;
}

app.get("/api/auto-scanner", (_req, res) => {
  // Live, polled data. Forbid intermediary/browser caching so a snapshot can
  // never be replayed after the underlying series has moved on.
  res.setHeader("Cache-Control", "no-store");
  res.json(buildAutoSnapshot());
});

app.post("/api/auto-scanner/run", async (_req, res) => {
  try {
    if (autoRunning) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(202).json(buildAutoSnapshot());
    }
    await runAutoSweep("manual");
    res.setHeader("Cache-Control", "no-store");
    res.json(buildAutoSnapshot());
  } catch (error: any) {
    autoSnapshotRows = null;
    autoRevision += 1;
    res.setHeader("Cache-Control", "no-store");
    try {
      return res.status(500).json(buildAutoSnapshot());
    } catch {
      return res.status(500).json({ error: error.message || "Automated sweep failed." });
    }
  }
});

app.post("/api/auto-scanner/config", async (req, res) => {
  try {
    const params = normalizeAutoParams(req.body?.params);
    let symbols = normalizeAutoSymbolList(req.body?.symbols);
    const baseSymbol = params.compareAsset.endsWith("USDT")
      ? params.compareAsset
      : `${params.compareAsset}USDT`;

    const warnings: string[] = [];
    if (symbols.includes(baseSymbol)) {
      symbols = symbols.filter((s) => s !== baseSymbol);
      warnings.push(`${baseSymbol} is the benchmark and cannot also be a subject; removed.`);
    }
    if (symbols.length === 0) {
      warnings.push("No subjects configured; the automated scanner idles until symbols are added.");
    }

    const rejected = await validateAutoSymbols(symbols);
    const confirm = req.body?.confirm === true;

    if (!confirm) {
      const preview: AutoScanConfigResponse = {
        accepted: false,
        config: { symbols, params },
        warnings,
        rejected,
      };
      return res.json(preview);
    }

    const applied = applyAutoConfig(symbols, params);
    // Kick an immediate backfill so the universe fills without waiting a bar.
    void runAutoSweep("config");

    const payload: AutoScanConfigResponse = {
      accepted: true,
      config: autoConfig,
      warnings: [...warnings, ...applied],
      rejected,
    };
    res.json(payload);
  } catch (error: any) {
    console.error("API auto-scanner config failed:", error);
    res.status(500).json({ error: error.message || "Could not apply the scanner config." });
  }
});

// 3. Generates the rich GPT memo
app.post("/api/report", async (req, res) => {
  try {
    const { metrics, symbol, baseAsset, name, compareAsset = "BTC" } = req.body;

    if (!metrics || !symbol) {
      return res.status(400).json({ error: "Missing required quantitative metrics structure." });
    }

    const avgBeta = (metrics.metrics1h.beta + metrics.metrics15m.beta) / 2;

    if (!process.env.GEMINI_API_KEY) {
      return res.json({
         memo: `### QUANT DESK SUMMARY NOTE

**CRITICAL: Active Gemini API Secrets Key Missing.**
Please configure the \`GEMINI_API_KEY\` variable inside the **Settings > Secrets** panel in AI Studio to get institutional-grade generative AI correlation reporting.

#### Local Quantitative Heuristic Analysis:
- Asset: **${name} (${baseAsset}/${compareAsset})**
- Systematic Coupling Index: **${metrics.unified.unifiedScore}/100**
- Regime Class: **${metrics.unified.marketRegime}**
- 1-Hour Price Return Corelation: **${metrics.metrics1h.priceCorrelation.toFixed(4)}** (Beta: **${metrics.metrics1h.beta.toFixed(3)}**)
- 15m Price Return Corelation: **${metrics.metrics15m.priceCorrelation.toFixed(4)}** (Beta: **${metrics.metrics15m.beta.toFixed(3)}**)
- Beta-Neutral Hedge Ratio: **${metrics.unified.hedgeRatio.toFixed(6)}** ${compareAsset} per unit of ${baseAsset}.
- Recommended Action: **${metrics.metrics1h.currentZScore > 1.8 ? "Arbitrage Divergence Short (Z-score: " + metrics.metrics1h.currentZScore.toFixed(2) + ")" : metrics.metrics1h.currentZScore < -1.8 ? "Arbitrage Divergence Buy" : "Systematic Hold (Equilibrium)"}**`
      });
    }

    // Build the Prompt for Gemini 3.5 Flash
    const prompt = `You are an elite quantitative analyst and chief risk officer (CRO) at a multi-billion dollar crypto hedge fund.
Write a dense, highly professional, standard "Quant Desk Memo" analyzing the calculated correlation patterns between ${name} (${baseAsset}) and the base comparison benchmark asset ${compareAsset}.
Use Markdown and standard financial vocabulary (e.g. "idiosyncratic volatility", "systemic covariance", "co-movement", "reversion speed", "tracking error decay").

Here is the structured quantitative data collected over a rolling 7-day lookback window:
- Symbol Pair Analyzed: ${symbol} (${baseAsset} vs ${compareAsset})

[TIME FRAME: 1-HOUR INTERVALS]
- Returns Correlation: ${metrics.metrics1h.priceCorrelation.toFixed(4)} (Pearson r)
- Volume Sync: ${metrics.metrics1h.volumeCorrelation.toFixed(4)} (Correlation of change in volume)
- Volatility Sync: ${metrics.metrics1h.volatilityCorrelation.toFixed(4)} (Correlation of extreme absolute deviations)
- Beta (Sensitivity): ${metrics.metrics1h.beta.toFixed(3)}
- Alpha (Excess Return Proxy): ${metrics.metrics1h.alpha.toExponential(4)}
- R² (Explained Variance): ${(metrics.metrics1h.r2 * 100).toFixed(2)}%
- Tracking Error: ${(metrics.metrics1h.trackingError * 100).toFixed(4)}%
- Lead-Lag Finding: ${metrics.metrics1h.leadLagOptimal.interpretation} (optimal historical coefficient: ${metrics.metrics1h.leadLagOptimal.coefficient.toFixed(4)})
- Current Price Spread Z-Score: ${metrics.metrics1h.currentZScore.toFixed(2)}
- Current Mean-Reversion Position recommendation: ${metrics.metrics1h.spreadSignal}

[TIME FRAME: 15-MINUTE INTERVALS]
- Returns Correlation: ${metrics.metrics15m.priceCorrelation.toFixed(4)}
- Volume Sync: ${metrics.metrics15m.volumeCorrelation.toFixed(4)}
- Volatility Sync: ${metrics.metrics15m.volatilityCorrelation.toFixed(4)}
- Beta (Sensitivity): ${metrics.metrics15m.beta.toFixed(3)}
- Alpha (Excess Return Proxy): ${metrics.metrics15m.alpha.toExponential(4)}
- R² (Explained Variance): ${(metrics.metrics15m.r2 * 100).toFixed(2)}%
- Tracking Error: ${(metrics.metrics15m.trackingError * 100).toFixed(4)}%
- Lead-Lag Finding: ${metrics.metrics15m.leadLagOptimal.interpretation} (optimal historical coefficient: ${metrics.metrics15m.leadLagOptimal.coefficient.toFixed(4)})
- Current Price Spread Z-Score: ${metrics.metrics15m.currentZScore.toFixed(2)}
- Current Mean-Reversion Position recommendation: ${metrics.metrics15m.spreadSignal}

[UNIFIED METRICS]
- Unified Systematic Coupling Score: ${metrics.unified.unifiedScore}/100
- Return Coupling Intensity: ${metrics.unified.priceCoupling}
- Calculated Regime Classification: ${metrics.unified.marketRegime}
- Optimal Portfolio Beta-Hedging Ratio: Short ${metrics.unified.hedgeRatio.toFixed(6)} ${compareAsset} for every 1 unit of ${baseAsset} held.

Please construct a dense, professional Markdown report structured with the following exact headers:
### 1. Executive Summary & Systematic Regime
Review the current systematic regime status, coupling score, and whether the asset is behaving primarily as a systematic beta-tracker or has high idiosyncratic drivers relative to ${compareAsset}.

### 2. High-Frequency Decoupling & Lead-Lag Signals
Compare the 1-hour and 15-minute timeframes. Focus on tracking error decay and lead-lag dynamics. Specifically interpret whether there is an asset discovery lag (e.g. ${compareAsset} leading or lagging) across high frequencies, and how a market maker should position limit orders.

### 3. Hedging Mathematics & Risk Ratios
Provide rigorous instructions using the calculated Beta (${avgBeta.toFixed(3)}) and the optimal Hedge Ratio of ${metrics.unified.hedgeRatio.toFixed(6)} ${compareAsset}. Explain how to manage risk, neutralize systemic beta, and outline the volatility tracking dispersion.

### 4. Mean-Reversion Spreads & Pairs Alpha
Analyze the current Z-score metrics (1h: ${metrics.metrics1h.currentZScore.toFixed(1)}, 15m: ${metrics.metrics15m.currentZScore.toFixed(1)}) and recommendations. Outline specific entry/exit boundaries if this asset presents a pairs-trading arbitrage opportunity against ${compareAsset}.

Keep the report crisp, technical, quantitative, and completely devoid of generic market summaries. Do not write filler. Use concise bulleted sections where appropriate.`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
    });

    res.json({ memo: response.text });
  } catch (error: any) {
    console.error("Gemini report generation failed:", error);
    res.status(500).json({ error: error.message || "Report generation failure" });
  }
});

/* ------------------------------------------------------------------------- *
 * Post-surge event probability
 *
 * GET /api/probability?symbol=...&view=full|brief
 *
 * Server-side compute (mirrors /api/terminal): klines are pulled for a
 * top-by-volume spot universe plus BTCUSDT context, the engine detects and
 * labels surge episodes once per parameter set, and the response is either
 * the full advisory page or the compact terminal card. Nothing here is a
 * forecast - see the caveats the payload always carries.
 * ------------------------------------------------------------------------- */

const PROBABILITY_BAR_TTL_MS = 10 * 60 * 1000;
const PROBABILITY_PREPARED_TTL_MS = 12 * 60 * 1000;
const PROBABILITY_UNIVERSE_TTL_MS = 60 * 1000;
const PROBABILITY_FETCH_CONCURRENCY = 6;

interface ProbabilityBarCacheEntry {
  fetchedAt: number;
  bars: Kline[] | null;
}

const probabilityBarCache = new Map<string, ProbabilityBarCacheEntry>();

function boundedFloat(raw: unknown, fallback: number, low: number, high: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(high, Math.max(low, parsed));
}

/** Runs `worker` over `items` with at most `limit` in flight. */
async function mapPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const size = Math.min(limit, Math.max(1, items.length));
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        await worker(items[idx]);
      }
    })
  );
}

/**
 * Spot USDT pairs ranked by 24h quote volume - one full ticker/24hr request,
 * cached for a minute. Restricted to the tradable spot catalog so leveraged
 * tokens and delisted pairs cannot enter the universe. On ticker failure the
 * last known ranking (or the catalog itself) keeps the endpoint alive: the
 * survivorship-bias caveat already discloses that this universe is today's
 * listings, not the point-in-time one.
 */
let probabilityUniverseCache: { symbols: string[]; fetchedAt: number } | null = null;

async function fetchProbabilityUniverseCandidates(): Promise<string[]> {
  if (
    probabilityUniverseCache &&
    Date.now() - probabilityUniverseCache.fetchedAt < PROBABILITY_UNIVERSE_TTL_MS
  ) {
    return probabilityUniverseCache.symbols;
  }
  try {
    const response = await fetch(VENUE_TICKER_24H_URL.spot);
    if (!response.ok) throw new Error(`ticker/24hr returned HTTP status ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error("ticker/24hr returned an unexpected payload");

    const ranked = data
      .map((row: any) => ({ symbol: String(row.symbol ?? ""), qv: Number(row.quoteVolume) }))
      .filter((row) => row.symbol.endsWith("USDT") && Number.isFinite(row.qv) && row.qv > 0)
      .sort((a, b) => b.qv - a.qv)
      .map((row) => row.symbol);

    const catalog = await getSymbolCatalog();
    const spot = new Set(
      catalog.symbols.filter((entry) => entry.market === "spot").map((entry) => entry.symbol)
    );
    const symbols = ranked.filter((s) => spot.has(s));
    if (symbols.length === 0) return probabilityUniverseCache?.symbols ?? ranked;

    probabilityUniverseCache = { symbols, fetchedAt: Date.now() };
    return symbols;
  } catch (error: any) {
    console.warn(`Probability universe ranking failed: ${error.message}`);
    if (probabilityUniverseCache) return probabilityUniverseCache.symbols;
    const catalog = await getSymbolCatalog();
    const fallback = catalog.symbols
      .filter((entry) => entry.market === "spot")
      .map((entry) => entry.symbol);
    if (fallback.length === 0) throw error;
    return fallback;
  }
}

/**
 * Klines for the probability universe, cached per symbol+window. Failures are
 * cached as nulls too, so one bad symbol is not re-fetched on every view.
 * Returns the cache stamp of every series actually used, which the prepared
 * cache keys on - any refetch invalidates the downstream computation.
 */
async function fetchProbabilityBars(
  entries: { symbol: string; market: Market }[],
  interval: Interval,
  lookbackDays: number
): Promise<{
  klinesBySymbol: Map<string, Kline[]>;
  failedSymbols: string[];
  barStamp: number;
}> {
  const endTime = Date.now();
  const requestedStart = endTime - lookbackDays * 24 * 60 * 60 * 1000;
  const out = new Map<string, Kline[]>();
  const failed: string[] = [];
  const missing: { symbol: string; market: Market; key: string }[] = [];
  let barStamp = 0;

  for (const entry of entries) {
    const key = `${entry.market}:${entry.symbol}:${interval}:${lookbackDays}`;
    const hit = probabilityBarCache.get(key);
    if (hit && Date.now() - hit.fetchedAt < PROBABILITY_BAR_TTL_MS) {
      barStamp = Math.max(barStamp, hit.fetchedAt);
      if (hit.bars && hit.bars.length > 0) out.set(entry.symbol, hit.bars);
      else failed.push(entry.symbol);
    } else {
      missing.push({ ...entry, key });
    }
  }

  await mapPool(missing, PROBABILITY_FETCH_CONCURRENCY, async (entry) => {
    try {
      const clamp = await clampStartToHistory(
        entry.symbol,
        interval,
        requestedStart,
        endTime,
        entry.market
      );
      const bars = await fetchKlinesRange(
        entry.symbol,
        interval,
        clamp.start,
        endTime,
        entry.market,
        lookbackDays
      );
      const fetchedAt = Date.now();
      probabilityBarCache.set(entry.key, { fetchedAt, bars });
      barStamp = Math.max(barStamp, fetchedAt);
      if (bars.length > 0) out.set(entry.symbol, bars);
      else failed.push(entry.symbol);
    } catch (error: any) {
      console.error(`Probability kline fetch failed for ${entry.symbol}: ${error.message}`);
      const fetchedAt = Date.now();
      probabilityBarCache.set(entry.key, { fetchedAt, bars: null });
      barStamp = Math.max(barStamp, fetchedAt);
      failed.push(entry.symbol);
    }
  });

  return { klinesBySymbol: out, failedSymbols: failed, barStamp };
}

interface ProbabilityPreparedCache {
  key: string;
  barStamp: number;
  prepared: PreparedProbabilityDataset;
  at: number;
}

let probabilityPreparedCache: ProbabilityPreparedCache | null = null;

/**
 * The heavy step (detection + posteriors + skill + sensitivity over the whole
 * universe) runs once per parameter set and bar generation; the per-symbol
 * state views are built cheaply from the cached preparation.
 */
function getPreparedProbability(
  params: ProbabilityParams,
  klinesBySymbol: Map<string, Kline[]>,
  failedSymbols: string[],
  barStamp: number
): PreparedProbabilityDataset {
  const key = `${JSON.stringify(params)}|${[...klinesBySymbol.keys()].sort().join(",")}`;
  const cached = probabilityPreparedCache;
  if (
    cached &&
    cached.key === key &&
    cached.barStamp === barStamp &&
    Date.now() - cached.at < PROBABILITY_PREPARED_TTL_MS
  ) {
    return cached.prepared;
  }
  const context = klinesBySymbol.get("BTCUSDT") ?? null;
  const prepared = prepareProbabilityDataset(klinesBySymbol, failedSymbols, context, params);
  probabilityPreparedCache = { key, barStamp, prepared, at: Date.now() };
  return prepared;
}

app.get("/api/probability", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "BTCUSDT").toUpperCase();
    const view = req.query.view === "brief" ? "brief" : "full";
    const interval = parseInterval(req.query.interval);
    const lookbackDays = boundedInt(
      req.query.lookbackDays,
      PROBABILITY_DEFAULTS.lookbackDays,
      7,
      PROBABILITY_MAX_LOOKBACK_DAYS[interval]
    );
    const universeSize = boundedInt(req.query.universe, PROBABILITY_DEFAULTS.universeSize, 5, 50);
    const L = boundedInt(req.query.L, PROBABILITY_DEFAULTS.L, 3, 24);
    const k = boundedFloat(req.query.k, PROBABILITY_DEFAULTS.k, 1.5, 8);
    const beta = boundedFloat(req.query.beta, PROBABILITY_DEFAULTS.beta, 0.02, 0.5);
    const deltaC = boundedFloat(req.query.deltaC, PROBABILITY_DEFAULTS.deltaC, 0.05, 0.6);
    const deltaE = boundedFloat(req.query.deltaE, PROBABILITY_DEFAULTS.deltaE, 0.05, 0.6);
    const m = boundedInt(req.query.m, PROBABILITY_DEFAULTS.m, 1, 6);
    const params: ProbabilityParams = {
      interval,
      lookbackDays,
      universeSize,
      L,
      k,
      beta,
      deltaC,
      deltaE,
      m,
    };

    const coinConfig = await resolveCoinConfig(symbol);
    if (!coinConfig) {
      return res.status(400).json({
        error: `Symbol ${symbol} is not tradeable on Binance spot or USD-margined futures markets. It may be delisted, or the ticker may be misspelled.`,
      });
    }

    // Subject first (it drives the card), BTCUSDT always (regime context),
    // then the top of the volume-ranked spot universe.
    const candidates = await fetchProbabilityUniverseCandidates();
    const fetchList: { symbol: string; market: Market }[] = [];
    const seen = new Set<string>();
    const add = (s: string, market: Market) => {
      if (seen.has(s)) return;
      seen.add(s);
      fetchList.push({ symbol: s, market });
    };
    add(symbol, coinConfig.market ?? "spot");
    add("BTCUSDT", "spot");
    for (const s of candidates.slice(0, universeSize)) add(s, "spot");

    const startedAt = Date.now();
    const { klinesBySymbol, failedSymbols, barStamp } = await fetchProbabilityBars(
      fetchList,
      interval,
      lookbackDays
    );
    if (klinesBySymbol.size === 0) {
      return res.status(422).json({
        error: `No kline data is available for ${symbol} (or its universe) on ${interval} over ${lookbackDays} days. Binance may be rate-limiting this server; retry shortly.`,
        symbol,
        interval,
        lookbackDays,
      });
    }

    const prepared = getPreparedProbability(params, klinesBySymbol, failedSymbols, barStamp);
    const payload =
      view === "brief"
        ? buildProbabilityBrief(prepared, symbol)
        : buildProbabilityResponse(prepared, symbol);

    console.log(
      `Probability ${view} ${symbol} @ ${interval} ${lookbackDays}d: ` +
        `${prepared.universe.symbols.length} symbols, ${prepared.events.length} events, ` +
        `${Date.now() - startedAt}ms${probabilityPreparedCache?.prepared === prepared ? " (cached)" : ""}`
    );
    res.json(payload);
  } catch (error: any) {
    console.error("API probability failed:", error);
    res.status(500).json({ error: error.message || "Probability calculation failed" });
  }
});

const MOVE_BAR_TTL_MS = 2 * 60 * 1000;
const MOVE_BAR_CACHE_MAX = 400;
const moveBarCache = new Map<string, { fetchedAt: number; bars: Kline[] | null }>();

async function fetchMoveBars(
  symbol: string,
  interval: Interval,
  start: number,
  endTime: number,
  market: Market
): Promise<Kline[]> {
  const key = `${market}:${symbol}:${interval}:${start}`;
  const hit = moveBarCache.get(key);
  if (hit && Date.now() - hit.fetchedAt < MOVE_BAR_TTL_MS) return hit.bars ?? [];
  const bars = await fetchKlinesRange(symbol, interval, start, endTime, market);
  if (moveBarCache.size > MOVE_BAR_CACHE_MAX) moveBarCache.clear();
  moveBarCache.set(key, { fetchedAt: Date.now(), bars });
  return bars;
}

/**
 * GET /api/move-prob?symbol=...&pct=10&hours=3&view=full|brief
 *
 * Unconditional probability that the coin trades +/-pct% within the next
 * `hours`, measured over every historical bar in the window. No z-score
 * trigger: the estimate updates as the window, the price and the trailing
 * volatility regime move.
 */
app.get("/api/move-prob", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "BTCUSDT").toUpperCase();
    const view = req.query.view === "brief" ? "brief" : "full";
    const interval = parseInterval(req.query.interval);
    const lookbackDays = boundedInt(
      req.query.lookbackDays,
      90,
      7,
      PROBABILITY_MAX_LOOKBACK_DAYS[interval]
    );
    const thresholdPct = boundedFloat(req.query.pct, 10, 0.25, 300);
    const horizonHours = boundedFloat(req.query.hours, 3, 0.25, 24 * 90);

    const intervalMs = INTERVAL_MS[interval];
    const horizonBars = Math.max(
      1,
      Math.min(5000, Math.round((horizonHours * 3600000) / intervalMs))
    );
    const effectiveHorizonHours = (horizonBars * intervalMs) / 3600000;

    const coinConfig = await resolveCoinConfig(symbol);
    if (!coinConfig) {
      return res.status(400).json({
        error: `Symbol ${symbol} is not tradeable on Binance spot or USD-margined futures markets. It may be delisted, or the ticker may be misspelled.`,
      });
    }
    const market: Market = coinConfig.market ?? "spot";

    const endTime = Date.now();
    const requestedStart = endTime - lookbackDays * 24 * 60 * 60 * 1000;
    const clamp = await clampStartToHistory(symbol, interval, requestedStart, endTime, market);
    const startedAt = Date.now();
    const bars = await fetchMoveBars(symbol, interval, clamp.start, endTime, market);

    const body = computeMoveProbability(bars, { thresholdPct, horizonBars });
    if (!body) {
      const listing =
        clamp.firstBarTime !== null
          ? `${symbol} only started trading on ${new Date(clamp.firstBarTime)
              .toISOString()
              .slice(0, 16)
              .replace("T", " ")} UTC.`
          : `No ${interval} history is available for ${symbol}.`;
      return res.status(422).json({
        error:
          `Only ${bars.length} ${interval} bars are available for ${symbol} over ${lookbackDays} days, ` +
          `and a +/-${thresholdPct}% move across ${horizonBars} bar(s) needs at least ` +
          `${MIN_MOVE_WINDOWS + horizonBars}. ${listing} Widen the lookback or shorten the horizon.`,
        symbol,
        interval,
        lookbackDays,
        bars: bars.length,
        horizonBars,
        firstBarTime: clamp.firstBarTime,
      });
    }

    const warnings: string[] = [];
    if (Math.abs(effectiveHorizonHours - horizonHours) > 1e-9) {
      warnings.push(
        `${horizonHours}h is not a whole number of ${interval} bars; reported at the nearest ` +
          `${horizonBars} bar(s) = ${effectiveHorizonHours}h.`
      );
    }
    if (clamp.clamped && clamp.firstBarTime !== null) {
      warnings.push(
        `Window starts at the ${symbol} listing date (${new Date(clamp.firstBarTime)
          .toISOString()
          .slice(0, 10)}) rather than the full ${lookbackDays} days requested.`
      );
    }
    if (body.designEffect > 2) {
      warnings.push(
        `Adjacent windows overlap heavily (design effect ${body.designEffect.toFixed(1)}): ` +
          `intervals use n_eff ${body.nEff.toFixed(0)} of ${body.nWindows} raw windows.`
      );
    }
    if (body.nEff < MIN_MOVE_WINDOWS) {
      warnings.push(
        `Effective sample ${body.nEff.toFixed(0)} is small: treat every interval here as wide.`
      );
    }

    const lastBar = bars[bars.length - 1];
    const asOf = {
      timestamp: lastBar.time + intervalMs,
      iso: new Date(lastBar.time + intervalMs).toISOString(),
      serverTime: Date.now(),
      barCount: bars.length,
    };
    const params = {
      symbol,
      interval,
      lookbackDays,
      thresholdPct,
      horizonHours,
      horizonBars,
      effectiveHorizonHours,
    };
    const caveats = [
      "Unconditional historical frequency over overlapping windows, not a conditional forecast: this describes how often the move happened in this window, not whether it is due now.",
      "Barriers are touched on the high/low basis (price traded there); the close-basis row shows how often a bar also settled beyond the level.",
      "Trailing-volatility terciles re-condition the estimate on today's regime, which is why the number moves between refreshes even when the price has not.",
    ];

    const payload: MoveProbabilityResponse | MoveProbabilityBrief =
      view === "brief"
        ? {
            symbol,
            params,
            bars: bars.length,
            lastPrice: lastBar.close,
            nWindows: body.nWindows,
            nEff: body.nEff,
            everTouch: body.everTouch,
            firstTouch: { up: body.firstTouch.up, down: body.firstTouch.down },
            asOf,
            warnings,
          }
        : {
            symbol,
            market,
            params,
            bars: bars.length,
            lastPrice: lastBar.close,
            asOf,
            warnings,
            caveats,
            ...body,
          };

    console.log(
      `Move prob ${symbol} @ ${interval} ±${thresholdPct}% x ${horizonBars} bars ` +
        `(${lookbackDays}d): ${body.nWindows} windows, ${Date.now() - startedAt}ms`
    );
    res.json(payload);
  } catch (error: any) {
    console.error("API move-prob failed:", error);
    res.status(500).json({ error: error.message || "Move probability calculation failed" });
  }
});

/* ------------------------------------------------------------------------- *
 * Liquidations (fused from liq-collector-main)
 *
 * The three venue websockets run inside this process (see
 * src/utils/liquidation_collectors.ts) and buffer into the ring store. These
 * routes serve the Liquidations page: per-coin tape for a searched symbol,
 * and the gainers/losers leaderboard measured against the previous matching
 * window. All three windows are cut on the receive clock; see the store for
 * the retention math that keeps the 24h baseline resident.
 *
 * Collection is deliberately independent of traffic: it starts with the
 * process and runs whether or not any user is looking, because this box is
 * meant to sit on GCloud collecting 24/7. Before the sockets open, the
 * durable log is replayed so a restart does not lose the multi-window
 * baseline (LIQ_PERSIST=0 disables it; LIQ_DATA_DIR relocates it).
 * ------------------------------------------------------------------------- */

startLiquidationPersistence(liquidationStore, {
  retentionMs: liqRetentionMs(),
  maxEvents: liqMaxEvents(),
});

/* ------------------------------------------------------------------------- *
 * CoinGecko id helper (coingecko_id_helper_spec.md)
 *
 * First thing at boot: load the persisted `venue symbol -> gecko id` map and,
 * when it is absent or stale, start rebuilding it in the background (the full
 * /coins/list is fetched first). The build never blocks `app.listen`; until it
 * finishes the position analyst keeps using the top-of-book symbol snapshot.
 * ------------------------------------------------------------------------- */

startCoinGeckoIdMap();

/* ------------------------------------------------------------------------- *
 * Position Analyst (position_analyst_spec.md)
 *
 * POST /api/position assembles the raw Binance feeds the engine needs, then
 * hands them to the pure `computePositionAnalysis`. Binance-only: multi-venue
 * OI/funding/breadth are reported as unavailable in the payload, not faked.
 * ------------------------------------------------------------------------- */

function numOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampNum(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

async function fetchJsonLoose(url: string): Promise<any | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** Binance order book snapshot, normalised to [price, qty] number pairs. */
async function fetchDepthSnapshot(symbol: string, market: Market): Promise<PositionDepthRaw | null> {
  const url =
    market === "futures"
      ? `https://fapi.binance.com/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=500`
      : `https://api.binance.com/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=500`;
  const data = await fetchJsonLoose(url);
  if (!data) return null;
  const toPairs = (rows: any): [number, number][] =>
    Array.isArray(rows)
      ? rows
          .map((r: any) => [Number(r[0]), Number(r[1])] as [number, number])
          .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
      : [];
  const bids = toPairs(data.bids);
  const asks = toPairs(data.asks);
  if (bids.length === 0 || asks.length === 0) return null;
  return { fetchedAt: Date.now(), venue: `binance-${market}`, bids, asks };
}

/**
 * Futures-side snapshot (mark, funding, open interest and its history). Called
 * regardless of the subject's venue so a spot pair still gets its perp's OI;
 * every sub-fetch tolerates failure and a total miss returns null.
 */
async function fetchFuturesSnapshot(symbol: string): Promise<PositionFuturesRaw | null> {
  const q = encodeURIComponent(symbol);
  const [premium, oi, oiHist, funding] = await Promise.all([
    fetchJsonLoose(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${q}`),
    fetchJsonLoose(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${q}`),
    fetchJsonLoose(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${q}&period=15m&limit=500`),
    fetchJsonLoose(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${q}&limit=100`),
  ]);
  if (!premium && !oi && !oiHist && !funding) return null;
  const num = (v: any): number | null => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    markPrice: num(premium?.markPrice),
    indexPrice: num(premium?.indexPrice),
    lastFundingRate: num(premium?.lastFundingRate),
    nextFundingTime: num(premium?.nextFundingTime),
    openInterestBase: num(oi?.openInterest),
    openInterestTime: num(oi?.time),
    oiHistory: Array.isArray(oiHist)
      ? oiHist
          .map((r: any) => ({
            time: Number(r.timestamp),
            sumOpenInterest: Number(r.sumOpenInterest),
            sumOpenInterestValue: Number(r.sumOpenInterestValue),
          }))
          .filter((r: any) => Number.isFinite(r.time) && Number.isFinite(r.sumOpenInterest))
      : [],
    fundingHistory: Array.isArray(funding)
      ? funding
          .map((r: any) => ({ time: Number(r.fundingTime), rate: Number(r.fundingRate) }))
          .filter((r: any) => Number.isFinite(r.time) && Number.isFinite(r.rate))
      : [],
  };
}

/**
 * Coerces a venue field to a finite number or null. A JSON string ("0.0123")
 * is accepted because Bybit/OKX/Hyperliquid all quote numerics as strings.
 */
function venueNum(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

interface VenueProbe {
  snapshot: PositionVenueSnapshot;
  maxLeverage: number | null;
}

/** Bybit v5 linear perp: OI (base + USD), 24h turnover, funding and mark. */
async function fetchBybitPerpSnapshot(baseAsset: string): Promise<VenueProbe> {
  const now = Date.now();
  const symbol = `${baseAsset}USDT`;
  const base: PositionVenueSnapshot = {
    venue: "bybit",
    marketType: "perp",
    oiUsd: null,
    oiBase: null,
    vol24Usd: null,
    markPrice: null,
    fundingRate: null,
    nextFundingTime: null,
    status: "failed",
    venueSymbol: symbol,
    fetchedAt: now,
  };
  const data = await fetchJsonLoose(
    `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${encodeURIComponent(symbol)}`
  );
  const list = data?.result?.list;
  if (!Array.isArray(list) || list.length === 0) {
    return {
      snapshot: {
        ...base,
        status: data == null ? "failed" : "not_listed",
        note: data == null ? "Bybit tickers request failed." : "Bybit linear tickers lists no such symbol.",
      },
      maxLeverage: null,
    };
  }
  const t = list[0];
  const markPrice = venueNum(t.markPrice) ?? venueNum(t.lastPrice);
  const oiBase = venueNum(t.openInterest);
  const oiUsd =
    venueNum(t.openInterestValue) ?? (oiBase != null && markPrice != null ? oiBase * markPrice : null);
  return {
    snapshot: {
      ...base,
      oiBase,
      oiUsd,
      vol24Usd: venueNum(t.turnover24h),
      markPrice,
      fundingRate: venueNum(t.fundingRate),
      nextFundingTime: venueNum(t.nextFundingTime),
      status: "ok",
      note: "Bybit v5 linear tickers.",
    },
    maxLeverage: null,
  };
}

/**
 * OKX SWAP snapshot. OI is converted contracts -> base via `ctVal × ctMult` and
 * base -> USD at the venue mark, matching the OKX UI's USD figure within 1%.
 */
async function fetchOkxPerpSnapshot(baseAsset: string): Promise<VenueProbe> {
  const now = Date.now();
  const instId = `${baseAsset}-USDT-SWAP`;
  const base: PositionVenueSnapshot = {
    venue: "okx",
    marketType: "perp",
    oiUsd: null,
    oiBase: null,
    vol24Usd: null,
    markPrice: null,
    fundingRate: null,
    nextFundingTime: null,
    status: "failed",
    venueSymbol: instId,
    fetchedAt: now,
  };
  const [oiRes, tickerRes, fundingRes, instrRes] = await Promise.all([
    fetchJsonLoose(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${encodeURIComponent(instId)}`),
    fetchJsonLoose(`https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`),
    fetchJsonLoose(`https://www.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`),
    fetchJsonLoose(`https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(instId)}`),
  ]);
  if (!oiRes && !tickerRes && !fundingRes && !instrRes) {
    return { snapshot: { ...base, note: "OKX requests failed." }, maxLeverage: null };
  }
  const instr = instrRes?.data?.[0];
  const ticker = tickerRes?.data?.[0];
  const oi = oiRes?.data?.[0];
  const funding = fundingRes?.data?.[0];
  if (!instr && !ticker) {
    return {
      snapshot: { ...base, status: "not_listed", note: "OKX SWAP instrument list has no such base." },
      maxLeverage: null,
    };
  }
  const markPrice = venueNum(ticker?.last);
  const ctVal = venueNum(instr?.ctVal);
  const ctMult = venueNum(instr?.ctMult) ?? 1;
  const oiContracts = venueNum(oi?.oi);
  const oiBase =
    venueNum(oi?.oiCcy) ?? (oiContracts != null && ctVal != null ? oiContracts * ctVal * ctMult : null);
  const oiUsd = venueNum(oi?.oiUsd) ?? (oiBase != null && markPrice != null ? oiBase * markPrice : null);
  const volCcy = venueNum(ticker?.volCcy24h);
  const vol24Usd = volCcy != null && markPrice != null ? volCcy * markPrice : null;
  return {
    snapshot: {
      ...base,
      oiBase,
      oiUsd,
      vol24Usd,
      markPrice,
      fundingRate: venueNum(funding?.fundingRate),
      nextFundingTime: venueNum(funding?.nextFundingTime),
      status: "ok",
      note: "OKX SWAP; OI converted via ctVal × ctMult.",
    },
    maxLeverage: venueNum(instr?.maxLeverage),
  };
}

/** Hyperliquid perp meta + contexts; handles the 1000×/k-prefixed names. */
async function fetchHyperliquidSnapshot(baseAsset: string): Promise<VenueProbe> {
  const now = Date.now();
  const base: PositionVenueSnapshot = {
    venue: "hyperliquid",
    marketType: "perp",
    oiUsd: null,
    oiBase: null,
    vol24Usd: null,
    markPrice: null,
    fundingRate: null,
    nextFundingTime: null,
    status: "failed",
    venueSymbol: `${baseAsset}USDT`,
    fetchedAt: now,
  };
  let payload: any = null;
  try {
    const response = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    });
    if (!response.ok) {
      return { snapshot: { ...base, note: `Hyperliquid HTTP ${response.status}.` }, maxLeverage: null };
    }
    payload = await response.json();
  } catch {
    return { snapshot: { ...base, note: "Hyperliquid request failed." }, maxLeverage: null };
  }
  const meta = payload?.[0];
  const ctxs = payload?.[1];
  if (!Array.isArray(meta?.universe) || !Array.isArray(ctxs)) {
    return { snapshot: { ...base, note: "Hyperliquid returned an unexpected payload." }, maxLeverage: null };
  }
  const candidates = [baseAsset, `k${baseAsset}`, `1000${baseAsset}`];
  let idx = -1;
  for (const name of candidates) {
    const found = meta.universe.findIndex((u: any) => u?.name === name);
    if (found >= 0) {
      idx = found;
      break;
    }
  }
  if (idx < 0) {
    return {
      snapshot: { ...base, status: "not_listed", note: "Base not in the Hyperliquid universe." },
      maxLeverage: null,
    };
  }
  const uni = meta.universe[idx];
  const ctx = ctxs[idx] ?? {};
  const markPrice = venueNum(ctx.markPx) ?? venueNum(ctx.oraclePx);
  const oiCoins = venueNum(ctx.openInterest);
  const oiUsd = oiCoins != null && markPrice != null ? oiCoins * markPrice : null;
  return {
    snapshot: {
      ...base,
      venueSymbol: `${uni.name}-PERP`,
      oiBase: oiCoins,
      oiUsd,
      vol24Usd: venueNum(ctx.dayNtlVlm),
      markPrice,
      fundingRate: venueNum(ctx.funding),
      nextFundingTime: null,
      status: "ok",
      note: "Hyperliquid metaAndAssetCtxs.",
    },
    maxLeverage: venueNum(uni.maxLeverage),
  };
}

/**
 * Assembles the four-venue perp snapshot. OI is summed across venues in USD by
 * the engine; here each venue reports its own honest status (`not_listed` only
 * when the venue's own list confirms absence).
 */
async function fetchVenueSnapshots(
  baseAsset: string,
  futures: PositionFuturesRaw | null,
  now: number
): Promise<{ snapshots: PositionVenueSnapshot[]; maxLeverage: number | null }> {
  const perpSymbol = `${baseAsset}USDT`;
  const [binanceTicker, bybit, okx, hyperliquid] = await Promise.all([
    fetchTicker24h(perpSymbol, "futures"),
    fetchBybitPerpSnapshot(baseAsset),
    fetchOkxPerpSnapshot(baseAsset),
    fetchHyperliquidSnapshot(baseAsset),
  ]);

  const binanceMark = futures?.markPrice ?? binanceTicker?.lastPrice ?? null;
  const binanceOiBase = futures?.openInterestBase ?? null;
  const binanceOiUsd =
    binanceOiBase != null && binanceMark != null ? binanceOiBase * binanceMark : null;
  const binanceStatus: PositionVenueStatus =
    futures != null || binanceTicker != null ? (binanceMark != null ? "ok" : "stale") : "not_listed";
  const binance: PositionVenueSnapshot = {
    venue: "binance",
    marketType: "perp",
    oiUsd: binanceOiUsd,
    oiBase: binanceOiBase,
    vol24Usd: binanceTicker?.quoteVolumeUsd ?? null,
    markPrice: binanceMark,
    fundingRate: futures?.lastFundingRate ?? null,
    nextFundingTime: futures?.nextFundingTime ?? null,
    status: binanceStatus,
    venueSymbol: perpSymbol,
    fetchedAt: now,
    note: binanceStatus === "not_listed" ? "No Binance USDT-M perp for this base." : "Binance USDT-M perpetual.",
  };

  const venueMax = Math.max(
    0,
    ...[okx.maxLeverage, hyperliquid.maxLeverage].filter((v): v is number => v != null && v > 0)
  );
  return {
    snapshots: [binance, bybit.snapshot, okx.snapshot, hyperliquid.snapshot],
    maxLeverage: venueMax > 0 ? venueMax : null,
  };
}

app.get("/api/position/mark", async (req, res) => {
  const symbol = normalizeLiqSymbol(String(req.query.symbol || ""));
  if (!/^[A-Z0-9]{4,24}$/.test(symbol)) {
    return res.status(400).json({ error: "A usable `symbol` query parameter is required." });
  }
  try {
    const market = await resolveMarket(symbol);
    const ticker = await fetchTicker24h(symbol, market);
    res.json({ symbol, market, mark: ticker?.lastPrice ?? null });
  } catch (error: any) {
    res.status(502).json({ error: error?.message || "Mark price unavailable." });
  }
});

app.post("/api/position", async (req, res) => {
  try {
    const body: any = req.body ?? {};
    const rawSymbol = String(body.symbol || "").trim().toUpperCase();
    if (!rawSymbol) {
      return res.status(400).json({ error: "`symbol` is required." });
    }
    const symbol = normalizeLiqSymbol(rawSymbol);
    if (!/^[A-Z0-9]{4,24}$/.test(symbol)) {
      return res.status(400).json({ error: `\`${rawSymbol}\` is not a usable ticker.` });
    }

    const side: PositionSide = body.side === "short" ? "short" : "long";
    const entry = numOrNull(body.entry);
    if (entry == null || entry <= 0) {
      return res.status(400).json({ error: "`entry` must be a positive number." });
    }

    const now = Date.now();

    // Probe the Binance USDT-M perp first: its presence decides the default
    // book. A leveraged position is analysed on the perp tape (P3); the caller
    // may override with an explicit `marketType`.
    const futures = await fetchFuturesSnapshot(symbol).catch(() => null);
    const perpExists =
      futures != null && (futures.markPrice != null || futures.openInterestBase != null);
    const requestedType: PositionMarketType | null =
      body.marketType === "spot" ? "spot" : body.marketType === "perp" ? "perp" : null;
    const marketType: PositionMarketType = requestedType ?? (perpExists ? "perp" : "spot");
    const market: Market = marketType === "perp" ? "futures" : "spot";
    // The opposite tape, for the spot-perp basis even when the subject is perp.
    const otherMarket: Market = marketType === "perp" ? "spot" : "futures";

    const config = await resolveCoinConfig(symbol);
    const baseAsset = config?.baseAsset ?? symbol.replace(/USDT$/, "");
    const baseMarket = await resolveBaseMarket("BTCUSDT", market);

    const startTime = now - MAX_LOOKBACK_DAYS["15m"] * 24 * 60 * 60 * 1000;

    const [klines, spotKlines, btcKlines, ticker, depth, mcapMap, venuePack] = await Promise.all([
      fetchKlinesRange(symbol, "15m", startTime, now, market).catch(() => [] as Kline[]),
      fetchKlinesRange(symbol, "15m", startTime, now, otherMarket).catch(() => [] as Kline[]),
      fetchKlinesRange("BTCUSDT", "15m", startTime, now, baseMarket).catch(() => [] as Kline[]),
      fetchTicker24h(symbol, market),
      fetchDepthSnapshot(symbol, market),
      fetchMcapSnapshot(),
      fetchVenueSnapshots(baseAsset, futures, now),
    ]);

    if (klines.length < 30) {
      return res.status(422).json({
        error: `Only ${klines.length} confirmed 15m bars are available for ${symbol}; not enough history to analyse.`,
      });
    }

    const mcap = mcapMap.get(baseAsset) ?? mcapMap.get(config?.baseAsset ?? baseAsset);

    const venues = venuePack.snapshots;
    // 24h volume summed across every reporting venue in USD (P3.2).
    const venueVolSum = venues.reduce((acc, v) => (v.vol24Usd != null ? acc + v.vol24Usd : acc), 0);
    const anyVenueVol = venues.some((v) => v.vol24Usd != null);
    const tickerAgg = {
      lastPrice: ticker?.lastPrice ?? (marketType === "perp" ? futures?.markPrice ?? null : null),
      quoteVolumeUsd: anyVenueVol ? venueVolSum : ticker?.quoteVolumeUsd ?? null,
    };

    // CoinGecko id-map fallback (coingecko_id_helper_spec.md). The top-of-book
    // snapshot only covers the first few hundred coins; for anything it missed,
    // resolve the coin's gecko id from the id map built at startup and fetch the
    // market cap by id. A coin with no confident match stays null (never guessed).
    let mcapUsd = mcap?.marketCap ?? null;
    if (mcapUsd == null) {
      const gecko = await resolveGeckoMcap({
        baseAsset,
        venue: "binance",
        venueSymbol: symbol,
        venuePrice: futures?.markPrice ?? tickerAgg.lastPrice ?? null,
      }).catch(() => null);
      if (gecko?.marketCapUsd != null) mcapUsd = gecko.marketCapUsd;
    }

    // Liquidation baseline over the WHOLE retained buffer (not the 24h slice),
    // so an in-process read reflects durable history replayed at boot (P4.1).
    const liqEvents = liquidationStore.eventsFor(symbol, 0, now);
    const liqBaseline =
      liqEvents.length > 0
        ? {
            events: liqEvents.length,
            spanMs: liqEvents[liqEvents.length - 1].receivedAtMs - liqEvents[0].receivedAtMs,
            firstMs: liqEvents[0].receivedAtMs,
          }
        : { events: 0, spanMs: 0, firstMs: null };

    const manualRaw: any = body.manual ?? {};
    const manual = {
      markPrice: numOrNull(manualRaw.markPrice),
      oiUsd: numOrNull(manualRaw.oiUsd),
      vol24Usd: numOrNull(manualRaw.vol24Usd),
      mcapUsd: numOrNull(manualRaw.mcapUsd),
      sigmaDay: numOrNull(manualRaw.sigmaDay),
      yImpact: numOrNull(manualRaw.yImpact),
      liqFraction: numOrNull(manualRaw.liqFraction),
      locks: Array.isArray(manualRaw.locks) ? manualRaw.locks.map((x: any) => String(x)) : [],
    };

    const input: PositionInput = {
      symbol,
      side,
      entry,
      takeProfit: numOrNull(body.takeProfit),
      stopLoss: numOrNull(body.stopLoss),
      size: numOrNull(body.size),
      leverage: numOrNull(body.leverage),
      openedAt: numOrNull(body.openedAt),
      horizonHours: clampNum(numOrNull(body.horizonHours) ?? 12, 1, 72),
      feeBpsOneSide: clampNum(numOrNull(body.feeBpsOneSide) ?? 5, 0, 100),
      slippageBps: clampNum(numOrNull(body.slippageBps) ?? 0, 0, 500),
      marketType,
      // Cap the modelled liquidation tiers at the symbol's real max leverage.
      maxLeverage: numOrNull(body.maxLeverage) ?? venuePack.maxLeverage,
      referencePrice: numOrNull(body.referencePrice),
    };

    const inputs: PositionAnalystInputs = {
      now,
      symbol,
      market,
      marketType,
      baseAsset,
      name: config?.name ?? baseAsset,
      input,
      klines,
      btcKlines,
      spotKlines,
      depth,
      futures,
      liq: liquidationStore.coin(symbol, "24h"),
      liqBaseline,
      mcapUsd,
      ticker: tickerAgg,
      firstBarTime: config?.firstBarTime ?? null,
      historyClamped: false,
      venues,
      manual,
    };

    const analysis: PositionAnalysisResponse = computePositionAnalysis(inputs);
    res.json(analysis);
  } catch (error: any) {
    console.error("Position analysis failed:", error?.message || error);
    res.status(500).json({ error: error?.message || "Position analysis failed." });
  }
});

// CoinGecko id helper: build status + manual id override (Data Health card).
app.get("/api/coingecko/status", (_req, res) => {
  res.json(coinGeckoStatus());
});

app.post("/api/coingecko/refresh", async (_req, res) => {
  try {
    await refreshCoinGeckoIdMap();
    res.json(coinGeckoStatus());
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "CoinGecko id-map refresh failed." });
  }
});

app.post("/api/coingecko/override", (req, res) => {
  const key = String(req.body?.key || "").trim();
  const geckoId = String(req.body?.geckoId || "").trim();
  if (!key || !geckoId) {
    return res.status(400).json({ error: "`key` and `geckoId` are required." });
  }
  setGeckoOverride(key, geckoId, String(req.body?.note || "") || undefined);
  res.json(coinGeckoStatus());
});

app.delete("/api/coingecko/override", (req, res) => {
  const key = String(req.body?.key || req.query?.key || "").trim();
  if (!key) return res.status(400).json({ error: "`key` is required." });
  clearGeckoOverride(key);
  res.json(coinGeckoStatus());
});

// Feed health: per-venue connection state, buffer size, oldest event age.
app.get("/api/liq/status", (_req, res) => {
  res.json({ ...liquidationStore.status(), persistence: liquidationPersistenceInfo() });
});

// Gainers/losers leaderboard: ?window=1h|4h|24h (default 1h).
app.get("/api/liq/leaders", (req, res) => {
  const window: LiqWindow = parseLiqWindow(req.query.window) ?? "1h";
  res.json(liquidationStore.leaders(window));
});

// One coin's liquidation tape: ?symbol=ETH (or ETHUSDT / BTC-USDT-SWAP).
app.get("/api/liq/coin", (req, res) => {
  const raw = String(req.query.symbol || "").trim();
  if (!raw) {
    return res.status(400).json({ error: "A `symbol` query parameter is required." });
  }
  const symbol = normalizeLiqSymbol(raw);
  if (!/^[A-Z0-9]{2,20}$/.test(symbol)) {
    return res.status(400).json({ error: `\`${raw}\` is not a usable ticker.` });
  }
  const window: LiqWindow = parseLiqWindow(req.query.window) ?? "1h";
  res.json(liquidationStore.coin(symbol, window));
});

/**
 * Chart timeframes for the heatmap. The chart picks its own candle interval
 * independently of the page window, so each interval carries the lookback
 * span that keeps it to a healthy number of bars (4h/12h/24h/48h). Spans are
 * additionally clamped to the liquidation retention, since prints older than
 * retention cannot appear in the map anyway.
 */
const LIQ_HEATMAP_TIMEFRAMES: Record<string, { interval: string; barMs: number; spanMs: number }> = {
  "1m": { interval: "1m", barMs: 60_000, spanMs: 24 * 60 * 60 * 1000 },
  "5m": { interval: "5m", barMs: 5 * 60_000, spanMs: 48 * 60 * 60 * 1000 },
  "15m": { interval: "15m", barMs: 15 * 60_000, spanMs: 3 * 24 * 60 * 60 * 1000 },
  "1h": { interval: "1h", barMs: 60 * 60_000, spanMs: 7 * 24 * 60 * 60 * 1000 },
  "4h": { interval: "4h", barMs: 4 * 60 * 60_000, spanMs: 14 * 24 * 60 * 60 * 1000 },
  "1d": { interval: "1d", barMs: 24 * 60 * 60_000, spanMs: 30 * 24 * 60 * 60 * 1000 },
};

/** Interval each page window defaults to, preserving the pre-timeframe look. */
const LIQ_HEATMAP_DEFAULT_INTERVAL: Record<LiqWindow, string> = {
  "1h": "1m",
  "4h": "5m",
  "24h": "15m",
};

/** Price buckets the heatmap bands are cut into. */
const LIQ_HEATMAP_BUCKETS = 90;

/**
 * Cap on the raw prints echoed to the client. The bucketed bands always cover
 * the whole slice; the ladder chart only needs enough prints to draw its
 * lines, and a 24h window on a cascading coin can otherwise run to hundreds
 * of thousands of rows. The NEWEST events are kept.
 */
const LIQ_HEATMAP_EVENT_CAP = 20_000;

/**
 * One-shot kline pull for the heatmap. Deliberately separate from
 * fetchKlinesRange: that helper is interval-enum bound, while the heatmap
 * wants 1m/5m frames the rest of the terminal never requests.
 */
async function fetchHeatmapCandles(
  symbol: string,
  interval: string,
  barMs: number,
  startTime: number,
  endTime: number,
  market: Market
): Promise<Kline[]> {
  const url =
    `${VENUE_KLINE_URL[market]}?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${interval}&startTime=${Math.floor(startTime)}&endTime=${Math.floor(endTime)}&limit=1000`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Binance ${market} returned HTTP status ${response.status}`);
  }
  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("Unexpected kline payload");
  }
  const cutoff = Date.now() - barMs;
  return mapKlines(data).filter((k) => k.time <= cutoff);
}

/**
 * GET /api/liq/heatmap: the per-coin candlestick plus liquidation-intensity
 * bands. Candle fetch failure is non-fatal — the levels are the point of the
 * chart, so a venue hiccup still returns the liquidation map with no candles.
 */
app.get("/api/liq/heatmap", async (req, res) => {
  try {
    const raw = String(req.query.symbol || "").trim();
    let symbol = normalizeLiqSymbol(raw);
    if (symbol && !symbol.endsWith("USDT")) symbol = `${symbol}USDT`;
    if (!symbol) {
      return res.status(400).json({ error: "A usable `symbol` query parameter is required." });
    }
    const window: LiqWindow = parseLiqWindow(req.query.window) ?? "1h";
    // Chart-local timeframe: an unknown/absent interval falls back to the one
    // the page window used to imply, so older clients keep working unchanged.
    const requestedTf = String(req.query.interval || "").toLowerCase();
    const tfKey = Object.prototype.hasOwnProperty.call(LIQ_HEATMAP_TIMEFRAMES, requestedTf)
      ? requestedTf
      : LIQ_HEATMAP_DEFAULT_INTERVAL[window];
    const { interval, barMs, spanMs } = LIQ_HEATMAP_TIMEFRAMES[tfKey];

    // Market routing only, never a gate: the catalog omits the benchmark
    // ticker (BTCUSDT) and any pair not yet listed, but the liquidation tape
    // is keyed by ticker the same way /api/liq/coin is. Unresolved symbols
    // fall back to spot, and a genuinely unknown ticker is caught below once
    // both the candle pull and the tape come back empty.
    const coinConfig = await resolveCoinConfig(symbol);
    const market: Market = coinConfig?.market ?? "spot";

    const now = Date.now();
    const windowStart = now - Math.min(spanMs, liqRetentionMs());

    let candles: LiqHeatmapCandle[] = [];
    try {
      const klines = await fetchHeatmapCandles(symbol, interval, barMs, windowStart, now, market);
      candles = klines.map((k) => ({
        time: k.time,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volume,
      }));
    } catch (error: any) {
      console.warn(`Heatmap candles unavailable for ${symbol}: ${error.message}`);
    }

    const events = liquidationStore.eventsFor(symbol, windowStart, now, LIQ_HEATMAP_EVENT_CAP);

    // No tape and no venue candles: the ticker does not exist anywhere we
    // read. Distinguishes a typo from a real coin whose venue hiccuped.
    if (candles.length === 0 && events.length === 0) {
      return res.status(404).json({ error: `No market data found for ${symbol}.` });
    }

    // Bucket across the union of the candle range and the liquidation prices,
    // so a level below/above the visible candles still lands somewhere.
    let minPrice = Infinity;
    let maxPrice = -Infinity;
    for (const k of candles) {
      if (k.low < minPrice) minPrice = k.low;
      if (k.high > maxPrice) maxPrice = k.high;
    }
    for (const event of events) {
      if (!(event.price > 0)) continue;
      if (event.price < minPrice) minPrice = event.price;
      if (event.price > maxPrice) maxPrice = event.price;
    }
    if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice)) {
      minPrice = 0;
      maxPrice = 1;
    }
    if (!(maxPrice > minPrice)) maxPrice = minPrice + 1;

    const step = (maxPrice - minPrice) / LIQ_HEATMAP_BUCKETS;
    const buckets: LiqHeatmapLevel[] = Array.from({ length: LIQ_HEATMAP_BUCKETS }, (_, i) => ({
      price: minPrice + (i + 0.5) * step,
      low: minPrice + i * step,
      high: minPrice + (i + 1) * step,
      notional: 0,
      longNotional: 0,
      shortNotional: 0,
      events: 0,
    }));

    let eventCount = 0;
    let notional = 0;
    for (const event of events) {
      if (!(event.price > 0)) continue;
      let idx = Math.floor((event.price - minPrice) / step);
      if (idx < 0) idx = 0;
      else if (idx >= LIQ_HEATMAP_BUCKETS) idx = LIQ_HEATMAP_BUCKETS - 1;
      const bucket = buckets[idx];
      bucket.notional += event.notional;
      bucket.events += 1;
      if (event.position === "long") bucket.longNotional += event.notional;
      else if (event.position === "short") bucket.shortNotional += event.notional;
      eventCount += 1;
      notional += event.notional;
    }

    const levels = buckets.filter((b) => b.events > 0);
    const maxLevelNotional = levels.reduce((m, b) => Math.max(m, b.notional), 0);

    // Prints with no usable price cannot be placed on a ladder, so they are
    // counted above but not echoed here.
    const chartEvents: LiqHeatmapEvent[] = events
      .filter((event) => event.price > 0)
      .map((event) => ({
        t: event.receivedAtMs,
        et: event.eventTimeMs,
        exchange: event.exchange,
        position: event.position,
        price: event.price,
        qty: event.qty,
        notional: event.notional,
      }));

    const payload: LiqHeatmapResponse = {
      symbol,
      interval,
      barMs,
      window,
      windowStart,
      windowEnd: now,
      candles,
      levels,
      maxLevelNotional,
      events: chartEvents,
      eventCount,
      notional,
      retentionHours: liqRetentionMs() / 3_600_000,
    };
    res.json(payload);
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Heatmap build failed" });
  }
});

// Liveness probe for Cloud Run / any container orchestrator. Deliberately does
// not touch Binance: an upstream outage should not get the container recycled.
app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", uptimeSeconds: Math.round(process.uptime()) });
});

// Setup Vite & Static Assets serving
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    // Development Mode with Vite HMR.
    // Vite is imported lazily and only here. It is a build-time tool excluded
    // from the production image, and esbuild's --packages=external turns a
    // top-level import into a require() that runs at startup - which would throw
    // "Cannot find module 'vite'" in the container before it ever listens.
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production Mode
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Liquidation collectors (fused liq-collector). LIQ_COLLECT=0 serves a
  // buffered tape without opening venue sockets (tests, offline debugging).
  if (process.env.LIQ_COLLECT === "0") {
    console.log("Liquidation collectors disabled (LIQ_COLLECT=0).");
  } else {
    startLiquidationCollectors();
    console.log("Liquidation collectors online (Binance, Bybit, OKX).");
  }

  // Always-on automated scanner. Starts after the store replay so the first
  // sweep sees a settled process; AUTO_SCAN=0 skips it for tests.
  startAutoScanner();

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Crypto Quant Server active on http://0.0.0.0:${PORT} (${process.env.NODE_ENV === "production" ? "production" : "development"})`);
  });

  // Cloud Run sends SIGTERM before shutting an instance down. Stop accepting
  // connections so in-flight requests finish instead of being cut off.
  const shutdown = (signal: string) => {
    console.log(`${signal} received, draining connections...`);
    stopLiquidationCollectors();
    stopLiquidationPersistence();
    stopAutoScanner();
    server.close(() => {
      console.log("HTTP server closed.");
      process.exit(0);
    });
    // Do not hang forever on a stuck upstream connection
    setTimeout(() => {
      console.error("Forced shutdown after drain timeout.");
      process.exit(1);
    }, 10000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

startServer();
