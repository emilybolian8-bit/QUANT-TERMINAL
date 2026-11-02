/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Interval, TerminalResponse, ZScoreMode } from "../types";
import { defaultLookbackDays, defaultRollingWindow } from "./terminal_calculations";

/**
 * Background cache for the Quant Terminal.
 *
 * The terminal endpoint runs the heaviest math in the app (cross-correlation
 * spectrum, asymmetric beta, stability, two residual regressions, vol regimes,
 * session splits). Paying that round trip the moment the user clicks the tab is
 * what makes the tab feel slow. This module lets the client warm the exact frame
 * the terminal opens on as soon as a coin is selected, so opening the tab is a
 * cache hit rather than a wait.
 *
 * It is deliberately process-global and dependency-free: any surface can prefetch
 * and the terminal will find the same entry, keyed on the full parameter set so
 * a differently-tuned frame never masquerades as the default one.
 */

export interface TerminalRequestParams {
  /** Subject ticker WITH the quote suffix, e.g. "SOLUSDT". */
  symbol: string;
  /** Benchmark base asset WITHOUT the suffix, e.g. "BTC". */
  benchmark: string;
  interval: Interval;
  lookbackDays: number;
  maxLag: number;
  rollingWindow: number;
  zscoreMode: ZScoreMode;
}

/** A prefetched frame is served for five minutes before it is treated as cold. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Bound on retained frames; entries are evicted least-recently-used first. */
const MAX_ENTRIES = 12;

interface CacheEntry {
  data: TerminalResponse;
  storedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<TerminalResponse>>();

/**
 * The exact parameters the terminal boots with — one hour bars, a 45-day
 * lookback, ±12 lags, the shared 168-bar window and rolling Z-scores. Kept in
 * one place so a prefetch and the terminal's own first render cannot disagree on
 * the cache key.
 */
export function defaultTerminalParams(symbol: string, benchmark: string): TerminalRequestParams {
  return {
    symbol,
    benchmark,
    interval: "1h",
    lookbackDays: defaultLookbackDays("1h"),
    maxLag: 12,
    rollingWindow: defaultRollingWindow("1h"),
    zscoreMode: "rolling",
  };
}

export function terminalCacheKey(params: TerminalRequestParams): string {
  return [
    params.symbol,
    params.benchmark,
    params.interval,
    params.lookbackDays,
    params.maxLag,
    params.rollingWindow,
    params.zscoreMode,
  ].join("|");
}

export function buildTerminalQuery(params: TerminalRequestParams): string {
  return new URLSearchParams({
    symbol: params.symbol,
    baseAsset: params.benchmark,
    interval: params.interval,
    lookbackDays: String(params.lookbackDays),
    maxLag: String(params.maxLag),
    rollingWindow: String(params.rollingWindow),
    zscoreMode: params.zscoreMode,
  }).toString();
}

/** Returns a fresh cached frame, or null on a miss/expiry. Refreshes LRU order. */
export function peekTerminalCache(params: TerminalRequestParams): TerminalResponse | null {
  const key = terminalCacheKey(params);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // Re-insert so the most recently read frame is the last evicted.
  cache.delete(key);
  cache.set(key, entry);
  return entry.data;
}

/**
 * Fetches a frame, de-duplicating concurrent calls for the same key. A cache hit
 * short-circuits unless `force` is set, which is what RECOMPUTE uses.
 */
export async function fetchTerminal(
  params: TerminalRequestParams,
  opts?: { force?: boolean }
): Promise<TerminalResponse> {
  const key = terminalCacheKey(params);

  if (!opts?.force) {
    const cached = peekTerminalCache(params);
    if (cached) return cached;

    const pending = inFlight.get(key);
    if (pending) return pending;
  }

  const request = fetch(`/api/terminal?${buildTerminalQuery(params)}`)
    .then(async (res) => {
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || "Terminal calculation failed.");
      }
      const data = (await res.json()) as TerminalResponse;
      cache.set(key, { data, storedAt: Date.now() });
      while (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      return data;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, request);
  return request;
}

/**
 * Warms the cache off the critical path. Never throws: a failed background
 * warm-up is silent, and the terminal simply computes on demand as before.
 */
export function prefetchTerminal(params: TerminalRequestParams): void {
  if (peekTerminalCache(params)) return;
  if (inFlight.has(terminalCacheKey(params))) return;
  void fetchTerminal(params).catch(() => {
    /* background warm-up is best-effort */
  });
}
