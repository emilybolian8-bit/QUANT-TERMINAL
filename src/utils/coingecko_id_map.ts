/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CoinGecko id helper.
 *
 * When the terminal cannot get a market cap for a coin, the missing piece is
 * usually the CoinGecko `id`: the top-of-book symbol snapshot only covers the
 * first few hundred coins, and tickers are not unique off-exchange. This module
 * builds a local `venue symbol -> gecko id` map once at startup (top ~1,100
 * coins plus the full id list as a fallback pool), scores every candidate, and
 * then serves market caps by id for coins the snapshot missed.
 *
 * Design notes:
 *  - Storage is a single JSON file (matching the liquidation-persistence house
 *    style) rather than SQLite, so there is no native dependency.
 *  - The startup build is asynchronous and never blocks `app.listen`; until the
 *    map is ready the position analyst keeps using the old symbol snapshot.
 *  - The full id list is fetched first, exactly as the spec requires.
 *  - A coin that cannot be matched confidently returns `unavailable`; nothing
 *    is ever guessed.
 *
 * Env:
 *  - COINGECKO_DISABLE=1        skip the startup build entirely
 *  - COINGECKO_API_KEY          optional demo/pro key (sent as x-cg-demo-api-key)
 *  - COINGECKO_BASE_URL         default https://api.coingecko.com/api/v3
 *  - COINGECKO_DATA_FILE        default <cwd>/data/coingecko.json
 *  - COINGECKO_RPM              requests per minute, default 10 (public tier)
 *  - COINGECKO_TOP_N            coins in the top set, default 1100
 *  - COINGECKO_REFRESH_DAYS     id-map refresh cadence, default 7
 *  - COINGECKO_MCAP_TTL_SECONDS market-cap cache TTL, default 600
 */

import fs from "fs";
import path from "path";
import {
  DEFAULT_MATCH_CONFIG,
  matchCoin,
  normalizeVenueSymbol,
  type GeckoCandidate,
  type GeckoMatchConfig,
  type GeckoMatchStatus,
  type MatchResult,
  type NormalizedVenueInput,
} from "./coingecko_matcher";

export type { GeckoMatchStatus };

/* -------------------------------------------------------------------------- *
 * Persistent shapes (mirror the spec's tables).
 * -------------------------------------------------------------------------- */

export interface GeckoCoinRecord {
  geckoId: string;
  symbol: string;
  name: string;
  marketCapRank: number | null;
  marketCapUsd: number | null;
  priceUsd: number | null;
  totalVolumeUsd: number | null;
  updatedAt: string;
}

export interface GeckoAllIdRecord {
  id: string;
  symbol: string;
  name: string;
}

export interface SymbolMapRow {
  venue: string;
  venueSymbol: string;
  baseAsset: string;
  multiplier: number;
  geckoId: string | null;
  confidence: number | null;
  method: string | null;
  status: GeckoMatchStatus;
  runnerUpId: string | null;
  runnerUpScore: number | null;
  reasons: string[];
  matchedAt: string | null;
}

export interface GeckoOverride {
  geckoId: string;
  locked: boolean;
  enteredAt: string;
  note?: string;
}

export interface McapCacheRow {
  geckoId: string;
  marketCap: number | null;
  fdv: number | null;
  circulatingSupply: number | null;
  totalSupply: number | null;
  maxSupply: number | null;
  priceUsd: number | null;
  fetchedAt: string;
  status: string;
}

interface GeckoStore {
  version: 1;
  builtAt: string | null;
  coins: Record<string, GeckoCoinRecord>;
  allIds: GeckoAllIdRecord[];
  symbolMap: Record<string, SymbolMapRow>;
  overrides: Record<string, GeckoOverride>;
  mcapCache: Record<string, McapCacheRow>;
}

