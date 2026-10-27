/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AsymmetrySegment,
  BetaAsymmetry,
  CorrelationStability,
  CrossCorrelationSpectrum,
  HourOfDayStat,
  Interval,
  Kline,
  LagPoint,
  ResidualAnalysis,
  ResidualPoint,
  RollingCoupling,
  RollingMetricStats,
  SessionAnalysis,
  SessionStat,
  StabilityBucket,
  TerminalBar,
  TimeBlockCorrelation,
  VolatilityRegime,
  VolatilityStats,
  VolRegimeSpan,
  ZScoreMode,
} from "../types";
import {
  calculateLinearRegression,
  calculateMean,
  calculatePearsonCorrelation,
  calculateStdDev,
  computeZScores,
} from "./quant_calculations";

/** Candle duration in ms, per supported interval. */
export const TERMINAL_INTERVAL_MS: Record<Interval, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

/** Bars per year, used to annualize realized volatility. */
export const PERIODS_PER_YEAR: Record<Interval, number> = {
  "15m": 35040,
  "1h": 8760,
  "4h": 2190,
  "1d": 365,
};

/** How far back each interval may be requested. Binance caps a kline request too. */
export const MAX_LOOKBACK_DAYS: Record<Interval, number> = {
  "15m": 45,
  "1h": 45,
  "4h": 180,
  "1d": 365,
};

/**
 * Rolling-correlation window defaults. The scanner, terminal and dashboard all
 * read these, so one pair opens with the same window everywhere: a week of
 * hourly bars (168 x 1h, 96 x 15m) is long enough that the estimate is not
 * dominated by a handful of bars and short enough that "stability" still
 * reacts inside a 45-day window.
 */
export function defaultRollingWindow(interval: Interval): number {
  switch (interval) {
    case "15m":
      return 96;
    case "1h":
      return 168;
    case "4h":
      return 30;
    case "1d":
      return 20;
  }
}

/**
 * Default lookback in days, per interval. 45 days on both dashboard frames is
 * also the server-side cap for 15m/1h, so the default is the longest sample
 * the endpoint will serve and no request is silently narrowed.
 */
export function defaultLookbackDays(interval: Interval): number {
  switch (interval) {
    case "15m":
    case "1h":
      return 45;
    case "4h":
      return 120;
    case "1d":
      return 180;
  }
}

/** Minimum overlap needed before any terminal statistic is reported at all. */
export const MIN_TERMINAL_BARS = 12;

const BPS = 10_000;

/**
 * Trading sessions as fixed UTC windows. They deliberately do NOT follow DST:
 * a session boundary that shifts twice a year would make the same bar land in
 * a different session across the sample and silently corrupt the split. The
 * trade-off is stated in the UI, alongside the hour-of-day profile which has
 * no boundary assumption at all.
 */
export const TRADING_SESSIONS = [
  { id: "asia", label: "ASIA", startHour: 0, endHour: 8, window: "00:00-08:00 UTC" },
  { id: "europe", label: "EUROPE", startHour: 8, endHour: 13, window: "08:00-13:00 UTC" },
  { id: "us", label: "US", startHour: 13, endHour: 21, window: "13:00-21:00 UTC" },
  { id: "late", label: "LATE", startHour: 21, endHour: 24, window: "21:00-24:00 UTC" },
] as const;

export const SESSION_BOUNDARY_NOTE =
  "Sessions are fixed UTC windows and ignore daylight-saving shifts. The hour-of-day profile below uses no session boundary at all, so cross-check it when a seasonal DST change lands mid-sample. Projected annual figures linearly scale one window's mean return by bars per year; they are arithmetic projections, not forecasts.";

/**
 * Longest chart series shipped to the client, per interval. Chart series are
 * shipped one point per bar so a zoomed reader sees every 15m/1h observation
 * rather than every Nth bar (stride-thinning a 45-day 1h window made adjacent
 * points ~2h apart and hid the per-bar z-score). The scalar statistics are
 * always computed on the full sample; only the drawn series is trimmed from the
 * left to the most recent window below, which also keeps the payload small.
 */
const MAX_CHART_BARS: Record<Interval, number> = {
  "15m": 672, // ~1 week of 15m bars
  "1h": 336, // ~2 weeks of 1h bars
  "4h": 360, // ~2 months of 4h bars
  "1d": 180, // ~6 months of daily bars
};

/**
 * Keeps one point per bar, returning the most recent at most `maxPoints`
 * observations so the chart ends on the latest real bar instead of a thinned
 * sample. A non-positive `maxPoints` is treated as "no cap".
 */
export function recentWindow<T>(items: T[], maxPoints: number): T[] {
  if (maxPoints <= 0 || items.length <= maxPoints) return items;
  return items.slice(items.length - maxPoints);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Inverse standard normal CDF (Acklam's rational approximation, accurate to
 * about 1e-9). Needed to turn the family-wise significance level into a z-score
 * for the lead/lag test, which a table of hardcoded z-values cannot cover.
 */
export function inverseNormalCdf(p: number): number {
  if (p <= 0 || p >= 1) throw new Error(`inverseNormalCdf domain error: p=${p}`);
  if (p === 0.5) return 0;

  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269,
    -30.66479806614716, 2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      ((((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)) as number
    );
  }

  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }

  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

/**
 * Percentile rank of `value` within `sample`, as 0-100. Ties are counted as
 * "at or below" so a value equal to the sample median cannot report as a
 * percentile flip depending on sort stability.
 */
export function percentileRank(sample: number[], value: number): number {
  if (sample.length === 0) return 50;
  let below = 0;
  for (const v of sample) {
    if (v < value) below += 1;
  }
  return (below / sample.length) * 100;
}

/** Linear-interpolated quantile of a pre-sorted ascending array. */
function quantileOfSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  return quantileOfSorted([...values].sort((a, b) => a - b), 0.5);
}

/**
 * Lag-1 autocorrelation of a series. Lead/lag coefficients come from
 * OVERLAPPING return pairs, so the raw sample size badly overstates how much
 * independent information is in them.
 */
function lag1Autocorrelation(values: number[]): number {
  const n = values.length;
  if (n < 4) return 0;
  const mean = calculateMean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    const d = values[i] - mean;
    den += d * d;
    if (i > 0) num += d * (values[i - 1] - mean);
  }
  return den === 0 ? 0 : clamp(num / den, -0.99, 0.99);
}

/**
 * Overlap-corrected sample size for the correlation between two series, via
 * Quenouille's adjustment n' = n(1 - rho1_a*rho1_b)/(1 + rho1_a*rho1_b).
 * Without it a 0.20 coefficient on 4000 overlapping 15m bars looks like a
 * discovery when it is really an artefact of sampling every 15 minutes.
 */
export function effectiveSampleSize(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 4) return n;
  const rho = lag1Autocorrelation(a) * lag1Autocorrelation(b);
  const factor = (1 - rho) / (1 + rho);
  return clamp(n * factor, 4, n);
}

