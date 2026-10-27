/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Position Analyst engine.
 *
 * Implements the four analytical layers of position_analyst_spec.md as pure
 * functions over already-fetched Binance/Bybit/OKX/Hyperliquid data:
 *   L1  Move anomaly      — is the recent move a fluke or an explained repricing
 *   L2  Reachability      — can price actually reach the TP/SL inside the horizon
 *   L3  Opposing levels   — bull/bear candle groups, air pockets, liq clusters
 *   L4  Market relative   — required vs available flow against mcap/OI/volume
 *
 * Forward-looking cards measure from a single `reference_price`: the mark for a
 * live position, the planned entry for a pre-entry analysis. Entry-based
 * figures are kept separately as "trade quality" and never drive the verdict.
 *
 * Everything is walk-forward: features and analogs only ever read bars that
 * precede the analysis clock. Where a feed cannot answer a question the field
 * is null with an explicit status rather than a fabricated number.
 */

import type {
  CoinLiqResponse,
  Interval,
  Kline,
  Market,
  PositionAlert,
  PositionAnalysisResponse,
  PositionAnalog,
  PositionConfidenceReason,
  PositionDepthBand,
  PositionField,
  PositionFieldStatus,
  PositionFlow,
  PositionFunding,
  PositionFundingVenue,
  PositionHeader,
  PositionInput,
  PositionLadderRow,
  PositionLevel,
  PositionLevels,
  PositionLiquidationEstimate,
  PositionMarketRelative,
  PositionMarketType,
  PositionMove,
  PositionMoveDriver,
  PositionMoveForward,
  PositionOpenInterest,
  PositionOrderBook,
  PositionOutcome,
  PositionReachability,
  PositionSide,
  PositionTradeQuality,
  PositionVenueSnapshot,
  PositionVerdict,
  PositionVerdictBlock,
  PositionWall,
} from "../types";

/* --------------------------------------------------------------------------- *
 * Raw inputs assembled by the server from the public venue endpoints.
 * ------------------------------------------------------------------------- */

export interface PositionDepthRaw {
  fetchedAt: number;
  venue: string;
  bids: [number, number][];
  asks: [number, number][];
}

export interface PositionFuturesRaw {
  markPrice: number | null;
  indexPrice: number | null;
  lastFundingRate: number | null;
  nextFundingTime: number | null;
  openInterestBase: number | null;
  openInterestTime: number | null;
  oiHistory: { time: number; sumOpenInterest: number; sumOpenInterestValue: number }[];
  fundingHistory: { time: number; rate: number }[];
}

export interface PositionManualOverrides {
  markPrice?: number | null;
  oiUsd?: number | null;
  vol24Usd?: number | null;
  mcapUsd?: number | null;
  /** Per-day volatility (fraction), used when klines cannot supply σ. */
  sigmaDay?: number | null;
  /** L4 impact constant; defaults to the calibrated value, not a leftover. */
  yImpact?: number | null;
  /** Fraction of OI that can plausibly be force-closed. */
  liqFraction?: number | null;
  /** Field keys that force the manual value to win even when auto succeeds. */
  locks?: string[];
}

/**
 * Liquidation-baseline health, measured server-side from the durable collector
 * so a restart does not silently reset the z-score baseline.
 */
export interface PositionLiqBaseline {
  events: number;
  spanMs: number;
  firstMs: number | null;
}

export interface PositionAnalystInputs {
  now: number;
  symbol: string;
  market: Market;
  marketType: PositionMarketType;
  baseAsset: string;
  name: string;
  input: PositionInput;
  klines: Kline[];
  btcKlines: Kline[];
  /** Spot klines, for the spot-perp basis even when the subject is perp. */
  spotKlines?: Kline[];
  depth: PositionDepthRaw | null;
  futures: PositionFuturesRaw | null;
  liq: CoinLiqResponse;
  /** Events retained for this symbol and the span they cover. */
  liqBaseline?: PositionLiqBaseline;
  mcapUsd: number | null;
  ticker: { lastPrice: number | null; quoteVolumeUsd: number | null } | null;
  firstBarTime: number | null;
  historyClamped: boolean;
  /** Multi-venue OI/volume/funding/mark snapshots assembled by the server. */
  venues?: PositionVenueSnapshot[];
  /** Operator-entered fallbacks for fields the feeds could not fill. */
  manual?: PositionManualOverrides;
}

/* --------------------------------------------------------------------------- *
 * Spec constants, engine config and defaults.
 * --------------------------------------------------------------------------- */

const BASE_INTERVAL: Interval = "15m";
const BARS_PER_HOUR = 4;
const VOL_LOOKBACK_BARS = 7 * 24 * BARS_PER_HOUR; // 672
const LEVEL_LOOKBACK_BARS = 48 * BARS_PER_HOUR; // 192 (N = 48h)
const LEVEL_HALF_LIFE_HOURS = 6;
const MOVE_SCAN_BARS = 24 * BARS_PER_HOUR; // 96
const MAX_MOVE_BARS = 8;
const MIN_ANALOGS = 30;
const MAINT_MARGIN = 0.005;
const Z_MOVE_THRESHOLD = 2;
const MAX_LIQ_Z = 10;
const LIQ_BASELINE_MIN_HOURS = 48;
const LIQ_BASELINE_MIN_EVENTS = 30;
const LOG1P_FLOOR = 0.5;

export interface PositionEngineConfig {
  /** Square-root impact constant (spec ~1; audit found ~3). */
  yImpact: number;
  /** Fraction of OI that can plausibly be liquidated in a spike. */
  liqFraction: number;
  /** Modelled leverage-tier weights for the liquidation ladder. */
  leverageTiers: { leverage: number; weight: number }[];
  /** Cap tiers at the symbol's max leverage. */
  maxLeverage: number;
  /** Max standardised feature distance for a nearest-neighbour match. */
  maxAnalogDistance: number;
  kMax: number;
}

/** Calibrated defaults: Y≈3 and a tier distribution peaking at 10–25×. */
export function defaultEngineConfig(): PositionEngineConfig {
  return {
    yImpact: 3,
    liqFraction: 0.3,
    leverageTiers: [
      { leverage: 5, weight: 0.1 },
      { leverage: 10, weight: 0.25 },
      { leverage: 25, weight: 0.3 },
      { leverage: 50, weight: 0.2 },
      { leverage: 100, weight: 0.15 },
    ],
    maxLeverage: 100,
    maxAnalogDistance: 2,
    kMax: 200,
  };
}

/* --------------------------------------------------------------------------- *
 * Numeric helpers.
 * --------------------------------------------------------------------------- */

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function sampleStd(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) * (v - m);
  return Math.sqrt(acc / (values.length - 1));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median-absolute-deviation sigma, scaled by 1.4826 to be stdev-consistent. */
function madSigma(values: number[]): number {
  if (values.length < 3) return sampleStd(values);
  const med = median(values);
  const dev = values.map((v) => Math.abs(v - med));
  return median(dev) * 1.4826 || sampleStd(values);
}

function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function percentileRank(value: number, values: number[]): number {
  if (values.length === 0) return 0;
  let count = 0;
  for (const v of values) if (v <= value) count += 1;
  return count / values.length;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function isNum(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return Math.sign(x) * y;
}

function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** Wilson score interval for a binomial proportion; returns [lo, hi] in [0,1]. */
export function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [clamp((center - margin) / denom, 0, 1), clamp((center + margin) / denom, 0, 1)];
}

function ols(y: number[], x: number[]): { alpha: number; beta: number; r2: number } {
  const n = Math.min(y.length, x.length);
  if (n < 3) return { alpha: 0, beta: 0, r2: 0 };
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const beta = sxx === 0 ? 0 : sxy / sxx;
  const alpha = my - beta * mx;
  const r2 = sxx === 0 || syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { alpha, beta, r2 };
}

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function resolveConfig(inputs: PositionAnalystInputs): PositionEngineConfig {
  const cfg = defaultEngineConfig();
  const m = inputs.manual ?? {};
  if (isNum(m.yImpact) && m.yImpact > 0) cfg.yImpact = m.yImpact;
  if (isNum(m.liqFraction) && m.liqFraction > 0) cfg.liqFraction = clamp(m.liqFraction, 0.01, 1);
  const maxLev = inputs.input.maxLeverage;
  if (isNum(maxLev) && maxLev > 0) cfg.maxLeverage = maxLev;
  cfg.leverageTiers = cfg.leverageTiers.filter((t) => t.leverage <= cfg.maxLeverage);
  return cfg;
}

/* --------------------------------------------------------------------------- *
 * Tensors.
 * --------------------------------------------------------------------------- */

interface AlignedBar {
  time: number;
  coinClose: number;
  coinReturn: number;
  btcReturn: number;
}

function buildAligned(coin: Kline[], btc: Kline[]): AlignedBar[] {
  const btcMap = new Map<number, number>();
  for (const k of btc) btcMap.set(k.time, k.close);
  const out: AlignedBar[] = [];
  for (let i = 1; i < coin.length; i += 1) {
    const bPrev = btcMap.get(coin[i - 1].time);
    const b = btcMap.get(coin[i].time);
    if (bPrev == null || b == null || bPrev <= 0) continue;
    out.push({
      time: coin[i].time,
      coinClose: coin[i].close,
      coinReturn: coin[i].close / coin[i - 1].close - 1,
      btcReturn: b / bPrev - 1,
    });
  }
  return out;
}

function barReturns(klines: Kline[]): number[] {
  const out: number[] = [0];
  for (let i = 1; i < klines.length; i += 1) {
    out.push(klines[i].close / klines[i - 1].close - 1);
  }
  return out;
}

/** Median USD volume over a rolling `bars`-length window (the horizon volume). */
function rollingVolumeMedian(klines: Kline[], bars: number): number | null {
  if (klines.length < bars + 2) return null;
  const usd = klines.map((k) => k.close * k.volume);
  const sums: number[] = [];
  let run = 0;
  for (let i = 0; i < usd.length; i += 1) {
    run += usd[i];
    if (i >= bars) run -= usd[i - bars];
    if (i >= bars - 1) sums.push(run);
  }
  return sums.length ? median(sums) : null;
}

function computeAtr(klines: Kline[], period = 14): number {
  if (klines.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < klines.length; i += 1) {
    const prevClose = klines[i - 1].close;
    trs.push(
      Math.max(
        klines[i].high - klines[i].low,
        Math.abs(klines[i].high - prevClose),
        Math.abs(klines[i].low - prevClose)
      )
    );
  }
  return mean(trs.slice(-period));
}

/* --------------------------------------------------------------------------- *
 * L1 — Move anomaly.
 * --------------------------------------------------------------------------- */

interface MoveDetection {
  startIndex: number;
  endIndex: number;
  moveBars: number;
  moveReturn: number;
  moveResidual: number;
  sigmaBaseline: number;
  sigmaResidual: number;
  zRaw: number;
  zRes: number;
  beta: number;
  r2: number;
  percentile: number;
}

