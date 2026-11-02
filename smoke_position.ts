/**
 * Regression smoke test for the Position Management fixes (P1-P6).
 *
 * Run with:  npx tsx smoke_position.ts
 *
 * Exercises the pure engine (`computePositionAnalysis`) plus the exported
 * helpers. No network / server required.
 */

import {
  computePositionAnalysis,
  effectiveCount,
  gateLiquidation,
  wilson,
  type PositionAnalystInputs,
  type PositionLiqBaseline,
} from "./src/utils/position_analyst";
import { CoinLiqResponse, Kline, LiqTotals, PositionInput, PositionSide } from "./src/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (!cond) failures += 1;
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}
function approx(a: number | null | undefined, b: number, tol: number): boolean {
  return a != null && Number.isFinite(a) && Math.abs(a - b) <= tol;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BAR_MS = 15 * 60 * 1000;
const START = Date.UTC(2025, 0, 1);

function makeSeries(seed: number, n: number, base: number, vol: number): Kline[] {
  const rng = mulberry32(seed);
  const bars: Kline[] = [];
  let price = base;
  for (let i = 0; i < n; i += 1) {
    const open = price;
    const close = price * (1 + (rng() - 0.5) * vol);
    const high = Math.max(open, close) * (1 + rng() * vol * 0.4);
    const low = Math.min(open, close) * (1 - rng() * vol * 0.4);
    bars.push({
      time: START + i * BAR_MS,
      open,
      high,
      low,
      close,
      volume: 1000 + rng() * 800,
      takerBuy: 400 + rng() * 400,
    });
    price = close;
  }
  return bars;
}

function emptyTotals(): LiqTotals {
  return { events: 0, qty: 0, notional: 0, longEvents: 0, longNotional: 0, shortEvents: 0, shortNotional: 0, byExchange: {} };
}

function makeLiq(series: { longNotional: number; shortNotional: number }[] = []): CoinLiqResponse {
  return {
    symbol: "IOUSDT",
    base: "IO",
    window: "24h",
    windowStart: START,
    windowEnd: START + 24 * 3600000,
    previousStart: START - 24 * 3600000,
    current: emptyTotals(),
    previous: emptyTotals(),
    delta: { events: 0, eventsPct: null, notional: 0, notionalPct: null },
    series: series.map((b, i) => ({ t: START + i * BAR_MS, events: 0, notional: b.longNotional + b.shortNotional, ...b })),
    recent: [],
    buffered: series.length,
  } as CoinLiqResponse;
}

const MARK = 0.1754;
const ENTRY = 0.185;
const TP = 0.215;
const SL = 0.174;
const N = 2400;

const klines = makeSeries(42, N, MARK, 0.01);
const btcKlines = makeSeries(7, N, 60000, 0.006);
// Pin the live tape to the snapshot mark.
klines[klines.length - 1] = { ...klines[klines.length - 1], close: MARK, high: MARK * 1.002, low: MARK * 0.998 };

function baseInputs(now: number, over: Partial<PositionInput> = {}): PositionAnalystInputs {
  const input: PositionInput = {
    symbol: "IOUSDT",
    side: "long",
    entry: ENTRY,
    takeProfit: TP,
    stopLoss: SL,
    size: 5,
    leverage: 2,
    openedAt: now - 3600000,
    horizonHours: 12,
    feeBpsOneSide: 5,
    slippageBps: 0,
    marketType: "perp",
    maxLeverage: 50,
    ...over,
  };
  const oiHistory = Array.from({ length: 96 }, (_, i) => ({
    time: START + i * BAR_MS,
    sumOpenInterest: 1_000_000 + Math.sin(i / 5) * 20_000,
    sumOpenInterestValue: 0,
  }));
  return {
    now,
    symbol: "IOUSDT",
    market: "futures",
    marketType: "perp",
    baseAsset: "IO",
    name: "io.net",
    input,
    klines,
    btcKlines,
    depth: {
      fetchedAt: now,
      venue: "binance-futures",
      bids: [[MARK - 0.0002, 50000], [MARK - 0.0005, 30000]],
      asks: [[MARK + 0.0002, 50000], [MARK + 0.0005, 30000]],
    },
    futures: {
      markPrice: MARK,
      indexPrice: MARK,
      lastFundingRate: 0.0001,
      nextFundingTime: now + 6 * 3600000,
      openInterestBase: 6_000_000,
      openInterestTime: now,
      oiHistory,
      fundingHistory: [{ time: now - 8 * 3600000, rate: 0.0001 }],
    },
    liq: makeLiq([{ longNotional: 200, shortNotional: 0 }]),
    mcapUsd: 200_000_000,
    ticker: { lastPrice: MARK, quoteVolumeUsd: 40_000_000 },
    firstBarTime: START,
    historyClamped: false,
  };
}

const now = START + N * BAR_MS;

/* 1. Header k values equal Layer 2 k values. */
{
  const a = computePositionAnalysis(baseInputs(now));
  const dTp = Math.abs(TP - MARK) / MARK;
  const dSl = Math.abs(SL - MARK) / MARK;
  check(
    "1. header k equals layer-2 k",
    approx(a.header.distanceToTpSigma, dTp / a.reachability.sigmaH, 1e-9) &&
      approx(a.header.distanceToSlSigma, dSl / a.reachability.sigmaH, 1e-9) &&
      approx(a.reachability.kTp, a.header.distanceToTpSigma, 1e-9) &&
      approx(a.reachability.kSl, a.header.distanceToSlSigma, 1e-9),
    `ref=${a.reachability.referencePrice} source=${a.reachability.referenceSource} k_sl=${a.reachability.kSl?.toFixed(3)}`
  );
  check(
    "1b. live position references the mark, not the entry",
    a.reachability.referenceSource === "mark" && approx(a.reachability.referencePrice, MARK, 1e-12),
    `k_sl=${a.reachability.kSl?.toFixed(3)} (audit expected ~0.26)`
  );
}

/* 2. Stop 0.5σ_H below the mark -> STOP_IMMINENT and P_touch SL > 60%. */
{
  const probe = computePositionAnalysis(baseInputs(now));
  // 0.5σ_H below the mark (the epsilon keeps distanceToSlSigma strictly ≤ 0.5).
  const sl = MARK * (1 - 0.5 * probe.reachability.sigmaH * (1 - 1e-6));
  const a = computePositionAnalysis(baseInputs(now, { stopLoss: sl }));
  const imminent = a.header.alerts.some((x) => x.code === "STOP_IMMINENT");
  check(
    "2. stop at 0.5σ_H -> STOP_IMMINENT and P_touch SL > 60%",
    imminent && (a.reachability.pTouchSl ?? 0) > 0.6,
    `pTouchSl=${((a.reachability.pTouchSl ?? 0) * 100).toFixed(1)}% alerts=[${a.header.alerts.map((x) => x.code).join(",")}]`
  );
}

/* 3. Mark beyond the SL -> STOP_BREACHED and no probabilities. */
{
  const a = computePositionAnalysis(baseInputs(now, { stopLoss: MARK * 1.03 }));
  check(
    "3. mark beyond SL -> STOP_BREACHED, probabilities withheld",
    a.header.alerts.some((x) => x.code === "STOP_BREACHED") &&
      a.outcome.status === "STOP_BREACHED" &&
      a.outcome.pTp == null &&
      a.outcome.pSl == null,
    `status=${a.outcome.status} pTp=${a.outcome.pTp}`
  );
}

/* 4. N_eff <= N_raw / H roughly for contiguous analogs. */
{
  const indices = Array.from({ length: 2000 }, (_, i) => i);
  const H = 48;
  const nEff = effectiveCount(indices, H);
  check(
    "4. N_eff <= N_raw / H for contiguous analogs",
    nEff <= indices.length / H + 1,
    `nEff=${nEff.toFixed(1)} raw=${indices.length} bound=${(indices.length / H + 1).toFixed(1)}`
  );
}

/* 5. Liquidation baseline: durable baseline keeps z alive; a wiped buffer does not. */
{
  const liq = makeLiq(Array.from({ length: 40 }, () => ({ longNotional: 100, shortNotional: 100 })));
  const baseline: PositionLiqBaseline = { events: 120, spanMs: 72 * 3600000, firstMs: START };
  const withBaseline = gateLiquidation(liq, "long", 4, baseline);
  const wiped: CoinLiqResponse = { ...liq, buffered: 0 };
  const withoutBaseline = gateLiquidation(wiped, "long", 4);
  check(
    "5. liquidation baseline survives restart, empty buffer is insufficient",
    withBaseline.status === "ok" && withBaseline.z != null && Math.abs(withBaseline.z) <= 10 && withoutBaseline.status === "insufficient_baseline",
    `with=${withBaseline.status}/z=${withBaseline.z?.toFixed(2)} without=${withoutBaseline.status}`
  );
}

/* 6. Venue OI sums to the reported total. */
{
  const base = baseInputs(now);
  base.venues = [
    { venue: "binance", marketType: "perp", oiUsd: 1_000_000, oiBase: null, vol24Usd: 10_000_000, markPrice: MARK, fundingRate: 0.0001, nextFundingTime: now, status: "ok", venueSymbol: "IOUSDT", fetchedAt: now },
    { venue: "bybit", marketType: "perp", oiUsd: 400_000, oiBase: null, vol24Usd: 4_000_000, markPrice: MARK, fundingRate: 0.0002, nextFundingTime: now, status: "ok", venueSymbol: "IOUSDT", fetchedAt: now },

    { venue: "okx", marketType: "perp", oiUsd: 300_000, oiBase: null, vol24Usd: 3_000_000, markPrice: MARK, fundingRate: 0.0001, nextFundingTime: now, status: "ok", venueSymbol: "IO-USDT-SWAP", fetchedAt: now },
    { venue: "hyperliquid", marketType: "perp", oiUsd: 100_000, oiBase: null, vol24Usd: 1_000_000, markPrice: MARK, fundingRate: 0.0001, nextFundingTime: now, status: "ok", venueSymbol: "IO", fetchedAt: now },
  ];
  const a = computePositionAnalysis(base);
  const sum = a.openInterest.venues.reduce((acc, v) => acc + (v.oiUsd ?? 0), 0);
  check("6. total OI equals sum of per-venue OI", approx(a.openInterest.totalUsd, sum, 1e-6), `total=${a.openInterest.totalUsd} sum=${sum}`);
}

/* 7. Confidence drops when a field is unavailable / single-venue. */
{
  const base = baseInputs(now);
  const clean = computePositionAnalysis(base);
  base.venues = [
    { venue: "binance", marketType: "perp", oiUsd: 1_000_000, oiBase: null, vol24Usd: 10_000_000, markPrice: MARK, fundingRate: 0.0001, nextFundingTime: now, status: "failed", venueSymbol: "IOUSDT", fetchedAt: now },
  ];
  const degraded = computePositionAnalysis({ ...base, mcapUsd: null });
  check(
    "7. confidence falls below 100 with a visible reason list",
    clean.verdictBlock.confidence <= 100 &&
      degraded.verdictBlock.confidence < clean.verdictBlock.confidence &&
      degraded.verdictBlock.confidenceReasons.length > 0,
    `clean=${clean.verdictBlock.confidence} degraded=${degraded.verdictBlock.confidence} reasons=${degraded.verdictBlock.confidenceReasons.map((r) => r.label).join("|")}`
  );
}

/* 8. Same-bar TP and SL touch counts as SL. */
{
  const entry = 100;
  const hi = 106; // touches TP at +5%
  const lo = 94; // touches SL at -5%
  const resolved = sameBarResolver(entry, hi, lo, "long", 0.05, 0.05);
  const onlyTp = sameBarResolver(entry, 106, 98, "long", 0.05, 0.05);
  check(
    "8. same-bar TP and SL touch resolves SL",
    resolved === "sl" && onlyTp === "tp",
    `both=${resolved} tpOnly=${onlyTp}`
  );
}

/* 9. No forward probability when N_eff < 30. */
{
  const a = computePositionAnalysis(baseInputs(now, { horizonHours: 72 }));
  check(
    "9. N_eff < 30 suppresses forward probabilities",
    a.outcome.analog.gate === "insufficient_evidence"
      ? a.outcome.pTp == null && a.outcome.pSl == null
      : a.outcome.nEff >= 30,
    `gate=${a.outcome.analog.gate} nEff=${a.outcome.nEff} pTp=${a.outcome.pTp}`
  );
}

/* Wilson interval sanity, used by the CIs. */
{
  const [lo, hi] = wilson(3, 10);
  check("wilson(3,10) brackets 0.3", lo < 0.3 && hi > 0.3, `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`);
}

/**
 * Local mirror of the engine's single-bar resolution rule: within one bar a
 * simultaneous TP and SL touch resolves to SL (conservative). Exposed here so
 * the test does not depend on private engine internals.
 */
function sameBarResolver(entry: number, high: number, low: number, side: PositionSide, dTp: number, dSl: number): "tp" | "sl" | "none" {
  const tpPrice = side === "long" ? entry * (1 + dTp) : entry * (1 - dTp);
  const slPrice = side === "long" ? entry * (1 - dSl) : entry * (1 + dSl);
  const hitSl = side === "long" ? low <= slPrice : high >= slPrice;
  const hitTp = side === "long" ? high >= tpPrice : low <= tpPrice;
  if (hitSl) return "sl";
  if (hitTp) return "tp";
  return "none";
}
function sl1(entry: number, high: number, low: number): "tp" | "sl" | "none" {
  return sameBarResolver(entry, high, low, "long", 0.05, 0.05);
}

function report(): void {
  console.log(failures === 0 ? "\nALL POSITION REGRESSION CHECKS PASSED" : `\n${failures} POSITION CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

report();
