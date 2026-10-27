/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Kline, AlignedDataPoint, CorrelationMetrics, LagCoefficient, ScanTodayZ, ZScoreMode } from "../types";

/**
 * Calculates the mean of a number array.
 */
export function calculateMean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((sum, val) => sum + val, 0) / arr.length;
}

/**
 * Calculates standard deviation.
 */
export function calculateStdDev(arr: number[], mean: number): number {
  if (arr.length <= 1) return 0;
  const variance = arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/**
 * Calculates Pearson Correlation Coefficient.
 */
export function calculatePearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n === 0 || n !== y.length) return 0;

  const meanX = calculateMean(x);
  const meanY = calculateMean(y);

  let num = 0;
  let denX = 0;
  let denY = 0;

  for (let i = 0; i < n; i++) {
    const diffX = x[i] - meanX;
    const diffY = y[i] - meanY;
    num += diffX * diffY;
    denX += diffX * diffX;
    denY += diffY * diffY;
  }

  if (denX === 0 || denY === 0) return 0;
  return num / Math.sqrt(denX * denY);
}

/**
 * Performs linear regression (Y = alpha + beta * X) returning beta, alpha, and R-squared.
 */
export function calculateLinearRegression(
  x: number[],
  y: number[]
): { beta: number; alpha: number; r2: number } {
  const n = x.length;
  if (n <= 1 || n !== y.length) {
    return { beta: 0, alpha: 0, r2: 0 };
  }

  const meanX = calculateMean(x);
  const meanY = calculateMean(y);

  let num = 0;
  let den = 0;

  for (let i = 0; i < n; i++) {
    const diffX = x[i] - meanX;
    num += diffX * (y[i] - meanY);
    den += diffX * diffX;
  }

  const beta = den === 0 ? 0 : num / den;
  const alpha = meanY - beta * meanX;

  // R2 = r^2 for single variable linear regression
  const r = calculatePearsonCorrelation(x, y);
  const r2 = r * r;

  return { beta, alpha, r2 };
}

/**
 * Rolling window used for the price-ratio Z-score: one week of hourly bars.
 * Shared by every page so the spread Z reads identically wherever it is shown.
 */
const RATIO_Z_WINDOW = 168;

/**
 * Standardises `values` into Z-scores under the selected mode.
 *
 * - `batch`: mean/std over the whole sample. Uses the future, so it is a
 *   look-back description rather than a live signal.
 * - `rolling`: mean/std over the trailing `window` points only.
 * - `expanding`: mean/std over everything since the start, with a short warmup
 *   that standardises against the first `warmup` points so the head of the
 *   series does not divide by a near-zero standard deviation.
 *
 * This is the single implementation all pages route through, so a mode change
 * cannot desynchronise the dashboard, scanner and terminal.
 */
export function computeZScores(values: number[], mode: ZScoreMode, window: number): number[] {
  const n = values.length;
  if (n === 0) return [];
  const out: number[] = [];

  if (mode === "batch") {
    const mean = calculateMean(values);
    const std = calculateStdDev(values, mean);
    for (let i = 0; i < n; i++) out.push(std > 1e-12 ? (values[i] - mean) / std : 0);
    return out;
  }

  if (mode === "rolling") {
    const w = Math.max(2, window);
    for (let i = 0; i < n; i++) {
      const slice = values.slice(Math.max(0, i - w + 1), i + 1);
      const mean = calculateMean(slice);
      const std = calculateStdDev(slice, mean);
      out.push(std > 1e-12 ? (values[i] - mean) / std : 0);
    }
    return out;
  }

  const warmup = Math.min(24, n);
  for (let i = 0; i < n; i++) {
    const slice = values.slice(0, i < warmup ? warmup : i + 1);
    const mean = calculateMean(slice);
    const std = calculateStdDev(slice, mean);
    out.push(std > 1e-12 ? (values[i] - mean) / std : 0);
  }
  return out;
}