function detectMove(klines: Kline[], aligned: AlignedBar[]): MoveDetection {
  const returns = barReturns(klines);
  const sigma = madSigma(returns.slice(1)) || sampleStd(returns.slice(1)) || 1e-9;

  const reg = ols(
    aligned.map((a) => a.coinReturn),
    aligned.map((a) => a.btcReturn)
  );
  const residMap = new Map<number, number>();
  for (const a of aligned) {
    residMap.set(a.time, a.coinReturn - (reg.alpha + reg.beta * a.btcReturn));
  }
  const residuals = [...residMap.values()];
  const sigmaResidual = madSigma(residuals) || sampleStd(residuals) || 1e-9;

  const n = klines.length;
  const scanStart = Math.max(1, n - MOVE_SCAN_BARS);

  let endIndex = -1;
  for (let i = n - 1; i >= scanStart; i -= 1) {
    if (Math.abs(returns[i]) >= Z_MOVE_THRESHOLD * sigma) {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    let best = -1;
    let bestAbs = 0;
    for (let i = scanStart; i < n; i += 1) {
      if (Math.abs(returns[i]) > bestAbs) {
        bestAbs = Math.abs(returns[i]);
        best = i;
      }
    }
    endIndex = best === -1 ? n - 1 : best;
  }

  let startIndex = endIndex;
  const sign = Math.sign(returns[endIndex]) || 1;
  while (
    startIndex > 1 &&
    endIndex - startIndex + 1 < MAX_MOVE_BARS &&
    Math.sign(returns[startIndex - 1]) === sign &&
    Math.abs(returns[startIndex - 1]) >= 0.5 * sigma
  ) {
    startIndex -= 1;
  }

  const baseIndex = Math.max(0, startIndex - 1);
  const baseClose = klines[baseIndex].close;
  const moveReturn = baseClose > 0 ? klines[endIndex].close / baseClose - 1 : 0;
  const moveBars = endIndex - startIndex + 1;

  let moveResidual = 0;
  for (let i = startIndex; i <= endIndex; i += 1) {
    moveResidual += residMap.get(klines[i].time) ?? 0;
  }

  const denomRaw = sigma * Math.sqrt(moveBars);
  const denomRes = sigmaResidual * Math.sqrt(moveBars);
  const zRaw = denomRaw === 0 ? 0 : moveReturn / denomRaw;
  const zRes = denomRes === 0 ? 0 : moveResidual / denomRes;

  const windows: number[] = [];
  const absMove = Math.abs(moveReturn);
  for (let i = moveBars; i < startIndex; i += 1) {
    const b = klines[i - moveBars].close;
    if (b > 0) windows.push(Math.abs(klines[i].close / b - 1));
  }
  const percentile = percentileRank(absMove, windows);

  return {
    startIndex,
    endIndex,
    moveBars,
    moveReturn,
    moveResidual,
    sigmaBaseline: sigma,
    sigmaResidual,
    zRaw,
    zRes,
    beta: reg.beta,
    r2: reg.r2,
    percentile,
  };
}

/* --------------------------------------------------------------------------- *
 * L2 — Reachability.
 * --------------------------------------------------------------------------- */

interface TpSlGeometry {
  dTp: number | null;
  dSl: number | null;
  tpPrice: number | null;
  slPrice: number | null;
}

function geometryFrom(
  reference: number,
  side: PositionSide,
  takeProfit: number | null,
  stopLoss: number | null
): TpSlGeometry {
  let dTp: number | null = null;
  let dSl: number | null = null;
  if (takeProfit != null && reference > 0) {
    dTp = Math.abs(takeProfit - reference) / reference;
  }
  if (stopLoss != null && reference > 0) {
    dSl = Math.abs(stopLoss - reference) / reference;
  }
  return { dTp, dSl, tpPrice: takeProfit, slPrice: stopLoss };
}

/** Cumulative opposing notional between mid and `price` on the order book. */
function sweepCost(depth: PositionDepthRaw | null, price: number): number | null {
  if (!depth) return null;
  const bestBid = depth.bids[0]?.[0];
  const bestAsk = depth.asks[0]?.[0];
  if (!bestBid || !bestAsk) return null;
  const mid = (bestBid + bestAsk) / 2;
  if (price >= mid) {
    let cost = 0;
    for (const [p, q] of depth.asks) {
      if (p > price) break;
      cost += p * q;
    }
    return cost;
  }
  let cost = 0;
  for (const [p, q] of depth.bids) {
    if (p < price) break;
    cost += p * q;
  }
  return cost;
}

/* --------------------------------------------------------------------------- *
 * L3 — Levels (candle groups).
 * --------------------------------------------------------------------------- */

interface CandleGroupLevel {
  price: number;
  low: number;
  high: number;
  weight: number;
  bullWeight: number;
  bearWeight: number;
}

function buildCandleGroupLevels(
  klines: Kline[],
  atr: number,
  lookback = LEVEL_LOOKBACK_BARS
): { bucketPct: number; buckets: CandleGroupLevel[]; markPrice: number } {
  const window = klines.slice(-lookback);
  const markPrice = klines.length > 0 ? klines[klines.length - 1].close : 0;
  const bucketPct = markPrice > 0 ? Math.max(0.25 * atr, markPrice * 1e-4) / markPrice : 0.001;
  const bucketWidth = markPrice > 0 ? markPrice * bucketPct : 0;

  const map = new Map<number, CandleGroupLevel>();
  const nowTime = klines.length > 0 ? klines[klines.length - 1].time : 0;
  const halfLifeMs = LEVEL_HALF_LIFE_HOURS * 3600 * 1000;

  for (const k of window) {
    const typical = (k.high + k.low + k.close) / 3;
    const key = bucketWidth > 0 ? Math.round(typical / bucketWidth) : 0;
    let bucket = map.get(key);
    if (!bucket) {
      const center = key * bucketWidth;
      bucket = {
        price: center,
        low: center - bucketWidth / 2,
        high: center + bucketWidth / 2,
        weight: 0,
        bullWeight: 0,
        bearWeight: 0,
      };
      map.set(key, bucket);
    }
    const ageMs = Math.max(0, nowTime - k.time);
    const decay = Math.exp(-ageMs / halfLifeMs);
    const w = k.volume * decay;
    bucket.weight += w;
    if (k.close >= k.open) bucket.bullWeight += w;
    else bucket.bearWeight += w;
  }

  const buckets = [...map.values()].sort((a, b) => a.price - b.price);
  return { bucketPct, buckets, markPrice };
}

function polarityOf(bucket: CandleGroupLevel): "bull" | "bear" | "mixed" {
  const total = bucket.bullWeight + bucket.bearWeight;
  if (total <= 0) return "mixed";
  const ratio = bucket.bullWeight / total;
  if (ratio >= 0.6) return "bull";
  if (ratio <= 0.4) return "bear";
  return "mixed";
}

/* --------------------------------------------------------------------------- *
 * Analog engine — nearest-neighbour matching with honest uncertainty.
 * --------------------------------------------------------------------------- */

interface AnalogResult {
  pTp: number | null;
  pSl: number | null;
  pTimeout: number | null;
  pTpCi: [number, number] | null;
  pSlCi: [number, number] | null;
  nRaw: number;
  nEff: number;
  dateStart: number | null;
  dateEnd: number | null;
  medianBarsToExit: number | null;
  mfeMedian: number | null;
  maeMedian: number | null;
}

function emptyAnalog(): AnalogResult {
  return {
    pTp: null,
    pSl: null,
    pTimeout: null,
    pTpCi: null,
    pSlCi: null,
    nRaw: 0,
    nEff: 0,
    dateStart: null,
    dateEnd: null,
    medianBarsToExit: null,
    mfeMedian: null,
    maeMedian: null,
  };
}

/** Greedy effective sample size: analogs at least `spacing` bars apart. */
export function effectiveCount(sortedIndices: number[], spacing: number): number {
  let count = 0;
  let last = -Infinity;
  for (const i of sortedIndices) {
    if (i - last >= spacing) {
      count += 1;
      last = i;
    }
  }
  return count;
}

function outcomeOf(
  klines: Kline[],
  i: number,
  isLong: boolean,
  dTp: number,
  dSl: number,
  horizonBars: number
): { outcome: "tp" | "sl" | "timeout"; exitBar: number; mfe: number; mae: number } {
  const entry = klines[i].close;
  const tpPrice = isLong ? entry * (1 + dTp) : entry * (1 - dTp);
  const slPrice = isLong ? entry * (1 - dSl) : entry * (1 + dSl);
  let outcome: "tp" | "sl" | "timeout" = "timeout";
  let exitBar = horizonBars;
  let mfe = 0;
  let mae = 0;
  for (let j = i + 1; j <= i + horizonBars && j < klines.length; j += 1) {
    const hi = klines[j].high;
    const lo = klines[j].low;
    mfe = Math.max(mfe, isLong ? hi / entry - 1 : entry / lo - 1);
    mae = Math.min(mae, isLong ? lo / entry - 1 : entry / hi - 1);
    const hitSl = isLong ? lo <= slPrice : hi >= slPrice;
    const hitTp = isLong ? hi >= tpPrice : lo <= tpPrice;
    // Both barriers touched within one bar counts as SL (conservative).
    if (hitSl) {
      outcome = "sl";
      exitBar = j - i;
      break;
    }
    if (hitTp) {
      outcome = "tp";
      exitBar = j - i;
      break;
    }
  }
  return { outcome, exitBar, mfe, mae };
}

/** Incremental (walk-forward) volume profile -> distance to nearest opposing level. */
function levelFeatureSeries(
  klines: Kline[],
  atr: number,
  bucketWidth: number,
  side: PositionSide
): { dist: number[]; strength: number[] } {
  const n = klines.length;
  const dist = new Array<number>(n).fill(10);
  const strength = new Array<number>(n).fill(0);
  if (bucketWidth <= 0 || atr <= 0) return { dist, strength };
  const keyOf = (k: Kline): number => Math.round(((k.high + k.low + k.close) / 3) / bucketWidth);
  const keys = new Array<number>(n);
  const bucket = new Map<number, number>();
  const isLong = side === "long";

  for (let i = 0; i < n; i += 1) {
    const k = klines[i];
    const key = keyOf(k);
    keys[i] = key;
    bucket.set(key, (bucket.get(key) ?? 0) + k.volume);
    if (i >= LEVEL_LOOKBACK_BARS) {
      const oldKey = keys[i - LEVEL_LOOKBACK_BARS];
      const remaining = (bucket.get(oldKey) ?? 0) - klines[i - LEVEL_LOOKBACK_BARS].volume;
      if (remaining <= 0) bucket.delete(oldKey);
      else bucket.set(oldKey, remaining);
    }
    const close = k.close;
    let bestDist = 10;
    let bestVol = 0;
    let maxVol = 0;
    for (const [bkey, vol] of bucket) {
      maxVol = Math.max(maxVol, vol);
      const centre = bkey * bucketWidth;
      if (isLong && centre > close) {
        const d = (centre - close) / atr;
        if (d < bestDist) {
          bestDist = d;
          bestVol = vol;
        }
      } else if (!isLong && centre < close) {
        const d = (close - centre) / atr;
        if (d < bestDist) {
          bestDist = d;
          bestVol = vol;
        }
      }
    }
    dist[i] = bestDist;
    strength[i] = maxVol > 0 ? bestVol / maxVol : 0;
  }
  return { dist, strength };
}

function standardize(values: number[]): { mean: number; std: number } {
  const m = mean(values);
  const s = sampleStd(values) || 1;
  return { mean: m, std: s };
}

interface AnalogSet {
  result: AnalogResult;
  matchedIndices: number[];
  allIndices: number[];
  distances: number[];
  pooled: boolean;
  featuresUsed: string[];
  featuresOmitted: string[];
}

/**
 * Feature vector matching over kline history. Only features that can be
 * reconstructed walk-forward are used; the rest are reported as omitted rather
 * than silently dropped.
 */
function buildAnalogSet(
  klines: Kline[],
  aligned: AlignedBar[],
  input: PositionInput,
  dTp: number,
  dSl: number,
  horizonBars: number,
  atr: number,
  cfg: PositionEngineConfig
): AnalogSet {
  const featuresOmitted = [
    "quadrant (no per-bar OI history)",
    "liq_z (no historical liquidation baseline per bar)",
    "depth_z (no stored book snapshots)",
    "sweep_ratio (no historical book)",
    "market_relative_score (cross-sectional history absent)",
  ];
  const featuresUsed = [
    "z_res",
    "vol_z",
    "delta_z",
    "dist_to_level_atr",
    "level_strength",
    "hour_sin",
    "hour_cos",
  ];

  const empty: AnalogSet = {
    result: emptyAnalog(),
    matchedIndices: [],
    allIndices: [],
    distances: [],
    pooled: false,
    featuresUsed,
    featuresOmitted,
  };

  const isLong = input.side === "long";
  const returns = barReturns(klines);
  const n = klines.length;
  const startIdx = Math.max(LEVEL_LOOKBACK_BARS, 20);
  const lastIdx = n - horizonBars - 1;
  if (lastIdx <= startIdx) return empty;

  const residMap = new Map<number, number>();
  const reg = ols(
    aligned.map((a) => a.coinReturn),
    aligned.map((a) => a.btcReturn)
  );
  for (const a of aligned) residMap.set(a.time, a.coinReturn - (reg.alpha + reg.beta * a.btcReturn));

  const volUsd = klines.map((k) => k.close * k.volume);
  const delta = klines.map((k) => 2 * (k.takerBuy ?? k.volume / 2) - k.volume);

  const buckets = klines.length > 0 ? Math.max(0.25 * atr, klines[n - 1].close * 1e-4) : 0;
  const level = levelFeatureSeries(klines, atr || 1e-9, buckets, input.side);

  // Rolling residual / volume / delta standardisation (trailing window).
  const rollStd = (arr: number[], i: number, win = LEVEL_LOOKBACK_BARS): number => {
    const from = Math.max(0, i - win);
    return sampleStd(arr.slice(from, i + 1)) || 1e-9;
  };
  const rollMean = (arr: number[], i: number, win = VOL_LOOKBACK_BARS): number => {
    const from = Math.max(0, i - win);
    return mean(arr.slice(from, i + 1));
  };

  const residSeries: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i += 1) residSeries[i] = residMap.get(klines[i].time) ?? 0;

  const featureAt = (i: number): number[] => {
    const hour = (new Date(klines[i].time).getUTCHours() + new Date(klines[i].time).getUTCMinutes() / 60) / 24;
    return [
      residSeries[i] / rollStd(residSeries, i),
      (volUsd[i] - rollMean(volUsd, i)) / rollStd(volUsd, i),
      (delta[i] - rollMean(delta, i)) / rollStd(delta, i),
      level.dist[i],
      level.strength[i],
      Math.sin(2 * Math.PI * hour),
      Math.cos(2 * Math.PI * hour),
    ];
  };

  const candidates: { index: number; feat: number[] }[] = [];
  for (let i = startIdx; i <= lastIdx; i += 1) {
    if (klines[i].close <= 0) continue;
    candidates.push({ index: i, feat: featureAt(i) });
  }
  if (candidates.length < MIN_ANALOGS) return empty;

  const currentFeat = featureAt(n - 1);
  const stats = currentFeat.map((_, f) => standardize(candidates.map((c) => c.feat[f])));
  const std = (v: number, f: number): number => (v - stats[f].mean) / stats[f].std;

  const dist = candidates.map((c) => {
    let acc = 0;
    for (let f = 0; f < currentFeat.length; f += 1) {
      const d = std(c.feat[f], f) - std(currentFeat[f], f);
      acc += d * d;
    }
    return { index: c.index, distance: Math.sqrt(acc) };
  });

  const matched = dist
    .filter((d) => d.distance <= cfg.maxAnalogDistance)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, cfg.kMax);

  const replay = (indices: number[]): AnalogResult => {
    let tp = 0;
    let sl = 0;
    let timeout = 0;
    const barsToExit: number[] = [];
    const mfes: number[] = [];
    const maes: number[] = [];
    let first: number | null = null;
    let last: number | null = null;
    for (const i of indices) {
      const o = outcomeOf(klines, i, isLong, dTp, dSl, horizonBars);
      if (o.outcome === "tp") tp += 1;
      else if (o.outcome === "sl") sl += 1;
      else timeout += 1;
      if (o.outcome !== "timeout") barsToExit.push(o.exitBar);
      mfes.push(o.mfe);
      maes.push(o.mae);
      if (first == null) first = klines[i].time;
      last = klines[i].time;
    }
    const total = tp + sl + timeout;
    if (total === 0) return emptyAnalog();
    return {
      pTp: tp / total,
      pSl: sl / total,
      pTimeout: timeout / total,
      pTpCi: null,
      pSlCi: null,
      nRaw: total,
      nEff: total,
      dateStart: first,
      dateEnd: last,
      medianBarsToExit: barsToExit.length ? median(barsToExit) : null,
      mfeMedian: mfes.length ? median(mfes) : null,
      maeMedian: maes.length ? median(maes) : null,
    };
  };

  const matchedIndices = matched.map((m) => m.index).sort((a, b) => a - b);
  let chosen = matchedIndices;
  let pooled = false;
  let nEff = effectiveCount(chosen, horizonBars);

  // Fallback: relax to the full unmatched pool before declaring no evidence.
  if (nEff < MIN_ANALOGS) {
    chosen = candidates.map((c) => c.index).sort((a, b) => a - b);
    pooled = true;
    nEff = effectiveCount(chosen, horizonBars);
  }

  const result = replay(chosen);
  const distances = matched.length ? matched.map((m) => m.distance) : [];

  // Intervals are computed from N_eff, never from N_raw.
  if (result.pTp != null && result.pSl != null && nEff >= MIN_ANALOGS) {
    const scaledTp = Math.round((result.pTp ?? 0) * nEff);
    const scaledSl = Math.round((result.pSl ?? 0) * nEff);
    result.pTpCi = wilson(scaledTp, nEff);
    result.pSlCi = wilson(scaledSl, nEff);
  }
  result.nEff = nEff;

  return {
    result,
    matchedIndices: chosen,
    allIndices: candidates.map((c) => c.index),
    distances,
    pooled,
    featuresUsed,
    featuresOmitted,
  };
}