/** Downside deviation about a zero minimum acceptable return. */
function semiDeviation(values: number[]): number {
  if (values.length === 0) return 0;
  let acc = 0;
  for (const v of values) {
    const shortfall = Math.min(0, v);
    acc += shortfall * shortfall;
  }
  return Math.sqrt(acc / values.length);
}

/** Sample skewness (Fisher-Pearson). 0 for a symmetric series. */
function skewness(values: number[]): number {
  const n = values.length;
  if (n < 3) return 0;
  const mean = calculateMean(values);
  const std = calculateStdDev(values, mean);
  if (std === 0) return 0;
  let acc = 0;
  for (const v of values) acc += Math.pow((v - mean) / std, 3);
  return (n / ((n - 1) * (n - 2))) * acc;
}

/** Deepest peak-to-trough decline over a log-price series, as a fraction. */
function maxDrawdownFromLogs(logPrices: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const lp of logPrices) {
    if (lp > peak) peak = lp;
    if (peak > -Infinity) {
      const dd = 1 - Math.exp(lp - peak);
      if (dd > worst) worst = dd;
    }
  }
  return worst;
}

/**
 * Aligns benchmark and subject candles on their open timestamp and derives the
 * log return series every terminal calculation runs on.
 *
 * Log returns (not simple percentage returns) because the residual and
 * volatility work compounds cleanly over a multi-week window, and the
 * log-price regression needs log levels regardless.
 */
export function buildTerminalBars(baseKlines: Kline[], coinKlines: Kline[]): TerminalBar[] {
  const baseMap = new Map<number, Kline>();
  for (const k of baseKlines) baseMap.set(k.time, k);

  const timeline: { time: number; base: Kline; coin: Kline }[] = [];
  for (const coin of coinKlines) {
    const base = baseMap.get(coin.time);
    if (!base) continue;
    if (coin.close <= 0 || base.close <= 0) continue;
    timeline.push({ time: coin.time, base, coin });
  }
  timeline.sort((a, b) => a.time - b.time);

  const bars: TerminalBar[] = [];
  for (let i = 1; i < timeline.length; i += 1) {
    const prev = timeline[i - 1];
    const curr = timeline[i];
    if (prev.coin.close <= 0 || prev.base.close <= 0) continue;

    const baseReturn = Math.log(curr.base.close / prev.base.close);
    const coinReturn = Math.log(curr.coin.close / prev.coin.close);
    const baseLogPrice = Math.log(curr.base.close);
    const coinLogPrice = Math.log(curr.coin.close);

    bars.push({
      time: curr.time,
      hourUtc: new Date(curr.time).getUTCHours(),
      baseLogPrice,
      coinLogPrice,
      baseReturn,
      coinReturn,
      baseAbsReturn: Math.abs(baseReturn),
      coinAbsReturn: Math.abs(coinReturn),
      baseVolume: curr.base.volume,
      coinVolume: curr.coin.volume,
      logRatio: coinLogPrice - baseLogPrice,
    });
  }
  return bars;
}

/**
 * Return pairs at a given bar offset, with the same sign convention as
 * CorrelationMetrics: lag > 0 correlates base(t - lag) with coin(t), i.e. the
 * benchmark LEADS the subject.
 */
function laggedPairs(bars: TerminalBar[], lag: number): { base: number[]; coin: number[] } {
  const base: number[] = [];
  const coin: number[] = [];
  if (lag >= 0) {
    for (let t = lag; t < bars.length; t += 1) {
      base.push(bars[t - lag].baseReturn);
      coin.push(bars[t].coinReturn);
    }
  } else {
    const absLag = Math.abs(lag);
    for (let t = 0; t < bars.length - absLag; t += 1) {
      base.push(bars[t + absLag].baseReturn);
      coin.push(bars[t].coinReturn);
    }
  }
  return { base, coin };
}

/**
 * Lead/lag cross-correlation spectrum over -maxLag..+maxLag bars.
 *
 * Three things matter beyond the raw coefficient:
 *
 *  1. Scanning N lags and reporting the best one will always find something
 *     near zero, so each lag is judged against a FAMILY-WISE threshold, not a
 *     plain 95% band. The plain band is reported too, because the difference
 *     between "clears 95%" and "clears 95% after correcting for 25 lags tested"
 *     is the entire finding.
 *  2. The test uses an overlap-corrected sample size, because consecutive bar
 *     returns are near-independent and the naive n makes weak coefficients look
 *     significant.
 *  3. The verdict distinguishes a real lead/lag from a relationship that is
 *     simply synchronous but strong. Collapsing those two into "no signal"
 *     would be wrong and is the most common way this chart is misread.
 */