/**
 * Aligns two sets of kline data by timestamp and computes percentage returns,
 * volumes, spreads, ratio, and Z-scores of the ratio.
 */
export function alignAndProcessData(
  btcKlines: Kline[],
  coinKlines: Kline[],
  zscoreMode: "expanding" | "rolling" | "batch" = "expanding"
): AlignedDataPoint[] {
  // Map BTC klines by time
  const btcMap = new Map<number, Kline>();
  for (const k of btcKlines) {
    btcMap.set(k.time, k);
  }

  // Find common timestamps sorted
  const alignedTimeline: { time: number; btc: Kline; coin: Kline }[] = [];
  for (const coinK of coinKlines) {
    const btcK = btcMap.get(coinK.time);
    if (btcK) {
      alignedTimeline.push({ time: coinK.time, btc: btcK, coin: coinK });
    }
  }

  alignedTimeline.sort((a, b) => a.time - b.time);

  if (alignedTimeline.length <= 1) return [];

  // Compute percentage changes (returns)
  // Let return at t = (Price_t - Price_t-1) / Price_t-1
  const rawPoints: Omit<AlignedDataPoint, "zscore">[] = [];
  const ratios: number[] = [];

  for (let i = 1; i < alignedTimeline.length; i++) {
    const curr = alignedTimeline[i];
    const prev = alignedTimeline[i - 1];

    const btcClose = curr.btc.close;
    const coinClose = curr.coin.close;

    const btcReturn = prev.btc.close === 0 ? 0 : (curr.btc.close - prev.btc.close) / prev.btc.close;
    const coinReturn = prev.coin.close === 0 ? 0 : (curr.coin.close - prev.coin.close) / prev.coin.close;

    const btcVolReturn = prev.btc.volume === 0 ? 0 : (curr.btc.volume - prev.btc.volume) / prev.btc.volume;
    const coinVolReturn = prev.coin.volume === 0 ? 0 : (curr.coin.volume - prev.coin.volume) / prev.coin.volume;

    const ratio = coinClose / btcClose;
    ratios.push(ratio);

    rawPoints.push({
      time: curr.time,
      btcClose,
      btcReturn,
      btcVolume: curr.btc.volume,
      btcVolReturn,
      coinClose,
      coinReturn,
      coinVolume: curr.coin.volume,
      coinVolReturn,
      btcVolatility: Math.abs(btcReturn),
      coinVolatility: Math.abs(coinReturn),
      ratio,
    });
  }

  // Mean and STD of the price ratio under the selected zscoreMode.
  const zscores = computeZScores(ratios, zscoreMode, RATIO_Z_WINDOW);

  return rawPoints.map((pt, index) => ({
    ...pt,
    zscore: zscores[index],
  }));
}

/**
 * Scans a Z series for a ±`threshold` breach since 00:00 UTC today.
 *
 * This answers a different question than the current reading: the series can
 * spike past ±2 intraday and mean-revert before the newest bar, in which case
 * the current reading looks quiet even though the signal already fired. Reads
 * off the same z series as the Z column it sits beside, so the two never
 * disagree. Accepts any `{ time, zscore }` series (the aligned ratio-Z or a
 * residual Z-series), so whichever metric a surface displays feeds the same
 * breach check.
 *
 * Returns null for an empty series. `now` is injectable so callers can pin the
 * UTC day boundary in tests rather than depending on the wall clock.
 */
export function computeTodayZScoreExtremes(
  points: readonly { time: number; zscore: number }[],
  threshold = 2,
  now: number = Date.now()
): ScanTodayZ | null {
  if (points.length === 0) return null;

  const ref = new Date(now);
  const since = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate());

  let bars = 0;
  let maxAbs = 0;
  let extreme = 0;
  let hitUp = false;
  let hitDown = false;
  let firstHit: number | null = null;

  for (const point of points) {
    if (point.time < since) continue;
    bars += 1;

    const z = point.zscore;
    if (Math.abs(z) > maxAbs) {
      maxAbs = Math.abs(z);
      extreme = z;
    }
    if (z >= threshold) hitUp = true;
    if (z <= -threshold) hitDown = true;
    if ((z >= threshold || z <= -threshold) && firstHit === null) firstHit = point.time;
  }

  return { since, bars, extreme, maxAbs, hitUp, hitDown, firstHit };
}