/* --------------------------------------------------------------------------- *
 * L4 — Market relative.
 * --------------------------------------------------------------------------- */

function computeMarketRelative(
  marketType: PositionMarketType,
  dTp: number | null,
  dSl: number | null,
  sigmaPerBar: number,
  sigmaH: number,
  mcapUsd: number | null,
  vol24Usd: number | null,
  oiUsd: number | null,
  horizonBars: number,
  vHorizonUsd: number | null,
  basisPct: number | null,
  cfg: PositionEngineConfig,
  empiricalTarget: number | null
): PositionMarketRelative {
  const flags: string[] = [];
  const sigmaDay = sigmaPerBar * Math.sqrt(24 * BARS_PER_HOUR);
  const targetMove = dTp ?? (dSl != null ? Math.abs(dSl) : null);

  const vDay = vol24Usd;
  const qRequiredDay =
    vDay != null && sigmaDay > 0 && targetMove != null && targetMove > 0
      ? vDay * Math.pow(targetMove / (cfg.yImpact * sigmaDay), 2)
      : null;
  const qRequiredHorizon =
    vHorizonUsd != null && sigmaH > 0 && targetMove != null && targetMove > 0
      ? vHorizonUsd * Math.pow(targetMove / (cfg.yImpact * sigmaH), 2)
      : null;
  const fMax = oiUsd != null ? oiUsd * cfg.liqFraction : null;

  let plausFlow: number | null = null;
  if (qRequiredHorizon != null && vHorizonUsd != null && vHorizonUsd > 0) {
    plausFlow = clamp(1 - qRequiredHorizon / (vHorizonUsd + (fMax ?? 0)), 0, 1);
  }

  const volMcap = mcapUsd && vol24Usd != null ? vol24Usd / mcapUsd : null;
  const oiMcap = mcapUsd && oiUsd != null ? oiUsd / mcapUsd : null;
  const oiVol = vol24Usd && oiUsd != null ? oiUsd / vol24Usd : null;

  if (mcapUsd == null) flags.push("Market cap unavailable (CoinGecko miss or symbol ambiguity)");
  if (oiUsd == null) flags.push("Open interest unavailable (spot pair or futures feed miss)");
  if (plausFlow != null && plausFlow < 0.05) flags.push("Required flow exceeds plausible available flow");
  if (oiVol != null && oiVol > 3) flags.push("Open interest is large relative to 24h volume (crowded)");

  let label: PositionMarketRelative["label"] = "UNAVAILABLE";
  if (plausFlow != null) {
    if (plausFlow >= 0.2) label = "PLAUSIBLE";
    else if (plausFlow >= 0.05) label = "STRETCHED";
    else label = "IMPLAUSIBLE";
  }

  return {
    marketType,
    mcapUsd,
    fdvUsd: null,
    vol24Usd,
    volMcap,
    oiUsd,
    oiMcap,
    oiVol,
    fdvMcap: null,
    universePercentiles: null,
    tierPercentiles: null,
    vDayUsd: vDay,
    vHorizonUsd: vHorizonUsd,
    qRequiredDayUsd: qRequiredDay,
    qRequiredHorizonUsd: qRequiredHorizon,
    fMaxUsd: fMax,
    plausFlow,
    targetMove,
    basisPct,
    constants: {
      yImpact: cfg.yImpact,
      liqFraction: cfg.liqFraction,
      sigmaH,
      vHorizonUsd,
      vDayUsd: vDay,
    },
    empiricalMovePercentile: empiricalTarget,
    label,
    flags,
    note:
      "Universe/tier percentiles need stored cross-sectional history; shown as unavailable rather than defaulted. Q_required uses the reference-based target move.",
  };
}

/* --------------------------------------------------------------------------- *
 * Assembly.
 * --------------------------------------------------------------------------- */