export function computeCrossCorrelationSpectrum(
  bars: TerminalBar[],
  maxLag: number
): CrossCorrelationSpectrum {
  const points: LagPoint[] = [];
  const testCount = maxLag * 2 + 1;
  // Bonferroni: alpha/2 per tail, spread over every lag actually tested.
  const familyWiseZ = inverseNormalCdf(1 - 0.05 / testCount);
  const plainZ = 1.959963985;

  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    const { base, coin } = laggedPairs(bars, lag);
    const n = base.length;
    const coefficient = n >= 4 ? calculatePearsonCorrelation(base, coin) : 0;
    const nEff = effectiveSampleSize(base, coin);

    // Two different intervals are needed and they are NOT interchangeable:
    //
    //  - lowerBound/upperBound is the CONFIDENCE INTERVAL OF THE ESTIMATE. It is
    //    centred on the observed r and answers "how precisely is this
    //    coefficient pinned down".
    //  - significance is a test of H0: rho = 0. Its critical value is
    //    |tanh(z / se)| measured from ZERO, so it must NOT be read off the
    //    confidence interval. Comparing r against its own interval can never
    //    reject anything, which is exactly the mistake that makes a scan like
    //    this report no result on any input.
    const r = clamp(coefficient, -0.999999, 0.999999);
    const fisherZ = 0.5 * Math.log((1 + r) / (1 - r));
    const standardError = nEff > 3 ? 1 / Math.sqrt(nEff - 3) : 1;
    const lowerBound = Math.tanh(fisherZ - familyWiseZ * standardError);
    const upperBound = Math.tanh(fisherZ + familyWiseZ * standardError);
    const criticalFamilyWise = Math.tanh(familyWiseZ * standardError);
    const critical95 = Math.tanh(plainZ * standardError);

    points.push({
      lag,
      coefficient: Number.isFinite(coefficient) ? coefficient : 0,
      observations: n,
      effectiveSamples: Number.isFinite(nEff) ? Math.round(nEff) : n,
      standardError,
      lowerBound,
      upperBound,
      significant: nEff > 3 && Math.abs(coefficient) > criticalFamilyWise,
      significant95: nEff > 3 && Math.abs(coefficient) > critical95,
      isPeak: false,
    });
  }

  let peak = points[0];
  for (const p of points) {
    if (Math.abs(p.coefficient) > Math.abs(peak.coefficient)) peak = p;
  }
  if (points.length > 0) peak.isPeak = true;

  let significantPeak: LagPoint | null = null;
  for (const p of points) {
    if (p.significant && (significantPeak === null || Math.abs(p.coefficient) > Math.abs(significantPeak.coefficient))) {
      significantPeak = p;
    }
  }

  // A non-zero lag that clears the plain band but not the family-wise one: the
  // "maybe, needs more sample" tier. Restricted to non-zero lags so a strong
  // synchronous correlation is never reported as a lead/lag hint.
  let uncorrected: LagPoint | null = null;
  for (const p of points) {
    if (p.lag !== 0 && p.significant95 && !p.significant) {
      if (uncorrected === null || Math.abs(p.coefficient) > Math.abs(uncorrected.coefficient)) {
        uncorrected = p;
      }
    }
  }

  const zeroLag = points.find((p) => p.lag === 0);
  const zeroSignificant = zeroLag?.significant === true;
  const zeroSignificant95 = zeroLag?.significant95 === true;

  // Critical values are properties of the test, not of any one lag. They are
  // taken at lag 0, where the sample is largest, so every lag is judged against
  // the same bar. Overlapping lags lose pairs as |lag| grows, which makes their
  // critical values stricter automatically via their own smaller nEff.
  const seAtZero = zeroLag?.standardError ?? 1;
  const threshold = Math.tanh(familyWiseZ * seAtZero);
  const threshold95 = Math.tanh(plainZ * seAtZero);

  let verdict: CrossCorrelationSpectrum["verdict"];
  let leader: CrossCorrelationSpectrum["leader"];
  let leaderLabel: string;

  if (significantPeak !== null && significantPeak.lag !== 0) {
    verdict = "FAMILY_WISE_LAG";
    leader = significantPeak.lag > 0 ? "BASE" : "COIN";
    leaderLabel =
      `${significantPeak.lag > 0 ? "Benchmark" : "Subject"} leads by ${Math.abs(significantPeak.lag)} bar${Math.abs(significantPeak.lag) === 1 ? "" : "s"} ` +
      `(r = ${significantPeak.coefficient.toFixed(4)}), and it survives multiple-testing correction across all ${testCount} lags scanned.`;
  } else if (uncorrected !== null) {
    verdict = "UNCORRECTED_LAG";
    leader = uncorrected.lag > 0 ? "BASE" : "COIN";
    leaderLabel =
      `${uncorrected.lag > 0 ? "Benchmark" : "Subject"} leads by ${Math.abs(uncorrected.lag)} bar${Math.abs(uncorrected.lag) === 1 ? "" : "s"} ` +
      `(r = ${uncorrected.coefficient.toFixed(4)}), but it does not clear the family-wise ${threshold.toFixed(3)} threshold. ` +
      `Treat it as a hypothesis to re-test on a longer sample, not a tradable edge.`;
  } else if (zeroSignificant95) {
    verdict = zeroSignificant ? "SYNCHRONOUS_SIGNIFICANT" : "SYNCHRONOUS_SIGNIFICANT";
    leader = "SYNCHRONOUS";
    leaderLabel =
      `No offset beats the benchmark. Correlation is contemporaneous (r = ${zeroLag?.coefficient.toFixed(4)} at lag 0)` +
      `${zeroSignificant ? ", significant even after multiple-testing correction" : ", significant at a plain 95% level but not after correcting for the lag scan"}.`;
  } else {
    verdict = "NO_SIGNAL";
    leader = "SYNCHRONOUS";
    leaderLabel = `No lag, including lag 0, clears even a plain 95% band (|r| > ${threshold95.toFixed(3)}). This pair carries no detectable linear return relationship on this interval.`;
  }

  return {
    points,
    peakLag: peak.lag,
    peakCoefficient: peak.coefficient,
    significantPeakLag: significantPeak ? significantPeak.lag : null,
    significantPeakCoefficient: significantPeak ? significantPeak.coefficient : 0,
    uncorrectedLeadLag: uncorrected ? { lag: uncorrected.lag, coefficient: uncorrected.coefficient } : null,
    threshold,
    threshold95,
    verdict,
    leader,
    leaderLabel,
    sampleCount: bars.length,
  };
}

/**
 * Regresses coin returns on base returns inside one conditional subset and
 * reports the sensitivity plus the raw means, in basis points.
 */
function buildSegment(
  label: string,
  description: string,
  baseSubset: number[],
  coinSubset: number[]
): AsymmetrySegment {
  const observations = Math.min(baseSubset.length, coinSubset.length);
  if (observations < 3) {
    return {
      label,
      description,
      observations,
      beta: 0,
      correlation: 0,
      r2: 0,
      meanBaseReturnBps: 0,
      meanCoinReturnBps: 0,
    };
  }
  const { beta, r2 } = calculateLinearRegression(baseSubset, coinSubset);
  return {
    label,
    description,
    observations,
    beta: Number.isFinite(beta) ? beta : 0,
    correlation: calculatePearsonCorrelation(baseSubset, coinSubset),
    r2: Number.isFinite(r2) ? r2 : 0,
    meanBaseReturnBps: calculateMean(baseSubset) * BPS,
    meanCoinReturnBps: calculateMean(coinSubset) * BPS,
  };
}

/**
 * Conditional beta decomposition: how much the subject moves when the
 * benchmark is down, versus up, and how the left tail compares with ordinary
 * bad days. A single headline beta averages all of these together and hides
 * exactly the behaviour a risk desk cares about.
 */