export interface CoinGeckoStatus {
  enabled: boolean;
  building: boolean;
  builtAt: string | null;
  ageSeconds: number | null;
  coins: number;
  allIds: number;
  symbols: number;
  matched: number;
  review: number;
  unmatched: number;
  locked: number;
  overrides: number;
  lastError: string | null;
  dataFile: string;
  baseUrl: string;
}

export interface GeckoMcapResult {
  geckoId: string | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  circulatingSupply: number | null;
  priceUsd: number | null;
  status: "ok" | "derived" | "null_mcap" | "failed" | "price_mismatch" | "unavailable";
  reason?: string;
}

export interface ResolveMcapQuery {
  baseAsset?: string | null;
  venue?: string | null;
  venueSymbol?: string | null;
  venuePrice?: number | null;
}

interface UniverseInstrument {
  venue: string;
  venueSymbol: string;
  baseAsset: string | null;
  price: number | null;
  vol24Usd: number | null;
}

/* -------------------------------------------------------------------------- *
 * Config.
 * -------------------------------------------------------------------------- */

function baseUrl(): string {
  return process.env.COINGECKO_BASE_URL || "https://api.coingecko.com/api/v3";
}

function dataFile(): string {
  return process.env.COINGECKO_DATA_FILE || path.join(process.cwd(), "data", "coingecko.json");
}

function requestsPerMinute(): number {
  return Math.max(1, Number(process.env.COINGECKO_RPM) || 10);
}

function topN(): number {
  return Math.max(1, Number(process.env.COINGECKO_TOP_N) || 1100);
}

function refreshDays(): number {
  return Math.max(1, Number(process.env.COINGECKO_REFRESH_DAYS) || 7);
}

function mcapTtlMs(): number {
  return Math.max(30, Number(process.env.COINGECKO_MCAP_TTL_SECONDS) || 600) * 1000;
}

const MATCH_CONFIG: GeckoMatchConfig = DEFAULT_MATCH_CONFIG;
const PAGE_SIZE = 250;

/* -------------------------------------------------------------------------- *
 * Store.
 * -------------------------------------------------------------------------- */

function emptyStore(): GeckoStore {
  return {
    version: 1,
    builtAt: null,
    coins: {},
    allIds: [],
    symbolMap: {},
    overrides: {},
    mcapCache: {},
  };
}

let store: GeckoStore = emptyStore();
let loaded = false;
let building = false;
let lastError: string | null = null;

function loadStore(): void {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(dataFile(), "utf8")) as Partial<GeckoStore>;
    store = {
      ...emptyStore(),
      ...parsed,
      coins: parsed.coins ?? {},
      allIds: parsed.allIds ?? [],
      symbolMap: parsed.symbolMap ?? {},
      overrides: parsed.overrides ?? {},
      mcapCache: parsed.mcapCache ?? {},
    };
  } catch {
    // No file yet (first run) or a corrupt file: start empty and rebuild.
    store = emptyStore();
  }
}

/** Writes through a temp file + rename so a crash never truncates the store. */
function saveStore(): void {
  const file = dataFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, file);
  } catch (err: any) {
    lastError = `store write failed: ${err?.message || err}`;
  }
}

/* -------------------------------------------------------------------------- *
 * Rate-limited fetch with exponential backoff.
 * -------------------------------------------------------------------------- */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const limiter = { tokens: requestsPerMinute(), last: Date.now() };

async function throttle(): Promise<void> {
  const rpm = requestsPerMinute();
  const now = Date.now();
  limiter.tokens = Math.min(rpm, limiter.tokens + ((now - limiter.last) / 60_000) * rpm);
  limiter.last = now;
  if (limiter.tokens < 1) {
    const waitMs = Math.ceil(((1 - limiter.tokens) / rpm) * 60_000);
    await sleep(waitMs);
    limiter.tokens = 0;
    limiter.last = Date.now();
  } else {
    limiter.tokens -= 1;
  }
}