export function computePositionAnalysis(inputs: PositionAnalystInputs): PositionAnalysisResponse {
  const { input, klines, btcKlines, now } = inputs;
  const cfg = resolveConfig(inputs);
  const warnings: string[] = [];
  const caveats: string[] = [
    "Multi-venue OI/funding are summed where a fetcher is implemented; venues marked not_implemented are not inferred.",
    "Liquidation clusters, sweep cost and funding-in-window are model estimates, not venue facts.",
    "Analog hit-rates are nearest-neighbour replays over stored history; walk-forward, no look-ahead.",
  ];

  const horizonBars = Math.max(1, Math.round(input.horizonHours * BARS_PER_HOUR));

  const returns = barReturns(klines);
  let sigmaPerBar =
    madSigma(returns.slice(1)) || sampleStd(returns.slice(1)) || (klines.length ? 0.005 : 0);

  // ---------- Manual fallbacks (operator-supplied) ----------
  const manual = inputs.manual ?? {};
  const locks = new Set(manual.locks ?? []);
  const manualUsed: string[] = [];
  const resolve = (key: string, auto: number | null, fallback: number | null | undefined): number | null => {
    if (fallback != null && (locks.has(key) || auto == null)) {
      manualUsed.push(key);
      return fallback;
    }
    return auto;
  };

  const move = detectMove(klines, buildAligned(klines, btcKlines));

  // ---------- Reference price (P1) ----------
  const lastClose = klines.length ? klines[klines.length - 1].close : null;
  const mark = resolve("mark", inputs.ticker?.lastPrice ?? lastClose, manual.markPrice);
  const explicitRef = isNum(input.referencePrice) && input.referencePrice > 0 ? input.referencePrice : null;
  const referencePrice =
    explicitRef ?? (input.openedAt != null && mark != null ? mark : input.entry);
  const referenceSource: "mark" | "entry" | "manual" =
    explicitRef != null ? "manual" : input.openedAt != null && mark != null ? "mark" : "entry";

  const geo = geometryFrom(referencePrice, input.side, input.takeProfit, input.stopLoss);
  const geoEntry = geometryFrom(input.entry, input.side, input.takeProfit, input.stopLoss);

  const vol24 = resolve("vol24", inputs.ticker?.quoteVolumeUsd ?? null, manual.vol24Usd);
  const mcapUsd = resolve("mcap", inputs.mcapUsd, manual.mcapUsd);
  if (manual.sigmaDay != null && manual.sigmaDay > 0 && (locks.has("sigma") || !(sigmaPerBar > 0))) {
    sigmaPerBar = manual.sigmaDay / Math.sqrt(24 * BARS_PER_HOUR);
    manualUsed.push("sigma");
  }

  const sizeUsd = input.size != null && mark != null ? input.size * mark : null;
  const dir = input.side === "long" ? 1 : -1;
  const uPnlPct = mark != null && input.entry > 0 ? (dir * (mark - input.entry)) / input.entry : null;
  const uPnlUsd = uPnlPct != null && sizeUsd != null ? uPnlPct * sizeUsd : null;
  const riskPerUnit = geoEntry.dSl != null ? geoEntry.dSl * input.entry : null;
  const rMultiple =
    mark != null && riskPerUnit && riskPerUnit > 0 ? (dir * (mark - input.entry)) / riskPerUnit : null;

  const sigmaH = sigmaPerBar * Math.sqrt(horizonBars);
  const atr = computeAtr(klines, 14);
  const atrPct = mark != null && mark > 0 && atr > 0 ? atr / mark : null;

  const distanceToTpPct =
    geo.tpPrice != null && referencePrice > 0 ? Math.abs(geo.tpPrice - referencePrice) / referencePrice : null;
  const distanceToSlPct =
    geo.slPrice != null && referencePrice > 0 ? Math.abs(geo.slPrice - referencePrice) / referencePrice : null;
  const distanceToTpSigma = distanceToTpPct != null && sigmaH > 0 ? distanceToTpPct / sigmaH : null;
  const distanceToSlSigma = distanceToSlPct != null && sigmaH > 0 ? distanceToSlPct / sigmaH : null;

  const elapsedHours = input.openedAt != null ? (now - input.openedAt) / 3600000 : null;
  const remainingHours = elapsedHours != null ? Math.max(0, input.horizonHours - elapsedHours) : null;
  const timeoutAt = input.openedAt != null ? input.openedAt + input.horizonHours * 3600000 : null;
  const expired = timeoutAt != null ? now >= timeoutAt : false;

  // ---------- P5 alerts ----------
  const crossedSl =
    geo.slPrice != null && referencePrice > 0
      ? input.side === "long"
        ? referencePrice <= geo.slPrice
        : referencePrice >= geo.slPrice
      : false;
  const crossedTp =
    geo.tpPrice != null && referencePrice > 0
      ? input.side === "long"
        ? referencePrice >= geo.tpPrice
        : referencePrice <= geo.tpPrice
      : false;
  const slPriceDist = geo.slPrice != null && mark != null ? Math.abs(mark - geo.slPrice) : null;
  const stopImminent =
    !crossedSl &&
    slPriceDist != null &&
    referenceSource === "mark" &&
    ((distanceToSlSigma != null && distanceToSlSigma <= 0.5) || (atr > 0 && slPriceDist <= atr));

  const alerts: PositionAlert[] = [];
  if (crossedSl)
    alerts.push({ code: "STOP_BREACHED", severity: "critical", message: `Mark ${mark} is beyond the stop ${geo.slPrice}; the position is stopped out.` });
  if (crossedTp)
    alerts.push({ code: "TARGET_REACHED", severity: "info", message: `Mark ${mark} is beyond the target ${geo.tpPrice}; the target is reached.` });
  if (stopImminent)
    alerts.push({
      code: "STOP_IMMINENT",
      severity: "warning",
      message: `Stop is within ${distanceToSlSigma != null ? distanceToSlSigma.toFixed(2) : "0.5"}σ_H of the mark (≤ 1 ATR).`,
    });
  if (expired)
    alerts.push({ code: "EXPIRED", severity: "warning", message: "Position is past its holding horizon; forward figures are re-baselined." });

  const header: PositionHeader = {
    side: input.side,
    entry: input.entry,
    mark,
    referencePrice,
    referenceSource,
    sizeUsd,
    leverage: input.leverage,
    uPnlUsd,
    uPnlPct,
    rMultiple,
    takeProfit: input.takeProfit,
    stopLoss: input.stopLoss,
    distanceToTpPct,
    distanceToSlPct,
    distanceToTpSigma,
    distanceToSlSigma,
    horizonHours: input.horizonHours,
    elapsedHours,
    remainingHours,
    timeoutAt,
    expired,
    alerts,
  };

  // ---------- L2 Reachability ----------
  const empiricalForward: number[] = [];
  for (let i = 0; i + horizonBars < klines.length; i += 1) {
    const base = klines[i].close;
    if (base > 0) empiricalForward.push(klines[i + horizonBars].close / base - 1);
  }
  const sigmaHEmpirical = empiricalForward.length > 5 ? sampleStd(empiricalForward) : null;
  const sigmaDivergence = sigmaHEmpirical != null && sigmaH > 0 ? sigmaHEmpirical / sigmaH - 1 : null;
  const sigmaRatio = sigmaHEmpirical != null && sigmaH > 0 ? sigmaHEmpirical / sigmaH : null;

  const kTp = geo.dTp != null && sigmaH > 0 ? geo.dTp / sigmaH : null;
  const kSl = geo.dSl != null && sigmaH > 0 ? geo.dSl / sigmaH : null;
  const pTouchTp = kTp != null ? 2 * (1 - normCdf(kTp)) : null;
  const pTouchSl = kSl != null ? 2 * (1 - normCdf(kSl)) : null;
  const pTpFirstDriftless =
    geo.dTp != null && geo.dSl != null && geo.dTp + geo.dSl > 0
      ? geo.dSl / (geo.dTp + geo.dSl)
      : null;

  const entryKTp = geoEntry.dTp != null && sigmaH > 0 ? geoEntry.dTp / sigmaH : null;
  const entryKSl = geoEntry.dSl != null && sigmaH > 0 ? geoEntry.dSl / sigmaH : null;
  const tradeQuality: PositionTradeQuality = {
    entryKTp,
    entryKSl,
    entryDTp: geoEntry.dTp,
    entryDSl: geoEntry.dSl,
    entryPTouchTp: entryKTp != null ? 2 * (1 - normCdf(entryKTp)) : null,
    entryPTouchSl: entryKSl != null ? 2 * (1 - normCdf(entryKSl)) : null,
    entryTpFirstDriftless:
      geoEntry.dTp != null && geoEntry.dSl != null && geoEntry.dTp + geoEntry.dSl > 0
        ? geoEntry.dSl / (geoEntry.dTp + geoEntry.dSl)
        : null,
  };

  const medianBarVolume = median(klines.slice(-VOL_LOOKBACK_BARS).map((k) => k.close * k.volume));
  const flowPerBar = vol24 != null ? vol24 / (24 * BARS_PER_HOUR) : medianBarVolume;
  const sweepTp = geo.tpPrice != null ? sweepCost(inputs.depth, geo.tpPrice) : null;
  const sweepSl = geo.slPrice != null ? sweepCost(inputs.depth, geo.slPrice) : null;
  const sweepRatioTp = sweepTp != null && flowPerBar > 0 ? sweepTp / (flowPerBar * horizonBars) : null;
  const sweepRatioSl = sweepSl != null && flowPerBar > 0 ? sweepSl / (flowPerBar * horizonBars) : null;

  const depthImbalance = computeDepthImbalance(inputs.depth, mark);

  const reachability: PositionReachability = {
    horizonBars,
    referencePrice,
    referenceSource,
    sigmaH,
    sigmaHEmpirical,
    sigmaDivergence,
    atr,
    atrPct,
    sigmaBaselinePct: sigmaPerBar,
    sigmaRatio,
    dTp: geo.dTp,
    dSl: geo.dSl,
    kTp,
    kSl,
    pTouchTp,
    pTouchSl,
    pTpFirstDriftless,
    sweepRatioTp,
    sweepRatioSl,
    depthImbalance,
    tpInCluster: null,
    slExposed: null,
    fundingInWindow: countFundingInWindow(inputs.futures, now, horizonBars),
    tradeQuality,
    label: reachabilityLabel(kTp),
    interpretation:
      kTp == null
        ? "No take-profit supplied; reachability is undefined."
        : `TP sits ${kTp.toFixed(2)}σ_H from the ${referenceSource === "entry" ? "entry" : "mark"}, so a naive first-touch estimate is ${(pTouchTp! * 100).toFixed(0)}%.`,
  };

  // ---------- Order book ----------
  const orderBook = computeOrderBook(inputs.depth, mark, now);

  // ---------- Multi-venue OI / funding (P3) ----------
  const venues = inputs.venues ?? [];
  const oiAuto =
    inputs.futures?.openInterestBase != null && mark != null
      ? inputs.futures.openInterestBase * mark
      : null;
  const oiUsd = resolve("oi", oiAuto, manual.oiUsd);
  const openInterest = computeOpenInterest(inputs, mark, oiUsd, vol24, venues);
  const oiTotalUsd = openInterest.totalUsd;
  reachability.tpInCluster = oiClusterNear(geo.tpPrice, mark, atr);
  reachability.slExposed = geo.slPrice != null ? slExposed(geo.slPrice, mark, input.side, atr, inputs.depth) : null;

  // ---------- L3 Levels ----------
  const levels = computeLevels(
    klines,
    mark,
    atr,
    geo,
    input,
    oiTotalUsd,
    sigmaPerBar,
    cfg,
    // Long/short OI split from the quadrant history so the two liq sides differ.
    longShareFromQuadrant(oiQuadrant(inputs.futures, move, inputs.liq, inputs.liqBaseline))
  );

  // ---------- Analog outcome (P1/P2) ----------
  const crossStatus: PositionOutcome["status"] = crossedSl
    ? "STOP_BREACHED"
    : crossedTp
      ? "TARGET_REACHED"
      : null;

  const analogSet = crossStatus || geo.dTp == null || geo.dSl == null
    ? {
        result: emptyAnalog(),
        matchedIndices: [] as number[],
        allIndices: [] as number[],
        distances: [] as number[],
        pooled: false,
        featuresUsed: [] as string[],
        featuresOmitted: [] as string[],
      }
    : buildAnalogSet(klines, buildAligned(klines, btcKlines), input, geo.dTp, geo.dSl, horizonBars, atr, cfg);

  const analogResult = analogSet.result;
  const analog: PositionAnalog = {
    nRaw: analogResult.nRaw,
    nEff: analogResult.nEff,
    pooled: analogSet.pooled,
    gate: analogResult.nEff >= MIN_ANALOGS && crossStatus == null ? "ok" : "insufficient_evidence",
    featureDistanceMin: analogSet.distances.length ? Math.min(...analogSet.distances) : null,
    featureDistanceMax: analogSet.distances.length ? Math.max(...analogSet.distances) : null,
    featuresUsed: analogSet.featuresUsed,
    featuresOmitted: analogSet.featuresOmitted,
    dateStart: analogResult.dateStart,
    dateEnd: analogResult.dateEnd,
    allPrecede:
      (analogResult.dateEnd == null || analogResult.dateEnd <= (klines[klines.length - 1]?.time ?? now)) &&
      (analogResult.dateStart == null || analogResult.dateStart < (klines[klines.length - 1]?.time ?? now)),
    horizonBars,
    minSpacingBars: horizonBars,
  };

  const gated = analog.gate !== "ok";
  const costs = 2 * (input.feeBpsOneSide / 10000) + 2 * (input.slippageBps / 10000);
  const pTpLo = gated ? null : analogResult.pTpCi?.[0] ?? null;
  const pSlHi = gated ? null : analogResult.pSlCi?.[1] ?? null;
  const ev =
    !gated && analogResult.pTp != null && analogResult.pSl != null && geo.dTp != null && geo.dSl != null
      ? analogResult.pTp * geo.dTp - analogResult.pSl * geo.dSl - costs
      : null;
  const evLower =
    pTpLo != null && pSlHi != null && geo.dTp != null && geo.dSl != null
      ? pTpLo * geo.dTp - pSlHi * geo.dSl - costs
      : null;
  const payoffRatio = geo.dTp != null && geo.dSl != null && geo.dSl > 0 ? geo.dTp / geo.dSl : null;
  const ciWidthTp = !gated && analogResult.pTpCi ? analogResult.pTpCi[1] - analogResult.pTpCi[0] : null;
  const ciWidthSl = !gated && analogResult.pSlCi ? analogResult.pSlCi[1] - analogResult.pSlCi[0] : null;

  const outcome: PositionOutcome = {
    pTp: gated ? null : analogResult.pTp,
    pSl: gated ? null : analogResult.pSl,
    pTimeout: gated ? null : analogResult.pTimeout,
    pTpCi: gated ? null : analogResult.pTpCi,
    pSlCi: gated ? null : analogResult.pSlCi,
    n: gated ? 0 : analogResult.nEff,
    nRaw: analogResult.nRaw,
    nEff: analogResult.nEff,
    analog,
    status: crossStatus,
    ciWidthTp,
    ciWidthSl,
    dateStart: analogResult.dateStart,
    dateEnd: analogResult.dateEnd,
    medianBarsToExit: analogResult.medianBarsToExit,
    mfeMedian: analogResult.mfeMedian,
    maeMedian: analogResult.maeMedian,
    ev,
    evLower,
    payoffRatio,
    noEdge: crossStatus != null || evLower == null || evLower <= 0,
    note: crossStatus
      ? `Barrier already crossed (${crossStatus}); forward probabilities withheld.`
      : gated
        ? `Only ${analogResult.nEff} effective analogs (<${MIN_ANALOGS}); INSUFFICIENT EVIDENCE — no probabilities shown.`
        : `Nearest-neighbour replay: N_raw ${analogResult.nRaw}, N_eff ${analogResult.nEff}${analogSet.pooled ? " (pooled/unmatched fallback)" : ""}; intervals from N_eff.`,
  };

  // ---------- L4 Market relative ----------
  const basisPct = computeBasisPct(inputs);
  const marketRelative = computeMarketRelative(
    inputs.marketType,
    geo.dTp,
    geo.dSl,
    sigmaPerBar,
    sigmaH,
    mcapUsd,
    vol24,
    oiTotalUsd,
    horizonBars,
    rollingVolumeMedian(klines, horizonBars),
    basisPct,
    cfg,
    geo.dTp != null ? percentileRank(geo.dTp, empiricalForward.map(Math.abs)) : null
  );

  // ---------- Move forward distribution (P2.6) ----------
  const forward = computeForwardDistribution(klines, move, horizonBars);
  const drivers = computeDrivers(inputs, move, klines);
  const moveCard: PositionMove = {
    moveBars: move.moveBars,
    moveReturn: move.moveReturn,
    moveStartTime: klines[move.startIndex]?.time ?? null,
    moveEndTime: klines[move.endIndex]?.time ?? null,
    zRaw: move.zRaw,
    zRes: move.zRes,
    beta: move.beta,
    r2: move.r2,
    percentile: move.percentile,
    sigmaBaseline: move.sigmaBaseline,
    class: reconcileClass(classifyMove(move, inputs.futures, inputs.liq, inputs.liqBaseline), drivers),
    quadrant: oiQuadrant(inputs.futures, move, inputs.liq, inputs.liqBaseline),
    breadth: null,
    explainedFraction: move.r2,
    drivers,
    forward,
    label: moveLabel(move),
    interpretation: moveInterpretation(move),
  };

  // The OI card owns the quadrant field; the move detection supplies it.
  openInterest.quadrant = moveCard.quadrant;

  // ---------- Funding ----------
  const funding = computeFund(msgFunding(inputs), venues, now, horizonBars);

  // ---------- Flow ----------
  const flow = computeFlow(inputs.liq, klines, input.side);

  // ---------- Verdict ----------
  const verdictBlock = computeVerdict(
    moveCard,
    reachability,
    outcome,
    marketRelative,
    analogResult.nEff,
    gated,
    alerts,
    inputs,
    manualUsed,
    venues
  );

  // ---------- Health ----------
  const health = computeHealth(inputs, mark, oiUsd, vol24, mcapUsd, sigmaPerBar, now, manualUsed, venues);

  if (inputs.market === "spot" && oiUsd == null) {
    warnings.push(
      "Subject is a spot pair and no matching Binance futures perp exists, so open interest, funding and OI-quadrant fields are unavailable."
    );
  }
  if (inputs.historyClamped) {
    warnings.push("Requested history exceeded the 45-day 15m cap; using the most recent window.");
  }
  if (klines.length < VOL_LOOKBACK_BARS) {
    warnings.push(`Only ${klines.length} bars available (< 7d); volatility baseline is thin.`);
  }
  const missingVenues = venues.filter((v) => v.status === "not_implemented").map((v) => v.venue);
  if (missingVenues.length > 0) {
    warnings.push(`Venues not yet implemented: ${missingVenues.join(", ")} — totals are understated.`);
  }

  return {
    analysisId: `${input.symbol}-${now}`,
    generatedAt: now,
    symbol: inputs.symbol,
    baseAsset: inputs.baseAsset,
    name: inputs.name,
    market: inputs.market,
    marketType: inputs.marketType,
    interval: BASE_INTERVAL,
    input,
    asOf: {
      timestamp: klines.length ? klines[klines.length - 1].time : now,
      iso: new Date(klines.length ? klines[klines.length - 1].time : now).toISOString(),
      lagMinutes: klines.length ? (now - klines[klines.length - 1].time) / 60000 : 0,
      bars: klines.length,
      firstBarTime: inputs.firstBarTime,
      historyDays: klines.length / (24 * BARS_PER_HOUR),
      historyClamped: inputs.historyClamped,
    },
    header,
    verdictBlock,
    move: moveCard,
    reachability,
    orderBook,
    openInterest,
    levels,
    outcome,
    marketRelative,
    funding,
    flow,
    health,
    warnings,
    caveats,
  };
}