export function computeBetaAsymmetry(bars: TerminalBar[]): BetaAsymmetry {
  const base = bars.map((b) => b.baseReturn);
  const coin = bars.map((b) => b.coinReturn);

  const sortedBase = [...base].sort((a, b) => a - b);
  const p05 = quantileOfSorted(sortedBase, 0.05);
  const p10 = quantileOfSorted(sortedBase, 0.1);
  const p90 = quantileOfSorted(sortedBase, 0.9);

  const take = (predicate: (i: number) => boolean) => {
    const b: number[] = [];
    const c: number[] = [];
    for (let i = 0; i < bars.length; i += 1) {
      if (predicate(i)) {
        b.push(base[i]);
        c.push(coin[i]);
      }
    }
    return { b, c };
  };

  const marketDownBars = take((i) => base[i] < 0);
  const marketUpBars = take((i) => base[i] > 0);
  const tailDownBars = take((i) => base[i] <= p10);
  const extremeDownBars = take((i) => base[i] <= p05);
  const coinDownBars = take((i) => coin[i] < 0);

  const marketDown = buildSegment(
    "Market Down",
    "Benchmark return below zero",
    marketDownBars.b,
    marketDownBars.c
  );
  const marketUp = buildSegment(
    "Market Up",
    "Benchmark return above zero",
    marketUpBars.b,
    marketUpBars.c
  );
  const marketTailDown = buildSegment(
    "Downside Tail",
    "Benchmark in the worst 10% of bars",
    tailDownBars.b,
    tailDownBars.c
  );
  const marketExtremeDown = buildSegment(
    "Extreme Tail",
    "Benchmark in the worst 5% of bars",
    extremeDownBars.b,
    extremeDownBars.c
  );
  const coinDown = buildSegment(
    "Subject Down",
    "Bars where the subject itself fell",
    coinDownBars.b,
    coinDownBars.c
  );

  const baseSemi = semiDeviation(base);
  const coinSemi = semiDeviation(coin);

  // Up/down capture as normally published: COMPOUND move over up bars divided
  // by the benchmark's compound move over those same bars. Summed log returns,
  // not means, so a handful of large bars are not averaged away.
  //
  // Note this measure sits close to beta whenever the regression intercept is
  // near zero, which is the normal case for crypto log returns. The genuinely
  // discriminating asymmetry numbers here are downBeta vs upBeta and the
  // semideviation ratio, not this ratio.
  const sumUpBase = marketUpBars.b.reduce((a, v) => a + v, 0);
  const sumDownBase = marketDownBars.b.reduce((a, v) => a + v, 0);
  const sumUpCoin = marketUpBars.c.reduce((a, v) => a + v, 0);
  const sumDownCoin = marketDownBars.c.reduce((a, v) => a + v, 0);
  const upCapturePct = sumUpBase !== 0 ? (sumUpCoin / sumUpBase) * 100 : 0;
  const downCapturePct = sumDownBase !== 0 ? (sumDownCoin / sumDownBase) * 100 : 0;
  const captureRatio = downCapturePct !== 0 ? upCapturePct / Math.abs(downCapturePct) : 0;

  const upBeta = marketUp.beta;
  const downBeta = marketDown.beta;
  const betaSkewRatio = upBeta !== 0 ? downBeta / upBeta : 0;

  let label = "SYMMETRIC";
  let interpretation = "";
  const semiRatioText = `Downside semideviation runs at ${coinSemi > 0 ? (coinSemi / baseSemi).toFixed(2) : "n/a"}x the benchmark's.`;
  if (Math.abs(downBeta) > Math.abs(upBeta) * 1.2) {
    label = "LEFT-TAIL ASYMMETRIC";
    interpretation =
      `Downside beta (${downBeta.toFixed(3)}) exceeds upside beta (${upBeta.toFixed(3)}): the subject amplifies losses more than gains. ` +
      `Long exposure carries more downside than the headline beta implies. ${semiRatioText}`;
  } else if (Math.abs(upBeta) > Math.abs(downBeta) * 1.2) {
    label = "RIGHT-SIDE ASYMMETRIC";
    interpretation =
      `Upside beta (${upBeta.toFixed(3)}) exceeds downside beta (${downBeta.toFixed(3)}): the subject captures rallies better than it gives back. ${semiRatioText}`;
  } else {
    interpretation =
      `Downside beta (${downBeta.toFixed(3)}) and upside beta (${upBeta.toFixed(3)}) are within 20% of each other; ` +
      `the subject responds to the benchmark roughly proportionally in both directions. ${semiRatioText}`;
  }
  interpretation +=
    ` In the benchmark's worst 10% of bars the subject's beta is ${marketTailDown.beta.toFixed(3)} (r = ${marketTailDown.correlation.toFixed(3)}),` +
    ` rising to ${marketExtremeDown.beta.toFixed(3)} in the worst 5% - that tail figure is where convexity risk actually lives.`;

  return {
    marketDown,
    marketUp,
    marketTailDown,
    marketExtremeDown,
    coinDown,
    upBeta,
    downBeta,
    betaAsymmetry: downBeta - upBeta,
    betaSkewRatio,
    upCapturePct,
    downCapturePct,
    captureRatio,
    baseSemiDeviation: baseSemi,
    coinSemiDeviation: coinSemi,
    semiDeviationRatio: baseSemi > 0 ? coinSemi / baseSemi : 0,
    label,
    interpretation,
  };
}

/**
 * Rolling correlation of the return pair, and how much that number moves.
 *
 * The headline question is not "what is the correlation" but "should I trust
 * the number I am quoting", which is a dispersion question: a correlation that
 * swings from 0.2 to 0.9 inside one window describes no relationship at all.
 */