async function geckoFetch(pathAndQuery: string, attempt = 0): Promise<any> {
  await throttle();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    const key = process.env.COINGECKO_API_KEY;
    if (key) headers["x-cg-demo-api-key"] = key;
    const response = await fetch(`${baseUrl()}${pathAndQuery}`, {
      signal: controller.signal,
      headers,
    });
    if (response.status === 429 || response.status >= 500) {
      throw new Error(`HTTP ${response.status}`);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err: any) {
    if (attempt < 3) {
      await sleep(1000 * 2 ** attempt + Math.floor(Math.random() * 250));
      return geckoFetch(pathAndQuery, attempt + 1);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Plain JSON fetch for the exchange (non-CoinGecko) universe endpoints. */
async function httpJson(url: string, init?: RequestInit): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function numOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function symbolKeyOf(venue: string, venueSymbol: string): string {
  return `${venue}:${venueSymbol}`;
}

/* -------------------------------------------------------------------------- *
 * Build steps.
 * -------------------------------------------------------------------------- */

async function fetchAllIds(): Promise<void> {
  const rows = await geckoFetch("/coins/list");
  if (!Array.isArray(rows)) throw new Error("coins/list returned an unexpected payload");
  store.allIds = rows
    .map((coin: any) => ({
      id: String(coin?.id ?? ""),
      symbol: String(coin?.symbol ?? "").toLowerCase(),
      name: String(coin?.name ?? ""),
    }))
    .filter((coin) => coin.id.length > 0 && coin.symbol.length > 0);
  saveStore();
}

async function fetchTopCoins(): Promise<void> {
  const coins: Record<string, GeckoCoinRecord> = {};
  const limit = topN();
  for (let page = 1; Object.keys(coins).length < limit && page <= 20; page += 1) {
    const rows = await geckoFetch(
      `/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${PAGE_SIZE}&page=${page}&sparkline=false`
    );
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const coin of rows) {
      if (Object.keys(coins).length >= limit) break;
      const id = String(coin?.id ?? "");
      if (!id) continue;
      coins[id] = {
        geckoId: id,
        symbol: String(coin?.symbol ?? "").toLowerCase(),
        name: String(coin?.name ?? ""),
        marketCapRank: numOrNull(coin?.market_cap_rank),
        marketCapUsd: numOrNull(coin?.market_cap),
        priceUsd: numOrNull(coin?.current_price),
        totalVolumeUsd: numOrNull(coin?.total_volume),
        updatedAt: new Date().toISOString(),
      };
    }
    store.coins = coins;
    saveStore(); // Write after every page so an interrupted build resumes.
    if (rows.length < PAGE_SIZE) break;
  }
}

async function binanceUniverse(): Promise<UniverseInstrument[]> {
  const [info, tickers] = await Promise.all([
    httpJson("https://fapi.binance.com/fapi/v1/exchangeInfo"),
    httpJson("https://fapi.binance.com/fapi/v1/ticker/24hr"),
  ]);
  if (!info || !Array.isArray(info.symbols)) return [];
  const prices = new Map<string, { price: number | null; vol: number | null }>();
  if (Array.isArray(tickers)) {
    for (const t of tickers) {
      prices.set(String(t.symbol), { price: numOrNull(t.lastPrice), vol: numOrNull(t.quoteVolume) });
    }
  }
  return info.symbols
    .filter(
      (s: any) =>
        s.quoteAsset === "USDT" &&
        s.status === "TRADING" &&
        (s.contractType === "PERPETUAL" || s.contractType == null)
    )
    .map((s: any) => {
      const t = prices.get(String(s.symbol));
      return {
        venue: "binance",
        venueSymbol: String(s.symbol),
        baseAsset: String(s.baseAsset ?? "") || null,
        price: t?.price ?? null,
        vol24Usd: t?.vol ?? null,
      };
    });
}

async function bybitUniverse(): Promise<UniverseInstrument[]> {
  const [info, tickers] = await Promise.all([
    httpJson("https://api.bybit.com/v5/market/instruments-info?category=linear"),
    httpJson("https://api.bybit.com/v5/market/tickers?category=linear"),
  ]);
  const list = info?.result?.list;
  if (!Array.isArray(list)) return [];
  const prices = new Map<string, { price: number | null; vol: number | null }>();
  if (Array.isArray(tickers?.result?.list)) {
    for (const t of tickers.result.list) {
      prices.set(String(t.symbol), { price: numOrNull(t.lastPrice), vol: numOrNull(t.turnover24h) });
    }
  }
  return list
    .filter((s: any) => s.quoteCoin === "USDT" && (s.status == null || s.status === "Trading"))
    .map((s: any) => {
      const t = prices.get(String(s.symbol));
      return {
        venue: "bybit",
        venueSymbol: String(s.symbol),
        baseAsset: String(s.baseCoin ?? "") || null,
        price: t?.price ?? null,
        vol24Usd: t?.vol ?? null,
      };
    });
}

async function okxUniverse(): Promise<UniverseInstrument[]> {
  const [info, tickers] = await Promise.all([
    httpJson("https://www.okx.com/api/v5/public/instruments?instType=SWAP"),
    httpJson("https://www.okx.com/api/v5/market/tickers?instType=SWAP"),
  ]);
  const list = info?.data;
  if (!Array.isArray(list)) return [];
  const prices = new Map<string, { price: number | null; vol: number | null }>();
  if (Array.isArray(tickers?.data)) {
    for (const t of tickers.data) {
      prices.set(String(t.instId), { price: numOrNull(t.last), vol: numOrNull(t.volCcy24h) });
    }
  }
  return list
    .filter((s: any) => s.state === "live" && (s.settleCcy === "USDT" || s.quoteCcy === "USDT"))
    .map((s: any) => {
      const t = prices.get(String(s.instId));
      return {
        venue: "okx",
        venueSymbol: String(s.instId),
        baseAsset: String(s.baseCcy ?? "") || null,
        price: t?.price ?? null,
        vol24Usd: t?.vol ?? null,
      };
    });
}

async function hyperliquidUniverse(): Promise<UniverseInstrument[]> {
  const data = await httpJson("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  });
  if (!Array.isArray(data) || !Array.isArray(data[0]?.universe) || !Array.isArray(data[1])) {
    return [];
  }
  const universe = data[0].universe as any[];
  const contexts = data[1] as any[];
  return universe.map((u, i) => ({
    venue: "hyperliquid",
    venueSymbol: String(u?.name ?? ""),
    baseAsset: String(u?.name ?? "") || null,
    price: numOrNull(contexts[i]?.markPx),
    vol24Usd: numOrNull(contexts[i]?.dayNtlVlm),
  }));
}

async function fetchUniverse(): Promise<UniverseInstrument[]> {
  const results = await Promise.all([
    binanceUniverse().catch(() => []),
    bybitUniverse().catch(() => []),
    okxUniverse().catch(() => []),
    hyperliquidUniverse().catch(() => []),
  ]);
  return results.flat();
}

function toCandidate(coin: GeckoCoinRecord): GeckoCandidate {
  return {
    geckoId: coin.geckoId,
    symbol: coin.symbol,
    name: coin.name,
    marketCapRank: coin.marketCapRank,
    marketCapUsd: coin.marketCapUsd,
    priceUsd: coin.priceUsd,
    totalVolumeUsd: coin.totalVolumeUsd,
  };
}

/** Top-set candidates for a base asset; the pool is the full id list minus. */
function candidatesFor(baseAsset: string, pool: boolean): GeckoCandidate[] {
  const symbol = baseAsset.toLowerCase();
  if (!pool) {
    return Object.values(store.coins)
      .filter((coin) => coin.symbol === symbol)
      .map(toCandidate);
  }
  const inTop = new Set(Object.values(store.coins).map((c) => c.geckoId));
  return store.allIds
    .filter((row) => row.symbol === symbol && !inTop.has(row.id))
    .map((row) => ({
      geckoId: row.id,
      symbol: row.symbol,
      name: row.name,
      marketCapRank: null,
      marketCapUsd: null,
      priceUsd: null,
      totalVolumeUsd: null,
    }));
}

async function buildUniverseAndMatch(): Promise<void> {
  const universe = await fetchUniverse();
  const nowIso = new Date().toISOString();
  const map: Record<string, SymbolMapRow> = { ...store.symbolMap };

  for (const instrument of universe) {
    if (!instrument.venueSymbol) continue;

    // A locked manual override always wins and is never overwritten.
    const override =
      store.overrides[instrument.venueSymbol] ??
      store.overrides[symbolKeyOf(instrument.venue, instrument.venueSymbol)];

    const normalized = normalizeVenueSymbol(
      instrument.venue,
      instrument.venueSymbol,
      instrument.baseAsset
    );

    if (override) {
      map[symbolKeyOf(instrument.venue, instrument.venueSymbol)] = {
        venue: instrument.venue,
        venueSymbol: instrument.venueSymbol,
        baseAsset: normalized.baseAsset,
        multiplier: normalized.multiplier,
        geckoId: override.geckoId,
        confidence: 1,
        method: "manual",
        status: "locked",
        runnerUpId: null,
        runnerUpScore: null,
        reasons: ["locked manual override"],
        matchedAt: nowIso,
      };
      continue;
    }

    const input: NormalizedVenueInput = {
      venue: instrument.venue,
      venueSymbol: instrument.venueSymbol,
      baseAsset: normalized.baseAsset,
      multiplier: normalized.multiplier,
      price: instrument.price,
      vol24Usd: instrument.vol24Usd,
    };

    const top = candidatesFor(normalized.baseAsset, false);
    const pool = top.length === 0 ? candidatesFor(normalized.baseAsset, true) : [];
    const result: MatchResult = matchCoin(input, top, pool, MATCH_CONFIG);

    map[symbolKeyOf(instrument.venue, instrument.venueSymbol)] = {
      venue: result.venue,
      venueSymbol: result.venueSymbol,
      baseAsset: result.baseAsset,
      multiplier: result.multiplier,
      geckoId: result.geckoId,
      confidence: result.confidence,
      method: result.method,
      status: result.status,
      runnerUpId: result.runnerUpId,
      runnerUpScore: result.runnerUpScore,
      reasons: result.reasons,
      matchedAt: nowIso,
    };
  }

  store.symbolMap = map;
  saveStore();
}

/* -------------------------------------------------------------------------- *
 * Build orchestration.
 * -------------------------------------------------------------------------- */

export async function buildIdMap(): Promise<CoinGeckoStatus> {
  if (process.env.COINGECKO_DISABLE === "1") return coinGeckoStatus();
  loadStore();
  if (building) return coinGeckoStatus();
  building = true;
  lastError = null;
  const startedAt = Date.now();
  try {
    // The full id list is fetched first, exactly as the spec requires.
    await fetchAllIds();
    await fetchTopCoins();
    await buildUniverseAndMatch();
    store.builtAt = new Date().toISOString();
    saveStore();
    console.log(
      `CoinGecko id-map built in ${Date.now() - startedAt}ms: ` +
        `${Object.keys(store.coins).length} top coins, ${store.allIds.length} ids, ` +
        `${Object.keys(store.symbolMap).length} mapped symbols.`
    );
  } catch (err: any) {
    lastError = `build failed: ${err?.message || err}`;
    console.warn(`CoinGecko id-map: ${lastError}. Continuing with whatever is on disk.`);
    saveStore();
  } finally {
    building = false;
  }
  return coinGeckoStatus();
}

export function coinGeckoStatus(): CoinGeckoStatus {
  const rows = Object.values(store.symbolMap);
  const counts = { matched: 0, review: 0, unmatched: 0, locked: 0 };
  for (const row of rows) counts[row.status] += 1;
  return {
    enabled: process.env.COINGECKO_DISABLE !== "1",
    building,
    builtAt: store.builtAt,
    ageSeconds: store.builtAt ? Math.round((Date.now() - Date.parse(store.builtAt)) / 1000) : null,
    coins: Object.keys(store.coins).length,
    allIds: store.allIds.length,
    symbols: rows.length,
    matched: counts.matched,
    review: counts.review,
    unmatched: counts.unmatched,
    locked: counts.locked,
    overrides: Object.keys(store.overrides).length,
    lastError,
    dataFile: dataFile(),
    baseUrl: baseUrl(),
  };
}

/**
 * Loads the persisted map and kicks off a rebuild when it is missing or older
 * than the refresh cadence. Non-blocking: the HTTP server listens regardless.
 */
export function startCoinGeckoIdMap(): CoinGeckoStatus {
  loadStore();
  if (process.env.COINGECKO_DISABLE === "1") return coinGeckoStatus();
  const ageDays = store.builtAt
    ? (Date.now() - Date.parse(store.builtAt)) / 86_400_000
    : Infinity;
  if (ageDays > refreshDays()) {
    console.log("CoinGecko id-map: stale or absent — building in the background.");
    void buildIdMap();
  }
  return coinGeckoStatus();
}

export async function refreshCoinGeckoIdMap(): Promise<CoinGeckoStatus> {
  return buildIdMap();
}

/* -------------------------------------------------------------------------- *
 * Id resolution and market-cap client.
 * -------------------------------------------------------------------------- */

export function resolveGeckoId(query: ResolveMcapQuery): {
  geckoId: string | null;
  status: GeckoMatchStatus | "unknown";
  reason: string | null;
} {
  loadStore();

  // Manual overrides are keyed by either the full venue symbol or the base.
  const overrideKeys: string[] = [];
  if (query.venueSymbol) {
    overrideKeys.push(query.venueSymbol);
    if (query.venue) overrideKeys.push(symbolKeyOf(query.venue, query.venueSymbol));
  }
  for (const key of overrideKeys) {
    const override = store.overrides[key];
    if (override) return { geckoId: override.geckoId, status: "locked", reason: null };
  }
  if (query.baseAsset && store.overrides[query.baseAsset]) {
    return { geckoId: store.overrides[query.baseAsset].geckoId, status: "locked", reason: null };
  }

  if (query.venue && query.venueSymbol) {
    const row = store.symbolMap[symbolKeyOf(query.venue, query.venueSymbol)];
    if (row) return { geckoId: row.geckoId, status: row.status, reason: row.reasons[0] ?? null };
  }

  if (query.baseAsset) {
    const base = query.baseAsset.toLowerCase();
    const rows = Object.values(store.symbolMap).filter((r) => r.baseAsset.toLowerCase() === base);
    const best = rows.find((r) => r.status === "matched" || r.status === "locked") ?? rows[0];
    if (best) return { geckoId: best.geckoId, status: best.status, reason: best.reasons[0] ?? null };
  }

  return { geckoId: null, status: "unknown", reason: "no symbol-map entry" };
}

function fromCache(
  row: McapCacheRow,
  venuePrice: number | null,
  multiplier: number
): GeckoMcapResult {
  let status: GeckoMcapResult["status"] = row.marketCap != null ? "ok" : "null_mcap";
  if (venuePrice != null && row.priceUsd != null && row.priceUsd > 0) {
    const venueBase = venuePrice / (multiplier || 1);
    if (Math.abs(venueBase / row.priceUsd - 1) > MATCH_CONFIG.priceMatchTolerance) {
      status = "price_mismatch";
    }
  }
  return {
    geckoId: row.geckoId,
    marketCapUsd: row.marketCap,
    fdvUsd: row.fdv,
    circulatingSupply: row.circulatingSupply,
    priceUsd: row.priceUsd,
    status,
  };
}

/**
 * Fetches market cap/fdv/supply for a coin by its resolved gecko id. Returns
 * `unavailable` (never a guess) when the id is not confidently matched.
 */
export async function resolveGeckoMcap(query: ResolveMcapQuery): Promise<GeckoMcapResult> {
  const resolved = resolveGeckoId(query);
  if (!resolved.geckoId || (resolved.status !== "matched" && resolved.status !== "locked")) {
    return {
      geckoId: resolved.geckoId,
      marketCapUsd: null,
      fdvUsd: null,
      circulatingSupply: null,
      priceUsd: null,
      status: "unavailable",
      reason: resolved.reason ?? `id not confidently matched (${resolved.status})`,
    };
  }

  const geckoId = resolved.geckoId;
  const multiplier =
    (query.venue && query.venueSymbol
      ? store.symbolMap[symbolKeyOf(query.venue, query.venueSymbol)]?.multiplier
      : null) ?? 1;
  const cached = store.mcapCache[geckoId];
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < mcapTtlMs()) {
    return fromCache(cached, query.venuePrice ?? null, multiplier);
  }

  try {
    const rows = await geckoFetch(
      `/coins/markets?vs_currency=usd&ids=${encodeURIComponent(geckoId)}&sparkline=false`
    );
    const coin = Array.isArray(rows) ? rows[0] : null;
    if (!coin) {
      return {
        geckoId,
        marketCapUsd: null,
        fdvUsd: null,
        circulatingSupply: null,
        priceUsd: null,
        status: "failed",
        reason: "CoinGecko returned no row for the id",
      };
    }

    const price = numOrNull(coin.current_price);
    const circ = numOrNull(coin.circulating_supply);
    let marketCap = numOrNull(coin.market_cap);
    let status: McapCacheRow["status"] = "ok";

    if (marketCap == null || marketCap === 0) {
      // Unverified circulating supply: derive if possible, never substitute FDV.
      if (circ != null && circ > 0 && price != null && price > 0) {
        marketCap = circ * price;
        status = "derived";
      } else {
        marketCap = null;
        status = "null_mcap";
      }
    }

    const row: McapCacheRow = {
      geckoId,
      marketCap,
      fdv: numOrNull(coin.fully_diluted_valuation),
      circulatingSupply: circ,
      totalSupply: numOrNull(coin.total_supply),
      maxSupply: numOrNull(coin.max_supply),
      priceUsd: price,
      fetchedAt: new Date().toISOString(),
      status,
    };
    store.mcapCache[geckoId] = row;
    saveStore();
    return fromCache(row, query.venuePrice ?? null, multiplier);
  } catch (err: any) {
    // Serve the last cached value when the network fails; the caller can read
    // `status`/`fetchedAt` to see it is stale. Otherwise report failure.
    if (cached) return fromCache(cached, query.venuePrice ?? null, multiplier);
    return {
      geckoId,
      marketCapUsd: null,
      fdvUsd: null,
      circulatingSupply: null,
      priceUsd: null,
      status: "failed",
      reason: err?.message || "CoinGecko request failed",
    };
  }
}

/* -------------------------------------------------------------------------- *
 * Manual overrides + review queue (Data Health card).
 * -------------------------------------------------------------------------- */

export function setGeckoOverride(key: string, geckoId: string, note?: string): void {
  loadStore();
  store.overrides[key] = {
    geckoId,
    locked: true,
    enteredAt: new Date().toISOString(),
    ...(note ? { note } : {}),
  };
  saveStore();
}

export function clearGeckoOverride(key: string): void {
  loadStore();
  delete store.overrides[key];
  saveStore();
}

export function symbolMapSnapshot(): SymbolMapRow[] {
  loadStore();
  return Object.values(store.symbolMap);
}