// Small shim so the funding builder keeps a stable clock in one place.
function msgFunding(inputs: PositionAnalystInputs): PositionFuturesRaw | null {
  return inputs.futures;
}

/* --------------------------------------------------------------------------- *
 * Card builders.
 * --------------------------------------------------------------------------- */

function computeDepthImbalance(depth: PositionDepthRaw | null, mark: number | null): number | null {
  if (!depth || mark == null) return null;
  let bid = 0;
  let ask = 0;
  for (const [p, q] of depth.bids) if (Math.abs(p - mark) / mark <= 0.01) bid += p * q;
  for (const [p, q] of depth.asks) if (Math.abs(p - mark) / mark <= 0.01) ask += p * q;
  if (bid + ask === 0) return null;
  return (bid - ask) / (bid + ask);
}

function computeOrderBook(
  depth: PositionDepthRaw | null,
  mark: number | null,
  now: number
): PositionOrderBook {
  if (!depth || depth.bids.length === 0 || depth.asks.length === 0) {
    return {
      venue: depth?.venue ?? "binance",
      fetchedAt: depth?.fetchedAt ?? null,
      ageMs: depth ? now - depth.fetchedAt : null,
      midPrice: null,
      spreadBps: null,
      bands: [],
      walls: [],
      cumulative: [],
      note: "Order book unavailable for this symbol/venue.",
    };
  }
  const bestBid = depth.bids[0][0];
  const bestAsk = depth.asks[0][0];
  const mid = (bestBid + bestAsk) / 2;
  const spreadBps = mid > 0 ? ((bestAsk - bestBid) / mid) * 10000 : null;

  const bands: PositionDepthBand[] = [10, 25, 50].map((bandBps) => {
    const lo = mid * (1 - bandBps / 10000);
    const hi = mid * (1 + bandBps / 10000);
    let bidUsd = 0;
    let askUsd = 0;
    for (const [p, q] of depth.bids) if (p >= lo) bidUsd += p * q;
    for (const [p, q] of depth.asks) if (p <= hi) askUsd += p * q;
    return { bandBps, bidUsd, askUsd, imbalance: bidUsd + askUsd === 0 ? 0 : (bidUsd - askUsd) / (bidUsd + askUsd) };
  });

  const sizes = [...depth.bids, ...depth.asks].map(([, q], i) =>
    (i < depth.bids.length ? depth.bids[i][0] : depth.asks[i - depth.bids.length][0]) * q
  );
  const sizeMedian = median(sizes);
  const walls: PositionWall[] = [];
  for (const [p, q] of depth.bids)
    if (p * q > 3 * sizeMedian) walls.push({ side: "bid", price: p, sizeUsd: p * q, distancePct: (p - mid) / mid });
  for (const [p, q] of depth.asks)
    if (p * q > 3 * sizeMedian) walls.push({ side: "ask", price: p, sizeUsd: p * q, distancePct: (p - mid) / mid });
  walls.sort((a, b) => b.sizeUsd - a.sizeUsd);

  const step = Math.max(1, Math.floor(Math.max(depth.bids.length, depth.asks.length) / 60));
  const cumulative: PositionOrderBook["cumulative"] = [];
  let cumBid = 0;
  let cumAsk = 0;
  const maxLen = Math.max(depth.bids.length, depth.asks.length);
  for (let i = 0; i < maxLen; i += step) {
    const bid = depth.bids[i];
    const ask = depth.asks[i];
    if (bid) cumBid += bid[0] * bid[1];
    if (ask) cumAsk += ask[0] * ask[1];
    cumulative.push({ price: bid?.[0] ?? ask?.[0] ?? mid, cumBidUsd: cumBid, cumAskUsd: cumAsk });
  }

  return {
    venue: depth.venue,
    fetchedAt: depth.fetchedAt,
    ageMs: now - depth.fetchedAt,
    midPrice: mid,
    spreadBps,
    bands,
    walls: walls.slice(0, 12),
    cumulative,
    note: "Single-venue snapshot; walls are buckets >3× the median level size.",
  };
}

/** Spot-perp basis, computed from the two kline tapes when both exist. */
function computeBasisPct(inputs: PositionAnalystInputs): number | null {
  const perp = inputs.marketType === "perp" ? inputs.klines : inputs.spotKlines;
  const spot = inputs.marketType === "perp" ? inputs.spotKlines : inputs.klines;
  if (!perp || !spot || perp.length === 0 || spot.length === 0) return null;
  const p = perp[perp.length - 1].close;
  const s = spot[spot.length - 1].close;
  if (!(p > 0) || !(s > 0)) return null;
  return p / s - 1;
}

function isoStatus(v: PositionVenueStatusInput): PositionFieldStatus {
  const map: Record<string, PositionFieldStatus> = {
    ok: "ok",
    stale: "stale",
    failed: "failed",
    unsupported: "unsupported",
    not_implemented: "not_implemented",
    not_listed: "not_listed",
    no_history: "no_history",
  };
  return map[v] ?? "unavailable";
}
type PositionVenueStatusInput = PositionVenueSnapshot["status"];

function computeOpenInterest(
  inputs: PositionAnalystInputs,
  mark: number | null,
  oiUsd: number | null,
  vol24: number | null,
  venues: PositionVenueSnapshot[]
): PositionOpenInterest {
  const futures = inputs.futures;
  const oiBase = futures?.openInterestBase ?? null;

  let venueRows;
  if (venues.length > 0) {
    venueRows = venues.map((v) => ({
      venue: v.venue,
      oiUsd: v.oiUsd,
      oiBase: v.oiBase,
      status: v.status,
      lastDataAt: v.fetchedAt,
      venuePrice: v.markPrice,
      marketType: v.marketType,
      note: v.note,
    }));
  } else {
    venueRows = [
      {
        venue: "binance" as const,
        oiUsd,
        oiBase,
        status: (oiBase != null ? "ok" : "failed") as PositionOpenInterest["venues"][number]["status"],
        lastDataAt: futures?.openInterestTime ?? null,
        venuePrice: mark,
        marketType: inputs.marketType,
        note: undefined,
      },
      { venue: "bybit", oiUsd: null, oiBase: null, status: "not_implemented" as const, lastDataAt: null, venuePrice: null, marketType: inputs.marketType, note: undefined },
      { venue: "okx", oiUsd: null, oiBase: null, status: "not_implemented" as const, lastDataAt: null, venuePrice: null, marketType: inputs.marketType, note: undefined },
      { venue: "hyperliquid", oiUsd: null, oiBase: null, status: "not_implemented" as const, lastDataAt: null, venuePrice: null, marketType: inputs.marketType, note: undefined },
    ];
  }

  // Sum OI across venues exactly where each returned a number.
  const summed = venueRows.reduce((acc, v) => (v.oiUsd != null ? acc + v.oiUsd : acc), 0);
  const anyVenueOi = venueRows.some((v) => v.oiUsd != null);
  const totalUsd = anyVenueOi ? summed : oiUsd;
  const totalBase = venueRows.reduce((acc, v) => (v.oiBase != null ? acc + v.oiBase : acc), 0) || oiBase;

  // ΔOI windows: require two DISTINCT timestamps and an interval that can
  // actually resolve the window; otherwise n/a (never a copy of another window).
  const deltas: PositionOpenInterest["deltas"] = [];
  const hist = futures?.oiHistory ?? [];
  const barMs = 15 * 60 * 1000;
  const windowBars: { label: string; bars: number }[] = [
    { label: "5m", bars: 1 },
    { label: "15m", bars: 1 },
    { label: "1h", bars: BARS_PER_HOUR },
    { label: "4h", bars: 4 * BARS_PER_HOUR },
  ];
  for (const w of windowBars) {
    const requiredMs = w.label === "5m" ? 5 * 60 * 1000 : w.label === "15m" ? 15 * 60 * 1000 : w.bars * barMs;
    if (hist.length < 2 || requiredMs < barMs) {
      deltas.push({ window: w.label, deltaBase: null, deltaPct: null, fromTime: null, toTime: null });
      continue;
    }
    const last = hist[hist.length - 1];
    let prevIdx = -1;
    for (let i = hist.length - 2; i >= 0; i -= 1) {
      if (last.time - hist[i].time >= requiredMs) {
        prevIdx = i;
        break;
      }
    }
    if (prevIdx < 0) {
      deltas.push({ window: w.label, deltaBase: null, deltaPct: null, fromTime: null, toTime: null });
      continue;
    }
    const prev = hist[prevIdx];
    const deltaBase = last.sumOpenInterest - prev.sumOpenInterest;
    deltas.push({
      window: w.label,
      deltaBase,
      deltaPct: prev.sumOpenInterest !== 0 ? deltaBase / prev.sumOpenInterest : null,
      fromTime: prev.time,
      toTime: last.time,
    });
  }

  return {
    totalUsd,
    totalBase: Number.isFinite(totalBase) ? totalBase : null,
    markPrice: mark,
    venues: venueRows,
    deltas,
    quadrant: "see Move card",
    oiVsVol: vol24 != null && vol24 > 0 && totalUsd != null ? totalUsd / vol24 : null,
    lastDataAt: futures?.openInterestTime ?? null,
    note: `${venueRows.filter((v) => v.oiUsd != null).length} venue(s) reporting; OI summed in USD across venues. ΔOI 5m is n/a when the 15m feed cannot resolve 5 minutes.`,
  };
}