/**
 * Computes cross-correlation coefficient at a specific lag.
 * Positive lag: BTC leads Coin. e.g. lag = 1 -> Correlating BTC_t-1 with Coin_t
 * Negative lag: Coin leads BTC. e.g. lag = -1 -> Correlating BTC_t+1 with Coin_t (BTC lead/lag backtest)
 */
export function calculateLagCorrelation(
  aligned: AlignedDataPoint[],
  lag: number
): number {
  if (aligned.length <= Math.abs(lag) + 5) return 0;

  const x: number[] = []; // BTC returns
  const y: number[] = []; // Coin returns

  if (lag >= 0) {
    // BTC leads Coin (BTC at t-lag is correlated with Coin at t)
    for (let t = lag; t < aligned.length; t++) {
      x.push(aligned[t - lag].btcReturn);
      y.push(aligned[t].coinReturn);
    }
  } else {
    // Coin leads BTC (Coin at t correlates with BTC at t - lag / t + |lag|)
    const absLag = Math.abs(lag);
    for (let t = 0; t < aligned.length - absLag; t++) {
      x.push(aligned[t + absLag].btcReturn);
      y.push(aligned[t].coinReturn);
    }
  }

  return calculatePearsonCorrelation(x, y);
}

/**
 * Generates rolling correlation vectors.
 */
export function calculateRollingCorrelation(
  aligned: AlignedDataPoint[],
  windowSize: number
): { time: number; value: number }[] {
  if (aligned.length < windowSize) return [];

  const results: { time: number; value: number }[] = [];

  for (let i = windowSize; i <= aligned.length; i++) {
    const window = aligned.slice(i - windowSize, i);
    const btc = window.map((w) => w.btcReturn);
    const coin = window.map((w) => w.coinReturn);
    const corr = calculatePearsonCorrelation(btc, coin);
    results.push({
      time: aligned[i - 1].time,
      value: isNaN(corr) ? 0 : corr,
    });
  }

  return results;
}

/**
 * Computes all correlation and quant statistics for the aligned series.
 */
