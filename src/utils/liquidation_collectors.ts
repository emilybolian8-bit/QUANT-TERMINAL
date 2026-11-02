/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live liquidation collectors — the Binance/Bybit/OKX websockets from
 * liq-collector-main ported into the terminal's own Node process so a single
 * `npm run dev` (or the production bundle) serves both the quant math and the
 * liquidation tape.
 *
 * Fidelity notes carried over from the Python originals:
 *  - Binance `!forceOrder@arr` pushes every force-order on the exchange; no
 *    subscription, client-side nothing to manage.
 *  - Bybit `allLiquidation.*` is per-symbol: every currently-trading linear
 *    instrument is auto-discovered over REST and subscribed in chunks, then
 *    re-checked every 4 hours for new listings. The deprecated `liquidation.*`
 *    topic (1 msg/sec/symbol cap) is deliberately not used.
 *  - OKX `liquidation-orders` on instType SWAP pushes batches, not single
 *    orders, and keeps the venue's own ticker (BTC-USDT-SWAP) which the store
 *    normalizes into the shared symbol space.
 *  - Every socket keeps an application-level ping (matching the venues'
 *    expectations) plus an idle watchdog: if neither messages nor pongs
 *    arrive for longer than the ping cadence allows, the socket is torn down
 *    and the loop reconnects with exponential backoff.
 */

import WebSocket from "ws";
import { liquidationStore, normalizeLiqSymbol } from "./liquidation_store";
import type { LiqExchange, LiqPosition } from "../types";

const BINANCE_URL = "wss://fstream.binance.com/market/ws/!forceOrder@arr";
const BYBIT_URL = "wss://stream.bybit.com/v5/public/linear";
const BYBIT_INSTRUMENTS_URL = "https://api.bybit.com/v5/market/instruments-info";
const OKX_URL = "wss://ws.okx.com:8443/ws/v5/public";

const KEEPALIVE_MS = 20_000;
const IDLE_TIMEOUT_MS = 75_000;
const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;

const BYBIT_SUBSCRIBE_CHUNK = 50;
const BYBIT_SUBSCRIBE_DELAY_MS = 100;
const BYBIT_SYMBOL_REFRESH_MS = 4 * 60 * 60 * 1000;

let started = false;
let stopped = false;
const activeSockets = new Map<LiqExchange, WebSocket>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The force-order's own side closes the OPPOSITE book side: a forced sell
 * wipes a long, a forced buy wipes a short. Same convention on all venues.
 */
function positionFromOrderSide(side: unknown): LiqPosition {
  const value = String(side || "").toLowerCase();
  if (value === "sell" || value === "s") return "long";
  if (value === "buy" || value === "b") return "short";
  return "unknown";
}

interface ForceOrder {
  exchange: LiqExchange;
  venueSymbol: string;
  side: unknown;
  price: number;
  qty: number;
  eventTimeMs?: number;
}

function recordForceOrder(order: ForceOrder): void {
  const price = Math.max(0, order.price);
  const qty = Math.max(0, order.qty);
  liquidationStore.push({
    exchange: order.exchange,
    symbol: normalizeLiqSymbol(order.venueSymbol),
    venueSymbol: order.venueSymbol,
    position: positionFromOrderSide(order.side),
    price,
    qty,
    notional: price > 0 && qty > 0 ? price * qty : 0,
    eventTimeMs: order.eventTimeMs && order.eventTimeMs > 0 ? order.eventTimeMs : Date.now(),
  });
}

/* ------------------------------------------------------------------------- *
 * Binance
 * ------------------------------------------------------------------------- */

function handleBinanceMessage(raw: string): void {
  const msg = JSON.parse(raw);
  const order = msg && typeof msg === "object" ? msg.o : null;
  if (!order || !order.s) return;

  // `ap` (average price) is the filled price when present, `p` otherwise.
  recordForceOrder({
    exchange: "binance",
    venueSymbol: String(order.s),
    side: order.S,
    price: toNumber(order.ap) || toNumber(order.p),
    qty: toNumber(order.q),
    eventTimeMs: toNumber(order.T),
  });
}

/* ------------------------------------------------------------------------- *
 * Bybit
 * ------------------------------------------------------------------------- */

/**
 * Every currently-trading linear (USDT/USDC perp) symbol, paginated with
 * Bybit's cursor. Required: `allLiquidation` is per-symbol, and an empty
 * subscription silently receives nothing.
 */