/** True when `price` sits within 0.25 ATR of a modelled liq tier (magnet). */
function oiClusterNear(price: number | null, mark: number | null, atr: number): boolean | null {
  if (price == null || mark == null) return null;
  for (const tier of [5, 10, 20, 25, 50, 100]) {
    const longLiq = mark * (1 - 1 / tier + MAINT_MARGIN);
    const shortLiq = mark * (1 + 1 / tier - MAINT_MARGIN);
    const tol = Math.max(0.25 * atr, mark * 1e-4);
    if (Math.abs(price - longLiq) <= tol || Math.abs(price - shortLiq) <= tol) return true;
  }
  return false;
}

/**
 * SL_exposed: true when the stop lies within ±0.25 ATR BEYOND a heavy cluster
 * on the stop side (so a cascade can run through it).
 */
function slExposed(
  slPrice: number,
  mark: number,
  side: PositionSide,
  atr: number,
  depth: PositionDepthRaw | null
): boolean | null {
  if (!(atr > 0)) return null;
  const tol = 0.25 * atr;
  // Heavy cluster = an order-book wall on the stop side of the mark.
  const stopSide = side === "long" ? "bid" : "ask";
  if (depth) {
    const sizes = [...depth.bids, ...depth.asks].map(([, q], i) =>
      (i < depth.bids.length ? depth.bids[i][0] : depth.asks[i - depth.bids.length][0]) * q
    );
    const med = median(sizes) || 1;
    const levels = stopSide === "bid" ? depth.bids : depth.asks;
    for (const [p, q] of levels) {
      if (p * q > 3 * med) {
        // A heavy cluster is "beyond" the SL when it is further from the mark.
        const beyond = side === "long" ? p <= slPrice : p >= slPrice;
        if (beyond && Math.abs(p - slPrice) <= tol) return true;
      }
    }
  }
  // Fall back to the modelled liquidation tiers.
  for (const tier of [5, 10, 25, 50, 100]) {
    const longLiq = mark * (1 - 1 / tier + MAINT_MARGIN);
    const shortLiq = mark * (1 + 1 / tier - MAINT_MARGIN);
    const cluster = side === "long" ? longLiq : shortLiq;
    const beyond = side === "long" ? slPrice <= cluster : slPrice >= cluster;
    if (beyond && Math.abs(cluster - slPrice) <= tol) return true;
  }
  return false;
}

function computeLevels(
  klines: Kline[],
  mark: number | null,
  atr: number,
  geo: TpSlGeometry,
  input: PositionInput,
  oiUsd: number | null,
  sigmaPerBar: number,
  cfg: PositionEngineConfig,
  /** Fraction of modelled liquidation notional on the long side (0-1). */
  liqLongShare = 0.5
): PositionLevels {
  const { bucketPct, buckets } = buildCandleGroupLevels(klines, atr);
  const weights = buckets.map((b) => b.weight).filter((w) => w > 0);
  const sortedWeights = [...weights].sort((a, b) => a - b);
  const medianWeight = median(weights);
  const m = mark ?? (klines.length ? klines[klines.length - 1].close : 0);

  const ref = geo.tpPrice != null && geo.slPrice != null ? input.entry : input.entry;
  const tp = geo.tpPrice;
  const sl = geo.slPrice;

  const levels: PositionLevel[] = buckets
    .filter((b) => b.weight > 0)
    .map((b) => {
      const distancePct = m > 0 ? (b.price - m) / m : 0;
      const inTpCorridor = tp != null && Math.min(ref, tp) <= b.price && b.price <= Math.max(ref, tp);
      const inSlCorridor = sl != null && Math.min(ref, sl) <= b.price && b.price <= Math.max(ref, sl);
      return {
        price: b.price,
        low: b.low,
        high: b.high,
        weight: b.weight,
        strengthPct: percentileRank(b.weight, sortedWeights) * 100,
        distanceAtr: atr > 0 ? (b.price - m) / atr : 0,
        distancePct,
        role: b.price < m ? ("support" as const) : ("resistance" as const),
        polarity: polarityOf(b),
        inCorridor: inTpCorridor || inSlCorridor,
      };
    });

  const supports = levels.filter((l) => l.role === "support");
  const resistances = levels.filter((l) => l.role === "resistance");
  const nearestSupport = supports.length ? supports.reduce((a, b) => (b.price > a.price ? b : a)) : null;
  const nearestResistance = resistances.length
    ? resistances.reduce((a, b) => (b.price < a.price ? b : a))
    : null;

  // Air pockets: low-weight buckets ONLY between mark and SL, and mark and TP.
  const pockets: PositionLevels["airPockets"] = [];
  const corridors: [number, number][] = [];
  if (sl != null) corridors.push([Math.min(m, sl), Math.max(m, sl)]);
  if (tp != null) corridors.push([Math.min(m, tp), Math.max(m, tp)]);
  for (const b of buckets) {
    if (b.weight >= 0.25 * medianWeight) continue;
    const inCorridor = corridors.some(([lo, hi]) => b.price >= lo && b.price <= hi);
    if (!inCorridor) continue;
    pockets.push({
      low: b.low,
      high: b.high,
      center: b.price,
      distancePct: m > 0 ? (b.price - m) / m : 0,
    });
  }

  const tpCorridorLevels = levels.filter(
    (l) => tp != null && Math.min(ref, tp) <= l.price && l.price <= Math.max(ref, tp)
  );
  const slCorridorLevels = levels.filter(
    (l) => sl != null && Math.min(ref, sl) <= l.price && l.price <= Math.max(ref, sl)
  );

  // Modelled liquidation clusters: weighted tiers, capped at max leverage.
  const sigmaDay = sigmaPerBar * Math.sqrt(24 * BARS_PER_HOUR);
  const liquidationEstimates: PositionLiquidationEstimate[] = [];
  if (oiUsd != null && m > 0) {
    const tierWeights = cfg.leverageTiers;
    const totalWeight = tierWeights.reduce((a, t) => a + t.weight, 0) || 1;
    for (const t of tierWeights) {
      const dist = 1 / t.leverage - MAINT_MARGIN;
      if (dist <= 0) continue;
      const share = (t.weight / totalWeight) * oiUsd;
      liquidationEstimates.push({
        leverage: t.leverage,
        price: m * (1 - dist),
        side: "long",
        notionalUsd: share * liqLongShare,
        distancePct: -dist,
      });
      liquidationEstimates.push({
        leverage: t.leverage,
        price: m * (1 + dist),
        side: "short",
        notionalUsd: share * (1 - liqLongShare),
        distancePct: dist,
      });
    }
  }

  const ladder = buildLadder(buckets, m, oiUsd, sigmaDay, cfg);

  return {
    atr,
    markPrice: m || null,
    bucketPct,
    levels,
    nearestResistance,
    nearestSupport,
    airPockets: pockets,
    betweenEntryTp: {
      count: tpCorridorLevels.length,
      resistanceUsd: tpCorridorLevels.reduce((acc, l) => acc + l.weight * l.price, 0),
    },
    betweenEntrySl: {
      count: slCorridorLevels.length,
      supportUsd: slCorridorLevels.reduce((acc, l) => acc + l.weight * l.price, 0),
    },
    liquidationEstimates,
    ladder,
    method:
      "Candle-group volume profile: 48h of 15m bars, decayed with a 6h half-life, bucketed at 0.25×ATR. Liq clusters are estimated, model-based, from OI with configurable leverage-tier weights.",
  };
}

function buildLadder(
  buckets: CandleGroupLevel[],
  mark: number,
  oiUsd: number | null,
  sigmaDay: number,
  cfg: PositionEngineConfig
): PositionLadderRow[] {
  if (mark <= 0) return [];
  const lo = mark * 0.85;
  const hi = mark * 1.15;
  const inRange = buckets.filter((b) => b.price >= lo && b.price <= hi);
  const scale = Math.max(sigmaDay, 0.005);
  const density = (d: number): number => (0.6 / scale) * Math.exp(-Math.abs(d) / scale);
  const tierWeights = cfg.leverageTiers;
  const totalWeight = tierWeights.reduce((a, t) => a + t.weight, 0) || 1;

  return inRange
    .map((b) => {
      const notional = b.weight * b.price;
      const dist = (b.price - mark) / mark;
      // Long/short OI split so the two sides differ rather than mirroring.
      const longShare = dist < 0 ? 0.65 : 0.35;
      const shortShare = 1 - longShare;
      const liqShare = oiUsd != null ? oiUsd * density(dist) * 0.01 : 0;
      return {
        price: b.price,
        resistanceUsd: b.price > mark ? notional : 0,
        supportUsd: b.price < mark ? notional : 0,
        liqLongUsd: dist < 0 ? liqShare * longShare : 0,
        liqShortUsd: dist > 0 ? liqShare * shortShare : 0,
        totalUsd: notional,
        polarity: polarityOf(b),
      };
    })
    .sort((a, b) => a.price - b.price);
}

function computeForwardDistribution(
  klines: Kline[],
  move: MoveDetection,
  horizonBars: number
): PositionMoveForward | null {
  const returns = barReturns(klines);
  const sigma = move.sigmaBaseline;
  const sign = Math.sign(move.moveReturn) || 1;

  const windowStats = (H: number) => {
    const forward: number[] = [];
    for (let i = 1; i + H < klines.length; i += 1) {
      if (Math.abs(returns[i]) >= Z_MOVE_THRESHOLD * sigma && Math.sign(returns[i]) === sign) {
        const base = klines[i].close;
        if (base > 0) forward.push(klines[i + H].close / base - 1);
      }
    }
    if (forward.length < 5) return null;
    const sorted = [...forward].sort((a, b) => a - b);
    const positives = forward.filter((v) => v > 0).length;
    return {
      n: forward.length,
      pPositive: positives / forward.length,
      median: quantileSorted(sorted, 0.5),
      p10: quantileSorted(sorted, 0.1),
      p90: quantileSorted(sorted, 0.9),
    };
  };

  const full = windowStats(horizonBars);
  if (!full) return null;

  const extra: PositionMoveForward["extra"] = [];
  for (const bars of [4, 16]) {
    if (bars >= horizonBars) continue;
    const s = windowStats(bars);
    if (s) extra.push({ bars, horizonHours: bars / BARS_PER_HOUR, n: s.n, pPositive: s.pPositive, median: s.median });
  }

  return {
    horizonBars,
    horizonHours: horizonBars / BARS_PER_HOUR,
    n: full.n,
    pPositive: full.pPositive,
    median: full.median,
    p10: full.p10,
    p90: full.p90,
    extra,
  };
}

/** Liquidation z with a baseline gate; null + status when the tape is too thin. */
export interface LiqGateResult {
  z: number | null;
  status: "ok" | "insufficient_baseline";
  note: string;
  baselineEvents: number;
  baselineHours: number;
}

export function gateLiquidation(
  liq: CoinLiqResponse,
  side: PositionSide,
  moveBars: number,
  baseline?: PositionLiqBaseline
): LiqGateResult {
  const events = baseline?.events ?? liq.buffered;
  const hours = baseline ? baseline.spanMs / 3600000 : 0;
  if (events < LIQ_BASELINE_MIN_EVENTS || hours < LIQ_BASELINE_MIN_HOURS) {
    return {
      z: null,
      status: "insufficient_baseline",
      note: `Liquidation baseline too thin (${events} events / ${hours.toFixed(0)}h; need ≥${LIQ_BASELINE_MIN_EVENTS} events and ≥${LIQ_BASELINE_MIN_HOURS}h).`,
      baselineEvents: events,
      baselineHours: hours,
    };
  }
  const notionals = liq.series.map((b) => b.notional);
  if (notionals.length < 2) {
    return { z: null, status: "insufficient_baseline", note: "No liquidation buckets.", baselineEvents: events, baselineHours: hours };
  }
  const recentSide =
    side === "long"
      ? liq.series[liq.series.length - 1].longNotional
      : liq.series[liq.series.length - 1].shortNotional;
  const series = liq.series.map((b) => (side === "long" ? b.longNotional : b.shortNotional));
  const m = mean(series);
  // Floor sigma (log1p-scaled guard) so a near-zero baseline cannot explode z.
  const s = Math.max(sampleStd(series), mean(series.map((v) => Math.log1p(v / LOG1P_FLOOR))) * LOG1P_FLOOR, 1);
  const z = clamp((recentSide - m) / s, -MAX_LIQ_Z, MAX_LIQ_Z);
  return { z, status: "ok", note: "Log1p-floored Poisson-style z, capped at ±10.", baselineEvents: events, baselineHours: hours };
}