export function computeCorrelationStability(
  bars: TerminalBar[],
  window: number,
  interval: Interval
): CorrelationStability {
  const series: { time: number; value: number }[] = [];
  const w = Math.max(3, Math.min(window, Math.floor(bars.length / 2)));

  for (let end = w; end <= bars.length; end += 1) {
    const slice = bars.slice(end - w, end);
    const r = calculatePearsonCorrelation(
      slice.map((b) => b.baseReturn),
      slice.map((b) => b.coinReturn)
    );
    if (Number.isFinite(r)) series.push({ time: slice[slice.length - 1].time, value: r });
  }

  const values = series.map((s) => s.value);
  if (values.length === 0) {
    return {
      window: w,
      series: [],
      current: 0,
      mean: 0,
      median: 0,
      stdDev: 0,
      min: 0,
      max: 0,
      percentile: 50,
      coefficientOfVariation: 0,
      stabilityScore: 0,
      positiveSharePct: 0,
      strongSharePct: 0,
      weakSharePct: 0,
      regimeShiftZ: 0,
      trendSlopePerBar: 0,
      trendAcrossSample: 0,
      buckets: [],
      blocks: [],
      label: "NO DATA",
      interpretation: "Not enough overlapping bars to measure a rolling correlation.",
    };
  }

  const mean = calculateMean(values);
  const stdDev = calculateStdDev(values, mean);
  const current = values[values.length - 1];
  const sorted = [...values].sort((a, b) => a - b);

  // A rolling correlation is a smoothed series, so its own standard deviation
  // is the right yardstick for "is today's value unusual".
  const regimeShiftZ = stdDev > 0 ? (current - mean) / stdDev : 0;
  const coefficientOfVariation = Math.abs(mean) > 1e-9 ? stdDev / Math.abs(mean) : 0;

  // 0.35 sd of dispersion is treated as fully unstable; below that it decays
  // linearly to a perfect 100.
  const stabilityScore = clamp(Math.round(100 * (1 - clamp(stdDev / 0.35, 0, 1))), 0, 100);

  const share = (predicate: (v: number) => boolean) =>
    (values.filter(predicate).length / values.length) * 100;

  // Histogram over fixed correlation bands, so the shape is comparable across
  // coins and window sizes.
  const bandDefs: { label: string; lo: number; hi: number }[] = [
    { label: "<= -0.2", lo: -Infinity, hi: -0.2 },
    { label: "-0.2 / 0.2", lo: -0.2, hi: 0.2 },
    { label: "0.2 / 0.5", lo: 0.2, hi: 0.5 },
    { label: "0.5 / 0.75", lo: 0.5, hi: 0.75 },
    { label: "0.75 / 0.9", lo: 0.75, hi: 0.9 },
    { label: ">= 0.9", lo: 0.9, hi: Infinity },
  ];
  const buckets: StabilityBucket[] = bandDefs.map((band) => {
    const count = values.filter((v) => v > band.lo && v <= band.hi).length;
    return { label: band.label, observations: count, sharePct: (count / values.length) * 100 };
  });

  // Equal time blocks expose structural drift: a subject whose first quartile
  // reads 0.8 and last quartile 0.3 is decoupling, which the window mean hides.
  const blockCount = 4;
  const blockSize = Math.floor(values.length / blockCount);
  const blocks: TimeBlockCorrelation[] = [];
  for (let bIdx = 0; bIdx < blockCount; bIdx += 1) {
    const from = bIdx * blockSize;
    const to = bIdx === blockCount - 1 ? values.length : from + blockSize;
    const slice = values.slice(from, to);
    if (slice.length === 0) continue;
    const blockMean = calculateMean(slice);
    blocks.push({
      label: `Q${bIdx + 1}`,
      observations: slice.length,
      meanCorrelation: blockMean,
      medianCorrelation: median(slice),
      stdDev: calculateStdDev(slice, blockMean),
    });
  }

  const { beta: trendSlopePerBar } = calculateLinearRegression(
    values.map((_, i) => i),
    values
  );
  const trendAcrossSample = trendSlopePerBar * values.length;

  let label = "STABLE";
  let interpretation = "";
  if (stabilityScore < 40) {
    label = "UNSTABLE";
    interpretation = `Rolling correlation (${w}-bar) has a ${stdDev.toFixed(3)} standard deviation across the window. Treat any single-point correlation quote as unreliable; use the block means instead.`;
  } else if (stabilityScore < 70) {
    label = "DRIFTING";
    interpretation = `Rolling correlation varies by ${stdDev.toFixed(3)} sd, and ${trendAcrossSample < -0.15 ? "the coupling is weakening" : trendAcrossSample > 0.15 ? "the coupling is strengthening" : "the drift is not one-directional"}. Current reading sits at the ${percentileRank(values, current).toFixed(0)}th percentile of its own history.`;
  } else {
    interpretation = `Rolling correlation is tight (${stdDev.toFixed(3)} sd, stability ${stabilityScore}/100) and currently at ${current.toFixed(3)}.`;
  }

  return {
    window: w,
    series: recentWindow(series, MAX_CHART_BARS[interval]),
    current,
    mean,
    median: median(values),
    stdDev,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    percentile: percentileRank(values, current),
    coefficientOfVariation,
    stabilityScore,
    positiveSharePct: share((v) => v > 0),
    strongSharePct: share((v) => v >= 0.7),
    weakSharePct: share((v) => v < 0.3),
    regimeShiftZ,
    trendSlopePerBar,
    trendAcrossSample,
    buckets,
    blocks,
    label,
    interpretation,
  };
}

/**
 * Full-length return-residual Z series: the subject's log return minus the OLS
 * prediction from the benchmark, standardised under the caller's `zscoreMode`
 * and rolling window. This is the single implementation behind the terminal's
 * "return residual z-score" chart and the scanner's Z-Score column, so the same
 * pair and window read identically on both surfaces.
 */
export function computeReturnResidualZ(
  bars: TerminalBar[],
  window: number,
  zscoreMode: ZScoreMode
): { beta: number; alpha: number; r2: number; zWindow: number; series: ResidualPoint[] } {
  const baseReturns = bars.map((b) => b.baseReturn);
  const coinReturns = bars.map((b) => b.coinReturn);

  const { beta, alpha, r2 } = calculateLinearRegression(baseReturns, coinReturns);
  const residuals = bars.map(
    (_, i) => coinReturns[i] - (alpha + beta * baseReturns[i])
  );

  const zWindow = Math.max(5, Math.min(window, Math.floor(bars.length / 2)));
  const z = computeZScores(residuals, zscoreMode, zWindow);

  return {
    beta,
    alpha,
    r2,
    zWindow,
    series: bars.map((b, i) => ({
      time: b.time,
      residual: residuals[i],
      zScore: z[i],
    })),
  };
}

/**
 * Two residuals, because they answer different questions.
 *
 *  - RETURN residual: coin return minus the OLS prediction from the benchmark.
 *    A large Z here means "today moved far more than the benchmark explains",
 *    which is an idiosyncratic-risk event, not a spread trade.
 *  - LOG-PRICE residual: log(coin) regressed on log(base). A stationary
 *    residual here is a cointegration gap, the quantity pairs desks actually
 *    trade, and it has a meaningful mean-reversion half-life.
 *
 * Both Z-series are standardised under the caller's `zscoreMode` through the
 * shared `computeZScores`, so switching modes in the terminal re-standardises
 * both charts with exactly the semantics the dashboard and scanner use.
 */
