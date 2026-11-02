/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-memory liquidation tape, fused from the liq-collector design into the
 * terminal's own process.
 *
 * The Python collector's contract is preserved where it mattered:
 *  - one normalized record per venue force-order (exchange, symbol, side,
 *    price, qty, notional, event clock), and
 *  - hourly/UTC rotation is replaced here by a bounded ring buffer, because
 *    the terminal only ever serves live windows (1h/4h/24h plus the matching
 *    previous window), not offline backtests.
 *
 * Windows are cut on our receive clock (`receivedAtMs`), which is monotonic
 * and therefore sliceable with a binary search; the exchange's own clock is
 * kept on each event for display. Retention must cover two full 24h windows
 * plus slack, otherwise the 24h gainers/losers comparison loses its
 * baseline.
 */

import type {
  CoinLiqResponse,
  LiqEvent,
  LiqExchange,
  LiqExchangeStatus,
  LiqLeadersResponse,
  LiqSeriesBucket,
  LiqStatusResponse,
  LiqTotals,
  LiqWindow,
} from "../types";

export const LIQ_WINDOWS: LiqWindow[] = ["1h", "4h", "24h"];

export const LIQ_WINDOW_MS: Record<LiqWindow, number> = {
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

/** Buckets rendered on the per-coin series chart. */
const SERIES_BUCKETS = 12;

/** Cap on the per-coin recent-events tape returned to the UI. */
const RECENT_EVENTS_CAP = 100;

/** Rows per leaderboard side. */
const LEADERBOARD_CAP = 25;

/** How long an unchanged leaders answer is reused under request bursts. */
const LEADERS_CACHE_MS = 5_000;

/**
 * Retention must cover two full 24h windows plus slack. Read lazily (not at
 * module scope) because dotenv.config() in server.ts runs after this module
 * is imported, so a value from .env would otherwise never be seen.
 */
export function liqRetentionMs(): number {
  const hours = Number(process.env.LIQ_RETENTION_HOURS || 50);
  return (Number.isFinite(hours) && hours > 0 ? hours : 50) * 3_600_000;
}

/**
 * Hard ceiling on buffered events. A cascade emits thousands of force-orders
 * per minute across the three venues, so time-based retention alone can grow
 * without bound during exactly the volatility this page exists for.
 */
export function liqMaxEvents(): number {
  const parsed = Number(process.env.LIQ_MAX_EVENTS);
  return Number.isFinite(parsed) && parsed > 1000 ? Math.floor(parsed) : 400_000;
}

const PRUNE_INTERVAL_MS = 60_000;

/**
 * Collapses any venue ticker onto the terminal's USDT-linear symbol space so
 * a search for "BTC" or "BTC-USDT-SWAP" or "BTC/USDT" all hit the same tape.
 * USD/USDC endings fold onto USDT because the linear contracts are the same
 * forced-close flow for ranking purposes; the venue's own ticker stays on the
 * event for provenance.
 */
export function normalizeLiqSymbol(raw: string): string {
  const tokens = String(raw || "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  if (tokens.length === 0) return "";

  // OKX contract-kind suffix: BTC-USDT-SWAP -> [BTC, USDT, SWAP]
  while (tokens.length > 2 && ["SWAP", "PERP", "FUT", "FUTURES"].includes(tokens[tokens.length - 1])) {
    tokens.pop();
  }

  const joined = tokens.join("");
  if (joined.endsWith("USDC")) return `${joined.slice(0, -4)}USDT`;
  if (joined.endsWith("USDT")) return joined;
  if (joined.endsWith("USD")) return `${joined}T`;
  return joined;
}

/** Accepts "1h"/"4h"/"24h" (case-insensitive); anything else -> null. */
export function parseLiqWindow(raw: unknown): LiqWindow | null {
  const value = String(raw || "").toLowerCase();
  return (LIQ_WINDOWS as string[]).includes(value) ? (value as LiqWindow) : null;
}

function emptyTotals(): LiqTotals {
  return {
    events: 0,
    qty: 0,
    notional: 0,
    longEvents: 0,
    longNotional: 0,
    shortEvents: 0,
    shortNotional: 0,
    byExchange: {},
  };
}

function accumulate(totals: LiqTotals, event: LiqEvent): void {
  totals.events += 1;
  totals.qty += event.qty;
  totals.notional += event.notional;
  if (event.position === "long") {
    totals.longEvents += 1;
    totals.longNotional += event.notional;
  } else if (event.position === "short") {
    totals.shortEvents += 1;
    totals.shortNotional += event.notional;
  }

  const bucket = (totals.byExchange[event.exchange] ||= { events: 0, notional: 0 });
  bucket.events += 1;
  bucket.notional += event.notional;
}

/** First index whose receivedAtMs >= target (events are receive-ordered). */
function lowerBound(events: LiqEvent[], target: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].receivedAtMs < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function pctChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

class LiquidationStore {
  private events: LiqEvent[] = [];
  private nextId = 1;
  private lastPruneAt = 0;
  private leadersCache = new Map<LiqWindow, { at: number; payload: LiqLeadersResponse }>();
  private statuses: Record<LiqExchange, LiqExchangeStatus>;
  /** Durable JSONL sink; null while persistence is off (or failed at boot). */
  private writer: { write(event: LiqEvent): void } | null = null;

  constructor() {
    this.statuses = {
      binance: this.freshStatus("binance"),
      bybit: this.freshStatus("bybit"),
      okx: this.freshStatus("okx"),
    };
  }

  private freshStatus(exchange: LiqExchange): LiqExchangeStatus {
    return {
      exchange,
      connected: false,
      lastEventAt: null,
      lastMessageAt: null,
      eventsReceived: 0,
      reconnects: 0,
      error: null,
    };
  }

  /** Applies a partial patch to one venue's feed health record. */
  setExchangeStatus(exchange: LiqExchange, patch: Partial<LiqExchangeStatus>): void {
    Object.assign(this.statuses[exchange], patch);
  }

  /** Counts a loop iteration that ended in a reconnect. */
  incrementReconnect(exchange: LiqExchange): void {
    this.statuses[exchange].reconnects += 1;
  }

  /** Attaches (or removes) the durable sink fed by every accepted event. */
  attachWriter(writer: { write(event: LiqEvent): void } | null): void {
    this.writer = writer;
  }

  /**
   * Merges events replayed from disk at boot. Intended to run BEFORE the
   * writer is attached so a previous run's log is not written back to itself.
   * Ids are re-assigned in receive-time order so records persisted by an
   * earlier process can never collide with this run's ids, and the leaders
   * cache is dropped because the buffer just changed underneath it.
   */
  hydrate(events: LiqEvent[]): number {
    if (events.length === 0) return 0;
    const merged = events.concat(this.events).sort((a, b) => a.receivedAtMs - b.receivedAtMs);
    const cap = liqMaxEvents();
    const kept = merged.length > cap ? merged.slice(merged.length - cap) : merged;
    for (let i = 0; i < kept.length; i += 1) kept[i].id = i + 1;
    this.events = kept;
    this.nextId = kept.length + 1;
    this.leadersCache.clear();
    return events.length;
  }

  /** Appends one normalized event and enforces retention + the size cap. */
  push(event: Omit<LiqEvent, "id" | "receivedAtMs"> & { receivedAtMs?: number }): LiqEvent {
    const receivedAtMs = event.receivedAtMs ?? Date.now();
    const record: LiqEvent = { ...event, id: this.nextId++, receivedAtMs };
    this.events.push(record);
    // Persist before the prune runs: an event worth keeping for the window
    // is worth a line on disk even if retention later drops it.
    this.writer?.write(record);

    const status = this.statuses[record.exchange];
    status.eventsReceived += 1;
    status.lastEventAt = receivedAtMs;

    const cap = liqMaxEvents();
    if (this.events.length > cap) {
      this.events.splice(0, this.events.length - cap);
    }
    this.maybePrune(receivedAtMs);
    return record;
  }

  private maybePrune(now: number): void {
    if (now - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
    this.lastPruneAt = now;
    const cutoff = now - liqRetentionMs();
    const drop = lowerBound(this.events, cutoff);
    if (drop > 0) this.events.splice(0, drop);
  }

  /**
   * Every retained event for one symbol whose receive clock falls in
   * [startMs, endMs), ascending by receive time. Drives the Code Lab `liq`
   * frame and the heatmap endpoint, both of which need the whole slice rather
   * than the capped `recent` tape. `cap` keeps the NEWEST events when the range
   * holds more than the caller can carry.
   */
  eventsFor(symbol: string, startMs: number, endMs: number, cap = Infinity): LiqEvent[] {
    const from = lowerBound(this.events, startMs);
    const to = lowerBound(this.events, endMs);
    const found: LiqEvent[] = [];
    for (let i = from; i < to; i += 1) {
      if (this.events[i].symbol === symbol) found.push(this.events[i]);
    }
    return found.length > cap ? found.slice(found.length - cap) : found;
  }

  /** GET /api/liq/status: buffer + per-venue connection health. */
  status(): LiqStatusResponse {
    const now = Date.now();
    // Quiet markets push no events, so the push-driven prune never fires;
    // a status read is frequent enough to keep retention honest.
    this.maybePrune(now);
    const oldest = this.events.length > 0 ? this.events[0].receivedAtMs : null;
    return {
      running: true,
      exchanges: (["binance", "bybit", "okx"] as LiqExchange[]).map((exchange) => ({
        ...this.statuses[exchange],
      })),
      bufferedEvents: this.events.length,
      oldestEventAgeMs: oldest === null ? null : now - oldest,
      retentionHours: liqRetentionMs() / 3_600_000,
      serverTime: now,
    };
  }

  /**
   * GET /api/liq/coin: totals for [now - 2*window, now), split into the
   * current window and the matching previous one, plus a 12-bucket series
   * and the newest raw events for the tape.
   */
  coin(symbol: string, window: LiqWindow): CoinLiqResponse {
    const windowMs = LIQ_WINDOW_MS[window];
    const now = Date.now();
    const windowEnd = now;
    const windowStart = now - windowMs;
    const previousStart = now - 2 * windowMs;

    const current = emptyTotals();
    const previous = emptyTotals();
    const buckets: LiqSeriesBucket[] = [];
    const bucketMs = windowMs / SERIES_BUCKETS;
    for (let i = 0; i < SERIES_BUCKETS; i += 1) {
      buckets.push({
        t: windowStart + i * bucketMs,
        events: 0,
        notional: 0,
        longNotional: 0,
        shortNotional: 0,
      });
    }

    const recent: LiqEvent[] = [];
    let buffered = 0;

    // Single pass over the whole buffer: window totals, series and the
    // retained-event count for this symbol come out of the same scan.
    for (let i = 0; i < this.events.length; i += 1) {
      const event = this.events[i];
      if (event.symbol !== symbol) continue;
      buffered += 1;
      if (event.receivedAtMs < previousStart) continue;

      if (event.receivedAtMs >= windowStart) {
        accumulate(current, event);
        const idx = Math.min(
          SERIES_BUCKETS - 1,
          Math.max(0, Math.floor((event.receivedAtMs - windowStart) / bucketMs))
        );
        const bucket = buckets[idx];
        bucket.events += 1;
        bucket.notional += event.notional;
        if (event.position === "long") bucket.longNotional += event.notional;
        else if (event.position === "short") bucket.shortNotional += event.notional;
        recent.push(event);
      } else {
        accumulate(previous, event);
      }
    }

    recent.sort((a, b) => b.id - a.id);

    return {
      symbol,
      base: symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol,
      window,
      windowStart,
      windowEnd,
      previousStart,
      current,
      previous,
      delta: {
        events: current.events - previous.events,
        eventsPct: pctChange(current.events, previous.events),
        notional: current.notional - previous.notional,
        notionalPct: pctChange(current.notional, previous.notional),
      },
      series: buckets,
      recent: recent.slice(0, RECENT_EVENTS_CAP),
      buffered,
    };
  }

  /**
   * GET /api/liq/leaders: every symbol that saw liquidations in either
   * window, ranked by the change in event count, then notional.
   * Gainers = biggest rise vs the previous matching window; losers = fall.
   */
  leaders(window: LiqWindow): LiqLeadersResponse {
    const cached = this.leadersCache.get(window);
    if (cached && Date.now() - cached.at < LEADERS_CACHE_MS) return cached.payload;

    const windowMs = LIQ_WINDOW_MS[window];
    const now = Date.now();
    const windowStart = now - windowMs;
    const previousStart = now - 2 * windowMs;

    const perSymbol = new Map<string, { current: LiqTotals; previous: LiqTotals }>();
    const start = lowerBound(this.events, previousStart);

    for (let i = start; i < this.events.length; i += 1) {
      const event = this.events[i];
      let entry = perSymbol.get(event.symbol);
      if (!entry) {
        entry = { current: emptyTotals(), previous: emptyTotals() };
        perSymbol.set(event.symbol, entry);
      }
      if (event.receivedAtMs >= windowStart) accumulate(entry.current, event);
      else accumulate(entry.previous, event);
    }

    const rows = [...perSymbol.entries()].map(([symbol, totals]) => ({
      symbol,
      base: symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol,
      current: totals.current,
      previous: totals.previous,
      deltaEvents: totals.current.events - totals.previous.events,
      deltaEventsPct: pctChange(totals.current.events, totals.previous.events),
      deltaNotional: totals.current.notional - totals.previous.notional,
      deltaNotionalPct: pctChange(totals.current.notional, totals.previous.notional),
    }));

    // Rank literally as specified: liquidation events first, quantity (USD
    // notional) as the tie-break. New activity (previous == 0) sorts above
    // any finite percentage rise because it has no baseline to divide by.
    const gainers = rows
      .filter((row) => row.deltaEvents > 0 || row.deltaNotional > 0)
      .sort(
        (a, b) => b.deltaEvents - a.deltaEvents || b.deltaNotional - a.deltaNotional || b.current.notional - a.current.notional
      )
      .slice(0, LEADERBOARD_CAP);

    const losers = rows
      .filter((row) => (row.deltaEvents < 0 || row.deltaNotional < 0) && row.previous.events > 0)
      .sort(
        (a, b) => a.deltaEvents - b.deltaEvents || a.deltaNotional - b.deltaNotional || b.previous.notional - a.previous.notional
      )
      .slice(0, LEADERBOARD_CAP);

    const payload: LiqLeadersResponse = {
      window,
      windowStart,
      windowEnd: now,
      previousStart,
      generatedAt: now,
      gainers,
      losers,
      symbolsActive: rows.filter((row) => row.current.events > 0).length,
    };

    this.leadersCache.set(window, { at: now, payload });
    return payload;
  }
}

/** Process-wide store shared by the collectors and the HTTP routes. */
export const liquidationStore = new LiquidationStore();