export function computeCorrelationMetrics(
  aligned: AlignedDataPoint[],
  timeframe: "1h" | "15m",
  /**
   * Bars behind the rolling-correlation series. Callers pass the shared
   * default or the user's scanner selection so the sparkline matches the
   * control the user is looking at; omitted it falls back to the historical
   * 24/48 split. The value actually used (after clamping to the sample) is
   * echoed back as `rollingWindow`.
   */
  rollingWindow?: number
): CorrelationMetrics {
  const btcReturns = aligned.map((d) => d.btcReturn);
  const coinReturns = aligned.map((d) => d.coinReturn);

  const btcVolChange = aligned.map((d) => d.btcVolReturn);
  const coinVolChange = aligned.map((d) => d.coinVolReturn);

  const btcAbsReturns = aligned.map((d) => d.btcVolatility);
  const coinAbsReturns = aligned.map((d) => d.coinVolatility);

  // Correlations
  const priceCorrelation = calculatePearsonCorrelation(btcReturns, coinReturns);
  const volumeCorrelation = calculatePearsonCorrelation(btcVolChange, coinVolChange);
  const volatilityCorrelation = calculatePearsonCorrelation(btcAbsReturns, coinAbsReturns);

  // Linear Regression (returns)
  const { beta, alpha, r2 } = calculateLinearRegression(btcReturns, coinReturns);

  // Tracking Error (Standard Deviation of return spread: CoinReturn - BtcReturn)
  const returnSpreads = aligned.map((d) => d.coinReturn - d.btcReturn);
  const meanSpread = calculateMean(returnSpreads);
  const trackingError = calculateStdDev(returnSpreads, meanSpread);

  // Correlated Volatility Ratio: average absolute return of coin / average absolute return of base asset
  const meanBtcVol = calculateMean(btcAbsReturns);
  const meanCoinVol = calculateMean(coinAbsReturns);
  const correlatedVolatility = meanBtcVol > 0 ? meanCoinVol / meanBtcVol : 1.0;

  // Spreads & Z-Scores
  const lastPoint = aligned[aligned.length - 1];
  const currentRatio = lastPoint ? lastPoint.ratio : 0;
  const currentZScore = lastPoint ? lastPoint.zscore : 0;

  let spreadSignal = "EQUILIBRIUM";
  if (currentZScore > 1.8) {
    spreadSignal = "SELL_COIN_BUY_BTC"; // Coin overvalued relative to historical ratios -> expect mean-reversion
  } else if (currentZScore < -1.8) {
    spreadSignal = "BUY_COIN_SELL_BTC"; // Coin undervalued relative to historical ratios -> buy coin, short BTC
  }

  // Lead-Lag Analysis (ranges from -3 to +3)
  const lagHistory: LagCoefficient[] = [];
  let maxAbsCoefficient = -1;
  let optimalLag = 0;
  let optimalCoefficient = 0;

  for (let lag = -3; lag <= 3; lag++) {
    const coeff = calculateLagCorrelation(aligned, lag);
    lagHistory.push({ lag, coefficient: coeff });

    if (Math.abs(coeff) > maxAbsCoefficient) {
      maxAbsCoefficient = Math.abs(coeff);
      optimalLag = lag;
      optimalCoefficient = coeff;
    }
  }

  let interpretation = "Perfect Synchronicity";
  if (optimalLag > 0) {
    interpretation = `BTC LEADS by ${optimalLag} period${optimalLag > 1 ? "s" : ""} (${timeframe === "1h" ? optimalLag + " hr" : (optimalLag * 15) + " min"})`;
  } else if (optimalLag < 0) {
    interpretation = `Coin LEADS by ${Math.abs(optimalLag)} period${Math.abs(optimalLag) > 1 ? "s" : ""} (${timeframe === "1h" ? Math.abs(optimalLag) + " hr" : (Math.abs(optimalLag) * 15) + " min"})`;
  } else {
    interpretation = "Synchronous price discovery. Zero latency.";
  }

  // Rolling Correlation. A window longer than the sample would emit nothing,
  // so it is clamped and the effective size echoed for the chart title.
  const requestedWindow = rollingWindow ?? (timeframe === "1h" ? 24 : 48);
  const windowSize = Math.max(5, Math.min(requestedWindow, aligned.length));
  const rollingCorrelation = calculateRollingCorrelation(aligned, windowSize);

  return {
    timeframe,
    priceCorrelation: isNaN(priceCorrelation) ? 0 : priceCorrelation,
    volumeCorrelation: isNaN(volumeCorrelation) ? 0 : volumeCorrelation,
    volatilityCorrelation: isNaN(volatilityCorrelation) ? 0 : volatilityCorrelation,
    beta: isNaN(beta) ? 0 : beta,
    alpha: isNaN(alpha) ? 0 : alpha,
    r2: isNaN(r2) ? 0 : r2,
    trackingError: isNaN(trackingError) ? 0 : trackingError,
    correlatedVolatility: isNaN(correlatedVolatility) ? 1.0 : correlatedVolatility,
    currentRatio,
    currentZScore: isNaN(currentZScore) ? 0 : currentZScore,
    spreadSignal,
    leadLagOptimal: {
      lag: optimalLag,
      coefficient: optimalCoefficient,
      interpretation,
    },
    lagHistory,
    rollingCorrelation,
    rollingWindow: windowSize,
    alignedData: aligned,
  };
}