export function computeResidualAnalysis(
  bars: TerminalBar[],
  window: number,
  interval: Interval,
  zscoreMode: ZScoreMode = "rolling"
): ResidualAnalysis {
  const rr = computeReturnResidualZ(bars, window, zscoreMode);
  const { beta, alpha, r2, zWindow } = rr;
  const returnResiduals = rr.series.map((p) => p.residual);
  const residualZ = rr.series.map((p) => p.zScore);
  const residualSeries = rr.series;
  const residualStdDev = calculateStdDev(returnResiduals, calculateMean(returnResiduals));

  const currentZ = residualZ.length > 0 ? residualZ[residualZ.length - 1] : 0;
  const currentResidualBps = returnResiduals.length > 0 ? returnResiduals[returnResiduals.length - 1] * BPS : 0;
  const cleanZ = residualZ.filter((z) => Number.isFinite(z));
  const meanZ = calculateMean(cleanZ);
  const stdZ = calculateStdDev(cleanZ, meanZ);
  // 2 sigma on a standardized residual is the conventional "unusual" line.
  const alertThreshold = 2;

  let residualLabel = "WITHIN BAND";
  let residualInterpretation = "";
  if (currentZ >= alertThreshold) {
    residualLabel = "IDIOSYNCRATIC OUTBOUND";
    residualInterpretation = `The latest move ran ${currentZ.toFixed(2)} residual sigma above what the benchmark explains. Treat it as subject-specific flow rather than a systematic move.`;
  } else if (currentZ <= -alertThreshold) {
    residualLabel = "IDIOSYNCRATIC INBOUND";
    residualInterpretation = `The latest move ran ${currentZ.toFixed(2)} residual sigma below the benchmark-implied path.`;
  } else {
    residualInterpretation = `Idiosyncratic dispersion is normal (${currentZ.toFixed(2)} sigma).`;
  }

  // --- Log-price residual -------------------------------------------------
  const baseLogs = bars.map((b) => b.baseLogPrice);
  const coinLogs = bars.map((b) => b.coinLogPrice);
  const priceFit = calculateLinearRegression(baseLogs, coinLogs);

  const logResiduals = bars.map(
    (_, i) => coinLogs[i] - (priceFit.alpha + priceFit.beta * baseLogs[i])
  );
  const logMean = calculateMean(logResiduals);
  const logStd = calculateStdDev(logResiduals, logMean);
  const logZ = computeZScores(logResiduals, zscoreMode, zWindow);
  const logSeries = bars.map((b, i) => ({
    time: b.time,
    residual: logResiduals[i],
    zScore: logZ[i],
  }));
  const currentLogResidual = logResiduals.length > 0 ? logResiduals[logResiduals.length - 1] : 0;
  const currentLogZ = logSeries.length > 0 ? logSeries[logSeries.length - 1].zScore : 0;

  // AR(1) on the residual drives the Ornstein-Uhlenbeck half-life. phi in
  // (0,1) implies reversion; phi <= 0 or >= 1 implies none.
  let ar1 = 0;
  if (logResiduals.length > 4) {
    const lagged = logResiduals.slice(0, -1);
    const current_ = logResiduals.slice(1);
    const phiFit = calculateLinearRegression(lagged, current_);
    ar1 = phiFit.beta;
  }
  // Near unity the half-life estimate is extremely noisy: a phi of 0.996 vs
  // 0.997 moves the answer by tens of bars, so the caller is told when the
  // number has left the range where it can be trusted.
  const halfLifeReliable = ar1 > 0 && ar1 < 0.99;
  const halfLifeBars = halfLifeReliable ? -Math.log(2) / Math.log(ar1) : null;

  let stationarityFlag = "NON-MEAN-REVERTING";
  let logInterpretation = "";
  if (halfLifeBars !== null) {
    stationarityFlag = "MEAN-REVERTING";
    logInterpretation = `The log-price residual is mean-reverting with a half-life of ${halfLifeBars.toFixed(1)} bars, so a ${currentLogZ.toFixed(2)} sigma gap is a decay candidate rather than a structural break.`;
  } else if (ar1 >= 0.99) {
    stationarityFlag = "SLOW / UNRELIABLE HALF-LIFE";
    logInterpretation =
      `AR(1) is ${ar1.toFixed(4)}, so close to unity that the implied half-life is not estimable at this sample length. ` +
      `The ${currentLogZ.toFixed(2)} sigma gap may or may not close; widen the window before sizing anything off it.`;
  } else {
    stationarityFlag = "RANDOM WALK LIKE";
    logInterpretation = `The log-price residual shows no usable mean reversion (AR(1) = ${ar1.toFixed(3)}). The ${currentLogZ.toFixed(2)} sigma gap is as likely to persist as to close; do not treat it as a converging spread.`;
  }

  return {
    beta,
    alpha,
    r2,
    residualStdDev,
    zscoreMode,
    returnResidual: {
      zWindow,
      series: recentWindow(residualSeries, MAX_CHART_BARS[interval]),
      currentResidualBps,
      currentZ,
      meanZ,
      stdZ,
      alertThreshold,
      label: residualLabel,
      interpretation: residualInterpretation,
    },
    logPriceResidual: {
      intercept: priceFit.alpha,
      slope: priceFit.beta,
      r2: priceFit.r2,
      zWindow,
      series: recentWindow(logSeries, MAX_CHART_BARS[interval]),
      current: currentLogResidual,
      mean: logMean,
      stdDev: logStd,
      currentZ: currentLogZ,
      ar1,
      halfLifeBars,
      stationarityFlag,
      interpretation: logInterpretation,
    },
  };
}

function regimeLabelFromPercentile(p: number): string {
  if (p >= 97) return "CRISIS";
  if (p >= 90) return "EXPANSION";
  if (p >= 70) return "ELEVATED";
  if (p >= 30) return "NORMAL";
  return "COMPRESSION";
}

/**
 * Realized-volatility percentile and Bollinger-width percentile, both measured
 * against the asset's OWN history. An absolute vol threshold means nothing
 * across coins; a percentile is comparable.
 *
 * `realizedVol` is the per-bar sigma over the trailing window; `annualizedVol`
 * scales it by sqrt(bars per year) so the number reads as a percentage
 * regardless of the interval. `volHistory` is passed in ANNUALIZED because that
 * is what the percentile is measured against - comparing a per-bar sigma to an
 * annualized series would pin every reading to the bottom of its own history.
 */
function buildVolStats(
  barSlice: TerminalBar[],
  allBars: TerminalBar[],
  logKey: "coinLogPrice" | "baseLogPrice",
  returnKey: "coinReturn" | "baseReturn",
  volHistory: number[],
  annualize: number
): VolatilityStats {
  const returns = barSlice.map((b) => b[returnKey]);
  const realizedVol = calculateStdDev(returns, calculateMean(returns));
  const annualizedVol = realizedVol * annualize;
  const percentile = percentileRank(volHistory, annualizedVol);
  const logPrices = barSlice.map((b) => b[logKey]);

  const logMean = calculateMean(logPrices);
  const logStd = calculateStdDev(logPrices, logMean);
  const bollingerWidth = logMean > 0 ? ((4 * logStd) / logMean) * 100 : 0;

  // Width history from the same rolling windows as the vol history, so the
  // percentile is measured on a consistent basis.
  const widths: number[] = [];
  const w = barSlice.length;
  for (let end = w; end <= allBars.length; end += 1) {
    const slice = allBars.slice(end - w, end);
    const m = calculateMean(slice.map((b) => b[logKey]));
    const s = calculateStdDev(slice.map((b) => b[logKey]), m);
    if (m > 0) widths.push(((4 * s) / m) * 100);
  }

  const volOfVolMean = calculateMean(volHistory);
  const volOfVol = volOfVolMean > 0 ? calculateStdDev(volHistory, volOfVolMean) / volOfVolMean : 0;

  return {
    realizedVol,
    annualizedVol,
    percentile,
    label: regimeLabelFromPercentile(percentile),
    downSemiDeviation: semiDeviation(returns),
    upSemiDeviation: (() => {
      let acc = 0;
      for (const r of returns) {
        const excess = Math.max(0, r);
        acc += excess * excess;
      }
      return returns.length > 0 ? Math.sqrt(acc / returns.length) : 0;
    })(),
    volOfVol,
    maxDrawdown: maxDrawdownFromLogs(logPrices),
    bollingerWidth,
    bollingerPercentile: percentileRank(widths, bollingerWidth),
  };
}

/**
 * Rolling realized volatility for both legs plus their ratio, and the regime
 * label each side currently sits in.
 *
 * The ratio matters as much as the levels: a subject whose absolute vol looks
 * calm may still be three times as volatile as the benchmark on a like-for-like
 * basis, and vol REGIME shifts usually show up in the ratio first.
 */
