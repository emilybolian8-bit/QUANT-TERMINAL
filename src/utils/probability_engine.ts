/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Post-surge event probability engine.
 *
 * A compact TypeScript implementation of `post_surge_event_probability_
 * framework.md`: detect extreme expansions, label them two-stage (breakdown
 * -> collapse / extension / consolidation), and report conditional
 * probabilities as Dirichlet posteriors over kernel-weighted analogs, with
 * clustering-aware effective sample sizes, competing-risks timing, an
 * adverse-excursion profile, blocked out-of-fold skill and a parameter
 * sensitivity grid.
 *
 * Everything here is DESCRIPTIVE historical precedent with honest uncertainty.
 * No output is a forecast or a trading signal. The positioning feature group
 * (OI / funding / basis) is intentionally absent: Binance serves 30 days of
 * open-interest history, which cannot support an event sample, so that group
 * is reported as unavailable rather than silently approximated.
 */

import {
  ClassProbability,
  DownsideProfile,
  EpisodeMeta,
  EpisodeSeries,
  EpisodeSeriesPoint,
  EpisodeStatus,
  EventAccounting,
  HealthAnalysis,
  Interval,
  Kline,
  ProbabilityAsOf,
  ProbabilityBrief,
  ProbabilityParams,
  ProbabilityResponse,
  ProbabilityState,
  RegimeBlockPoint,
  StageAClass,
  TimingAnalysis,
  TimingPoint,
} from "../types";
import { TERMINAL_INTERVAL_MS } from "./terminal_calculations";

/* -------------------------------------------------------------------------- *
 * Framework constants (section 1: scale-free parameters)
 * -------------------------------------------------------------------------- */

/** epsilon: fraction of pre-surge history excluded from the baseline. */
const EPS_BASELINE = 0.15;
/** B_max: cap on baseline bars so the baseline stays recent. */
const BASELINE_CAP = 500;
/** Minimum baseline samples before a z-score is trusted. */
const BASELINE_MIN = 100;
/** Numerical floor on the baseline scale (avoids divide-by-zero). */
const SCALE_FLOOR = 5e-4;
/** m_b: breakdown-window multiplier on the trigger span (L bars). */
const BREAKDOWN_WINDOW_MULT = 2;
/** c: per-coin cooldown as a multiple of h (>= 2 per the framework). */
const COOLDOWN_MULT = 2;
/** Minimum non-missing bar share for an event to enter the dataset. */
const MIN_COVERAGE = 0.8;
/** Kernel bandwidth on robustly standardized features. */
const KERNEL_KAPPA = 1.25;
/** Out-of-distribution threshold (robust z), on two or more features. */
const OOD_Z = 3.5;
/** Equal-count time blocks used for clustering and drift reporting. */
const MAX_TIME_BLOCKS = 8;
/** The kernel features (framework section 4; positioning excluded). */
const KERNEL_KEYS = [
  "cvdCorr",
  "displacement",
  "volumeDecay",
  "vwapDistance",
  "pullbackSpeed",
  "lowerHigh",
  "btcEpisodeReturn",
  "logR",
] as const;
type KernelKey = (typeof KERNEL_KEYS)[number];
/** Kernel analogs must clear at least this many effective events. */
const N_EFF_FLOOR_MIN = 20;
const N_EFF_FLOOR_SHARE = 0.05;
/** Minimum stage-B events before out-of-fold skill is estimated. */
const MIN_OOF_EVENTS = 40;
/** Benchmark symbol supplying the regime context features. */
export const PROBABILITY_CONTEXT_SYMBOL = "BTCUSDT";

export const PROBABILITY_DEFAULTS: ProbabilityParams = {
  interval: "1h",
  lookbackDays: 90,
  universeSize: 30,
  L: 6,
  k: 3,
  beta: 0.1,
  deltaC: 0.25,
  deltaE: 0.25,
  m: 2,
};

/**
 * Lookback ceilings for the probability page. Wider than the terminal's on
 * 1h because event detection needs far more bars than correlation does; the
 * server paginates so nothing is squeezed into one request.
 */
export const PROBABILITY_MAX_LOOKBACK_DAYS: Record<Interval, number> = {
  "15m": 45,
  "1h": 180,
  "4h": 365,
  "1d": 730,
};

export const PROBABILITY_GRIDS = {
  interval: ["15m", "1h", "4h", "1d"] as Interval[],
  lookbackDays: [30, 45, 90, 180, 365],
  universe: [15, 30, 50],
  L: [4, 6, 8, 12],
  k: [2.5, 3, 3.5, 4],
  beta: [0.05, 0.1, 0.15, 0.2],
  deltaC: [0.2, 0.25, 0.3],
  deltaE: [0.2, 0.25, 0.3],
  m: [1, 2, 3],
};

/** Honesty notes carried into every response. */
export const BASE_CAVEATS = [
  "Descriptive historical precedent, not a forecast: conditional frequencies describe past regimes and do not establish that any feature causes a reversal.",
  "Positioning features (OI expansion, funding excess, perp-spot basis) are unavailable: Binance serves only 30 days of open-interest history, too short to build an event sample.",
  "The universe is today's live USDT listings ranked by 24h volume: delisted pairs are absent, so results carry survivorship bias relative to the point-in-time universe the framework asks for.",
  "This is an advisory view, not an entry machine: probabilities are shrunk toward base rates, gated on effective sample size, and wide intervals are the correct output at small N.",
];

/* -------------------------------------------------------------------------- *
 * Small math utilities
 * -------------------------------------------------------------------------- */

function lgamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  const xx = x - 1;
  let a = c[0];
  const t = xx + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (xx + i);
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a);
}