async function fetchBybitLinearSymbols(): Promise<string[]> {
  const symbols: string[] = [];
  let cursor = "";

  for (let page = 0; page < 100; page += 1) {
    const url = new URL(BYBIT_INSTRUMENTS_URL);
    url.searchParams.set("category", "linear");
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Bybit instruments-info HTTP ${response.status}`);
    const payload: any = await response.json();
    if (payload?.retCode !== 0) throw new Error(`Bybit API error: ${payload?.retMsg}`);

    const result = payload.result || {};
    for (const item of result.list || []) {
      if (item?.status === "Trading" && item?.symbol) symbols.push(String(item.symbol));
    }
    cursor = result.nextPageCursor || "";
    if (!cursor) break;
  }

  return [...new Set(symbols)];
}

let bybitSymbols: string[] = [];
let bybitFetchedAt = 0;
let bybitInFlight: Promise<string[]> | null = null;
const bybitSubscribed = new Set<string>();

async function ensureBybitSymbols(): Promise<string[]> {
  if (bybitSymbols.length > 0 && Date.now() - bybitFetchedAt < BYBIT_SYMBOL_REFRESH_MS) {
    return bybitSymbols;
  }
  if (!bybitInFlight) {
    bybitInFlight = fetchBybitLinearSymbols()
      .then((symbols) => {
        bybitSymbols = symbols;
        bybitFetchedAt = Date.now();
        return symbols;
      })
      .finally(() => {
        bybitInFlight = null;
      });
  }
  return bybitInFlight;
}

async function subscribeBybit(ws: WebSocket): Promise<void> {
  const symbols = await ensureBybitSymbols();
  const fresh = symbols.filter((symbol) => !bybitSubscribed.has(symbol));
  for (let i = 0; i < fresh.length; i += BYBIT_SUBSCRIBE_CHUNK) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const chunk = fresh.slice(i, i + BYBIT_SUBSCRIBE_CHUNK);
    ws.send(JSON.stringify({ op: "subscribe", args: chunk.map((s) => `allLiquidation.${s}`) }));
    for (const symbol of chunk) bybitSubscribed.add(symbol);
    await sleep(BYBIT_SUBSCRIBE_DELAY_MS);
  }
}

function handleBybitMessage(raw: string): void {
  const msg = JSON.parse(raw);
  if (!msg || typeof msg !== "object") return;
  if (msg.op === "pong" || typeof msg.success === "boolean") return;

  const topic = String(msg.topic || "");
  if (!topic.startsWith("allLiquidation.")) return;
  const topicSymbol = topic.slice("allLiquidation.".length);

  const data = Array.isArray(msg.data) ? msg.data : msg.data ? [msg.data] : [];
  for (const liq of data) {
    if (!liq || typeof liq !== "object") continue;
    const venueSymbol = String(liq.symbol || liq.s || topicSymbol);
    recordForceOrder({
      exchange: "bybit",
      venueSymbol,
      side: liq.side ?? liq.S,
      // Long-form names first, then short-form: Bybit has shipped both.
      price: toNumber(liq.price ?? liq.p),
      qty: toNumber(liq.size ?? liq.v),
      eventTimeMs: toNumber(liq.updatedTime ?? liq.T ?? liq.timestamp),
    });
  }
}

/* ------------------------------------------------------------------------- *
 * OKX
 * ------------------------------------------------------------------------- */

function handleOkxMessage(raw: string): void {
  if (raw === "pong") return;
  const msg = JSON.parse(raw);
  if (!msg || typeof msg !== "object") return;
  if (msg.arg?.channel !== "liquidation-orders") return;

  for (const batch of msg.data || []) {
    if (!batch || typeof batch !== "object") continue;
    const instFamily = batch.instFamily || batch.uly || "";
    for (const detail of batch.details || []) {
      if (!detail || typeof detail !== "object") continue;
      const venueSymbol = String(detail.instId || instFamily);
      if (!venueSymbol) continue;
      recordForceOrder({
        exchange: "okx",
        venueSymbol,
        side: detail.side,
        // `bkPx` is the breakdown price; `sz` the closed size.
        price: toNumber(detail.bkPx),
        qty: toNumber(detail.sz),
        eventTimeMs: toNumber(detail.ts),
      });
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Shared socket loop
 * ------------------------------------------------------------------------- */

interface SocketJob {
  exchange: LiqExchange;
  connect: () => WebSocket;
  onMessage: (raw: string) => void;
  /** Interval that pings the venue; cleared automatically on close. */
  keepAlive: (ws: WebSocket) => ReturnType<typeof setInterval>;
  /** Optional hook after the socket opens (subscription flows). */
  onOpen?: (ws: WebSocket) => void;
  /** Optional hook when the connection tears down. */
  onClose?: () => void;
}

async function runSocketLoop(job: SocketJob): Promise<void> {
  let delay = INITIAL_RETRY_MS;

  while (!stopped) {
    let opened = false;

    await new Promise<void>((resolve) => {
      let ws: WebSocket;
      try {
        ws = job.connect();
      } catch (error: any) {
        liquidationStore.setExchangeStatus(job.exchange, {
          error: error?.message || "connection failed",
        });
        resolve();
        return;
      }

      activeSockets.set(job.exchange, ws);

      let lastActivity = Date.now();
      let finished = false;
      let keepalive: ReturnType<typeof setInterval> | null = null;
      let watchdog: ReturnType<typeof setInterval> | null = null;

      const finish = () => {
        if (finished) return;
        finished = true;
        if (keepalive) clearInterval(keepalive);
        if (watchdog) clearInterval(watchdog);
        activeSockets.delete(job.exchange);
        liquidationStore.setExchangeStatus(job.exchange, { connected: false });
        job.onClose?.();
        resolve();
      };

      ws.on("open", () => {
        opened = true;
        lastActivity = Date.now();
        liquidationStore.setExchangeStatus(job.exchange, { connected: true, error: null });
        try {
          job.onOpen?.(ws);
        } catch (error: any) {
          liquidationStore.setExchangeStatus(job.exchange, {
            error: error?.message || "post-open hook failed",
          });
        }
      });

      ws.on("message", (data) => {
        lastActivity = Date.now();
        liquidationStore.setExchangeStatus(job.exchange, { lastMessageAt: lastActivity });
        try {
          job.onMessage(String(data));
        } catch (error: any) {
          liquidationStore.setExchangeStatus(job.exchange, {
            error: error?.message || "message parse failed",
          });
        }
      });

      // Protocol pongs (Binance) never surface as messages, so they count
      // toward liveness here instead.
      ws.on("pong", () => {
        lastActivity = Date.now();
      });

      ws.on("error", (error: any) => {
        liquidationStore.setExchangeStatus(job.exchange, {
          error: error?.message || "socket error",
        });
      });

      ws.on("close", finish);

      keepalive = job.keepAlive(ws);
      watchdog = setInterval(() => {
        if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
          liquidationStore.setExchangeStatus(job.exchange, {
            error: "idle timeout — no traffic from venue, reconnecting",
          });
          ws.terminate();
        }
      }, Math.floor(IDLE_TIMEOUT_MS / 3));
    });

    if (stopped) break;
    if (opened) delay = INITIAL_RETRY_MS;
    liquidationStore.incrementReconnect(job.exchange);
    await sleep(delay);
    delay = Math.min(delay * 2, MAX_RETRY_MS);
  }
}

function pingWhenOpen(ws: WebSocket, build: () => string | Buffer): ReturnType<typeof setInterval> {
  return setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(build());
    } catch {
      // Send races a closing socket; the close handler drives the reconnect.
    }
  }, KEEPALIVE_MS);
}

function protocolPing(ws: WebSocket): ReturnType<typeof setInterval> {
  return setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.ping();
    } catch {
      // Same race as above.
    }
  }, KEEPALIVE_MS);
}

const jobs: SocketJob[] = [
  {
    exchange: "binance",
    connect: () => new WebSocket(BINANCE_URL),
    onMessage: handleBinanceMessage,
    keepAlive: protocolPing,
  },
  {
    exchange: "bybit",
    connect: () => new WebSocket(BYBIT_URL),
    onMessage: handleBybitMessage,
    keepAlive: (ws) => pingWhenOpen(ws, () => JSON.stringify({ op: "ping" })),
    onOpen: (ws) => {
      // A fresh connection remembers nothing, so every reconnect resubscribes
      // the full discovered universe from scratch.
      bybitSubscribed.clear();
      void subscribeBybit(ws).catch((error: any) => {
        liquidationStore.setExchangeStatus("bybit", {
          error: error?.message || "subscription failed",
        });
      });
    },
  },
  {
    exchange: "okx",
    connect: () => new WebSocket(OKX_URL),
    onMessage: handleOkxMessage,
    keepAlive: (ws) => pingWhenOpen(ws, () => "ping"),
    onOpen: (ws) => {
      ws.send(
        JSON.stringify({
          op: "subscribe",
          args: [{ channel: "liquidation-orders", instType: "SWAP" }],
        })
      );
    },
  },
];

/** Boots all three collectors. Idempotent, so hot reloads cannot double them. */
export function startLiquidationCollectors(): void {
  if (started) return;
  started = true;
  stopped = false;
  for (const job of jobs) {
    void runSocketLoop(job);
  }
}

/** Stops the loops and drops the active sockets (used on shutdown). */
export function stopLiquidationCollectors(): void {
  stopped = true;
  for (const ws of activeSockets.values()) {
    try {
      ws.terminate();
    } catch {
      // Already gone.
    }
  }
  activeSockets.clear();
}