function classifyMove(
  move: MoveDetection,
  futures: PositionFuturesRaw | null,
  liq: CoinLiqResponse,
  baseline?: PositionLiqBaseline
): string {
  if (Math.abs(move.zRaw) < Z_MOVE_THRESHOLD) {
    return move.percentile >= 0.85 ? "large_but_in_regime" : "no_significant_move";
  }
  const oiChange = futures?.oiHistory.length
    ? futures.oiHistory[futures.oiHistory.length - 1].sumOpenInterest -
      (futures.oiHistory[Math.max(0, futures.oiHistory.length - 2)]?.sumOpenInterest ?? 0)
    : null;
  const priceUp = move.moveReturn > 0;

  const liqGate = gateLiquidation(liq, priceUp ? "short" : "long", move.moveBars, baseline);
  if (move.zRes >= Z_MOVE_THRESHOLD) return "idiosyncratic";
  if (Math.abs(move.zRes) < 0.5) return "beta_explained";
  if (oiChange != null && oiChange > 0 && priceUp) return "leveraged_longs";
  if (oiChange != null && oiChange > 0 && !priceUp) return "leveraged_shorts";
  if (oiChange != null && oiChange < 0 && priceUp) {
    return liqGate.z != null && liqGate.z >= 1.5 ? "short_squeeze" : "short_covering_unconfirmed";
  }
  if (oiChange != null && oiChange < 0 && !priceUp) {
    return liqGate.z != null && liqGate.z >= 1.5 ? "long_unwind" : "long_deleveraging_unconfirmed";
  }
  return "unexplained";
}

function oiQuadrant(
  futures: PositionFuturesRaw | null,
  move: MoveDetection,
  liq: CoinLiqResponse,
  baseline?: PositionLiqBaseline
): string {
  if (!futures || futures.oiHistory.length < 2) return "unknown (no OI history)";
  const hist = futures.oiHistory;
  const last = hist[hist.length - 1].sumOpenInterest;
  const prev = hist[Math.max(0, hist.length - 2)].sumOpenInterest;
  const dOi = last - prev;
  const oiStd = sampleStd(hist.map((h) => h.sumOpenInterest)) || 1e-9;
  const oiZ = dOi / (oiStd * 1e-3 + 1e-12) / 1e3; // normalised ΔOI z-ish
  const priceUp = move.moveReturn > 0;

  // Deadband: a negligible ΔOI is NEUTRAL regardless of the sign.
  if (Math.abs(dOi) / (prev || 1) < 0.0005 || Math.abs(oiZ) < 0.5) return "NEUTRAL";

  if (dOi > 0 && priceUp) return "FRESH_LONGS";
  if (dOi > 0 && !priceUp) return "FRESH_SHORTS";
  if (dOi < 0 && priceUp) {
    const gate = gateLiquidation(liq, "short", move.moveBars, baseline);
    return gate.z != null && gate.z >= 1.5 ? "SHORT_SQUEEZE" : "SHORT_COVERING (unconfirmed)";
  }
  if (dOi < 0 && !priceUp) {
    const gate = gateLiquidation(liq, "long", move.moveBars, baseline);
    return gate.z != null && gate.z >= 1.5 ? "LONG_LIQUIDATION" : "LONG_UNWIND (unconfirmed)";
  }
  return "NEUTRAL";
}

/**
 * Long-side share of modelled liquidation notional, tilted by the OI quadrant
 * so long and short clusters are not mirror images. Bounded to [0.3, 0.7].
 */
function longShareFromQuadrant(quadrant: string): number {
  const q = quadrant.toUpperCase();
  if (q.includes("FRESH_LONGS") || q.includes("LONG_LIQUIDATION") || q.includes("LONG_UNWIND")) return 0.65;
  if (q.includes("FRESH_SHORTS") || q.includes("SHORT_SQUEEZE") || q.includes("SHORT_COVERING")) return 0.35;
  return 0.5;
}

function computeDrivers(
  inputs: PositionAnalystInputs,
  move: MoveDetection,
  klines: Kline[]
): PositionMoveDriver[] {
  const drivers: PositionMoveDriver[] = [];
  const start = move.startIndex;
  const end = move.endIndex;
  const runBars = move.moveBars;

  const vols = klines.slice(-VOL_LOOKBACK_BARS).map((k) => k.close * k.volume);
  const volStd = sampleStd(vols) || 1e-9;
  const runVol = klines.slice(start, end + 1).reduce((acc, k) => acc + k.close * k.volume, 0);
  const expVol = mean(vols) * runBars;
  const volZ = (runVol - expVol) / (volStd * Math.sqrt(runBars));
  drivers.push({
    key: "volume",
    label: "Volume",
    z: volZ,
    level: volZ >= 1.5 ? "high" : volZ <= -1.5 ? "low" : "normal",
    note: "Bar volume over the move vs the 7d baseline.",
  });

  const hist = inputs.futures?.oiHistory ?? [];
  if (hist.length > 2) {
    const oiChanges: number[] = [];
    for (let i = 1; i < hist.length; i += 1) oiChanges.push(hist[i].sumOpenInterest - hist[i - 1].sumOpenInterest);
    const oiStd = sampleStd(oiChanges) || 1e-9;
    const d = hist[hist.length - 1].sumOpenInterest - hist[Math.max(0, hist.length - 1 - runBars)].sumOpenInterest;
    const oiZ = d / (oiStd * Math.sqrt(runBars));
    drivers.push({
      key: "oi",
      label: "Open interest",
      z: oiZ,
      level: oiZ >= 1.5 ? "high" : oiZ <= -1.5 ? "low" : "normal",
      note: `ΔOI over the move: ${d.toFixed(2)} base.`,
    });
  } else {
    drivers.push({ key: "oi", label: "Open interest", z: null, level: "unavailable", note: "No OI history (spot or feed miss)." });
  }

  const gate = gateLiquidation(inputs.liq, inputs.input.side, runBars, inputs.liqBaseline);
  if (gate.status === "insufficient_baseline") {
    drivers.push({
      key: "liquidations",
      label: "Liquidations",
      z: null,
      level: "insufficient_baseline",
      note: gate.note,
    });
  } else {
    drivers.push({
      key: "liquidations",
      label: "Liquidations",
      z: gate.z,
      level: gate.z != null && gate.z >= 1.5 ? "high" : gate.z != null && gate.z <= -1.5 ? "low" : "normal",
      note: gate.note,
    });
  }

  const runDelta = klines.slice(start, end + 1).reduce((acc, k) => {
    const tb = k.takerBuy ?? k.volume / 2;
    return acc + (2 * tb - k.volume);
  }, 0);
  const deltas = klines.slice(-VOL_LOOKBACK_BARS).map((k) => {
    const tb = k.takerBuy ?? k.volume / 2;
    return 2 * tb - k.volume;
  });
  const deltaStd = sampleStd(deltas) || 1e-9;
  const deltaZ = runDelta / (deltaStd * Math.sqrt(runBars));
  drivers.push({
    key: "delta",
    label: "Taker delta (CVD)",
    z: deltaZ,
    level: deltaZ >= 1.5 ? "high" : deltaZ <= -1.5 ? "low" : "normal",
    note: "Net taker buy/sell over the move vs baseline.",
  });

  const impactZ = (() => {
    const series: number[] = [];
    for (let i = Math.max(1, klines.length - VOL_LOOKBACK_BARS); i < klines.length; i += 1) {
      const usd = klines[i].close * klines[i].volume;
      if (usd > 0) series.push(Math.abs(klines[i].close / klines[i - 1].close - 1) / usd);
    }
    const runImpact = Math.abs(move.moveReturn) / (runVol || 1);
    const impactMean = mean(series) || 1e-12;
    const impactStd = sampleStd(series) || 1e-12;
    return (runImpact - impactMean) / impactStd;
  })();
  drivers.push({
    key: "impact",
    label: "Price impact",
    z: impactZ,
    level: impactZ >= 1.5 ? "high" : impactZ <= -1.5 ? "low" : "normal",
    note: "Move per dollar traded vs baseline: high = thin book did the work.",
  });

  if (inputs.depth) {
    const imbalance = computeDepthImbalance(inputs.depth, klines[klines.length - 1].close);
    drivers.push({
      key: "depth",
      label: "Book depth",
      z: imbalance,
      level: imbalance != null && Math.abs(imbalance) > 0.3 ? "high" : "normal",
      note: "Current snapshot only (±1% imbalance); depth has no history here.",
    });
  } else {
    drivers.push({ key: "depth", label: "Book depth", z: null, level: "unavailable", note: "Order book unavailable." });
  }

  drivers.push({
    key: "breadth",
    label: "Breadth across venues",
    z: null,
    level: "unavailable",
    note: "Requires multi-venue feeds; reported as unavailable rather than guessed.",
  });

  return drivers;
}

/**
 * P4.3 consistency guard: a class may only stay UNEXPLAINED when no valid
 * driver exceeds 1.5σ. With breadth unavailable the strongest honest upgrade is
 * `driver_explained`, not one of the informed/forced classes.
 */
function reconcileClass(initial: string, drivers: PositionMoveDriver[]): string {
  if (initial !== "unexplained") return initial;
  const hasStrongDriver = drivers.some((d) => d.z != null && Math.abs(d.z) >= 1.5);
  return hasStrongDriver ? "driver_explained" : initial;
}

function moveLabel(move: MoveDetection): string {
  if (Math.abs(move.zRaw) < Z_MOVE_THRESHOLD) return "in-line move";
  if (move.zRes >= Z_MOVE_THRESHOLD) return "unexplained move";
  return "explained move";
}

function moveInterpretation(move: MoveDetection): string {
  const dir = move.moveReturn > 0 ? "up" : "down";
  return `The last move is ${(move.moveReturn * 100).toFixed(2)}% ${dir} over ${move.moveBars} bar(s); z_raw ${move.zRaw.toFixed(2)}, z_res ${move.zRes.toFixed(2)} (BTC R² ${move.r2.toFixed(2)}).`;
}

function reachabilityLabel(kTp: number | null): string {
  if (kTp == null) return "UNDEFINED";
  if (kTp <= 1) return "REACHABLE";
  if (kTp <= 2) return "STRETCHED";
  if (kTp <= 3) return "UNLIKELY";
  return "UNREACHABLE";
}

function countFundingInWindow(futures: PositionFuturesRaw | null, now: number, horizonBars: number): number {
  if (!futures?.nextFundingTime) return 0;
  const horizonMs = (horizonBars / BARS_PER_HOUR) * 3600 * 1000;
  const end = now + horizonMs;
  const period = 8 * 3600 * 1000;
  let count = 0;
  let t = futures.nextFundingTime;
  while (t <= end && count < 6) {
    if (t >= now) count += 1;
    t += period;
  }
  return count;
}

function computeFund(
  futures: PositionFuturesRaw | null,
  venues: PositionVenueSnapshot[],
  now: number,
  horizonBars: number
): PositionFunding {
  const settlements: number[] = [];
  if (futures?.nextFundingTime) {
    const horizonMs = (horizonBars / BARS_PER_HOUR) * 3600 * 1000;
    const end = now + horizonMs;
    let t = futures.nextFundingTime;
    while (t <= end && settlements.length < 6) {
      if (t >= now) settlements.push(t);
      t += 8 * 3600 * 1000;
    }
  }

  const fundingVenues: PositionFundingVenue[] = venues.length
    ? venues.map((v) => ({
        venue: v.venue,
        rate: v.fundingRate,
        status: isoStatus(v.status) === "not_implemented" ? "not_implemented" : v.fundingRate != null ? "ok" : "unavailable",
      }))
    : [
        { venue: "binance", rate: futures?.lastFundingRate ?? null, status: futures?.lastFundingRate != null ? "ok" : "unavailable" },
        { venue: "bybit", rate: null, status: "not_implemented" },
        { venue: "okx", rate: null, status: "not_implemented" },
        { venue: "hyperliquid", rate: null, status: "not_implemented" },
      ];

  // OI-notional-weighted funding across venues that report both.
  let weightSum = 0;
  let weighted = 0;
  const source = venues.length ? venues : [];
  for (const v of source) {
    if (v.fundingRate != null && v.oiUsd != null && v.oiUsd > 0) {
      weighted += v.fundingRate * v.oiUsd;
      weightSum += v.oiUsd;
    }
  }
  const oiWeightedRate = weightSum > 0 ? weighted / weightSum : futures?.lastFundingRate ?? null;

  const rateHistory = futures?.fundingHistory.map((f) => f.rate) ?? [];
  const current = futures?.lastFundingRate ?? null;
  const crowded = current != null && rateHistory.length > 30;
  const crowdingPercentile = crowded ? percentileRank(current as number, rateHistory) : null;

  return {
    venues: fundingVenues,
    oiWeightedRate,
    nextSettlement: futures?.nextFundingTime ?? null,
    settlementsInWindow: settlements,
    crowdingPercentile,
    crowdingBasis: crowded ? "ok" : "insufficient_history",
    note: "Funding summed/weighted across reporting venues; crowding percentile needs ≥30 stored settlements and is hidden until then.",
  };
}

