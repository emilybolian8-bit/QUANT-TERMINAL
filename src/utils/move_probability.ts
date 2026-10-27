/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Kline,
  MoveBarrierStat,
  MoveProbabilityBody,
  MoveTripleStat,
  TimingAnalysis,
} from "../types";

const Z80 = 1.2815515655446004;
const Z95 = 1.959963984540054;

/** Windows below this are reported as insufficient history, not as a number. */
export const MIN_MOVE_WINDOWS = 40;

/** Trailing window, in bars, behind the volatility-regime conditioning. */
const VOL_WINDOW = 24;

/** Design-effect search depth in bars; dependence cannot outlive the horizon. */
const MAX_LAG_SEARCH = 240;

/** Touch-free windows required before any interval is reported. */
const MIN_SERIES_FOR_DEFF = 60;

/**
 * Wilson score interval. Used with the dependence-adjusted count rather than
 * the raw one, so overlapping windows widen the interval instead of
 * pretending every bar is an independent experiment.
 */
export function wilson(k: number, n: number, z: number): [number, number] {
  if (!(n > 0)) return [0, 1];
  const p = Math.min(1, Math.max(0, k / n));
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half =
    (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

function stat(count: number, n: number, nEff: number): MoveBarrierStat {
  return {
    count,
    p: n > 0 ? count / n : 0,
    ci80: wilson(count, nEff, Z80),
    ci95: wilson(count, nEff, Z95),
  };
}

/**
 * Design effect from the autocorrelation of a 0/1 series: deff = 1 + 2*sum(rho)
 * over the lags where the correlation stays positive, which is the standard
 * variance inflation for a positively dependent Bernoulli sequence. Barriers
 * touched in adjacent windows are exactly that, so this is what turns "4300
 * overlapping windows" into the honest effective sample size.
 */
function designEffect(x: number[], maxLag: number): number {
  const n = x.length;
  if (n < MIN_SERIES_FOR_DEFF) return 1;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  const variance = mean * (1 - mean);
  if (variance <= 0) return 1;
  let deff = 1;
  let stale = 0;
  const depth = Math.min(maxLag, n - 2);
  for (let lag = 1; lag <= depth; lag++) {
    let cov = 0;
    for (let i = 0; i + lag < n; i++) cov += (x[i] - mean) * (x[i + lag] - mean);
    cov /= n;
    const rho = cov / variance;
    if (rho > 0) {
      stale = 0;
      deff += 2 * rho;
    } else {
      stale += 1;
      if (stale >= 3) break;
    }
  }
  return Math.max(1, Math.min(deff, n / 5));
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function trailingVol(logReturns: number[], i: number, window: number): number {
  let s = 0;
  let s2 = 0;
  let c = 0;
  for (let j = i - window + 1; j <= i; j++) {
    const v = logReturns[j];
    if (!Number.isFinite(v)) continue;
    s += v;
    s2 += v * v;
    c += 1;
  }
  if (c < 2) return NaN;
  const m = s / c;
  return Math.sqrt(Math.max(0, s2 / c - m * m));
}

/**
 * Every historical bar in the sample is treated as a starting point, so the
 * answer is an unconditional frequency: "of the last N windows, X% traded
 * through the barrier". No trigger, no conditioning on a surge - the estimate
 * simply moves as the window, the price and the trailing regime move.
 *
 * Barriers are touched on the high/low basis (price traded there) and also
 * reported on a close basis (price settled beyond it), because the two answer
 * different questions and the gap between them is the wick.
 */
export function computeMoveProbability(
  klines: Kline[],
  opts: { thresholdPct: number; horizonBars: number }
): MoveProbabilityBody | null {
  const H = Math.max(1, Math.round(opts.horizonBars));
  const threshold = opts.thresholdPct / 100;
  const n = klines.length;
  const nWin = n - H;
  if (nWin < MIN_MOVE_WINDOWS) return null;

  const upTouch = new Array<number>(nWin).fill(0);
  const downTouch = new Array<number>(nWin).fill(0);
  const eitherTouch = new Array<number>(nWin).fill(0);
  const upClose = new Array<number>(nWin).fill(0);
  const downClose = new Array<number>(nWin).fill(0);
  const eitherClose = new Array<number>(nWin).fill(0);

  const cause = new Array<number>(nWin).fill(0);
  const eventBar = new Array<number>(nWin).fill(H);
  let firstUp = 0;
  let firstDown = 0;
  let ambiguous = 0;
  const forwards: number[] = [];

  for (let i = 0; i < nWin; i++) {
    const base = klines[i].close;
    const upBar = base * (1 + threshold);
    const downBar = base * (1 - threshold);

    let upT = -1;
    let downT = -1;
    let cu = -1;
    let cd = -1;
    for (let j = 1; j <= H; j++) {
      const bar = klines[i + j];
      if (upT < 0 && bar.high >= upBar) upT = j;
      if (downT < 0 && bar.low <= downBar) downT = j;
      if (cu < 0 && bar.close >= upBar) cu = j;
      if (cd < 0 && bar.close <= downBar) cd = j;
      if (upT > 0 && downT > 0 && cu > 0 && cd > 0) break;
    }

    const uT = upT > 0 ? 1 : 0;
    const dT = downT > 0 ? 1 : 0;
    upTouch[i] = uT;
    downTouch[i] = dT;
    eitherTouch[i] = uT || dT ? 1 : 0;
    upClose[i] = cu > 0 ? 1 : 0;
    downClose[i] = cd > 0 ? 1 : 0;
    eitherClose[i] = cu > 0 || cd > 0 ? 1 : 0;

    if (uT && dT && upT === downT) {
      ambiguous += 1;
      cause[i] = 0;
      eventBar[i] = upT;
    } else if (uT && (!dT || upT < downT)) {
      firstUp += 1;
      cause[i] = 1;
      eventBar[i] = upT;
    } else if (dT) {
      firstDown += 1;
      cause[i] = -1;
      eventBar[i] = downT;
    }

    forwards.push(klines[i + H].close / base - 1);
  }

  const deff = designEffect(eitherTouch, Math.min(H * 2, MAX_LAG_SEARCH));
  const nEff = Math.max(1, nWin / deff);

  const sortedForwards = [...forwards].sort((a, b) => a - b);
  const mean = forwards.reduce((a, b) => a + b, 0) / forwards.length;
  let positives = 0;
  for (const r of forwards) if (r > 0) positives += 1;

  const upAt = new Array<number>(H + 1).fill(0);
  const downAt = new Array<number>(H + 1).fill(0);
  for (let i = 0; i < nWin; i++) {
    if (cause[i] === 1) upAt[eventBar[i]] += 1;
    else if (cause[i] === -1) downAt[eventBar[i]] += 1;
  }

  const fUp = new Array<number>(H + 1).fill(0);
  const fDown = new Array<number>(H + 1).fill(0);
  let atRisk = nWin;
  let survival = 1;
  for (let t = 1; t <= H; t++) {
    const dU = upAt[t];
    const dD = downAt[t];
    if (atRisk > 0) {
      fUp[t] = fUp[t - 1] + (survival * dU) / atRisk;
      fDown[t] = fDown[t - 1] + (survival * dD) / atRisk;
      survival *= 1 - (dU + dD) / atRisk;
    } else {
      fUp[t] = fUp[t - 1];
      fDown[t] = fDown[t - 1];
    }
    atRisk -= dU + dD;
  }

  let medianUp: number | null = null;
  let medianDown: number | null = null;
  for (let t = 1; t <= H; t++) {
    if (medianUp === null && fUp[t] >= 0.5) medianUp = t;
    if (medianDown === null && fDown[t] >= 0.5) medianDown = t;
  }

  const fracs = [0, 0.25, 0.5, 0.75, 1];
  const timing: TimingAnalysis = {
    horizonBars: H,
    medianCollapseBars: medianDown,
    points: fracs.map((frac) => {
      const bars = Math.min(H, Math.round(frac * H));
      return { frac, bars, collapse: fDown[bars], extension: fUp[bars] };
    }),
  };

  const logReturns = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) logReturns[i] = Math.log(klines[i].close / klines[i - 1].close);

  const volAt: number[] = [];
  const volValues: number[] = [];
  for (let i = VOL_WINDOW; i < nWin; i++) {
    const v = trailingVol(logReturns, i, VOL_WINDOW);
    volAt[i] = v;
    if (Number.isFinite(v)) volValues.push(v);
  }
  volValues.sort((a, b) => a - b);
  const cutLow = quantile(volValues, 1 / 3);
  const cutHigh = quantile(volValues, 2 / 3);
  const sliceLabels = [
    "Low vol (bottom tercile)",
    "Mid vol (middle tercile)",
    "High vol (top tercile)",
  ];
  const sliceN = [0, 0, 0];
  const sliceUp = [0, 0, 0];
  const sliceDown = [0, 0, 0];
  const sliceOf = (v: number) => (v <= cutLow ? 0 : v <= cutHigh ? 1 : 2);

  for (let i = 0; i < nWin; i++) {
    const v = volAt[i];
    if (!Number.isFinite(v)) continue;
    const s = sliceOf(v);
    sliceN[s] += 1;
    sliceUp[s] += upTouch[i];
    sliceDown[s] += downTouch[i];
  }

  const currentVol = trailingVol(logReturns, n - 1, VOL_WINDOW);
  let currentRegime = -1;
  let currentVolPct = 0;
  if (Number.isFinite(currentVol) && volValues.length > 0) {
    currentRegime = sliceOf(currentVol);
    let below = 0;
    for (const v of volValues) if (v <= currentVol) below += 1;
    currentVolPct = (below / volValues.length) * 100;
  }

  const regimes = sliceLabels.map((label, idx) => ({
    label,
    n: sliceN[idx],
    up: stat(sliceUp[idx], sliceN[idx], Math.max(1, sliceN[idx] / deff)),
    down: stat(sliceDown[idx], sliceN[idx], Math.max(1, sliceN[idx] / deff)),
    current: idx === currentRegime,
  }));

  const triple = (
    up: number[],
    down: number[],
    either: number[]
  ): MoveTripleStat => ({
    up: stat(up.reduce((a, b) => a + b, 0), nWin, nEff),
    down: stat(down.reduce((a, b) => a + b, 0), nWin, nEff),
    either: stat(either.reduce((a, b) => a + b, 0), nWin, nEff),
  });

  return {
    nWindows: nWin,
    nEff: Math.round(nEff * 10) / 10,
    designEffect: Math.round(deff * 100) / 100,
    everTouch: triple(upTouch, downTouch, eitherTouch),
    everClose: triple(upClose, downClose, eitherClose),
    firstTouch: {
      up: stat(firstUp, nWin, nEff),
      down: stat(firstDown, nWin, nEff),
      ambiguous,
      ambiguousShare: nWin > 0 ? ambiguous / nWin : 0,
    },
    forward: {
      p05: quantile(sortedForwards, 0.05),
      p25: quantile(sortedForwards, 0.25),
      p50: quantile(sortedForwards, 0.5),
      p75: quantile(sortedForwards, 0.75),
      p95: quantile(sortedForwards, 0.95),
      mean,
      pPositive: forwards.length > 0 ? positives / forwards.length : 0,
    },
    timing,
    medianUpBars: medianUp,
    medianDownBars: medianDown,
    regimes,
    currentRegime,
    currentVolPct: Math.round(currentVolPct),
  };
}