export function computeVolatilityRegime(
  bars: TerminalBar[],
  window: number,
  interval: Interval
): VolatilityRegime {
  const w = Math.max(5, Math.min(window, Math.floor(bars.length / 2)));
  const periodsPerYear = PERIODS_PER_YEAR[interval];
  const annualize = Math.sqrt(periodsPerYear);

  const series: { time: number; coinVol: number; baseVol: number; ratio: number }[] = [];
  for (let end = w; end <= bars.length; end += 1) {
    const slice = bars.slice(end - w, end);
    const coinMean = calculateMean(slice.map((b) => b.coinReturn));
    const baseMean = calculateMean(slice.map((b) => b.baseReturn));
    const coinVol = calculateStdDev(slice.map((b) => b.coinReturn), coinMean);
    const baseVol = calculateStdDev(slice.map((b) => b.baseReturn), baseMean);
    series.push({
      time: slice[slice.length - 1].time,
      // Annualized so the axis reads as a percentage regardless of interval.
      coinVol: coinVol * annualize,
      baseVol: baseVol * annualize,
      ratio: coinVol / (baseVol || 1e-12),
    });
  }

  const coinVolHistory = series.map((s) => s.coinVol);
  const baseVolHistory = series.map((s) => s.baseVol);
  const ratioHistory = series.map((s) => s.ratio);

  const tail = bars.slice(Math.max(0, bars.length - w));
  const coin = buildVolStats(tail, bars, "coinLogPrice", "coinReturn", coinVolHistory, annualize);
  const base = buildVolStats(tail, bars, "baseLogPrice", "baseReturn", baseVolHistory, annualize);

  const ratioMean = calculateMean(ratioHistory);
  const ratioStd = calculateStdDev(ratioHistory, ratioMean);
  const currentRatio = ratioHistory.length > 0 ? ratioHistory[ratioHistory.length - 1] : 0;
  const ratioPercentile = percentileRank(ratioHistory, currentRatio);

  // Regime spans: bucket every rolling reading into its band, then collapse
  // consecutive same-band readings into one span. A per-bar regime label would
  // be unreadable noise.
  const spans: VolRegimeSpan[] = [];
  for (const point of series) {
    const band = regimeLabelFromPercentile(percentileRank(coinVolHistory, point.coinVol));
    const last = spans[spans.length - 1];
    if (last && last.label === band) {
      last.endTime = point.time;
      last.bars += 1;
    } else {
      spans.push({ label: band, startTime: point.time, endTime: point.time, bars: 1 });
    }
  }

  const ratioLabel =
    ratioPercentile >= 80
      ? "VOLATILITY DOMINANCE PEAKING"
      : ratioPercentile >= 55
      ? "VOLATILITY DOMINANCE RISING"
      : ratioPercentile <= 20
      ? "VOLATILITY COMPRESSING VS BENCHMARK"
      : "STABLE VOLATILITY PREMIUM";

  const interpretation =
    `The subject is in a ${coin.label.toLowerCase()} vol regime at the ${coin.percentile.toFixed(0)}th percentile of its own history ` +
    `(annualized ${(coin.annualizedVol * 100).toFixed(1)}% vs the benchmark's ${(base.annualizedVol * 100).toFixed(1)}%). ` +
    `Its volatility premium over the benchmark sits at ${currentRatio.toFixed(2)}x, the ${ratioPercentile.toFixed(0)}th percentile of this window. ` +
    `${ratioLabel}.`;

  return {
    window: w,
    periodsPerYear,
    coin,
    base,
    ratio: {
      value: currentRatio,
      mean: ratioMean,
      stdDev: ratioStd,
      percentile: ratioPercentile,
      label: ratioLabel,
    },
    series: recentWindow(series, MAX_CHART_BARS[interval]),
    spans,
    label: coin.label,
    interpretation,
  };
}

/**
 * Rolling coupling of the pair on one trailing window: beta, correlation and
 * the coin/base vol ratio, point for point, with each current reading ranked
 * against its own history.
 *
 * The three series belong together because the same window can tell a story a
 * single one hides: a beta collapsing to zero while correlation recovers means
 * relative vol is doing the work, a vol ratio pinning near its 95th percentile
 * is usually where a "decorrelation" headline actually comes from. Ranking
 * each against the pair's OWN history makes the readings comparable across
 * coins — beta 0.8 is normal for some pairs and extreme for others.
 */
export function computeRollingCoupling(
  bars: TerminalBar[],
  window: number,
  interval: Interval
): RollingCoupling {
  const w = Math.max(3, Math.min(window, Math.floor(bars.length / 2)));
  const annualize = Math.sqrt(PERIODS_PER_YEAR[interval]);

  const series: { time: number; beta: number; correlation: number; volRatio: number }[] = [];
  for (let end = w; end <= bars.length; end += 1) {
    const slice = bars.slice(end - w, end);
    const coinReturns = slice.map((b) => b.coinReturn);
    const baseReturns = slice.map((b) => b.baseReturn);
    const r = calculatePearsonCorrelation(baseReturns, coinReturns);
    if (!Number.isFinite(r)) continue;
    const { beta } = calculateLinearRegression(baseReturns, coinReturns);
    // Ratios of realized vols: annualizing both legs cancels, so use raw sd.
    const coinVol = calculateStdDev(coinReturns, calculateMean(coinReturns));
    const baseVol = calculateStdDev(baseReturns, calculateMean(baseReturns));
    series.push({
      time: slice[slice.length - 1].time,
      beta: Number.isFinite(beta) ? beta : 0,
      correlation: r,
      volRatio: coinVol / (baseVol || 1e-12),
    });
  }

  const summarize = (values: number[]): RollingMetricStats => {
    if (values.length === 0) {
      return { current: 0, mean: 0, median: 0, stdDev: 0, min: 0, max: 0, percentile: 50, label: "NO DATA" };
    }
    const mean = calculateMean(values);
    const stdDev = calculateStdDev(values, mean);
    const sorted = [...values].sort((a, b) => a - b);
    const current = values[values.length - 1];
    const pct = percentileRank(values, current);
    return {
      current,
      mean,
      median: median(values),
      stdDev,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      percentile: pct,
      label: pct >= 70 ? "HIGH" : pct <= 30 ? "LOW" : "TYPICAL",
    };
  };

  const beta = summarize(series.map((s) => s.beta));
  const correlation = summarize(series.map((s) => s.correlation));
  const volRatio = summarize(series.map((s) => s.volRatio));

  const interpretation =
    series.length === 0
      ? "Not enough overlapping bars to measure a rolling coupling."
      : `Rolling ${w}-bar beta sits at ${beta.current.toFixed(2)} (p${beta.percentile}, ${beta.label.toLowerCase()}), ` +
        `correlation ${correlation.current.toFixed(2)} (p${correlation.percentile}, ${correlation.label.toLowerCase()}), ` +
        `vol ratio ${volRatio.current.toFixed(2)} (p${volRatio.percentile}, ${volRatio.label.toLowerCase()}) ` +
        `against this pair's own history.`;

  return {
    window: w,
    series: recentWindow(series, MAX_CHART_BARS[interval]),
    beta,
    correlation,
    volRatio,
    interpretation,
  };
}