function computeFlow(liq: CoinLiqResponse, klines: Kline[], side: PositionSide): PositionFlow {
  const cvdWindow = klines.slice(-VOL_LOOKBACK_BARS);
  let cum = 0;
  const cvdSeries: { t: number; value: number }[] = [];
  for (const k of cvdWindow) {
    const tb = k.takerBuy ?? k.volume / 2;
    cum += 2 * tb - k.volume;
    cvdSeries.push({ t: k.time, value: cum });
  }
  const bigTrades = liq.recent
    .filter((e) => e.notional >= 100000 && (e.position === "long" || e.position === "short"))
    .slice(0, 20)
    .map((e) => ({
      time: e.eventTimeMs,
      side: e.position as PositionSide,
      price: e.price,
      notionalUsd: e.notional,
      exchange: e.exchange,
    }));

  return {
    windowHours: 24,
    liqLongUsd: liq.current.longNotional,
    liqShortUsd: liq.current.shortNotional,
    liqSeries: liq.series.map((b) => ({
      t: b.t,
      longNotional: b.longNotional,
      shortNotional: b.shortNotional,
    })),
    cvd: cvdSeries.length ? cum : null,
    cvdSeries,
    bigTrades,
    relevantSide: side,
    note: "Liquidations from the in-process collector (Binance/Bybit/OKX); CVD from Binance taker-buy volume.",
  };
}

function computeVerdict(
  move: PositionMove,
  reach: PositionReachability,
  outcome: PositionOutcome,
  market: PositionMarketRelative,
  nEff: number,
  gated: boolean,
  alerts: PositionAlert[],
  inputs: PositionAnalystInputs,
  manualUsed: string[],
  venues: PositionVenueSnapshot[]
): PositionVerdictBlock {
  const reasonsFor: string[] = [];
  const reasonsAgainst: string[] = [];
  const notes: string[] = [];
  const invalidation: string[] = [];
  const degraded: string[] = [];

  if (inputs.market === "spot" && market.oiUsd == null) degraded.push("open interest / funding (no perp)");
  if (market.mcapUsd == null) degraded.push("market cap");
  if (gated) degraded.push(`analog sample (N_eff=${nEff})`);
  for (const key of manualUsed) degraded.push(`${key} (manual)`);

  if (outcome.pTp != null && outcome.pSl != null) {
    if (outcome.pTp > outcome.pSl)
      reasonsFor.push(`Analogs hit TP ${(outcome.pTp * 100).toFixed(0)}% vs SL ${(outcome.pSl * 100).toFixed(0)}%.`);
    else
      reasonsAgainst.push(`Analogs hit SL ${(outcome.pSl * 100).toFixed(0)}% vs TP ${(outcome.pTp * 100).toFixed(0)}%.`);
  }
  if (reach.kTp != null) {
    if (reach.kTp <= 1.5) reasonsFor.push(`TP is only ${reach.kTp.toFixed(2)}σ_H away.`);
    else reasonsAgainst.push(`TP is ${reach.kTp.toFixed(2)}σ_H away — a stretch for the horizon.`);
  }
  if (reach.kSl != null && reach.kSl <= 0.5) reasonsAgainst.push(`Stop is ${reach.kSl.toFixed(2)}σ_H from the mark — likely to be tested.`);
  if (market.label === "PLAUSIBLE") reasonsFor.push("Required flow is plausible against available flow.");
  if (market.label === "IMPLAUSIBLE") reasonsAgainst.push("Required flow looks implausible against available flow.");
  if (move.class === "idiosyncratic") reasonsAgainst.push("The move is idiosyncratic, not beta — momentum may fade.");
  if (/squeeze|unwind|covering/.test(move.class)) reasonsFor.push(`Move class ${move.class} often mean-reverts.`);
  // Book notes are neutral observations, never "reasons for".
  if (reach.sweepRatioTp != null && reach.sweepRatioTp <= 1) {
    notes.push("Thin asks between mark and TP (low liquidity, not support).");
  }
  if (reach.sweepRatioTp != null && reach.sweepRatioTp > 1) {
    reasonsAgainst.push(`Sweeping to TP costs ${reach.sweepRatioTp.toFixed(1)}× a bar's flow.`);
  }

  invalidation.push("OI quadrant flips toward forced-liquidating the position's side.");
  invalidation.push("The nearest opposing level is broken on volume (level flips polarity).");

  let verdict: PositionVerdict;
  if (outcome.status != null) verdict = "NO_EDGE";
  else if (gated || outcome.pTp == null) verdict = "INSUFFICIENT";
  else if (outcome.evLower != null && outcome.evLower <= 0) verdict = "NO_EDGE";
  else if (outcome.ev != null && outcome.ev > 0 && (reach.kTp == null || reach.kTp <= 2.5) && market.label !== "IMPLAUSIBLE")
    verdict = "FAVORABLE";
  else if (outcome.ev != null && outcome.ev < 0) verdict = "ADVERSE";
  else verdict = "NEUTRAL";

  // Confidence: weighted penalties for every unusable / single-venue field.
  const confidenceReasons: PositionConfidenceReason[] = [];
  let confidence = 100;
  const penalize = (label: string, penalty: number) => {
    confidence -= penalty;
    confidenceReasons.push({ label, penalty });
  };
  if (gated) penalize(`analog sample insufficient (N_eff=${nEff})`, 25);
  if (inputs.depth == null) penalize("order book unavailable", 15);
  if (market.mcapUsd == null) penalize("market cap unavailable", 10);
  if (market.fdvUsd == null) penalize("FDV unavailable", 5);
  if (market.universePercentiles == null) penalize("cross-sectional percentiles unavailable", 8);
  const reportingVenues = (venues.length ? venues : []).filter((v) => v.oiUsd != null);
  if (reportingVenues.length <= 1) penalize(`single-venue OI/volume (${reportingVenues.length || 0} reporting)`, 12);
  const notImpl = (venues.length ? venues : []).filter((v) => v.status === "not_implemented");
  if (notImpl.length > 0) penalize(`${notImpl.length} venue(s) not implemented`, 8);
  if (inputs.liqBaseline && inputs.liqBaseline.events < LIQ_BASELINE_MIN_EVENTS) penalize("liquidation baseline thin", 8);
  if (move.breadth == null) penalize("breadth unavailable", 5);
  if (inputs.market === "spot") penalize("spot subject (perp analytics limited)", 5);
  for (const key of manualUsed) penalize(`${key} manual`, 6);
  confidence = clamp(Math.round(confidence), 0, 100);

  return {
    verdict,
    evLower: outcome.evLower,
    suggestedFraction: outcome.evLower != null && outcome.evLower > 0 ? clamp(outcome.evLower * 0.5, 0, 0.02) : 0,
    suggestedSizeUsd: null,
    reasonsFor: reasonsFor.slice(0, 3),
    reasonsAgainst: reasonsAgainst.slice(0, 3),
    notes,
    invalidation,
    alerts,
    confidence,
    confidenceReasons,
    degradedInputs: degraded,
  };
}

function computeHealth(
  inputs: PositionAnalystInputs,
  mark: number | null,
  oiUsd: number | null,
  vol24: number | null,
  mcapUsd: number | null,
  sigmaPerBar: number,
  now: number,
  manualUsed: string[],
  venues: PositionVenueSnapshot[]
): PositionField[] {
  const age = (t: number | null | undefined): number | null => (t == null ? null : now - t);
  const statusFor = (key: string, autoStatus: PositionFieldStatus): PositionFieldStatus =>
    manualUsed.includes(key) ? "manual" : autoStatus;
  const sourceFor = (key: string, auto: string): string => (manualUsed.includes(key) ? "Manual entry" : auto);

  const fields: PositionField[] = [
    {
      key: "klines",
      label: "Klines (15m)",
      value: `${inputs.klines.length} bars`,
      source: `Binance ${inputs.marketType}`,
      ageMs: age(inputs.klines.length ? inputs.klines[inputs.klines.length - 1].time : null),
      status: inputs.klines.length >= VOL_LOOKBACK_BARS ? "ok" : "stale",
      usedIn: "L1, L2, L3, analog",
    },
    {
      key: "mark",
      label: "Mark price",
      value: mark != null ? mark.toString() : "—",
      source: sourceFor("mark", `Binance ${inputs.marketType} ticker`),
      ageMs: 0,
      status: statusFor("mark", mark != null ? "ok" : "failed"),
      usedIn: "Header, L2, L3, L4",
    },
    {
      key: "btc",
      label: "BTC benchmark klines",
      value: `${inputs.btcKlines.length} bars`,
      source: "Binance BTCUSDT",
      ageMs: null,
      status: inputs.btcKlines.length > 50 ? "ok" : "failed",
      usedIn: "L1 (beta, z_res)",
    },
    {
      key: "depth",
      label: "Order book",
      value: inputs.depth ? `${inputs.depth.bids.length + inputs.depth.asks.length} levels` : "—",
      source: inputs.depth ? `Binance ${inputs.depth.venue}` : `Binance ${inputs.marketType} depth`,
      ageMs: inputs.depth ? age(inputs.depth.fetchedAt) : null,
      status: inputs.depth ? "ok" : "failed",
      usedIn: "L2 (sweep), Order book",
    },
    {
      key: "oi",
      label: "Open interest (summed)",
      value: oiUsd != null ? `$${Math.round(oiUsd).toLocaleString()}` : "—",
      source: sourceFor("oi", `${venues.filter((v) => v.oiUsd != null).length || 1} venue(s)`),
      ageMs: age(inputs.futures?.openInterestTime),
      status: statusFor("oi", oiUsd != null ? "ok" : "failed"),
      usedIn: "L2, L3, L4, OI card",
    },
    {
      key: "funding",
      label: "Funding rate",
      value: inputs.futures?.lastFundingRate != null ? fmtPct(inputs.futures.lastFundingRate) : "—",
      source: "Binance premiumIndex",
      ageMs: 0,
      status: inputs.futures?.lastFundingRate != null ? "ok" : "unavailable",
      usedIn: "Funding card",
    },
    {
      key: "liq",
      label: "Liquidations",
      value: `${inputs.liq.buffered} retained`,
      source: "Liq collector",
      ageMs: null,
      status:
        inputs.liqBaseline && inputs.liqBaseline.events < LIQ_BASELINE_MIN_EVENTS
          ? "insufficient_baseline"
          : inputs.liq.buffered > 0
            ? "ok"
            : "unavailable",
      usedIn: "L1, Flow card",
    },
    {
      key: "mcap",
      label: "Market cap",
      value: mcapUsd != null ? `$${Math.round(mcapUsd).toLocaleString()}` : "—",
      source: sourceFor("mcap", "CoinGecko"),
      ageMs: null,
      status: statusFor("mcap", mcapUsd != null ? "ok" : "unavailable"),
      usedIn: "L4",
    },
    {
      key: "vol24",
      label: "24h quote volume",
      value: vol24 != null ? `$${Math.round(vol24).toLocaleString()}` : "—",
      source: sourceFor("vol24", "Binance ticker"),
      ageMs: 0,
      status: statusFor("vol24", vol24 != null ? "ok" : "failed"),
      usedIn: "L4, L2 (flow/bar)",
    },
    {
      key: "sigma",
      label: "Volatility baseline",
      value: sigmaPerBar > 0 ? `${(sigmaPerBar * 100).toFixed(3)}%/bar` : "—",
      source: sourceFor("sigma", "Computed (7d MAD × 1.4826)"),
      ageMs: 0,
      status: statusFor("sigma", sigmaPerBar > 0 ? "ok" : "failed"),
      usedIn: "L1, L2, L4",
    },
  ];

  for (const v of venues) {
    fields.push({
      key: `venue-${v.venue}`,
      label: `${v.venue} OI/vol/funding`,
      value: v.oiUsd != null ? `$${Math.round(v.oiUsd).toLocaleString()} OI` : "—",
      source: `${v.venue} (${v.venueSymbol ?? "unmapped"})`,
      ageMs: age(v.fetchedAt),
      status: isoStatus(v.status),
      usedIn: "OI card, Funding card",
      note: v.note,
    });
  }

  return fields;
}