function mean(arr: number[]): number {
  if (arr.length === 0) return NaN;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function std(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mu = mean(arr);
  let s = 0;
  for (const v of arr) s += (v - mu) * (v - mu);
  return Math.sqrt(s / (arr.length - 1));
}

function sortedCopy(arr: number[]): number[] {
  return arr.slice().sort((a, b) => a - b);
}

function quantileFromSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function median(arr: number[]): number {
  return quantileFromSorted(sortedCopy(arr), 0.5);
}

/** Robust scale: 1.4826 * MAD, falling back to std then to 1. */
function robustScale(arr: number[]): number {
  const fin = arr.filter(finite);
  if (fin.length < 2) return 1;
  const med = median(fin);
  const mad = median(fin.map((v) => Math.abs(v - med)));
  if (mad > 1e-9) return 1.4826 * mad;
  const sd = std(fin);
  return sd > 1e-9 ? sd : 1;
}

function pearson(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 3) return NaN;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  if (da <= 0 || db <= 0) return NaN;
  return num / Math.sqrt(da * db);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/* -------------------------------------------------------------------------- *
 * Seeded RNG, gamma and Dirichlet sampling
 * -------------------------------------------------------------------------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stringHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Marsaglia-Tsang gamma sampler with a Box-Muller normal. */
function randGamma(shape: number, rng: () => number): number {
  if (shape <= 0) return 0;
  if (shape < 1) {
    const u = Math.max(rng(), 1e-12);
    return randGamma(shape + 1, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x = 0;
    let v = 0;
    do {
      const u1 = Math.max(rng(), 1e-12);
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rng());
      x = z;
      v = 1 + c * x;
    } while (v <= 0 || v === 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

interface DirichletSummary {
  mean: number[];
  ci80: [number, number][];
  ci95: [number, number][];
}

/**
 * Posterior mean plus joint 80%/95% credible intervals from seeded
 * Dirichlet draws. Seeding from the alpha vector keeps results deterministic,
 * so a cached response and a fresh one agree exactly.
 */
function summarizeDirichlet(alpha: number[], draws = 1200): DirichletSummary {
  const total = alpha.reduce((s, a) => s + a, 0);
  if (!(total > 0) || alpha.some((a) => !(a > 0))) {
    const p = alpha.map(() => 1 / Math.max(1, alpha.length));
    return {
      mean: p,
      ci80: alpha.map(() => [0, 1] as [number, number]),
      ci95: alpha.map(() => [0, 1] as [number, number]),
    };
  }
  const meanP = alpha.map((a) => a / total);
  const rng = mulberry32(stringHash(alpha.map((a) => a.toFixed(6)).join(",")));
  const cols: number[][] = alpha.map(() => []);
  const g = alpha.map(() => 0);
  for (let d = 0; d < draws; d++) {
    let s = 0;
    for (let c = 0; c < alpha.length; c++) {
      g[c] = randGamma(alpha[c], rng);
      s += g[c];
    }
    if (!(s > 0)) continue;
    for (let c = 0; c < alpha.length; c++) cols[c].push(g[c] / s);
  }
  return {
    mean: meanP,
    ci80: cols.map((c) => {
      const s = sortedCopy(c);
      return [quantileFromSorted(s, 0.1), quantileFromSorted(s, 0.9)] as [number, number];
    }),
    ci95: cols.map((c) => {
      const s = sortedCopy(c);
      return [quantileFromSorted(s, 0.025), quantileFromSorted(s, 0.975)] as [number, number];
    }),
  };
}

/**
 * Empirical-Bayes prior strength m0 by maximizing the Dirichlet-multinomial
 * marginal likelihood on a bounded grid - never hand-picked (framework 6.2).
 */
function empiricalBayesM0(counts: number[]): number {
  const n = counts.reduce((s, c) => s + c, 0);
  if (n <= 0) return 1;
  const J = counts.length;
  const pBase = counts.map((c) => (c + 1) / (n + J));
  let bestM = 1;
  let bestLL = -Infinity;
  for (const m0 of [1, 2, 3, 5, 8, 12, 20, 35, 60, 100]) {
    let ll = lgamma(m0) - lgamma(m0 + n);
    for (let c = 0; c < J; c++) {
      const a = m0 * pBase[c];
      ll += lgamma(a + counts[c]) - lgamma(a);
    }
    if (ll > bestLL) {
      bestLL = ll;
      bestM = m0;
    }
  }
  return bestM;
}

function smoothedBase(counts: number[], m0: number): number[] {
  const J = counts.length;
  const n = counts.reduce((s, c) => s + c, 0);
  return counts.map((c) => m0 * ((c + 1) / (n + J)));
}

/* -------------------------------------------------------------------------- *
 * Series preparation: robust return z-scores, once per symbol+L
 * -------------------------------------------------------------------------- */

export interface PreparedSeries {
  /** z of the trailing L-bar return vs a robust rolling baseline. */
  z: Float64Array;
  /** Trailing L-bar log return. */
  r: Float64Array;
}

function insertSorted(win: number[], v: number): void {
  let lo = 0;
  let hi = win.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (win[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  win.splice(lo, 0, v);
}

function removeSorted(win: number[], v: number): void {
  let lo = 0;
  let hi = win.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (win[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  if (win[lo] === v) win.splice(lo, 1);
}

/**
 * Sliding-window robust baseline over the trailing L-bar log return,
 * excluding the most recent `epsilon` fraction (framework 4.1) and capped at
 * B_max samples. The sorted window is maintained incrementally.
 *
 * The scale is (Q3 - Q1) / 1.349 rather than 1.4826 * MAD: both are
 * consistent Gaussian scale estimators, and quartiles read off the sorted
 * window in O(1) while a MAD would re-sort 500 deviations per bar.
 */
function prepareSeries(klines: Kline[], L: number): PreparedSeries {
  const n = klines.length;
  const z = new Float64Array(n).fill(NaN);
  const r = new Float64Array(n).fill(NaN);
  const logC = new Float64Array(n);
  for (let i = 0; i < n; i++) logC[i] = Math.log(klines[i].close);
  for (let i = L; i < n; i++) r[i] = logC[i] - logC[i - L];

  const gapCap = Math.ceil(EPS_BASELINE * BASELINE_CAP);
  const win: number[] = [];
  let curStart = -1;
  let curEnd = -2;
  let synced = false;

  for (let i = 0; i < n; i++) {
    const start = Math.max(L, i - BASELINE_CAP);
    const gap = Math.min(gapCap, Math.floor(EPS_BASELINE * i));
    const end = i - 1 - gap;

    if (!synced) {
      win.length = 0;
      for (let j = start; j <= end; j++) if (finite(r[j])) insertSorted(win, r[j] as number);
      synced = true;
    } else {
      for (let j = curStart; j < start; j++) if (finite(r[j])) removeSorted(win, r[j] as number);
      for (let j = curEnd + 1; j <= end; j++) if (finite(r[j])) insertSorted(win, r[j] as number);
    }
    curStart = start;
    curEnd = end;

    if (end < start || win.length < BASELINE_MIN) continue;
    const med = quantileFromSorted(win, 0.5);
    const q1 = quantileFromSorted(win, 0.25);
    const q3 = quantileFromSorted(win, 0.75);
    let scale = (q3 - q1) / 1.349;
    if (!(scale > 0)) {
      const p90 = quantileFromSorted(win, 0.9);
      const p10 = quantileFromSorted(win, 0.1);
      scale = (p90 - p10) / 2.563;
    }
    if (scale >= SCALE_FLOOR && finite(r[i])) z[i] = ((r[i] as number) - med) / scale;
  }
  return { z, r };
}

/* -------------------------------------------------------------------------- *
 * Event detection and labelling (framework sections 2-3)
 * -------------------------------------------------------------------------- */

interface SurgeFeatures {
  cvdCorr: number;
  displacement: number;
  volumeDecay: number;
  vwapDistance: number;
  pullbackSpeed: number;
  lowerHigh: number;
  wickFraction: number;
  btcEpisodeReturn: number;
  btcVolPercentile: number;
  hourSin: number;
  hourCos: number;
  weekend: number;
  logHistoryBars: number;
  logR: number;
  logD: number;
  rhoBreak: number;
  barsPeakToBreak: number;
}

export interface RawEvent {
  symbol: string;
  t0: number;
  trigTime: number;
  peakTime: number;
  breakTime: number | null;
  endTime: number;
  /** Slice of the symbol's klines from origin to episode end. */
  bars: Kline[];
  /** Local (slice) indices. */
  sTrig: number;
  sPeak: number;
  sBreak: number | null;
  sEnd: number;
  /** Local index of the first-touch bar for the Stage B label, if any. */
  sResolved: number | null;
  coverage: number;
  /** Bars of symbol history available before the origin (logs feature). */
  historyBars: number;
  stageA: "breakdown" | "secondLeg" | "neither";
  outcome: -1 | 0 | 1 | null;
  ambiguous: boolean;
  preResolved: boolean;
  /** Horizon still open at the last available bar. */
  horizonOpen: boolean;
  /** Breakdown window still open at the last available bar. */
  windowOpen: boolean;
  D: number;
  h: number;
  R: number;
  p0: number;
  pBreak: number | null;
  pPeak: number;
  rhoBreak: number | null;
  features: SurgeFeatures | null;
  block: number;
}

interface DetectResult {
  events: RawEvent[];
  triggers: number;
  deduped: number;
  coverageExcluded: number;
}

/**
 * Sequential evaluation of the breakdown rule: a close at or below the
 * running max high minus `beta` of the range built so far. Using the running
 * range keeps the milestone leak-free - the final peak is never needed to
 * decide whether the breakdown happened (framework 2.3).
 */
function detectAndLabel(
  symbol: string,
  klines: Kline[],
  series: PreparedSeries,
  params: ProbabilityParams
): DetectResult {
  const n = klines.length;
  const { L, k, beta, deltaC, deltaE, m } = params;
  const events: RawEvent[] = [];
  let triggers = 0;
  let deduped = 0;
  let coverageExcluded = 0;
  let cooldownUntil = -1;
  if (n < 2) return { events, triggers, deduped, coverageExcluded };

  const barMs = klines[1].time - klines[0].time;
  const logHigh = (i: number) => Math.log(klines[i].high);
  const logLow = (i: number) => Math.log(klines[i].low);
  const logClose = (i: number) => Math.log(klines[i].close);

  for (let i = L; i < n; i++) {
    const z = series.z[i];
    if (!finite(z) || z < k) continue;
    if (!(series.r[i] > 0)) continue;
    triggers++;
    if (i <= cooldownUntil) {
      deduped++;
      continue;
    }

    // Origin: swing low over the trigger lookback (known at the trigger).
    let i0 = i - L;
    for (let j = i - L + 1; j <= i; j++) if (klines[j].low < klines[i0].low) i0 = j;
    const p0 = logLow(i0);
    if (!finite(p0)) continue;

    let runMax = -Infinity;
    for (let j = i0; j <= i; j++) runMax = Math.max(runMax, logHigh(j));
    const rTrig = Math.max(runMax - p0, 1e-9);

    const maxBreakIdx = Math.min(n - 1, i + BREAKDOWN_WINDOW_MULT * L);
    let iBreak: number | null = null;
    for (let tau = i + 1; tau <= maxBreakIdx; tau++) {
      runMax = Math.max(runMax, logHigh(tau));
      const range = runMax - p0;
      if (range > 1e-9 && logClose(tau) <= p0 + (1 - beta) * range) {
        iBreak = tau;
        break;
      }
    }

    let stageA: RawEvent["stageA"];
    let outcome: -1 | 0 | 1 | null = null;
    let ambiguous = false;
    let preResolved = false;
    let horizonOpen = false;
    let windowOpen = false;
    let sResolved: number | null = null;
    let iEnd: number;
    let iPeak: number;
    let pPeak: number;
    let R: number;
    let D: number;
    let h: number;
    let pBreak: number | null = null;
    let rhoBreak: number | null = null;

    if (iBreak !== null) {
      stageA = "breakdown";
      iPeak = i0;
      let best = -Infinity;
      for (let j = i0; j <= iBreak; j++) {
        const lh = logHigh(j);
        if (lh > best) {
          best = lh;
          iPeak = j;
        }
      }
      pPeak = best;
      R = pPeak - p0;
      if (!(R > 1e-9)) continue;
      D = iPeak - i0;
      h = Math.max(1, Math.round(m * D));
      iEnd = Math.min(n - 1, iBreak + h);
      pBreak = logClose(iBreak);
      rhoBreak = (pPeak - pBreak) / R;
      preResolved = logLow(iBreak) <= pBreak - deltaC * R;

      for (let tau = iBreak; tau <= iEnd; tau++) {
        const col = logLow(tau) <= pBreak - deltaC * R;
        const ext = logHigh(tau) >= pPeak + deltaE * R;
        if (col && ext) {
          ambiguous = true;
          sResolved = tau;
          break;
        }
        if (col || ext) {
          outcome = col ? -1 : 1;
          sResolved = tau;
          break;
        }
      }
      if (!ambiguous && outcome === null) {
        if (iBreak + h <= n - 1) outcome = 0;
        else horizonOpen = true;
      }
    } else {
      // No breakdown inside the window: did the run extend instead?
      iEnd = Math.min(n - 1, i + BREAKDOWN_WINDOW_MULT * L);
      windowOpen = i + BREAKDOWN_WINDOW_MULT * L > n - 1;
      const extLevel = runMax + deltaE * rTrig;
      let ext = false;
      for (let tau = i + 1; tau <= iEnd; tau++) {
        if (logHigh(tau) >= extLevel) {
          ext = true;
          break;
        }
      }
      stageA = ext ? "secondLeg" : "neither";
      iPeak = i0;
      let best = -Infinity;
      for (let j = i0; j <= iEnd; j++) {
        const lh = logHigh(j);
        if (lh > best) {
          best = lh;
          iPeak = j;
        }
      }
      pPeak = best;
      R = pPeak - p0;
      if (!(R > 1e-9)) continue;
      D = iPeak - i0;
      h = Math.max(1, Math.round(m * D));
    }

    // Coverage: bars present vs the wall-clock span the slice claims.
    const expected = (klines[iEnd].time - klines[i0].time) / barMs + 1;
    const present = iEnd - i0 + 1;
    const coverage = expected > 0 ? Math.min(1, present / expected) : 1;
    if (coverage < MIN_COVERAGE) {
      coverageExcluded++;
      continue;
    }

    events.push({
      symbol,
      t0: klines[i0].time,
      trigTime: klines[i].time,
      peakTime: klines[iPeak].time,
      breakTime: iBreak === null ? null : klines[iBreak].time,
      endTime: klines[iEnd].time,
      bars: klines.slice(i0, iEnd + 1),
      sTrig: i - i0,
      sPeak: iPeak - i0,
      sBreak: iBreak === null ? null : iBreak - i0,
      sEnd: iEnd - i0,
      sResolved: sResolved === null ? null : sResolved - i0,
      coverage,
      historyBars: i0,
      stageA,
      outcome,
      ambiguous,
      preResolved,
      horizonOpen,
      windowOpen,
      D,
      h,
      R,
      p0,
      pBreak,
      pPeak,
      rhoBreak,
      features: null,
      block: 0,
    });

    cooldownUntil =
      iBreak !== null ? iBreak + COOLDOWN_MULT * h : iEnd + BREAKDOWN_WINDOW_MULT * L;
  }

  return { events, triggers, deduped, coverageExcluded };
}

/* -------------------------------------------------------------------------- *
 * Episode features (framework section 5; positioning group unavailable)
 * -------------------------------------------------------------------------- */

/** Benchmark bars plus an open-time index for the context features. */
export interface ContextBars {
  klines: Kline[];
  barMs: number;
}

function ctxIndex(ctx: ContextBars, t: number): number | null {
  const arr = ctx.klines;
  if (arr.length === 0) return null;
  let lo = 0;
  let hi = arr.length - 1;
  if (t <= arr[0].time) return 0;
  if (t >= arr[hi].time) return hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Features of one episode measured at bar `sAsOf` (local index into
 * `ev.bars`): at the breakdown milestone for the decision-time vector, or at
 * a horizon phase when matching analogs. Everything here is known at
 * `sAsOf` - no post-episode information leaks into the matching features.
 */
function featuresAt(ev: RawEvent, sAsOf: number, ctx: ContextBars | null): SurgeFeatures {
  const bars = ev.bars;
  const upto = clamp(sAsOf, ev.sTrig, ev.sEnd);
  const R = ev.R > 1e-9 ? ev.R : 1e-9;
  const logC = (i: number) => Math.log(bars[i].close);

  // CVD correlation over the window: (close-to-close, taker buy - taker sell).
  let cvdCorr = NaN;
  const dClose: number[] = [];
  const dCvd: number[] = [];
  for (let i = Math.max(1, ev.sTrig); i <= upto; i++) {
    const t = bars[i].takerBuy;
    if (!finite(t)) {
      dClose.length = 0;
      dCvd.length = 0;
      break;
    }
    const v = bars[i].volume;
    dClose.push(logC(i) - logC(i - 1));
    dCvd.push(2 * (t as number) - v);
  }
  if (dClose.length >= 4) cvdCorr = pearson(dClose, dCvd);

  const span = Math.max(1, upto - ev.sTrig);
  const displacement = (logC(upto) - logC(ev.sTrig)) / R;

  const half = Math.max(1, Math.floor(span / 2));
  let vFirst = 0;
  let vLast = 0;
  let nFirst = 0;
  let nLast = 0;
  for (let i = ev.sTrig; i <= upto; i++) {
    if (i < ev.sTrig + half) {
      vFirst += bars[i].volume;
      nFirst++;
    } else {
      vLast += bars[i].volume;
      nLast++;
    }
  }
  const volumeDecay =
    nFirst > 0 && nLast > 0
      ? Math.log((vLast / nLast + 1e-9) / (vFirst / nFirst + 1e-9))
      : NaN;

  let pv = 0;
  let vv = 0;
  for (let i = ev.sTrig; i <= upto; i++) {
    const tp = (bars[i].high + bars[i].low + bars[i].close) / 3;
    pv += tp * bars[i].volume;
    vv += bars[i].volume;
  }
  const vwapDistance = vv > 0 ? (logC(upto) - Math.log(pv / vv)) / R : NaN;

  const pullbackSpeed = (upto - ev.sPeak) / ev.h;

  let lowerHigh = NaN;
  if (ev.sBreak !== null && upto > ev.sBreak) {
    let mx = -Infinity;
    for (let i = ev.sBreak + 1; i <= upto; i++) mx = Math.max(mx, Math.log(bars[i].high));
    if (finite(mx)) lowerHigh = clamp((ev.pPeak - mx) / R, 0, 1);
  }

  let wickSum = 0;
  let rangeSum = 0;
  for (let i = ev.sTrig; i <= upto; i++) {
    const rng = bars[i].high - bars[i].low;
    if (rng > 0) {
      wickSum += bars[i].high - Math.max(bars[i].open, bars[i].close);
      rangeSum += rng;
    }
  }
  const wickFraction = rangeSum > 0 ? wickSum / rangeSum : NaN;

  let btcEpisodeReturn = NaN;
  let btcVolPercentile = NaN;
  if (ctx) {
    const a = ctxIndex(ctx, ev.t0);
    const b = ctxIndex(ctx, ev.endTime);
    if (a !== null && b !== null && b > a) {
      const arr = ctx.klines;
      btcEpisodeReturn = Math.log(arr[b].close) - Math.log(arr[a].close);
      let meanVol = 0;
      for (let i = a; i <= b; i++) meanVol += arr[i].volume;
      meanVol /= b - a + 1;
      let le = 0;
      for (const bar of arr) if (bar.volume <= meanVol) le++;
      btcVolPercentile = le / arr.length;
    }
  }

  const hour = new Date(ev.trigTime).getUTCHours();
  const dow = new Date(ev.trigTime).getUTCDay();
  const rhoBreak =
    ev.sBreak !== null && upto >= ev.sBreak
      ? clamp((ev.pPeak - logC(upto)) / R, -0.5, 1.5)
      : NaN;

  return {
    cvdCorr,
    displacement,
    volumeDecay,
    vwapDistance,
    pullbackSpeed,
    lowerHigh,
    wickFraction,
    btcEpisodeReturn,
    btcVolPercentile,
    hourSin: Math.sin((2 * Math.PI * hour) / 24),
    hourCos: Math.cos((2 * Math.PI * hour) / 24),
    weekend: dow === 0 || dow === 6 ? 1 : 0,
    logHistoryBars: Math.log1p(ev.historyBars),
    logR: ev.R,
    logD: Math.log1p(ev.D),
    rhoBreak,
    barsPeakToBreak: (ev.sBreak ?? upto) - ev.sPeak,
  };
}

function pickKernel(f: SurgeFeatures): number[] {
  return KERNEL_KEYS.map((key) => f[key]);
}

/* -------------------------------------------------------------------------- *
 * Kernel matching, effective sample size and clustering
 * -------------------------------------------------------------------------- */

interface FeatureStats {
  med: number;
  scale: number;
  valid: boolean;
}

/** Pool median/MAD per kernel dimension; dims below 60% coverage are dropped. */
function buildFeatureStats(pool: number[][]): FeatureStats[] {
  return KERNEL_KEYS.map((_key, d) => {
    const vals = pool.map((row) => row[d]).filter(finite);
    if (vals.length < Math.max(8, pool.length * 0.6)) {
      return { med: NaN, scale: NaN, valid: false };
    }
    const med = median(vals);
    const mad = median(vals.map((v) => Math.abs(v - med)));
    const scale = mad > 1e-9 ? 1.4826 * mad : robustScale(vals);
    return { med, scale, valid: scale > 1e-9 };
  });
}

interface KernelQuery {
  /** One weight per pool row; 0 where the row cannot contribute. */
  weights: number[];
  /** (sum w)^2 / sum w^2 before the time-clustering adjustment. */
  nEffRaw: number;
  /** Dims whose robust z vs the pool reaches the OOD threshold. */
  oodDims: number;
  oodKeys: KernelKey[];
  usedDims: number;
  /** Share of total weight carried by the most recent 20% of the pool. */
  recentWeightShare: number;
}

/**
 * Gaussian kernel on robustly standardized features, bandwidth `KERNEL_KAPPA`,
 * averaged over dims so the weight does not shrink with dimension count.
 */
function kernelQuery(current: number[], pool: number[][], stats: FeatureStats[]): KernelQuery {
  const n = pool.length;
  const weights = new Array<number>(n).fill(0);
  const dims: number[] = [];
  for (let d = 0; d < stats.length; d++) {
    if (stats[d].valid && finite(current[d])) dims.push(d);
  }
  if (dims.length === 0 || n === 0) {
    return {
      weights,
      nEffRaw: 0,
      oodDims: dims.length,
      oodKeys: [],
      usedDims: 0,
      recentWeightShare: 0,
    };
  }
  let oodDims = 0;
  const oodKeys: KernelKey[] = [];
  for (const d of dims) {
    const z = Math.abs(((current[d] as number) - stats[d].med) / stats[d].scale);
    if (z >= OOD_Z) {
      oodDims++;
      oodKeys.push(KERNEL_KEYS[d]);
    }
  }
  let total = 0;
  let recent = 0;
  const recentFrom = Math.floor(n * 0.8);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    let ok = true;
    for (const d of dims) {
      const v = pool[i][d];
      if (!finite(v)) {
        ok = false;
        break;
      }
      const z = ((v as number) - stats[d].med) / stats[d].scale;
      acc += z * z;
    }
    const w = ok ? Math.exp(-acc / (2 * KERNEL_KAPPA * dims.length)) : 0;
    weights[i] = w;
    total += w;
    if (i >= recentFrom) recent += w;
  }
  let w2 = 0;
  for (const w of weights) w2 += w * w;
  const nEffRaw = total > 0 && w2 > 0 ? (total * total) / w2 : 0;
  return {
    weights,
    nEffRaw,
    oodDims,
    oodKeys,
    usedDims: dims.length,
    recentWeightShare: total > 0 ? recent / total : 0,
  };
}

/**
 * Design effect from equal-count time blocks: 1 + (m - 1) * ICC with the
 * standard unequal-size correction. `values` are 0/1 indicators (e.g. did the
 * event collapse), blockIds are contiguous in time.
 */
function designEffect(values: number[], blockIds: number[]): number {
  const n = values.length;
  if (n < 8) return 1;
  const K = Math.max(...blockIds) + 1;
  if (K < 2) return 1;
  const p = mean(values);
  if (p <= 0 || p >= 1) return 1;
  const sums: number[] = new Array(K).fill(0);
  const counts: number[] = new Array(K).fill(0);
  for (let i = 0; i < n; i++) {
    sums[blockIds[i]] += values[i];
    counts[blockIds[i]]++;
  }
  let ssBetween = 0;
  let ssWithin = 0;
  let mBar = 0;
  for (let b = 0; b < K; b++) {
    if (counts[b] === 0) continue;
    const pb = sums[b] / counts[b];
    ssBetween += counts[b] * (pb - p) * (pb - p);
    mBar += counts[b];
  }
  mBar /= K;
  for (let i = 0; i < n; i++) {
    const pb = counts[blockIds[i]] > 0 ? sums[blockIds[i]] / counts[blockIds[i]] : p;
    ssWithin += (values[i] - pb) * (values[i] - pb);
  }
  const MSb = ssBetween / (K - 1);
  const MSw = n - K > 0 ? ssWithin / (n - K) : 0;
  if (MSb + MSw <= 0) return 1;
  const icc = clamp((MSb - MSw) / (MSb + Math.max(mBar - 1, 1) * MSw), 0, 1);
  return 1 + Math.max(mBar - 1, 0) * icc;
}

/** Clustering adjustment on a kernel nEff: weight concentrated in few blocks
 *  of time is not independent precedent. `blockOf` indexes pool rows. */
function clusteredNEff(nEffRaw: number, weights: number[], blockOf: number[], K: number): number {
  if (K < 2 || nEffRaw <= 0) return nEffRaw;
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return 0;
  const share = new Array<number>(K).fill(0);
  for (let i = 0; i < weights.length; i++) share[blockOf[i]] += weights[i] / total;
  let hhi = 0;
  for (const s of share) hhi += s * s;
  const blockFactor = hhi > 0 ? Math.min(1, 1 / (K * hhi)) : 1;
  return nEffRaw * blockFactor;
}

/* -------------------------------------------------------------------------- *
 * Posterior helpers (framework 6)
 * -------------------------------------------------------------------------- */

interface Triple {
  collapse: ClassProbability;
  extension: ClassProbability;
  consolidation: ClassProbability;
}

/**
 * alpha = EB-smoothed parent + effective counts. For unweighted counts pass
 * nEff-scaled counts; for kernel views pass nEff * p_hat_implicit by feeding
 * weighted counts directly through `effCounts`.
 */
function posteriorTriple(
  effCounts: number[],
  baseCounts: number[],
  rawCounts: number[] | null
): { triple: Triple; m0: number; summary: DirichletSummary } {
  const m0 = empiricalBayesM0(baseCounts);
  const base = smoothedBase(baseCounts, m0);
  const alpha = base.map((a, i) => a + Math.max(0, effCounts[i] ?? 0));
  const summary = summarizeDirichlet(alpha);
  const triple: Triple = {
    collapse: {
      p: summary.mean[0],
      ci80: summary.ci80[0],
      ci95: summary.ci95[0],
      count: rawCounts ? rawCounts[0] : 0,
    },
    extension: {
      p: summary.mean[1],
      ci80: summary.ci80[1],
      ci95: summary.ci95[1],
      count: rawCounts ? rawCounts[1] : 0,
    },
    consolidation: {
      p: summary.mean[2],
      ci80: summary.ci80[2],
      ci95: summary.ci95[2],
      count: rawCounts ? rawCounts[2] : 0,
    },
  };
  return { triple, m0, summary };
}

const STAGE_A_LABELS: Record<StageAClass["key"], string> = {
  breakdown: "Breakdown occurs",
  secondLeg: "Second leg, no breakdown",
  neither: "Neither within the window",
};

function stageAClasses(
  events: RawEvent[],
  blockOf: (ev: RawEvent) => number
): StageAClass[] {
  const counts = [0, 0, 0];
  const keys: StageAClass["key"][] = ["breakdown", "secondLeg", "neither"];
  for (const ev of events) counts[keys.indexOf(ev.stageA)]++;
  const indicator = events.map((ev) => (ev.stageA === "breakdown" ? 1 : 0));
  const blocks = events.map(blockOf);
  const nEff = indicator.length > 0 ? indicator.length / designEffect(indicator, blocks) : 0;
  const total = counts.reduce((s, c) => s + c, 0);
  const { summary } = posteriorTriple(
    counts.map((c) => (total > 0 ? (c / total) * nEff : 0)),
    counts,
    counts
  );
  return keys.map((key, i) => ({
    key,
    label: STAGE_A_LABELS[key],
    p: summary.mean[i],
    ci80: summary.ci80[i],
    ci95: summary.ci95[i],
    count: counts[i],
  }));
}

/* -------------------------------------------------------------------------- *
 * Competing-risks timing (framework section 7): Aalen-Johansen
 * -------------------------------------------------------------------------- */

const TIMING_FRACS = [0, 0.25, 0.5, 0.75, 1];

function computeTiming(events: RawEvent[]): TimingAnalysis {
  // Rows: cause 1 = collapse, 2 = extension, 3 = consolidation (resolved at
  // its own horizon end), 0 = administratively censored (sample ends first).
  // Times are normalized by each event's OWN horizon so every episode lives
  // on the same [0, 1] axis: curves then end at the empirical class shares
  // instead of truncating at whichever horizon happens to be the median.
  // `bars` reports the axis back in bars at the median horizon.
  const rows: { t: number; cause: 0 | 1 | 2 | 3 }[] = [];
  const horizons: number[] = [];
  for (const ev of events) {
    if (ev.stageA !== "breakdown" || ev.sBreak === null || ev.ambiguous) continue;
    horizons.push(ev.h);
    if (ev.outcome === null) {
      rows.push({ t: Math.max(1, ev.sEnd - ev.sBreak) / ev.h, cause: 0 });
    } else if (ev.outcome === 0) {
      rows.push({ t: 1, cause: 3 });
    } else {
      const t = clamp((ev.sResolved ?? ev.sEnd) - ev.sBreak, 1, ev.h);
      rows.push({ t: t / ev.h, cause: ev.outcome === -1 ? 1 : 2 });
    }
  }
  const h = horizons.length > 0 ? Math.max(1, Math.round(median(horizons))) : 1;
  if (rows.length === 0) {
    return {
      horizonBars: h,
      points: TIMING_FRACS.map((frac) => ({
        frac,
        bars: Math.round(frac * h),
        collapse: 0,
        extension: 0,
      })),
      medianCollapseBars: null,
    };
  }
  rows.sort((a, b) => a.t - b.t);
  const curve: { t: number; collapse: number; extension: number }[] = [];
  let S = 1;
  let cifC = 0;
  let cifE = 0;
  let i = 0;
  let medianCollapse: number | null = null;
  while (i < rows.length) {
    const t = rows[i].t;
    let dC = 0;
    let dE = 0;
    let dAll = 0;
    let Y = 0;
    for (let j = i; j < rows.length; j++) {
      if (rows[j].t >= t) Y++;
      if (rows[j].t === t) {
        dAll++;
        if (rows[j].cause === 1) dC++;
        else if (rows[j].cause === 2) dE++;
      }
    }
    if (Y > 0) {
      const incC = (S * dC) / Y;
      const incE = (S * dE) / Y;
      cifC += incC;
      cifE += incE;
      S = Math.max(0, S * (1 - dAll / Y));
      if (medianCollapse === null && cifC >= 0.5) medianCollapse = t;
      curve.push({ t, collapse: cifC, extension: cifE });
    }
    while (i < rows.length && rows[i].t === t) i++;
  }
  const at = (frac: number): { collapse: number; extension: number } => {
    let res = { collapse: 0, extension: 0 };
    for (const pt of curve) {
      if (pt.t > frac) break;
      res = pt;
    }
    return res;
  };
  return {
    horizonBars: h,
    points: TIMING_FRACS.map((frac) => {
      const v = at(frac);
      return { frac, bars: Math.round(frac * h), collapse: v.collapse, extension: v.extension };
    }),
    medianCollapseBars:
      medianCollapse === null ? null : Math.max(1, Math.round(medianCollapse * h)),
  };
}

/* -------------------------------------------------------------------------- *
 * Downside profile (framework 8)
 * -------------------------------------------------------------------------- */

const REACH_GRID = [0, 0.1, 0.25, 0.5];

function quantileSorted(sorted: number[], q: number): number {
  return quantileFromSorted(sorted, q);
}

function excursionStats(vals: number[]): { p50: number; p90: number; p95: number; p99: number; es95: number } {
  if (vals.length === 0) return { p50: 0, p90: 0, p95: 0, p99: 0, es95: 0 };
  const s = sortedCopy(vals);
  const tailFrom = Math.max(1, Math.ceil(s.length * 0.05));
  let tail = 0;
  for (let i = s.length - tailFrom; i < s.length; i++) tail += s[i];
  return {
    p50: quantileSorted(s, 0.5),
    p90: quantileSorted(s, 0.9),
    p95: quantileSorted(s, 0.95),
    p99: quantileSorted(s, 0.99),
    es95: tail / tailFrom,
  };
}

function computeDownside(events: RawEvent[], deltaC: number): DownsideProfile {
  const breakdown = events.filter(
    (ev) => ev.stageA === "breakdown" && ev.sBreak !== null && ev.sBreak >= 0
  );
  const clean = breakdown.filter((ev) => !ev.ambiguous);
  const ambiguousShare = breakdown.length > 0 ? (breakdown.length - clean.length) / breakdown.length : 0;

  const reachBeforeCollapse = REACH_GRID.map((x) => ({ x, p: 0, n: clean.length }));
  const adverse: number[] = [];
  let deepestBelow = 0;

  for (const ev of clean) {
    const sB = ev.sBreak as number;
    const limit = ev.outcome === null ? ev.sEnd : (ev.sResolved ?? ev.sEnd);
    const collapseLevel = ev.pBreak !== null ? ev.pBreak - deltaC * ev.R : ev.p0 - deltaC * ev.R;
    let collapseT = Infinity;
    let maxAdverse = 0;
    let deepest = 0;
    const reachT = REACH_GRID.map(() => Infinity);
    for (let tau = sB; tau <= limit; tau++) {
      const hi = Math.log(ev.bars[tau].high);
      const lo = Math.log(ev.bars[tau].low);
      if (collapseT === Infinity && lo <= collapseLevel) collapseT = tau;
      REACH_GRID.forEach((x, gi) => {
        if (reachT[gi] === Infinity && hi >= ev.pPeak + x * ev.R) reachT[gi] = tau;
      });
      if (ev.pBreak !== null) maxAdverse = Math.max(maxAdverse, (hi - ev.pBreak) / ev.R);
      deepest = Math.max(deepest, (ev.pBreak !== null ? ev.pBreak : ev.pPeak) - lo);
    }
    adverse.push(Math.max(0, maxAdverse));
    deepestBelow = Math.max(deepestBelow, deepest / ev.R);
    reachT.forEach((rt, gi) => {
      // A same-bar tie between the upside level and the collapse level is
      // attributed to collapse (conservative for the reach estimate).
      if (rt < collapseT) reachBeforeCollapse[gi].p += 1;
    });
  }
  if (clean.length > 0) {
    for (const pt of reachBeforeCollapse) pt.p /= clean.length;
  }
  const adv = excursionStats(adverse);
  return {
    reachBeforeCollapse,
    adverseExcursionR: adv,
    adverseExcursionPct: {
      p50: adv.p50 * 100,
      p90: adv.p90 * 100,
      p95: adv.p95 * 100,
      p99: adv.p99 * 100,
      es95: adv.es95 * 100,
    },
    maxFavorableR: deepestBelow,
    ambiguousShare,
    note:
      "Reaches are levels above P_peak touched BEFORE the collapse level (a same-bar tie counts as collapse). " +
      "Adverse excursion is the worst move above P_break in units of R (against a breakdown short). " +
      "Ambiguous first-touch events are excluded from reaches and excursions.",
  };
}

/* -------------------------------------------------------------------------- *
 * Prepared dataset: everything the response builders need, computed once
 * -------------------------------------------------------------------------- */

export interface PreparedProbabilityDataset {
  params: ProbabilityParams;
  universe: ProbabilityResponse["universe"];
  failedSymbols: string[];
  klinesBySymbol: Map<string, Kline[]>;
  eventsBySymbol: Map<string, RawEvent[]>;
  context: ContextBars | null;
  /** Every event, chronological. */
  events: RawEvent[];
  /** Events with a breakdown (the Stage B pool), features measured at break. */
  stageBEvents: RawEvent[];
  stageBCounts: number[];
  stageBNEff: number;
  blockCount: number;
  stageA: StageAClass[];
  base: ProbabilityState["base"];
  timing: TimingAnalysis;
  downside: DownsideProfile;
  regime: RegimeBlockPoint[];
  health: HealthAnalysis;
  leakage: { rhoBreakMedian: number; rhoMin: number; rhoMax: number };
  accounting: EventAccounting;
  asOf: ProbabilityAsOf;
  warnings: string[];
}

function weightedTriple(
  weights: number[],
  pool: RawEvent[],
  baseCounts: number[]
): { triple: ProbabilityState["conditional"]; nEffRaw: number; totalW: number } {
  // Only rows with a resolved Stage B label contribute: unresolved episodes
  // are right-censored and must not dilute the class shares.
  let totalW = 0;
  let w2 = 0;
  for (let i = 0; i < pool.length; i++) {
    if (pool[i].outcome === null) continue;
    totalW += weights[i];
    w2 += weights[i] * weights[i];
  }
  const nEffRaw = totalW > 0 && w2 > 0 ? (totalW * totalW) / w2 : 0;
  const shares = [0, 0, 0];
  if (totalW > 0) {
    for (let i = 0; i < pool.length; i++) {
      const o = pool[i].outcome;
      if (o === null) continue;
      const c = o === -1 ? 0 : o === 1 ? 1 : 2;
      shares[c] += weights[i] / totalW;
    }
  }
  const eff = shares.map((s) => s * nEffRaw);
  const { triple } = posteriorTriple(eff, baseCounts, null);
  return { triple, nEffRaw, totalW };
}

/* -------------------------------------------------------------------------- *
 * Episode metadata and the symbol-level probability state
 * -------------------------------------------------------------------------- */

function episodeStatus(ev: RawEvent): EpisodeStatus {
  if (ev.stageA === "breakdown") {
    if (ev.outcome === null) return "post-breakdown";
    if (ev.outcome === -1) return "resolved-collapse";
    if (ev.outcome === 1) return "resolved-extension";
    return "resolved-consolidation";
  }
  return ev.windowOpen ? "awaiting-breakdown" : "expired";
}

function episodeMeta(prep: PreparedProbabilityDataset, symbol: string): EpisodeMeta | null {
  const events = prep.eventsBySymbol.get(symbol);
  if (!events || events.length === 0) return null;
  const ev = events[events.length - 1];
  const klines = prep.klinesBySymbol.get(symbol);
  const lastBarTime = klines && klines.length > 0 ? klines[klines.length - 1].time : ev.endTime;
  const status = episodeStatus(ev);
  const active = status === "post-breakdown" || status === "awaiting-breakdown";
  return {
    symbol,
    active,
    status,
    originTime: ev.t0,
    triggerTime: ev.trigTime,
    breakTime: ev.breakTime,
    peakTime: ev.peakTime,
    lastBarTime,
    barsSinceBreak:
      ev.sBreak === null ? 0 : (ev.sResolved ?? ev.sEnd) - ev.sBreak,
    horizonBars: ev.h,
    durationBars: ev.sEnd - ev.sTrig,
    surgeRangePct: ev.R * 100,
    rhoBreak: ev.rhoBreak,
  };
}

function fmtPct(v: number, digits = 1): string {
  if (!finite(v)) return "—";
  const s = (v * 100).toFixed(digits);
  return `${v >= 0 ? "+" : ""}${s}%`;
}

function describeFeatures(f: SurgeFeatures, ev: RawEvent): string[] {
  const out: string[] = [];
  out.push(
    `Surge of ${fmtPct(ev.R)} from the swing low over ${ev.D} bars; trigger fired on the robust z-score.`
  );
  if (finite(f.displacement)) {
    out.push(
      `Path from trigger to milestone covers ${fmtPct(f.displacement)} of the surge range.`
    );
  }
  if (finite(f.cvdCorr)) {
    const tag =
      f.cvdCorr > 0.35
        ? "price moved with aggressive taker flow"
        : f.cvdCorr < -0.35
          ? "price and taker flow diverged (spot-led)"
          : "no clear agreement between price and flow";
    out.push(`CVD vs price correlation over the window: ${f.cvdCorr.toFixed(2)} - ${tag}.`);
  }
  if (finite(f.vwapDistance)) {
    out.push(
      `Price sits ${fmtPct(f.vwapDistance)} of R ${f.vwapDistance >= 0 ? "above" : "below"} the surge VWAP.`
    );
  }
  if (finite(f.volumeDecay)) {
    const ratio = Math.exp(f.volumeDecay);
    out.push(
      `Volume in the second half of the window is ×${ratio.toFixed(2)} the first half.`
    );
  }
  if (finite(f.rhoBreak)) {
    out.push(`Breakdown pulled back ρ = ${f.rhoBreak.toFixed(2)} of the surge range.`);
  }
  if (finite(f.btcEpisodeReturn)) {
    out.push(
      `BTC moved ${fmtPct(f.btcEpisodeReturn)} over the same episode (context regime).`
    );
  }
  if (ev.preResolved) {
    out.push("First bar after t_break already crossed the collapse level (noisy label).");
  }
  return out;
}

function featureRows(f: SurgeFeatures, ev: RawEvent): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  rows.push({ label: "Surge range R", value: fmtPct(ev.R, 2) });
  rows.push({ label: "Horizon h", value: `${ev.h} bars` });
  if (finite(f.cvdCorr)) rows.push({ label: "CVD corr", value: f.cvdCorr.toFixed(2) });
  if (finite(f.displacement))
    rows.push({ label: "Displacement", value: fmtPct(f.displacement, 0) });
  if (finite(f.vwapDistance))
    rows.push({ label: "VWAP distance", value: fmtPct(f.vwapDistance, 1) });
  if (finite(f.volumeDecay))
    rows.push({ label: "Volume trend", value: `×${Math.exp(f.volumeDecay).toFixed(2)}` });
  if (finite(f.rhoBreak)) rows.push({ label: "Pullback ρ", value: f.rhoBreak.toFixed(2) });
  if (finite(f.btcEpisodeReturn))
    rows.push({ label: "BTC episode", value: fmtPct(f.btcEpisodeReturn, 1) });
  if (finite(f.barsPeakToBreak))
    rows.push({ label: "Peak→break", value: `${f.barsPeakToBreak} bars` });
  return rows;
}

function conditioningText(
  prep: PreparedProbabilityDataset,
  symbol: string,
  ev: RawEvent,
  phase: "post" | "await"
): string {
  const p = prep.params;
  if (phase === "post") {
    const since = (ev.sResolved ?? ev.sEnd) - (ev.sBreak as number);
    return (
      `Post-breakdown for ${symbol}: bar ${since} of h=${ev.h} after t_break ` +
      `(collapse = close ≤ P_break − ${(p.deltaC * 100).toFixed(0)}%·R, ` +
      `extension = high ≥ P_peak + ${(p.deltaE * 100).toFixed(0)}%·R, ` +
      `otherwise consolidation at the horizon end).`
    );
  }
  return (
    `Surge triggered for ${symbol}; breakdown window still open ` +
    `(next ${BREAKDOWN_WINDOW_MULT * p.L} bars, β=${p.beta}). No breakdown yet, ` +
    `so the pooled base rate is the honest headline.`
  );
}

function buildState(
  prep: PreparedProbabilityDataset,
  symbol: string
): ProbabilityState {
  const params = prep.params;
  const events = prep.eventsBySymbol.get(symbol) ?? [];
  const episode = episodeMeta(prep, symbol);

  // Latest open episode: unresolved breakdown, or a trigger window still open.
  let active: RawEvent | null = null;
  let phase: "post" | "await" = "post";
  for (const ev of events) {
    const openPost = ev.stageA === "breakdown" && ev.outcome === null;
    const openAwait = ev.stageA !== "breakdown" && ev.windowOpen;
    if (openPost || openAwait) {
      if (!active || ev.trigTime > active.trigTime) {
        active = ev;
        phase = openPost ? "post" : "await";
      }
    }
  }

  const baseTriple = prep.base;
  const poolAll = prep.stageBEvents;
  const poolN = poolAll.length;
  const floorNEff = Math.max(N_EFF_FLOOR_MIN, Math.floor(N_EFF_FLOOR_SHARE * poolN));
  const flags: string[] = [];

  if (!active) {
    return {
      description: [
        `No open surge episode for ${symbol}: nothing is currently conditioning a conditional view.`,
        `Pooled base rate across ${poolN} post-breakdown events is shown; it updates as new surges resolve.`,
      ],
      featureValues: [{ label: "Post-breakdown events", value: `${poolN}` }],
      conditioning: `No open episode for ${symbol}.`,
      gate: "FALLBACK",
      flags: ["No active episode - base rate only"],
      nAnalog: poolN,
      nEff: 0,
      recentWeightShare: 0,
      conditional: baseTriple,
      base: baseTriple,
      episode,
    };
  }

  const milestone = phase === "post" ? (active.sBreak as number) : active.sTrig;
  const current = pickKernel(featuresAt(active, milestone, prep.context));

  const pool: RawEvent[] = [];
  const poolVecs: number[][] = [];
  const poolBlocks: number[] = [];
  for (const a of poolAll) {
    if (a === active) continue;
    const idx = phase === "post" ? (a.sBreak as number) : a.sTrig;
    const vec = pickKernel(featuresAt(a, idx, prep.context));
    if (vec.some((v) => !finite(v))) continue;
    pool.push(a);
    poolVecs.push(vec);
    poolBlocks.push(a.block);
  }

  const stats = buildFeatureStats(poolVecs);
  const q = kernelQuery(current, poolVecs, stats);
  const nEff = clusteredNEff(q.nEffRaw, q.weights, poolBlocks, prep.blockCount);
  const { triple } = weightedTriple(q.weights, pool, prep.stageBCounts);

  const reasons: string[] = [];
  if (nEff < floorNEff) reasons.push(`nEff ${nEff.toFixed(1)} < floor ${floorNEff}`);
  if (q.oodDims >= 2)
    reasons.push(`out-of-distribution on ${q.oodKeys.join(", ")}`);
  if (q.usedDims < 3) reasons.push(`only ${q.usedDims} usable features`);
  const passed = reasons.length === 0;
  if (!passed) flags.push(...reasons.map((r) => `Gate: ${r}`));
  if (active.preResolved) flags.push("Breakdown resolved in its first bar (label noise)");
  if (q.recentWeightShare > 0.7) flags.push("Analogs concentrated in the most recent 20% of events");
  const ciWidth = triple.consolidation.ci80[1] - triple.consolidation.ci80[0];
  if (passed && ciWidth > 0.4) flags.push("Wide credible interval - prior-dominated");

  const f = featuresAt(active, milestone, prep.context);
  const state: ProbabilityState = {
    description: describeFeatures(f, active),
    featureValues: featureRows(f, active),
    conditioning: conditioningText(prep, symbol, active, phase),
    gate: passed ? "PASSED" : "FALLBACK",
    flags,
    nAnalog: poolN,
    nEff,
    recentWeightShare: q.recentWeightShare,
    conditional: passed ? triple : baseTriple,
    base: baseTriple,
    episode,
  };
  if (!passed) state.blocked = triple;
  return state;
}

/* -------------------------------------------------------------------------- *
 * Probability over time within one episode (the "shift" view)
 * -------------------------------------------------------------------------- */

const SERIES_PHASES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

function buildEpisodeSeries(
  prep: PreparedProbabilityDataset,
  symbol: string,
  limit = 3
): EpisodeSeries[] {
  const events = prep.eventsBySymbol.get(symbol) ?? [];
  const episodes = events.filter((e) => e.stageA === "breakdown" && e.sBreak !== null);
  const chosen = episodes.slice(-limit);
  const klines = prep.klinesBySymbol.get(symbol);
  if (!klines || klines.length < 2 || chosen.length === 0) return [];
  const barMs = klines[1].time - klines[0].time;
  const poolAll = prep.stageBEvents;
  const floorNEff = Math.max(
    N_EFF_FLOOR_MIN,
    Math.floor(N_EFF_FLOOR_SHARE * Math.max(0, poolAll.length - 1))
  );
  const baseCounts = prep.stageBCounts;
  const out: EpisodeSeries[] = [];

  for (const ep of chosen) {
    const sB = ep.sBreak as number;
    const limitOff =
      ep.outcome === null ? ep.sEnd - sB : (ep.sResolved ?? ep.sEnd) - sB;
    const points: EpisodeSeriesPoint[] = [];

    for (const phase of SERIES_PHASES) {
      const off = Math.round(phase * ep.h);
      if (off > limitOff) break;
      const curIdx = clamp(sB + off, sB, ep.sEnd);
      const current = pickKernel(featuresAt(ep, curIdx, prep.context));

      const pool: RawEvent[] = [];
      const poolVecs: number[][] = [];
      const poolBlocks: number[] = [];
      for (const a of poolAll) {
        if (a === ep || a.sBreak === null) continue;
        const aOff = Math.round(phase * a.h);
        const aIdx = clamp(a.sBreak + aOff, a.sBreak, a.sEnd);
        const vec = pickKernel(featuresAt(a, aIdx, prep.context));
        if (vec.some((v) => !finite(v))) continue;
        pool.push(a);
        poolVecs.push(vec);
        poolBlocks.push(a.block);
      }
      const stats = buildFeatureStats(poolVecs);
      const q = kernelQuery(current, poolVecs, stats);
      const nEff = clusteredNEff(q.nEffRaw, q.weights, poolBlocks, prep.blockCount);
      const gated =
        nEff >= floorNEff && q.oodDims < 2 && q.usedDims >= 3 && pool.length > 0;

      let collapse = prep.base.collapse.p;
      let extension = prep.base.extension.p;
      let consolidation = prep.base.consolidation.p;
      if (gated) {
        const { triple } = weightedTriple(q.weights, pool, baseCounts);
        collapse = triple.collapse.p;
        extension = triple.extension.p;
        consolidation = triple.consolidation.p;
      }

      // Pullback depth from the running peak at this bar, fraction of range.
      let runMax = -Infinity;
      for (let i = 0; i <= curIdx; i++) runMax = Math.max(runMax, Math.log(ep.bars[i].high));
      const range = runMax - ep.p0;
      const rho =
        range > 1e-9 ? (runMax - Math.log(ep.bars[curIdx].close)) / range : 0;

      const t = (ep.breakTime as number) + off * barMs;
      points.push({
        t,
        iso: new Date(t).toISOString(),
        barsSinceBreak: off,
        phase,
        collapse,
        extension,
        consolidation,
        nEff,
        gated,
        rho,
      });
    }

    out.push({
      symbol,
      originTime: ep.t0,
      breakTime: ep.breakTime as number,
      horizonBars: ep.h,
      active: ep.outcome === null,
      resolvedLabel: ep.outcome,
      points,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 * Blocked out-of-fold skill (framework section 10)
 * -------------------------------------------------------------------------- */

interface OofRecord {
  y: number;
  pred: [number, number, number];
  clim: [number, number, number];
  t: number;
  brier: number;
  climBrier: number;
}

function tripleOf(
  shares: number[],
  nEff: number,
  baseCounts: number[]
): [number, number, number] {
  const { triple } = posteriorTriple(
    shares.map((s) => s * nEff),
    baseCounts,
    null
  );
  return [triple.collapse.p, triple.extension.p, triple.consolidation.p];
}

function priorOf(baseCounts: number[]): [number, number, number] {
  const m0 = empiricalBayesM0(baseCounts);
  const base = smoothedBase(baseCounts, m0);
  const s = base.reduce((a, b) => a + b, 0) || 1;
  return [base[0] / s, base[1] / s, base[2] / s];
}

function bssOf(records: OofRecord[]): number | null {
  let b = 0;
  let c = 0;
  for (const r of records) {
    b += r.brier;
    c += r.climBrier;
  }
  if (!(c > 0)) return null;
  return 1 - b / c;
}

/**
 * Five contiguous time folds. Each test event is predicted from a kernel
 * over every OTHER fold, gated exactly like the live view; when the gate
 * fails the prediction falls back to the training prior (the model is never
 * allowed to fail silently by peeking).
 */
function evaluateSkill(events: RawEvent[]): {
  bss: number | null;
  bssCi80: [number, number] | null;
  calibrationSlope: number | null;
  calibrationIntercept: number | null;
  oofEvents: number;
} {
  const pool = events
    .filter((e) => e.stageA === "breakdown" && e.outcome !== null && e.features !== null)
    .sort((a, b) => a.trigTime - b.trigTime);
  const empty = { bss: null, bssCi80: null, calibrationSlope: null, calibrationIntercept: null, oofEvents: 0 };
  if (pool.length < MIN_OOF_EVENTS) return empty;

  const n = pool.length;
  const foldSize = Math.ceil(n / 5);
  const records: OofRecord[] = [];

  for (let fold = 0; fold < 5; fold++) {
    const lo = fold * foldSize;
    const hi = Math.min(n, lo + foldSize);
    if (lo >= hi) continue;
    const test = pool.slice(lo, hi);
    const train = [...pool.slice(0, lo), ...pool.slice(hi)];
    const trainClassified = train.filter((e) => e.outcome !== null);
    if (trainClassified.length < 20) continue;

    const baseCounts = [0, 0, 0];
    for (const e of trainClassified)
      baseCounts[e.outcome === -1 ? 0 : e.outcome === 1 ? 1 : 2]++;
    const prior = priorOf(baseCounts);

    const trainVecs = train
      .filter((e) => e.features !== null)
      .map((e) => pickKernel(e.features as SurgeFeatures));
    const stats = buildFeatureStats(trainVecs);
    const floorNEff = Math.max(
      N_EFF_FLOOR_MIN,
      Math.floor(N_EFF_FLOOR_SHARE * trainClassified.length)
    );
    const trainBlocks = train.map((e) => e.block);
    const K = trainBlocks.length > 0 ? Math.max(...trainBlocks) + 1 : 1;

    for (const ev of test) {
      const current = pickKernel(ev.features as SurgeFeatures);
      const q = kernelQuery(current, trainVecs, stats);
      const nEff = clusteredNEff(q.nEffRaw, q.weights, trainBlocks, K);
      let pred: [number, number, number];
      const totalW = q.weights.reduce((s, w) => s + w, 0);
      if (nEff >= floorNEff && q.oodDims < 2 && q.usedDims >= 3 && totalW > 0) {
        pred = tripleOf(q.weights.map((w) => w / totalW), nEff, baseCounts);
      } else {
        pred = prior;
      }
      const yIdx = ev.outcome === -1 ? 0 : ev.outcome === 1 ? 1 : 2;
      const y = [0, 0, 0];
      y[yIdx] = 1;
      let brier = 0;
      let climBrier = 0;
      for (let c = 0; c < 3; c++) {
        brier += (pred[c] - y[c]) ** 2;
        climBrier += (prior[c] - y[c]) ** 2;
      }
      records.push({
        y: yIdx,
        pred,
        clim: prior,
        t: ev.trigTime,
        brier,
        climBrier,
      });
    }
  }

  if (records.length < MIN_OOF_EVENTS) return empty;
  const bss = bssOf(records);

  // Moving-block bootstrap over the chronologically ordered records.
  records.sort((a, b) => a.t - b.t);
  const rng = mulberry32(stringHash(`bss:${records.length}:${records[0].t}`));
  const blockLen = 5;
  const nBlocks = Math.ceil(records.length / blockLen);
  const samples: number[] = [];
  for (let d = 0; d < 400; d++) {
    const pick: OofRecord[] = [];
    for (let b = 0; b < nBlocks; b++) {
      const start = Math.floor(rng() * records.length);
      for (let j = 0; j < blockLen; j++) pick.push(records[(start + j) % records.length]);
    }
    const s = bssOf(pick);
    if (s !== null && Number.isFinite(s)) samples.push(s);
  }
  let bssCi80: [number, number] | null = null;
  if (samples.length >= 50) {
    const sorted = sortedCopy(samples);
    bssCi80 = [quantileFromSorted(sorted, 0.1), quantileFromSorted(sorted, 0.9)];
  }

  // Calibration of P(collapse), out of fold: observed on predicted.
  let slope: number | null = null;
  let intercept: number | null = null;
  if (records.length >= 10) {
    const ps = records.map((r) => r.pred[0]);
    const ys = records.map((r) => (r.y === 0 ? 1 : 0));
    const mp = mean(ps);
    const my = mean(ys);
    let varp = 0;
    let cov = 0;
    for (let i = 0; i < ps.length; i++) {
      varp += (ps[i] - mp) ** 2;
      cov += (ps[i] - mp) * (ys[i] - my);
    }
    if (varp > 1e-9) {
      slope = cov / varp;
      intercept = my - slope * mp;
    }
  }

  return { bss, bssCi80, calibrationSlope: slope, calibrationIntercept: intercept, oofEvents: records.length };
}

/* -------------------------------------------------------------------------- *
 * Parameter sensitivity (framework section 9)
 * -------------------------------------------------------------------------- */

function countStageB(
  klinesBySymbol: Map<string, Kline[]>,
  seriesBySymbol: Map<string, PreparedSeries>,
  cell: ProbabilityParams
): { counts: number[]; total: number; events: number } {
  const counts = [0, 0, 0];
  let total = 0;
  let events = 0;
  for (const [sym, kb] of klinesBySymbol) {
    const series = seriesBySymbol.get(sym);
    if (!series) continue;
    const res = detectAndLabel(sym, kb, series, cell);
    events += res.events.length;
    for (const ev of res.events) {
      if (ev.stageA !== "breakdown" || ev.outcome === null) continue;
      counts[ev.outcome === -1 ? 0 : ev.outcome === 1 ? 1 : 2]++;
      total++;
    }
  }
  return { counts, total, events };
}

function computeSensitivity(
  klinesBySymbol: Map<string, Kline[]>,
  seriesBySymbol: Map<string, PreparedSeries>,
  params: ProbabilityParams
): {
  cells: HealthAnalysis["sensitivity"];
  range: [number, number] | null;
  verdict: HealthAnalysis["sensitivityVerdict"];
} {
  const betas = [...new Set([...PROBABILITY_GRIDS.beta, params.beta])].sort((a, b) => a - b);
  const ms = [...new Set([...PROBABILITY_GRIDS.m, params.m])].sort((a, b) => a - b);
  const cells: HealthAnalysis["sensitivity"] = [];
  const collapseValues: number[] = [];
  let userCellN = 0;

  for (const beta of betas) {
    for (const m of ms) {
      const cellParams = { ...params, beta, m };
      const { counts, total } = countStageB(klinesBySymbol, seriesBySymbol, cellParams);
      const collapse = total > 0 ? counts[0] / total : 0;
      cells.push({ beta, m, collapse, n: total });
      if (total > 0) collapseValues.push(collapse);
      if (beta === params.beta && m === params.m) userCellN = total;
    }
  }

  // Delta variants at the user's (beta, m): threshold sensitivity too.
  const dCs = [...new Set([...PROBABILITY_GRIDS.deltaC, params.deltaC])];
  const dEs = [...new Set([...PROBABILITY_GRIDS.deltaE, params.deltaE])];
  for (const deltaC of dCs) {
    for (const deltaE of dEs) {
      if (deltaC === params.deltaC && deltaE === params.deltaE) continue;
      const { counts, total } = countStageB(klinesBySymbol, seriesBySymbol, {
        ...params,
        deltaC,
        deltaE,
      });
      if (total > 0) collapseValues.push(counts[0] / total);
    }
  }

  const range: [number, number] | null =
    collapseValues.length > 0
      ? [Math.min(...collapseValues), Math.max(...collapseValues)]
      : null;
  const verdict: HealthAnalysis["sensitivityVerdict"] =
    userCellN < MIN_OOF_EVENTS
      ? "INSUFFICIENT"
      : range === null
        ? "INSUFFICIENT"
        : range[1] - range[0] <= 0.1
          ? "STABLE"
          : range[1] - range[0] <= 0.2
            ? "MODERATE"
            : "FRAGILE";
  return { cells, range, verdict };
}

/* -------------------------------------------------------------------------- *
 * Regime drift: shrunk P(collapse | breakdown) per time block
 * -------------------------------------------------------------------------- */

function buildRegime(
  events: RawEvent[],
  stageBCounts: number[],
  stageBNEff: number,
  totalClassified: number,
  base: ProbabilityState["base"],
  blockCount: number
): RegimeBlockPoint[] {
  const out: RegimeBlockPoint[] = [];
  for (let b = 0; b < blockCount; b++) {
    const inBlock = events.filter((e) => e.block === b);
    if (inBlock.length === 0) continue;
    const times = inBlock.map((e) => e.trigTime);
    const tMin = Math.min(...times);
    const tMax = Math.max(...times);
    const t = Math.round((tMin + tMax) / 2);
    const cls = inBlock.filter((e) => e.stageA === "breakdown" && e.outcome !== null);
    const counts = [0, 0, 0];
    for (const e of cls) counts[e.outcome === -1 ? 0 : e.outcome === 1 ? 1 : 2]++;
    const n = cls.length;
    let p = base.collapse.p;
    let ci80 = base.collapse.ci80;
    let nEff = 0;
    if (n > 0 && totalClassified > 0) {
      nEff = stageBNEff * (n / totalClassified);
      const eff = counts.map((c) => (c / n) * nEff);
      const { triple } = posteriorTriple(eff, stageBCounts, null);
      p = triple.collapse.p;
      ci80 = triple.collapse.ci80;
    }
    out.push({
      t,
      iso: new Date(t).toISOString(),
      label: `${new Date(tMin).toISOString().slice(0, 10)} → ${new Date(tMax).toISOString().slice(0, 10)}`,
      collapse: p,
      ci80,
      n,
      nEff,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 * Entry points
 * -------------------------------------------------------------------------- */

/**
 * One pass over the universe: detection, labels, features, posteriors,
 * timing, downside, regime drift, skill and sensitivity. Heavy - callers
 * should cache the result per parameter set.
 */
export function prepareProbabilityDataset(
  klinesBySymbol: Map<string, Kline[]>,
  failedSymbols: string[],
  contextKlines: Kline[] | null,
  params: ProbabilityParams
): PreparedProbabilityDataset {
  const seriesBySymbol = new Map<string, PreparedSeries>();
  for (const [sym, kb] of klinesBySymbol) {
    seriesBySymbol.set(sym, prepareSeries(kb, params.L));
  }

  const allEvents: RawEvent[] = [];
  const eventsBySymbol = new Map<string, RawEvent[]>();
  let triggers = 0;
  let deduped = 0;
  let coverageExcluded = 0;
  for (const [sym, kb] of klinesBySymbol) {
    const res = detectAndLabel(sym, kb, seriesBySymbol.get(sym) as PreparedSeries, params);
    triggers += res.triggers;
    deduped += res.deduped;
    coverageExcluded += res.coverageExcluded;
    const sorted = res.events.sort((a, b) => a.trigTime - b.trigTime);
    eventsBySymbol.set(sym, sorted);
    allEvents.push(...sorted);
  }
  allEvents.sort((a, b) => a.trigTime - b.trigTime);

  // Equal-count time blocks, chronological (clustering + regime drift).
  const n = allEvents.length;
  const blockCount =
    n === 0
      ? 0
      : Math.max(n >= 10 ? 2 : 1, Math.min(MAX_TIME_BLOCKS, Math.floor(n / 5)));
  allEvents.forEach((ev, i) => {
    ev.block = blockCount > 0 ? Math.min(blockCount - 1, Math.floor((i * blockCount) / n)) : 0;
  });

  const context: ContextBars | null =
    contextKlines && contextKlines.length > 1
      ? { klines: contextKlines, barMs: contextKlines[1].time - contextKlines[0].time }
      : null;
  for (const ev of allEvents) {
    if (ev.stageA === "breakdown" && ev.sBreak !== null) {
      ev.features = featuresAt(ev, ev.sBreak, context);
    }
  }

  const stageA = stageAClasses(allEvents, (ev) => ev.block);

  const stageB = allEvents.filter((e) => e.stageA === "breakdown");
  const classified = stageB.filter((e) => e.outcome !== null);
  const stageBCounts = [0, 0, 0];
  for (const e of classified)
    stageBCounts[e.outcome === -1 ? 0 : e.outcome === 1 ? 1 : 2]++;
  const blocksC = classified.map((e) => e.block);
  const deff = Math.max(
    designEffect(classified.map((e) => (e.outcome === -1 ? 1 : 0)), blocksC),
    designEffect(classified.map((e) => (e.outcome === 1 ? 1 : 0)), blocksC)
  );
  const stageBNEff = classified.length / deff;
  const totalClassified = classified.length;
  const base = posteriorTriple(
    stageBCounts.map((c) => (totalClassified > 0 ? (c / totalClassified) * stageBNEff : 0)),
    stageBCounts,
    stageBCounts
  ).triple;

  const timing = computeTiming(allEvents);
  const downside = computeDownside(allEvents, params.deltaC);
  const regime = buildRegime(
    allEvents,
    stageBCounts,
    stageBNEff,
    totalClassified,
    base,
    blockCount
  );

  const skill = evaluateSkill(stageB);
  const sens = computeSensitivity(klinesBySymbol, seriesBySymbol, params);
  const health: HealthAnalysis = {
    bss: skill.bss,
    bssCi80: skill.bssCi80,
    calibrationSlope: skill.calibrationSlope,
    calibrationIntercept: skill.calibrationIntercept,
    oofEvents: skill.oofEvents,
    sensitivity: sens.cells,
    sensitivityRange: sens.range,
    sensitivityVerdict: sens.verdict,
  };

  const rhos = stageB.map((e) => e.rhoBreak).filter(finite);
  const leakage = rhos.length > 0
    ? { rhoBreakMedian: median(rhos), rhoMin: Math.min(...rhos), rhoMax: Math.max(...rhos) }
    : { rhoBreakMedian: 0, rhoMin: 0, rhoMax: 0 };

  const secondLegOnly = allEvents.filter((e) => e.stageA === "secondLeg").length;
  const neither = allEvents.filter((e) => e.stageA === "neither").length;
  const ambiguous = stageB.filter((e) => e.ambiguous).length;
  const preResolved = stageB.filter((e) => e.preResolved).length;
  const attempted = n + coverageExcluded;
  const accounting: EventAccounting = {
    symbolsScanned: klinesBySymbol.size,
    symbolsFailed: failedSymbols.length,
    failedSymbols,
    triggers,
    deduped,
    events: n,
    withBreakdown: stageB.length,
    secondLegOnly,
    neither,
    ambiguous,
    ambiguousShare: stageB.length > 0 ? ambiguous / stageB.length : 0,
    preResolved,
    preResolvedShare: stageB.length > 0 ? preResolved / stageB.length : 0,
    excludedCoverage: coverageExcluded,
    excludedShare: attempted > 0 ? coverageExcluded / attempted : 0,
  };

  let windowStart = Infinity;
  let windowEnd = -Infinity;
  let totalBars = 0;
  for (const [, kb] of klinesBySymbol) {
    if (kb.length === 0) continue;
    windowStart = Math.min(windowStart, kb[0].time);
    windowEnd = Math.max(windowEnd, kb[kb.length - 1].time);
    totalBars += kb.length;
  }
  if (!finite(windowStart)) {
    windowStart = 0;
    windowEnd = 0;
  }
  const asOf: ProbabilityAsOf = {
    timestamp: windowEnd + TERMINAL_INTERVAL_MS[params.interval],
    iso: new Date(windowEnd + TERMINAL_INTERVAL_MS[params.interval]).toISOString(),
    serverTime: Date.now(),
    barCount: totalBars,
  };

  const warnings: string[] = [];
  if (n === 0)
    warnings.push(
      "No surge events in this window: widen the lookback, raise the universe, or lower k."
    );
  else if (stageB.length < MIN_OOF_EVENTS)
    warnings.push(
      `Only ${stageB.length} post-breakdown events (need ${MIN_OOF_EVENTS}): analog estimates are prior-dominated.`
    );
  if (failedSymbols.length > 0)
    warnings.push(
      `No kline data for ${failedSymbols.length} symbol(s): ${failedSymbols.slice(0, 5).join(", ")}${failedSymbols.length > 5 ? ", …" : ""}.`
    );
  if (accounting.excludedShare > 0.2)
    warnings.push(
      `${(accounting.excludedShare * 100).toFixed(0)}% of candidate events excluded for kline gaps.`
    );
  if (sens.verdict === "FRAGILE")
    warnings.push(
      "P(collapse) moves by more than 20 points across beta/delta/m: the point estimate is regime-dependent."
    );
  if (skill.bss !== null) {
    const spansZero =
      skill.bssCi80 !== null && skill.bssCi80[0] <= 0 && skill.bssCi80[1] >= 0;
    if (skill.bss <= 0 || spansZero)
      warnings.push(
        "Out-of-fold Brier skill is not distinguishable from zero: analog features add no proven skill over base rates in this window."
      );
  }
  if (context === null)
    warnings.push(
      "BTC context series unavailable: regime features (BTC episode return, volume percentile) are dropped."
    );

  return {
    params,
    universe: {
      requested: params.universeSize,
      symbols: [...klinesBySymbol.keys()],
      windowStart,
      windowEnd,
      totalBars,
    },
    failedSymbols,
    klinesBySymbol,
    eventsBySymbol,
    context,
    events: allEvents,
    stageBEvents: stageB,
    stageBCounts,
    stageBNEff,
    blockCount,
    stageA,
    base,
    timing,
    downside,
    regime,
    health,
    leakage,
    accounting,
    asOf,
    warnings,
  };
}

/* -------------------------------------------------------------------------- *
 * Response envelopes
 * -------------------------------------------------------------------------- */

export function buildProbabilityResponse(
  prep: PreparedProbabilityDataset,
  symbol: string
): ProbabilityResponse {
  return {
    params: prep.params,
    universe: prep.universe,
    stageA: prep.stageA,
    stageB: buildState(prep, symbol),
    timing: prep.timing,
    downside: prep.downside,
    history: {
      regime: prep.regime,
      episodes: buildEpisodeSeries(prep, symbol),
    },
    health: prep.health,
    diagnostics: {
      accounting: prep.accounting,
      leakage: prep.leakage,
      features: {
        positioning: {
          available: false,
          note: "Open interest, funding and basis excluded: Binance serves 30 days of OI history, far shorter than the event window, so the group is reported unavailable rather than approximated.",
        },
        orderFlow: {
          available: true,
          note: "CVD from kline field 9 (taker buy volume); agreement is the CVD/price correlation over the episode window.",
        },
        structure: {
          available: true,
          note: "OHLCV candles: swing-low origin, robust range R, VWAP distance, wick share, lower-high after the break.",
        },
        context: {
          available: prep.context !== null,
          note: "BTCUSDT episode return and volume percentile as the market-regime anchor.",
        },
      },
      caveats: BASE_CAVEATS,
    },
    asOf: prep.asOf,
    warnings: prep.warnings,
  };
}

export function buildProbabilityBrief(
  prep: PreparedProbabilityDataset,
  symbol: string
): ProbabilityBrief {
  return {
    symbol,
    params: prep.params,
    stageA: prep.stageA,
    state: buildState(prep, symbol),
    asOf: prep.asOf,
    warnings: prep.warnings,
  };
}