/**
 * Session-of-day and hour-of-day behaviour.
 *
 * Every session stat is computed on bars that fall inside the window, and the
 * hourly profile is included because it makes no session-boundary assumption
 * and so survives a DST shift that would otherwise contaminate the split.
 */
export function computeSessionEffects(bars: TerminalBar[], interval: Interval): SessionAnalysis {
  const periodsPerYear = PERIODS_PER_YEAR[interval];
  const totalVolume = bars.reduce((acc, b) => acc + b.coinVolume, 0);

  const sessions: SessionStat[] = TRADING_SESSIONS.map((def) => {
    const inSession = bars.filter((b) => b.hourUtc >= def.startHour && b.hourUtc < def.endHour);
    const coinReturns = inSession.map((b) => b.coinReturn);
    const baseReturns = inSession.map((b) => b.baseReturn);
    const observations = coinReturns.length;

    if (observations < 3) {
      return {
        id: def.id,
        label: def.label,
        window: def.window,
        startHour: def.startHour,
        endHour: def.endHour,
        observations,
        meanReturnBps: 0,
        projectedAnnualPct: 0,
        volatilityBps: 0,
        hitRatePct: 0,
        meanAbsMoveBps: 0,
        skew: 0,
        tStat: 0,
        totalVolume: 0,
        volumeSharePct: 0,
        correlation: 0,
        beta: 0,
        upCapturePct: 0,
        downCapturePct: 0,
        rank: 0,
      };
    }

    const meanReturn = calculateMean(coinReturns);
    const vol = calculateStdDev(coinReturns, meanReturn);
    const tStat = vol > 0 ? meanReturn / (vol / Math.sqrt(observations)) : 0;
    const volume = inSession.reduce((acc, b) => acc + b.coinVolume, 0);

    const upIdx = coinReturns.map((_, i) => i).filter((i) => baseReturns[i] > 0);
    const downIdx = coinReturns.map((_, i) => i).filter((i) => baseReturns[i] < 0);
    const meanUpBase = upIdx.length > 0 ? calculateMean(upIdx.map((i) => baseReturns[i])) : 0;
    const meanDownBase = downIdx.length > 0 ? calculateMean(downIdx.map((i) => baseReturns[i])) : 0;

    return {
      id: def.id,
      label: def.label,
      window: def.window,
      startHour: def.startHour,
      endHour: def.endHour,
      observations,
      meanReturnBps: meanReturn * BPS,
      projectedAnnualPct: meanReturn * periodsPerYear * 100,
      volatilityBps: vol * BPS,
      hitRatePct: (coinReturns.filter((r) => r > 0).length / observations) * 100,
      meanAbsMoveBps: calculateMean(coinReturns.map((r) => Math.abs(r))) * BPS,
      skew: skewness(coinReturns),
      // t-stat of 2 is the conventional significance line for a session edge.
      tStat,
      totalVolume: volume,
      volumeSharePct: totalVolume > 0 ? (volume / totalVolume) * 100 : 0,
      correlation: calculatePearsonCorrelation(baseReturns, coinReturns),
      beta: calculateLinearRegression(baseReturns, coinReturns).beta,
      upCapturePct:
        upIdx.length > 0 && meanUpBase !== 0
          ? (calculateMean(upIdx.map((i) => coinReturns[i])) / meanUpBase) * 100
          : 0,
      downCapturePct:
        downIdx.length > 0 && meanDownBase !== 0
          ? (calculateMean(downIdx.map((i) => coinReturns[i])) / meanDownBase) * 100
          : 0,
      // Rank is assigned below once every session mean is known.
      rank: 0,
    };
  });

  const ranked = [...sessions].filter((s) => s.observations > 0).sort((a, b) => b.meanReturnBps - a.meanReturnBps);
  ranked.forEach((s, i) => {
    const target = sessions.find((x) => x.id === s.id);
    if (target) target.rank = i + 1;
  });

  const hours: HourOfDayStat[] = Array.from({ length: 24 }, (_, hour) => {
    const slice = bars.filter((b) => b.hourUtc === hour);
    const returns = slice.map((b) => b.coinReturn);
    const volume = slice.reduce((acc, b) => acc + b.coinVolume, 0);
    if (returns.length === 0) {
      return { hour, observations: 0, meanReturnBps: 0, volatilityBps: 0, hitRatePct: 0, volumeSharePct: 0 };
    }
    const meanReturn = calculateMean(returns);
    return {
      hour,
      observations: returns.length,
      meanReturnBps: meanReturn * BPS,
      volatilityBps: calculateStdDev(returns, meanReturn) * BPS,
      hitRatePct: (returns.filter((r) => r > 0).length / returns.length) * 100,
      volumeSharePct: totalVolume > 0 ? (volume / totalVolume) * 100 : 0,
    };
  });

  const active = sessions.filter((s) => s.observations > 0);
  const best = ranked[0] ?? sessions[0];
  const worst = ranked[ranked.length - 1] ?? sessions[0];
  const mostVolatile = [...active].sort((a, b) => b.volatilityBps - a.volatilityBps)[0] ?? sessions[0];

  const sessionMeans = active.map((s) => s.meanReturnBps);
  const dispersionBps = sessionMeans.length > 1 ? calculateStdDev(sessionMeans, calculateMean(sessionMeans)) : 0;
  const correlations = active.map((s) => s.correlation);
  const sessionCorrelationSpread =
    correlations.length > 1 ? Math.max(...correlations) - Math.min(...correlations) : 0;

  const significant = active.filter((s) => Math.abs(s.tStat) >= 2);
  const interpretation =
    active.length === 0
      ? "No session carried enough bars in this window to measure."
      : `${best.label} is the strongest session at ${best.meanReturnBps.toFixed(2)} bps/bar (hit rate ${best.hitRatePct.toFixed(1)}%), ` +
        `${worst.label} the weakest at ${worst.meanReturnBps.toFixed(2)} bps/bar. ` +
        `${mostVolatile.label} carries the largest moves at ${mostVolatile.volatilityBps.toFixed(2)} bps of realized vol. ` +
        (significant.length > 0
          ? `${significant.map((s) => s.label).join(", ")} clear a |t| >= 2 session edge.`
          : `No session mean clears a |t| >= 2 threshold, so treat the spread as sampling noise.`);

  return {
    timezone: "UTC",
    sessions,
    hours,
    bestSessionId: best.id,
    worstSessionId: worst.id,
    mostVolatileSessionId: mostVolatile.id,
    dispersionBps,
    sessionCorrelationSpread,
    interpretation,
    boundaryNote: SESSION_BOUNDARY_NOTE,
  };
}