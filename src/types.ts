/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Candle duration the terminal can analyse. The main dashboard is fixed to
 * "1h"/"15m"; the quant terminal also reaches for higher frames because
 * volatility regimes and correlation stability need a longer sample to mean
 * anything.
 */
export type Interval = "15m" | "1h" | "4h" | "1d";

/**
 * How a series is standardised into Z-scores. `expanding` and `rolling` are
 * lookahead-proof (only past data); `batch` standardises over the whole sample
 * and therefore uses the future. Every page shares this one definition so the
 * same pair reads the same number in the dashboard, scanner and terminal.
 */
export type ZScoreMode = "expanding" | "rolling" | "batch";

export interface Kline {
  time: number; // Open timestamp in ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Taker-buy base volume (kline field 9). Present when the venue supplies it; drives CVD features. */
  takerBuy?: number;
}

export interface AlignedDataPoint {
  time: number;
  btcClose: number;
  btcReturn: number;
  btcVolume: number;
  btcVolReturn: number;
  coinClose: number;
  coinReturn: number;
  coinVolume: number;
  coinVolReturn: number;
  // Volatility proxy (absolute return)
  btcVolatility: number;
  coinVolatility: number;
  // Spread & Price Ratio
  ratio: number;
  zscore: number;
}

export interface LagCoefficient {
  lag: number; // e.g., -3 to +3. Positive means BTC leads Coin, Negative means Coin leads BTC.
  coefficient: number;
}

export interface CorrelationMetrics {
  timeframe: "1h" | "15m";
  priceCorrelation: number;
  volumeCorrelation: number;
  volatilityCorrelation: number;
  beta: number;
  alpha: number;
  r2: number;
  trackingError: number;
  correlatedVolatility?: number; // Relative Volatility ratio: average absolute return of coin / average absolute return of base asset
  currentRatio: number;
  currentZScore: number;
  spreadSignal: string; // "BUY_COIN_SELL_BTC" | "SELL_COIN_BUY_BTC" | "EQUILIBRIUM"
  leadLagOptimal: {
    lag: number;
    coefficient: number;
    interpretation: string;
  };
  lagHistory: LagCoefficient[];
  rollingCorrelation: { time: number; value: number }[];
  /** Effective bars behind `rollingCorrelation`, after clamping to the sample. */
  rollingWindow: number;
  alignedData: AlignedDataPoint[];
}

export interface UnifiedMetrics {
  unifiedScore: number; // 0 to 100 overall coupling score
  priceCoupling: "High" | "Moderate" | "Low" | "Inverse";
  marketRegime: string; // e.g. "Leveraged Beta Satellite", "Decoupled Safe Haven", etc.
  hedgeRatio: number; // units of BTC to short for 1 unit of Coin to be beta-neutral
  overallSummary: string;
}

export interface CoinOption {
  symbol: string; // e.g., ETHUSDT
  baseAsset: string; // e.g., ETH
  name: string;
  category: string;
  description: string;
  isCustom?: boolean;
  /** Which venue serves this symbol's price series. */
  market?: Market;
  /** Binance contract type; "PERPETUAL" for futures entries. */
  contractType?: string;
  /**
   * Accepted straight off the live tape because the exchange catalog had not
   * caught up with the listing yet. Treat as provisional.
   */
  provisional?: boolean;
  /** Epoch ms of this asset's oldest available bar, when known. */
  firstBarTime?: number | null;
}

/** Venue a price series is served from. */
export type Market = "spot" | "futures";

/** Envelope returned by GET /api/binance-symbols. */
export interface SymbolCatalog {
  symbols: CoinOption[];
  /** Epoch ms the catalog was last pulled from Binance. */
  fetchedAt: number;
  /** True when the payload is older than the server TTL or could not be built. */
  stale: boolean;
  count: number;
  /** Non-fatal upstream problem (e.g. rate limited) while serving last known data. */
  warning: string | null;
}

export interface CoverageWindow {
  barCount: number;
  firstBarTime: number;
  lastBarOpenTime: number;
  asOf: number;
  spanHours: number;
}

export interface AnalysisResponse {
  symbol: string;
  baseAsset: string;
  name: string;
  /** Venue the subject series came from. */
  market?: Market;
  /** Venue the benchmark series came from; matches `market` in practice. */
  baseMarket?: Market;
  metrics1h: CorrelationMetrics;
  metrics15m: CorrelationMetrics;
  unified: UnifiedMetrics;
  quantMemo: string; // Gemini-generated report
  asOf?: AsOfMeta;
}

/* ------------------------------------------------------------------------- *
 * Batch Scanner
 *
 * One request sweeps up to SCAN_MAX_SYMBOLS subjects against a single
 * benchmark and returns one flat row per symbol, so the UI never has to fan out
 * 20 round trips. Anything that fails for one symbol fails alone: its row
 * carries `error` and the rest of the scan still lands.
 * ------------------------------------------------------------------------- */

/** Hard ceiling on one scan. Bounds the kline fan-out and the wall clock. */
export const SCAN_MAX_SYMBOLS = 20;

/** Parameters the user picks before a scan runs. Echoed back on the response. */
export interface ScanParams {
  /** Benchmark base asset, without the quote suffix ("BTC", "ETH", ...). */
  compareAsset: string;
  interval: "1h" | "15m";
  /** Bar count behind the rolling stability / volatility-regime windows. */
  rollingWindow: number;
  zscoreMode: ZScoreMode;
  lookbackDays: number;
  /** Pull market cap from the cached CoinGecko snapshot. */
  includeMcap: boolean;
  /** Pull 24h quote volume from Binance and ratio it against the benchmark. */
  include24hVol: boolean;
}

/** Size and turnover figures that come from outside the kline series. */
export interface ScanExtra {
  /** Circulating market cap in USD. Null when no upstream source has it. */
  mcapUsd?: number | null;
  /** 24h quote volume in USD, from the Binance rolling ticker. */
  vol24hUsd?: number | null;
  /** The benchmark's own 24h quote volume, so the ratio is reproducible. */
  vol24hBaseUsd?: number | null;
  /** vol24hUsd / vol24hBaseUsd. Turnover relative to the benchmark. */
  vol24hRatio?: number | null;
  lastPriceUsd?: number | null;
  /** Which upstream served the market cap, for provenance. */
  mcapSource?: string | null;
  /**
   * True when the market-cap row matched on ticker symbol alone. Symbols are
   * not unique off-exchange, so this is a hint, not a confirmation.
   */
  mcapSymbolMatch?: boolean;
  /**
   * Newest closed bar: taker-buy base volume / total volume, 0-1. Above 0.5 the
   * aggressive (market) buyers out-muscled the sellers on that bar.
   */
  takerBuyShare?: number | null;
  /**
   * Volume-weighted taker-buy share across the same rolling window the metrics
   * use. A steadier read of who has been winning the tape than the last bar.
   */
  takerBuyShareWindow?: number | null;
  /**
   * Newest closed bar: aggressive BUY volume / aggressive SELL volume. Above 1
   * buyers dominate; below 1 sellers do. Null when a bar had no seller volume.
   */
  buySellRatio?: number | null;
  /**
   * Newest closed bar net taker delta in USD: (2*takerBuy - volume) * close.
   * Positive is net aggressive buying, negative net selling.
   */
  takerDeltaUsd?: number | null;
}

/** Volatility-regime slice the scanner surfaces per row. */
export interface ScanVolRegime {
  /** Annualized realized vol of the subject over the rolling window. */
  coinAnnualized: number;
  baseAnnualized: number;
  /** coinAnnualized / baseAnnualized. */
  ratio: number;
  /** Percentile of that ratio inside its own history. */
  ratioPercentile: number;
  /** Annualized vol from the full sample, not just the window. */
  coinFullSample: number;
  baseFullSample: number;
  maxDrawdown: number;
  label: string;
  interpretation: string;
}

/** Correlation-stability slice the scanner surfaces per row. */
export interface ScanStability {
  /** Effective bars behind this block, echoed so the row can show what ran. */
  window: number;
  /** Rolling correlation as of the newest confirmed bar. */
  current: number;
  mean: number;
  stdDev: number;
  min: number;
  max: number;
  /** Percentile rank of `current` inside its own rolling history. */
  percentile: number;
  /** 0-100, scaled off the rolling-correlation standard deviation. */
  score: number;
  positiveSharePct: number;
  strongSharePct: number;
  /** (current - mean) / stdDev: how unusual today's coupling is. */
  regimeShiftZ: number;
  trendSlopePerBar: number;
  label: string;
  interpretation: string;
}

/**
 * Whether the subject's price-ratio Z-score has pierced ±2 (the mean-reversion
 * alert band) at any point since 00:00 UTC today. Answers the "has it already
 * fired today?" question that the trailing `currentZScore` alone cannot: a
 * spread can spike and revert within the session and still read near zero now.
 */
export interface ScanTodayZ {
  /** UTC midnight (ms) the window opens at. */
  since: number;
  /** Aligned return bars that fall inside the window. */
  bars: number;
  /** Most extreme Z in the window, sign preserved. */
  extreme: number;
  /** |extreme|. */
  maxAbs: number;
  /** A bar reached z >= threshold. */
  hitUp: boolean;
  /** A bar reached z <= -threshold. */
  hitDown: boolean;
  /** Open time (ms) of the first bar that breached, or null. */
  firstHit: number | null;
}

/** One subject's row in the scan. Every row is present, even failed ones. */
export interface ScanResultItem {
  symbol: string;
  baseAsset: string;
  name: string;
  market: Market;
  baseMarket: Market;
  /** Newest CONFIRMED bar close for this row: the data-as-of the user asked for. */
  asOf: number | null;
  asOfIso: string | null;
  /** True when the subject's own history was shorter than the requested window. */
  historyClamped: boolean;
  barCount: number;
  /** Aligned return pairs behind every metric on this row. */
  observations: number;
  /** Effective bars behind `rollingCorrelation` on this row, after clamping. */
  rollingWindow: number;
  error: string | null;

  /* Metrics. Null when `error` is set, or when the sample was too short for
     that particular calculation to mean anything. */
  priceCorrelation: number | null;
  beta: number | null;
  alpha: number | null;
  r2: number | null;
  trackingError: number | null;
  volumeCorrelation: number | null;
  volatilityCorrelation: number | null;
  currentRatio: number | null;
  currentZScore: number | null;
  /** Whether ±2 was breached since 00:00 UTC today. Null when the sample is empty. */
  todayZ: ScanTodayZ | null;
  spreadSignal: string | null;
  /** Rolling correlation series, for the expanded sparkline. */
  rollingCorrelation: { time: number; value: number }[];
  leadLag: { lag: number; coefficient: number; interpretation: string }[];
  volatilityRegime: ScanVolRegime | null;
  stability: ScanStability | null;
  extra: ScanExtra;
  /**
   * Epoch ms these metrics were last recomputed. Populated by the automated
   * engine; left null by the on-demand batch scan.
   */
  updatedAt?: number | null;
}

export interface ScanResponse {
  /** One row per requested symbol, in request order. */
  results: ScanResultItem[];
  completed: number;
  failed: number;
  total: number;
  params: ScanParams;
  benchmarkSymbol: string;
  benchmarkBaseAsset: string;
  /**
   * Oldest newest-close across the successful rows. A single "data as of" for
   * the whole scan: rows that lagged the tape show up in `lagMinutes`.
   */
  asOf: {
    timestamp: number | null;
    iso: string | null;
    lagMinutes: number | null;
    serverTime: number;
  };
  /** Non-fatal degradations: a dead market-cap source, a partial catalog, etc. */
  warnings: string[];
}

/* ------------------------------------------------------------------------- *
 * Automated Scanner
 *
 * The batch scanner above is a one-shot fan-out: the user picks a handful of
 * symbols, hits run, and the server recomputes every row from scratch. The
 * automated scanner is the always-on counterpart. It owns a persistent
 * "universe" of up to AUTO_SCAN_MAX_SYMBOLS subjects, backfills each one once,
 * then on every candle close of the chosen frame fetches ONLY the newly closed
 * bars and recomputes the row from the stored series. The symbol list and the
 * parameters survive restarts, so the universe is only ever touched when the
 * user edits it.
 * ------------------------------------------------------------------------- */

/** Hard ceiling on the always-on universe. Bounds disk, memory and fan-out. */
export const AUTO_SCAN_MAX_SYMBOLS = 100;

/**
 * Frames the automated engine runs on. Deliberately the same two the batch
 * scanner uses: the residual/stability machinery the rows surface is defined
 * on the dashboard frames, and 4h/1d would silently change their meaning.
 */
export type AutoScanInterval = "15m" | "1h";

/** Parameters the automated engine sweeps with. A superset of ScanParams. */
export interface AutoScanParams {
  /** Benchmark base asset, without the quote suffix ("BTC", "ETH", ...). */
  compareAsset: string;
  interval: AutoScanInterval;
  rollingWindow: number;
  zscoreMode: ZScoreMode;
  lookbackDays: number;
  /**
   * |residual z| at or above which a row is flagged as an actionable alert.
   * The default is the ±2 mean-reversion band the batch scanner highlights.
   */
  zThreshold: number;
  includeMcap: boolean;
  include24hVol: boolean;
}

/** The user-owned universe: which symbols, swept with which parameters. */
export interface AutoScanConfig {
  /** Upper-cased USDT symbols, in the order the user arranged them. */
  symbols: string[];
  params: AutoScanParams;
}

/** How much of the universe has been built, for the status panel. */
export interface AutoScanUniverseStats {
  total: number;
  /** Full backfill done and metrics computed. */
  ready: number;
  /** Added but still backfilling / computing. */
  warming: number;
  /** Last sweep returned an error for these. */
  failed: number;
  /** Closed subject bars held across every universe entry. */
  barsStored: number;
  /** Closed benchmark bars held per venue, summed. */
  baseBarsStored: number;
  oldestBarTime: number | null;
  newestBarTime: number | null;
}

/** Liveness + schedule of the always-on engine. */
export interface AutoScanMeta {
  /** True while a sweep is in flight. */
  running: boolean;
  /** True once the engine booted. Always true in a normal process. */
  active: boolean;
  /** Bar size of the active frame, ms. */
  intervalMs: number;
  /** Scheduled wall-clock time of the next candle-close sweep. */
  nextSweepAt: number | null;
  /** The candle close the next sweep is waiting on. */
  nextCloseAt: number | null;
  lastSweepStartedAt: number | null;
  lastSweepFinishedAt: number | null;
  lastSweepDurationMs: number | null;
  /** Rows that recomputed cleanly on the last sweep. */
  lastSweepOk: number;
  lastSweepFailed: number;
  lastSweepError: string | null;
  consecutiveFailures: number;
  /** Completed sweep count since process start. */
  sweeps: number;
}

/** Full state handed to the Scanner page's automated view. */
export interface AutoScanSnapshot {
  config: AutoScanConfig;
  /** One row per configured symbol, in config order. */
  rows: ScanResultItem[];
  benchmarkSymbol: string;
  benchmarkBaseAsset: string;
  universe: AutoScanUniverseStats;
  meta: AutoScanMeta;
  /**
   * Oldest newest-close across the successful rows: one "data as of" for the
   * whole universe, so a symbol lagging the tape is visible in `lagMinutes`.
   */
  asOf: {
    timestamp: number | null;
    iso: string | null;
    lagMinutes: number | null;
    serverTime: number;
  };
  /** Incremented on every completed sweep; the client uses it to detect new data. */
  revision: number;
  warnings: string[];
}

/**
 * Result of a config submission. With `confirm: false` the server validates and
 * normalises without applying anything, which is what the confirmation dialog
 * shows; with `confirm: true` the accepted config is committed and the universe
 * is rebuilt.
 */
export interface AutoScanConfigResponse {
  accepted: boolean;
  config: AutoScanConfig;
  warnings: string[];
  /** Symbols that could not be resolved against the live Binance catalog. */
  rejected: string[];
}

/* ------------------------------------------------------------------------- *
 * Quant Terminal
 *
 * The terminal lets the benchmark be any asset (not just BTC), so every series
 * here is named `base*` rather than `btc*` the way CorrelationMetrics is.
 * ------------------------------------------------------------------------- */

/** A single aligned return observation used by every terminal calculation. */
export interface TerminalBar {
  time: number;
  /** Bar open hour in UTC, 0-23. Drives the time-of-day and session splits. */
  hourUtc: number;
  baseLogPrice: number;
  coinLogPrice: number;
  baseReturn: number;
  coinReturn: number;
  baseAbsReturn: number;
  coinAbsReturn: number;
  baseVolume: number;
  coinVolume: number;
  /** log(coin) - log(base). The unit the log-price residual is built on. */
  logRatio: number;
}

/**
 * Column names emitted by GET /api/code-series. Columnar (one array per field)
 * rather than row objects: a 45-day 15m pull is ~4.3k bars, and the redundant
 * per-row keys cost several hundred KB of JSON that pandas would discard.
 */
export type CodeSeriesColumn =
  | "time"
  | "close_time"
  | "hour_utc"
  | "subject_open"
  | "subject_high"
  | "subject_low"
  | "subject_close"
  | "subject_volume"
  | "subject_taker_buy"
  | "subject_taker_buy_share"
  | "subject_return"
  | "bench_open"
  | "bench_high"
  | "bench_low"
  | "bench_close"
  | "bench_volume"
  | "bench_return"
  | "log_ratio";

/** Columns of the preloaded `liq` frame the Code Lab seeds alongside `df`. */
export type CodeSeriesLiqColumn =
  | "time"
  | "event_time"
  | "exchange"
  | "position"
  | "price"
  | "qty"
  | "notional";

/**
 * Recent force-orders for the Code Lab subject, sliced from the live
 * liquidation tape. Retention is only a couple of days (see
 * `retentionHours`), so a 45-day OHLCV pull still carries a short `liq`
 * frame; scripts must not assume the two spans match.
 */
export interface CodeSeriesLiquidations {
  symbol: string;
  count: number;
  /** Sum of event notional in the delivered slice, USD. */
  notional: number;
  /** Receive time of the oldest/newest delivered event, epoch ms; null if none. */
  firstEventTime: number | null;
  lastEventTime: number | null;
  /** Tape retention at request time, hours. */
  retentionHours: number;
  columns: CodeSeriesLiqColumn[];
  /**
   * Row-major, always the same width as `columns`. `time`/`event_time` are
   * epoch ms; `exchange`/`position` are strings; the numeric fields are null
   * when the venue supplied no usable value.
   */
  rows: Array<Array<number | string | null>>;
}

/** Aligned subject + benchmark OHLCV, handed to the browser-side Python kernel. */
export interface CodeSeriesResponse {
  symbol: string;
  name: string;
  baseAsset: string;
  baseSymbol: string;
  market: Market;
  baseMarket: Market;
  interval: Interval;
  lookbackDays: number;
  /** Closed bars actually delivered after aligning the two venues on time. */
  barCount: number;
  columns: CodeSeriesColumn[];
  /**
   * Bar-major values, always the same width as `columns`. `null` marks a
   * genuinely undefined cell (only the first bar's returns, which have no
   * predecessor) and lands in pandas as NaN.
   */
  rows: Array<Array<number | null>>;
  meta: {
    /** Close time of the newest bar: `time + intervalMs`. */
    asOfTimestamp: number;
    asOfIso: string;
    lagMinutes: number;
    serverTime: number;
    firstBarTime: number;
    intervalMs: number;
    historyClamped: boolean;
  };
  /** Force-orders for the subject, seeded into Python as the `liq` frame. */
  liquidations: CodeSeriesLiquidations;
  warnings: string[];
}

/** One bar of the lead/lag cross-correlation spectrum. */
export interface LagPoint {
  /**
   * Bar offset. Positive means the benchmark LEADS the subject: it
   * correlates base(t - lag) against coin(t). Negative means the subject leads.
   */
  lag: number;
  coefficient: number;
  /** Overlapping return pairs behind this coefficient. */
  observations: number;
  /** Overlap-corrected sample size used for the significance test. */
  effectiveSamples: number;
  standardError: number;
  lowerBound: number;
  upperBound: number;
  /** Clears the family-wise threshold, i.e. survives multiple-testing control. */
  significant: boolean;
  /** Clears a plain two-sided 95% band, without any correction for the scan. */
  significant95: boolean;
  isPeak: boolean;
}

export interface CrossCorrelationSpectrum {
  points: LagPoint[];
  /** Largest |coefficient| lag. */
  peakLag: number;
  peakCoefficient: number;
  /** Strongest lag clearing the family-wise threshold, else null. */
  significantPeakLag: number | null;
  significantPeakCoefficient: number | null;
  /** Strongest NON-ZERO lag clearing a plain 95% band but not the family-wise one. */
  uncorrectedLeadLag: { lag: number; coefficient: number } | null;
  /**
   * |r| a lag must clear at the family-wise 95% level across all tested lags.
   * Wide, because the lags being scanned overlap each other.
   */
  threshold: number;
  /** |r| threshold for a single untested pair at 95%. */
  threshold95: number;
  /**
   * How the spectrum should be read: a genuine lead/lag, an uncorrected hint
   * that needs more data, or plain synchrony.
   */
  verdict: "FAMILY_WISE_LAG" | "UNCORRECTED_LAG" | "SYNCHRONOUS_SIGNIFICANT" | "NO_SIGNAL";
  leader: "BASE" | "COIN" | "SYNCHRONOUS";
  leaderLabel: string;
  sampleCount: number;
}

/** Regression/correlation measured on one conditional subset of the sample. */
export interface AsymmetrySegment {
  label: string;
  description: string;
  observations: number;
  beta: number;
  correlation: number;
  r2: number;
  meanBaseReturnBps: number;
  meanCoinReturnBps: number;
}

export interface BetaAsymmetry {
  marketDown: AsymmetrySegment;
  marketTailDown: AsymmetrySegment;
  marketExtremeDown: AsymmetrySegment;
  marketUp: AsymmetrySegment;
  coinDown: AsymmetrySegment;
  upBeta: number;
  downBeta: number;
  /** downBeta - upBeta. Positive means it falls harder than it rises. */
  betaAsymmetry: number;
  /** downBeta / upBeta. */
  betaSkewRatio: number;
  /** Mean subject return on up bars as a share of mean base return. */
  upCapturePct: number;
  /** Mean subject return on down bars as a share of mean base return. */
  downCapturePct: number;
  captureRatio: number;
  baseSemiDeviation: number;
  coinSemiDeviation: number;
  /** Subject downside semideviation / benchmark downside semideviation. */
  semiDeviationRatio: number;
  label: string;
  interpretation: string;
}

export interface StabilityBucket {
  label: string;
  observations: number;
  sharePct: number;
}

export interface TimeBlockCorrelation {
  label: string;
  observations: number;
  meanCorrelation: number;
  medianCorrelation: number;
  stdDev: number;
}

export interface CorrelationStability {
  window: number;
  series: { time: number; value: number }[];
  current: number;
  mean: number;
  median: number;
  stdDev: number;
  min: number;
  max: number;
  /** Percentile rank of `current` inside its own rolling history. */
  percentile: number;
  coefficientOfVariation: number;
  /** 0-100. Scaled off the rolling-correlation standard deviation. */
  stabilityScore: number;
  positiveSharePct: number;
  strongSharePct: number;
  weakSharePct: number;
  /** (current - mean) / stdDev: how unusual today's coupling is. */
  regimeShiftZ: number;
  /** OLS slope of the rolling series, in correlation units per bar. */
  trendSlopePerBar: number;
  /** Correlation drift implied by `trendSlopePerBar` across the sample. */
  trendAcrossSample: number;
  buckets: StabilityBucket[];
  blocks: TimeBlockCorrelation[];
  label: string;
  interpretation: string;
}

export interface ResidualPoint {
  time: number;
  residual: number;
  zScore: number;
}

export interface ResidualAnalysis {
  beta: number;
  alpha: number;
  r2: number;
  residualStdDev: number;
  /** Standardisation mode behind both residual Z-series below. */
  zscoreMode: ZScoreMode;
  /** Idiosyncratic return residual, z-scored on the selected mode. */
  returnResidual: {
    zWindow: number;
    series: ResidualPoint[];
    currentResidualBps: number;
    currentZ: number;
    meanZ: number;
    stdZ: number;
    /** |Z| beyond which the idiosyncratic move is historically unusual. */
    alertThreshold: number;
    label: string;
    interpretation: string;
  };
  /**
   * OLS of log(coin) on log(base). A stationary residual here is the
   * cointegration / stat-arb gap rather than a return-spread artefact.
   */
  logPriceResidual: {
    intercept: number;
    slope: number;
    r2: number;
    /** Bars behind this residual's standardisation, same window as `returnResidual`. */
    zWindow: number;
    series: { time: number; residual: number; zScore: number }[];
    current: number;
    mean: number;
    stdDev: number;
    currentZ: number;
    /** AR(1) coefficient of the residual; < 1 implies mean reversion. */
    ar1: number;
    /** Bars for a 50% decay. null when the residual does not revert. */
    halfLifeBars: number | null;
    stationarityFlag: string;
    interpretation: string;
  };
}

export interface VolatilityStats {
  realizedVol: number;
  annualizedVol: number;
  /** Percentile of current realized vol inside its own history. */
  percentile: number;
  label: string;
  downSemiDeviation: number;
  upSemiDeviation: number;
  /** Coefficient of variation of the rolling vol series. */
  volOfVol: number;
  maxDrawdown: number;
  bollingerWidth: number;
  bollingerPercentile: number;
}

export interface VolRegimeSpan {
  label: string;
  startTime: number;
  endTime: number;
  bars: number;
}

export interface VolatilityRegime {
  window: number;
  periodsPerYear: number;
  coin: VolatilityStats;
  base: VolatilityStats;
  ratio: {
    value: number;
    mean: number;
    stdDev: number;
    percentile: number;
    label: string;
  };
  series: { time: number; coinVol: number; baseVol: number; ratio: number }[];
  spans: VolRegimeSpan[];
  label: string;
  interpretation: string;
}

/** Summary stats for one rolling-metric series, percentile vs the coin's own history. */
export interface RollingMetricStats {
  current: number;
  mean: number;
  median: number;
  stdDev: number;
  min: number;
  max: number;
  /** Percentile rank of `current` inside this metric's own rolling history, 0-100. */
  percentile: number;
  label: string;
}

/**
 * Rolling coupling of the pair: beta, correlation and the coin/base vol ratio
 * measured over the same trailing window, point for point. The three percentiles
 * answer "is this reading normal for THIS pair" — a beta of 0.8 means something
 * different for a stable 0.5 beta pair than for one that usually sits at 2.0.
 */
export interface RollingCoupling {
  window: number;
  series: { time: number; beta: number; correlation: number; volRatio: number }[];
  beta: RollingMetricStats;
  correlation: RollingMetricStats;
  volRatio: RollingMetricStats;
  interpretation: string;
}

export interface SessionStat {
  id: string;
  label: string;
  window: string;
  startHour: number;
  endHour: number;
  observations: number;
  meanReturnBps: number;
  /** Mean session return scaled to a year. A projection, not a forecast. */
  projectedAnnualPct: number;
  volatilityBps: number;
  hitRatePct: number;
  meanAbsMoveBps: number;
  /** 1 if positive-skewed; < 1 means fat left tail. */
  skew: number;
  /** t-statistic of the session mean. |t| > 2 is a real session edge. */
  tStat: number;
  totalVolume: number;
  volumeSharePct: number;
  correlation: number;
  beta: number;
  upCapturePct: number;
  downCapturePct: number;
  /** 1 = best mean return of the day. */
  rank: number;
}

export interface HourOfDayStat {
  hour: number;
  observations: number;
  meanReturnBps: number;
  volatilityBps: number;
  hitRatePct: number;
  volumeSharePct: number;
}

export interface SessionAnalysis {
  timezone: "UTC";
  sessions: SessionStat[];
  hours: HourOfDayStat[];
  bestSessionId: string;
  worstSessionId: string;
  mostVolatileSessionId: string;
  /** Spread between the best and worst session mean, in bps. */
  dispersionBps: number;
  /** Bar-level correlation, not session-scoped, for reference. */
  sessionCorrelationSpread: number;
  interpretation: string;
  boundaryNote: string;
}

export interface TerminalAsOf {
  timestamp: number;
  iso: string;
  lagMinutes: number;
  serverTime: number;
  barCount: number;
  firstBarTime: number;
  lookbackDays: number;
  maxLookbackDays: number;
  historyClamped: boolean;
  firstBarTimeAsset: number | null;
}

/** Envelope returned by GET /api/terminal. */
export interface TerminalResponse {
  symbol: string;
  name: string;
  baseAsset: string;
  baseSymbol: string;
  market: Market;
  baseMarket: Market;
  interval: Interval;
  /** Max |lag| the user asked for, and what the sample could actually support. */
  maxLag: number;
  requestedMaxLag: number;
  rollingWindow: number;
  requestedRollingWindow: number;
  /** Z-score mode applied to the residual series; echoed for the UI. */
  zscoreMode: ZScoreMode;
  bars: number;
  spectrum: CrossCorrelationSpectrum;
  asymmetry: BetaAsymmetry;
  stability: CorrelationStability;
  residual: ResidualAnalysis;
  volatility: VolatilityRegime;
  /** Rolling beta, correlation and vol-ratio over the same window, with percentiles. */
  rolling: RollingCoupling;
  sessions: SessionAnalysis;
  asOf: TerminalAsOf;
  warnings: string[];
}

/**
 * Provenance for the served series: the newest CONFIRMED candle close, how far
 * behind the wall clock it is, and the window actually used after clamping.
 */
export interface AsOfMeta {
  timestamp: number | null;
  iso: string | null;
  lagMinutes: number | null;
  serverTime: number;
  maxLookbackDays: number;
  anchorApplied: boolean;
  anchorDate: string | null;
  /**
   * The requested window exceeded the subject asset's own history and the
   * sample was narrowed to fit. Metrics are still valid, but they describe a
   * shorter period than the anchor implies.
   */
  historyClamped: boolean;
  requestedStartTime: number | null;
  effectiveStartTime: number | null;
  /** Epoch ms of the subject asset's oldest bar Binance still serves. */
  firstBarTime: number | null;
  coverage: {
    "1h": CoverageWindow | null;
    "15m": CoverageWindow | null;
  };
}

/* =========================================================================== *
 * Post-surge event probability framework
 *
 * Types for GET /api/probability, implementing post_surge_event_probability_
 * framework.md. Everything here is DESCRIPTIVE historical precedent with
 * honest uncertainty - never a forecast or a trading signal.
 * =========================================================================== */

/** Every tunable in the framework, scale-free (windows are counts of bars). */
export interface ProbabilityParams {
  interval: Interval;
  lookbackDays: number;
  universeSize: number;
  /** Trigger lookback in bars (L_surge). */
  L: number;
  /** Trigger threshold on the baseline-scaled return z-score (k_surge). */
  k: number;
  /** Pullback depth defining t_break, as a fraction of the surge range. */
  beta: number;
  /** Collapse distance below P_break as a fraction of R (delta_c). */
  deltaC: number;
  /** Extension distance above P_peak as a fraction of R (delta_e). */
  deltaE: number;
  /** Horizon multiplier: h = m * D (D = bars from origin to peak). */
  m: number;
}

/** One class of the Dirichlet posterior: mean plus joint credible intervals. */
export interface ClassProbability {
  p: number;
  ci80: [number, number];
  ci95: [number, number];
  /** Raw event count behind the estimate (0 for kernel-weighted views). */
  count: number;
}

/** Stage A: does a breakdown occur at all? Classes are mutually exclusive. */
export interface StageAClass {
  key: "breakdown" | "secondLeg" | "neither";
  label: string;
  p: number;
  ci80: [number, number];
  ci95: [number, number];
  count: number;
}

export type EpisodeStatus =
  | "awaiting-breakdown"
  | "post-breakdown"
  | "resolved-collapse"
  | "resolved-extension"
  | "resolved-consolidation"
  | "expired";

/** Where the selected symbol sits inside its own surge episode, if any. */
export interface EpisodeMeta {
  symbol: string;
  active: boolean;
  status: EpisodeStatus;
  originTime: number;
  triggerTime: number;
  breakTime: number | null;
  peakTime: number;
  lastBarTime: number;
  barsSinceBreak: number;
  horizonBars: number;
  durationBars: number;
  /** Surge range R in percent terms (log range x100). */
  surgeRangePct: number;
  /** Pullback depth at breakdown as a fraction of R (rho_break). */
  rhoBreak: number | null;
}

/**
 * The headline state: kernel-weighted analog probabilities for the current
 * feature vector, shrunk toward the parent base rate, with the gate verdict.
 */
export interface ProbabilityState {
  /** Plain-language description of the current feature vector. */
  description: string[];
  featureValues: { label: string; value: string }[];
  conditioning: string;
  gate: "PASSED" | "FALLBACK";
  flags: string[];
  /** Analog count and effective (clustering/shrinkage-adjusted) analog count. */
  nAnalog: number;
  nEff: number;
  /** Share of kernel weight coming from the most recent 20% of events. */
  recentWeightShare: number;
  /** Conditional posterior (headline when the gate passes). */
  conditional: {
    collapse: ClassProbability;
    extension: ClassProbability;
    consolidation: ClassProbability;
  };
  /**
   * What the analog model would have said. Present only when the gate failed,
   * shown greyed so the base rate stays the headline per the insufficient-data
   * rule (framework 6.5).
   */
  blocked?: {
    collapse: ClassProbability;
    extension: ClassProbability;
    consolidation: ClassProbability;
  };
  /** Pooled base rate: Stage B outcomes across every event with a breakdown. */
  base: {
    collapse: ClassProbability;
    extension: ClassProbability;
    consolidation: ClassProbability;
  };
  episode: EpisodeMeta | null;
}

export interface TimingPoint {
  /** Fraction of the horizon h. */
  frac: number;
  bars: number;
  collapse: number;
  extension: number;
}

/** Aalen-Johansen competing-risks cumulative incidence (framework 7). */
export interface TimingAnalysis {
  horizonBars: number;
  points: TimingPoint[];
  /** In bars from t_break, or null when collapse incidence never reaches 50%. */
  medianCollapseBars: number | null;
}

export interface DownsideProfile {
  /** P(reach P_peak + x*R before the collapse level, within h). */
  reachBeforeCollapse: { x: number; p: number; n: number }[];
  /** Adverse excursion from P_break, in units of R. */
  adverseExcursionR: { p50: number; p90: number; p95: number; p99: number; es95: number };
  /** Same excursion in percent above P_break. */
  adverseExcursionPct: { p50: number; p90: number; p95: number; p99: number; es95: number };
  /** Maximum favourable excursion (deepest drawdown below P_break) in R. */
  maxFavorableR: number;
  ambiguousShare: number;
  note: string;
}

/** Shrunk P(collapse | breakdown) per time block - drift of precedent. */
export interface RegimeBlockPoint {
  t: number;
  iso: string;
  label: string;
  collapse: number;
  ci80: [number, number];
  n: number;
  nEff: number;
}

export interface EpisodeSeriesPoint {
  t: number;
  iso: string;
  barsSinceBreak: number;
  /** Horizon phase in [0, 1]. */
  phase: number;
  collapse: number;
  extension: number;
  consolidation: number;
  nEff: number;
  gated: boolean;
  /** Pullback depth from the running peak, as a fraction of the running range. */
  rho: number;
}

export interface EpisodeSeries {
  symbol: string;
  originTime: number;
  breakTime: number;
  horizonBars: number;
  active: boolean;
  /** Resolved Stage B label: -1 collapse, +1 extension, 0 consolidation, null open. */
  resolvedLabel: -1 | 0 | 1 | null;
  points: EpisodeSeriesPoint[];
}

export interface ProbabilityHistory {
  regime: RegimeBlockPoint[];
  episodes: EpisodeSeries[];
}

/** Out-of-fold skill, calibration and the parameter-sensitivity grid. */
export interface HealthAnalysis {
  /** Brier skill vs climatology out of fold, null when the sample is too small. */
  bss: number | null;
  bssCi80: [number, number] | null;
  /** Calibration slope/intercept on the collapse class, out of fold. */
  calibrationSlope: number | null;
  calibrationIntercept: number | null;
  oofEvents: number;
  /** Base-rate collapse probability across the beta x m grid. */
  sensitivity: { beta: number; m: number; collapse: number; n: number }[];
  sensitivityRange: [number, number] | null;
  sensitivityVerdict: "STABLE" | "MODERATE" | "FRAGILE" | "INSUFFICIENT";
}

export interface EventAccounting {
  symbolsScanned: number;
  symbolsFailed: number;
  failedSymbols: string[];
  triggers: number;
  deduped: number;
  events: number;
  withBreakdown: number;
  secondLegOnly: number;
  neither: number;
  ambiguous: number;
  ambiguousShare: number;
  preResolved: number;
  preResolvedShare: number;
  excludedCoverage: number;
  excludedShare: number;
}

export interface FeatureGroupStatus {
  available: boolean;
  note: string;
}

export interface Diagnostics {
  accounting: EventAccounting;
  leakage: { rhoBreakMedian: number; rhoMin: number; rhoMax: number };
  features: {
    positioning: FeatureGroupStatus;
    orderFlow: FeatureGroupStatus;
    structure: FeatureGroupStatus;
    context: FeatureGroupStatus;
  };
  caveats: string[];
}

export interface ProbabilityAsOf {
  timestamp: number;
  iso: string;
  serverTime: number;
  barCount: number;
}

/** Envelope returned by GET /api/probability?view=full. */
export interface ProbabilityResponse {
  params: ProbabilityParams;
  universe: {
    requested: number;
    symbols: string[];
    windowStart: number;
    windowEnd: number;
    totalBars: number;
  };
  stageA: StageAClass[];
  stageB: ProbabilityState;
  timing: TimingAnalysis;
  downside: DownsideProfile;
  history: ProbabilityHistory;
  health: HealthAnalysis;
  diagnostics: Diagnostics;
  asOf: ProbabilityAsOf;
  warnings: string[];
}

/** Envelope returned by GET /api/probability?view=brief (terminal card). */
export interface ProbabilityBrief {
  symbol: string;
  params: ProbabilityParams;
  stageA: StageAClass[];
  state: ProbabilityState;
  asOf: ProbabilityAsOf;
  warnings: string[];
}

/* =========================================================================== *
 * Live move probability
 *
 * Types for GET /api/move-prob: an unconditional, continuously-refreshed
 * estimate of P(the selected coin trades ±X% within the next N periods),
 * measured over every historical bar in the window instead of being triggered
 * by a z-score surge. Descriptive frequency, never a forecast.
 * =========================================================================== */

/** One proportion with joint credible intervals, on the Wilson base-rate form. */
export interface MoveBarrierStat {
  count: number;
  p: number;
  ci80: [number, number];
  ci95: [number, number];
}

export interface MoveTripleStat {
  up: MoveBarrierStat;
  down: MoveBarrierStat;
  either: MoveBarrierStat;
}

/** Forward-return distribution over the horizon, close to close. */
export interface MoveForwardStats {
  p05: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  mean: number;
  pPositive: number;
}

/** P(barrier touched) inside one trailing-volatility tercile. */
export interface MoveRegimeStat {
  label: string;
  n: number;
  up: MoveBarrierStat;
  down: MoveBarrierStat;
  /** True for the tercile today's trailing volatility falls in. */
  current: boolean;
}

/** The calculation shared by both views of GET /api/move-prob. */
export interface MoveProbabilityBody {
  /** Overlapping one-bar-step windows evaluated. */
  nWindows: number;
  /** Dependence-adjusted sample size used for every interval below. */
  nEff: number;
  designEffect: number;
  /** Barrier reached at any point in the horizon (high/low basis). */
  everTouch: MoveTripleStat;
  /** Barrier closed beyond by the horizon end (close basis). */
  everClose: MoveTripleStat;
  /** First barrier reached, treated as competing risks. */
  firstTouch: {
    up: MoveBarrierStat;
    down: MoveBarrierStat;
    ambiguous: number;
    ambiguousShare: number;
  };
  forward: MoveForwardStats;
  /** Aalen-Johansen cumulative incidence: extension = up, collapse = down. */
  timing: TimingAnalysis;
  medianUpBars: number | null;
  medianDownBars: number | null;
  regimes: MoveRegimeStat[];
  /** Index into `regimes` for today's trailing volatility, or -1. */
  currentRegime: number;
  /** Percentile of today's trailing volatility within this sample (0-100). */
  currentVolPct: number;
}

export interface MoveProbabilityParams {
  symbol: string;
  interval: Interval;
  lookbackDays: number;
  /** Barrier size in percent of the entry close, e.g. 10 for ±10%. */
  thresholdPct: number;
  /** Requested horizon in hours. */
  horizonHours: number;
  /** Horizon after rounding to whole bars. */
  horizonBars: number;
  /** horizonBars expressed back in hours (what the number actually means). */
  effectiveHorizonHours: number;
}

/** Envelope returned by GET /api/move-prob?view=full. */
export interface MoveProbabilityResponse extends MoveProbabilityBody {
  symbol: string;
  market: string;
  params: MoveProbabilityParams;
  bars: number;
  lastPrice: number;
  asOf: ProbabilityAsOf;
  warnings: string[];
  caveats: string[];
}

/** Envelope returned by GET /api/move-prob?view=brief (terminal card). */
export interface MoveProbabilityBrief {
  symbol: string;
  params: MoveProbabilityParams;
  bars: number;
  lastPrice: number;
  nWindows: number;
  nEff: number;
  everTouch: MoveTripleStat;
  firstTouch: { up: MoveBarrierStat; down: MoveBarrierStat };
  asOf: ProbabilityAsOf;
  warnings: string[];
}

/* =========================================================================== *
 * Liquidations (fused liq-collector)
 *
 * Types for the in-process Binance/Bybit/OKX liquidation collectors and the
 * /api/liq/* endpoints they feed: per-coin liquidation tape plus the
 * gainers/losers leaderboard measured against the previous matching window.
 * =========================================================================== */

/** Collector windows the Liquidations page offers. */
export type LiqWindow = "1h" | "4h" | "24h";

export type LiqExchange = "binance" | "bybit" | "okx";

/** Which side of the book was wiped out: a forced sell closes a long. */
export type LiqPosition = "long" | "short" | "unknown";

/** One normalized liquidation event, shared across all three venues. */
export interface LiqEvent {
  /** Monotonic id assigned by the store; stable sort key for the tape. */
  id: number;
  exchange: LiqExchange;
  /** Normalized USDT-linear ticker, e.g. "BTCUSDT" (OKX "BTC-USDT-SWAP" folded in). */
  symbol: string;
  /** The venue's own ticker, kept for provenance. */
  venueSymbol: string;
  position: LiqPosition;
  /** Mark/breakdown price the venue reported, in quote currency. */
  price: number;
  /** Base-asset quantity force-closed. */
  qty: number;
  /** price * qty in USD, 0 when the venue supplied no usable price. */
  notional: number;
  /** Exchange event clock, ms since epoch. */
  eventTimeMs: number;
  /** Our receive clock, ms since epoch. Drives windowing and retention. */
  receivedAtMs: number;
}

/** Rolling per-exchange feed health, surfaced by GET /api/liq/status. */
export interface LiqExchangeStatus {
  exchange: LiqExchange;
  connected: boolean;
  /** Epoch ms of the last message that parsed as an event, or null. */
  lastEventAt: number | null;
  /** Epoch ms the socket last reported any traffic (incl. pongs). */
  lastMessageAt: number | null;
  eventsReceived: number;
  /** Reconnect attempts since process start; grows during an outage. */
  reconnects: number;
  error: string | null;
}

/** Aggregate liquidation totals for one symbol/window slice. */
export interface LiqTotals {
  events: number;
  /** Sum of qty in base units — only comparable within one symbol. */
  qty: number;
  notional: number;
  longEvents: number;
  longNotional: number;
  shortEvents: number;
  shortNotional: number;
  byExchange: Partial<Record<LiqExchange, { events: number; notional: number }>>;
}

/** One time bucket of the per-coin liquidation series. */
export interface LiqSeriesBucket {
  /** Bucket open time, epoch ms. */
  t: number;
  events: number;
  notional: number;
  longNotional: number;
  shortNotional: number;
}

/** Envelope returned by GET /api/liq/coin. */
export interface CoinLiqResponse {
  symbol: string;
  base: string;
  window: LiqWindow;
  /** Current window is [windowStart, windowEnd); previous is the matching span behind it. */
  windowStart: number;
  windowEnd: number;
  previousStart: number;
  current: LiqTotals;
  previous: LiqTotals;
  /** current − previous for the active window. Pct null when previous is 0. */
  delta: { events: number; eventsPct: number | null; notional: number; notionalPct: number | null };
  series: LiqSeriesBucket[];
  /** Newest first, capped by the server. */
  recent: LiqEvent[];
  /** Events still retained for this symbol regardless of window. */
  buffered: number;
}

/** One row of the gainers/losers leaderboard. */
export interface LiqLeaderRow {
  symbol: string;
  base: string;
  current: LiqTotals;
  previous: LiqTotals;
  deltaEvents: number;
  deltaEventsPct: number | null;
  deltaNotional: number;
  deltaNotionalPct: number | null;
}

/** Envelope returned by GET /api/liq/leaders. */
export interface LiqLeadersResponse {
  window: LiqWindow;
  windowStart: number;
  windowEnd: number;
  previousStart: number;
  generatedAt: number;
  /** Ranked by liquidation events, then notional: biggest rise vs previous window. */
  gainers: LiqLeaderRow[];
  /** Same metrics, ranked by the biggest fall vs the previous window. */
  losers: LiqLeaderRow[];
  symbolsActive: number;
}

/** Durable-log state, merged into GET /api/liq/status by the server. */
export interface LiqPersistenceInfo {
  enabled: boolean;
  /** Directory holding the hourly per-venue JSONL files. */
  dir: string;
  /** Events replayed from disk at boot (previous runs survive restarts). */
  replayedEvents: number;
  /** Events appended to disk by this process. */
  writtenEvents: number;
  /** Consecutive write failures; the writer disables itself past the limit. */
  writeFailures: number;
  lastError: string | null;
}

/** Envelope returned by GET /api/liq/status. */
export interface LiqStatusResponse {
  running: boolean;
  exchanges: LiqExchangeStatus[];
  bufferedEvents: number;
  /** Age of the oldest retained event, ms; null when the buffer is empty. */
  oldestEventAgeMs: number | null;
  retentionHours: number;
  serverTime: number;
  persistence?: LiqPersistenceInfo;
}

/** One candle of the liquidation-heatmap chart. */
export interface LiqHeatmapCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * One price bucket of the liquidation heatmap. `price` is the bucket centre;
 * `notional`/`longNotional`/`shortNotional` sum the force-orders whose
 * breakdown price landed in [low, high).
 */
export interface LiqHeatmapLevel {
  price: number;
  low: number;
  high: number;
  notional: number;
  longNotional: number;
  shortNotional: number;
  events: number;
}

/** Envelope returned by GET /api/liq/heatmap. */
export interface LiqHeatmapResponse {
  symbol: string;
  /** Binance kline interval used for the candles (e.g. "1m", "5m", "15m"). */
  interval: string;
  /** Candle duration in ms, for axis labels. */
  barMs: number;
  window: LiqWindow;
  windowStart: number;
  windowEnd: number;
  candles: LiqHeatmapCandle[];
  /** Non-empty price buckets, ascending by price. */
  levels: LiqHeatmapLevel[];
  /** Largest bucket notional, for normalising band intensity. */
  maxLevelNotional: number;
  /**
   * Raw prints behind the bands, ascending by receive clock, so the client can
   * snap them to its own price grid instead of inheriting the 90-bucket split.
   */
  events: LiqHeatmapEvent[];
  eventCount: number;
  notional: number;
  retentionHours: number;
}

/**
 * One liquidation print, flattened for the ladder chart. Same facts as
 * `LiqEvent` with the keys the chart reads; `t` is the receive clock the
 * candles are indexed against, `et` the venue's own event clock.
 */
export interface LiqHeatmapEvent {
  t: number;
  et: number;
  exchange: LiqExchange;
  position: LiqPosition;
  price: number;
  qty: number;
  notional: number;
}

/* =========================================================================== *
 * Position Management (Position Analyst)
 *
 * Spec: position_analyst_spec.md. Given a symbol and a position, produce a
 * data-grounded verdict across four layers (move anomaly, TP/SL reachability,
 * opposing levels, market-relative plausibility) plus the position header,
 * order book, open interest, funding, flow pulse and data-health cards.
 *
 * Everything here is Binance-only where a multi-venue aggregate would be
 * required; fields that need other venues or stored cross-sectional history
 * come back null with an explicit "unavailable" status rather than a guess.
 * =========================================================================== */

export type PositionSide = "long" | "short";

/** Combined verdict over the position. `INSUFFICIENT` = not enough analogs. */
export type PositionVerdict = "FAVORABLE" | "NEUTRAL" | "ADVERSE" | "NO_EDGE" | "INSUFFICIENT";

/** Which market a value came from: a spot book or a perpetual swap. */
export type PositionMarketType = "spot" | "perp";

/**
 * Per-venue/-field acquisition status. `not_listed` may only be used when the
 * venue's own instrument list confirms the symbol is absent; anything merely
 * uncoded is `not_implemented`.
 */
export type PositionVenueStatus =
  | "ok"
  | "stale"
  | "failed"
  | "unsupported"
  | "not_implemented"
  | "not_listed"
  | "no_history";

/** Per-field provenance badge shown on every card. */
export type PositionFieldStatus =
  | "ok"
  | "stale"
  | "failed"
  | "unavailable"
  | "manual"
  | "unsupported"
  | "not_implemented"
  | "not_listed"
  | "no_history"
  | "insufficient_baseline";

/** A forward-looking alert the verdict must surface above its reasons. */
export interface PositionAlert {
  code: "EXPIRED" | "STOP_BREACHED" | "TARGET_REACHED" | "STOP_IMMINENT";
  severity: "info" | "warning" | "critical";
  message: string;
}

/**
 * One venue's contribution to the aggregate OI/volume/funding snapshot, built
 * server-side. `status` is the honest acquisition state, never inferred.
 */
export interface PositionVenueSnapshot {
  venue: "binance" | "bybit" | "okx" | "hyperliquid";
  marketType: PositionMarketType;
  oiUsd: number | null;
  oiBase: number | null;
  vol24Usd: number | null;
  markPrice: number | null;
  fundingRate: number | null;
  nextFundingTime: number | null;
  status: PositionVenueStatus;
  venueSymbol: string | null;
  fetchedAt: number;
  note?: string;
}

/** Trade-quality figures measured from the entry, kept out of the verdict. */
export interface PositionTradeQuality {
  entryKTp: number | null;
  entryKSl: number | null;
  entryDTp: number | null;
  entryDSl: number | null;
  entryPTouchTp: number | null;
  entryPTouchSl: number | null;
  entryTpFirstDriftless: number | null;
}

/** Diagnostics for the k-nearest-neighbour analog set. */
export interface PositionAnalog {
  nRaw: number;
  nEff: number;
  pooled: boolean;
  gate: "ok" | "insufficient_evidence";
  featureDistanceMin: number | null;
  featureDistanceMax: number | null;
  featuresUsed: string[];
  featuresOmitted: string[];
  dateStart: number | null;
  dateEnd: number | null;
  allPrecede: boolean;
  horizonBars: number;
  minSpacingBars: number;
}

/** A single number with its source, freshness and status, for the health card. */
export interface PositionField {
  key: string;
  label: string;
  value: string;
  source: string;
  /** Age in ms at analysis time; null when the value carries no clock. */
  ageMs: number | null;
  status: PositionFieldStatus;
  /** Which card/layer consumes this field. */
  usedIn: string;
  note?: string;
}

/** Caller-supplied position definition (page form, persisted to localStorage). */
export interface PositionInput {
  symbol: string;
  side: PositionSide;
  entry: number;
  takeProfit: number | null;
  stopLoss: number | null;
  /** Position size in base asset units; null when only entry/levels are known. */
  size: number | null;
  leverage: number | null;
  /** Epoch ms the position was opened; null when not tracked. */
  openedAt: number | null;
  /** Holding horizon in hours (spec default 12). */
  horizonHours: number;
  /** Taker fee per side, bps (spec default 5). */
  feeBpsOneSide: number;
  /** Assumed slippage per side, bps. */
  slippageBps: number;
  /** Spot or perp book/klines. Defaults to perp when the symbol exists on perp. */
  marketType?: PositionMarketType;
  /** Symbol max leverage, cap for the modelled liquidation tiers. */
  maxLeverage?: number | null;
  /** Explicit reference price; when absent the mark is used for a live position. */
  referencePrice?: number | null;
}

/** One order-book depth band around the mid. */
export interface PositionDepthBand {
  bandBps: number;
  bidUsd: number;
  askUsd: number;
  /** (bid - ask) / (bid + ask), in [-1, 1]; positive = bid-heavy. */
  imbalance: number;
}

export interface PositionWall {
  side: "bid" | "ask";
  price: number;
  sizeUsd: number;
  /** Signed distance from mid, fraction (e.g. -0.01 = 1% below). */
  distancePct: number;
}

export interface PositionCumDepth {
  price: number;
  cumBidUsd: number;
  cumAskUsd: number;
}

export interface PositionOrderBook {
  venue: string;
  fetchedAt: number | null;
  ageMs: number | null;
  midPrice: number | null;
  spreadBps: number | null;
  bands: PositionDepthBand[];
  walls: PositionWall[];
  cumulative: PositionCumDepth[];
  /** Notional to sweep from mid to `price` on the opposing side. */
  note: string;
}

export interface PositionOiVenue {
  venue: string;
  oiUsd: number | null;
  oiBase: number | null;
  status: PositionVenueStatus;
  lastDataAt: number | null;
  /** Venue mark used to convert base OI to USD. */
  venuePrice: number | null;
  marketType: PositionMarketType;
  note?: string;
}

export interface PositionOiDelta {
  window: string;
  deltaBase: number | null;
  deltaPct: number | null;
  /** The two distinct sample timestamps the window was computed from. */
  fromTime: number | null;
  toTime: number | null;
}

export interface PositionOpenInterest {
  totalUsd: number | null;
  totalBase: number | null;
  markPrice: number | null;
  venues: PositionOiVenue[];
  deltas: PositionOiDelta[];
  quadrant: string;
  oiVsVol: number | null;
  lastDataAt: number | null;
  note: string;
}

/** One row of the vertical levels ladder. */
export interface PositionLadderRow {
  price: number;
  /** Weighted resting supply treated as resistance above the mark. */
  resistanceUsd: number;
  /** Weighted resting demand treated as support below the mark. */
  supportUsd: number;
  /** Modelled liquidation notional for longs at this price. */
  liqLongUsd: number;
  /** Modelled liquidation notional for shorts at this price. */
  liqShortUsd: number;
  /** Combined weighted volume, for bucket intensity. */
  totalUsd: number;
  /** Nearest candle-group polarity at this bucket: "bull" | "bear" | "mixed". */
  polarity: "bull" | "bear" | "mixed";
}

export interface PositionLevel {
  price: number;
  low: number;
  high: number;
  /** Weighted traded volume for the bucket, cosmetics only (not USD). */
  weight: number;
  /** Percentile of this bucket's weight across all buckets, 0-100. */
  strengthPct: number;
  /** Signed distance from mark, in ATR units. */
  distanceAtr: number;
  /** Signed distance from mark, fraction. */
  distancePct: number;
  /** "support" below the mark, "resistance" above. */
  role: "support" | "resistance";
  polarity: "bull" | "bear" | "mixed";
  /** True when this level sits inside the entry→TP or entry→SL price corridor. */
  inCorridor: boolean;
}

export interface PositionLiquidationEstimate {
  leverage: number;
  price: number;
  side: "long" | "short";
  /** Modelled notional liquidated when price reaches this level. */
  notionalUsd: number | null;
  distancePct: number;
}

export interface PositionLevels {
  atr: number;
  markPrice: number | null;
  bucketPct: number;
  levels: PositionLevel[];
  nearestResistance: PositionLevel | null;
  nearestSupport: PositionLevel | null;
  airPockets: { low: number; high: number; center: number; distancePct: number }[];
  betweenEntryTp: { count: number; resistanceUsd: number };
  betweenEntrySl: { count: number; supportUsd: number };
  liquidationEstimates: PositionLiquidationEstimate[];
  /** Modelled liquidation notional per ladder bucket, for the ladder chart. */
  ladder: PositionLadderRow[];
  method: string;
}

export interface PositionMoveDriver {
  key: string;
  label: string;
  /** Standardised reading over the move window. */
  z: number | null;
  /** "high" | "normal" | "low" | "unavailable". */
  level: string;
  note: string;
}

export interface PositionMoveForward {
  horizonBars: number;
  horizonHours: number;
  n: number;
  pPositive: number | null;
  median: number | null;
  p10: number | null;
  p90: number | null;
  /** Extra fixed windows (4 and 16 bars) alongside the full horizon. */
  extra: { bars: number; horizonHours: number; n: number; pPositive: number | null; median: number | null }[];
}

export interface PositionMove {
  moveBars: number;
  moveReturn: number;
  moveStartTime: number | null;
  moveEndTime: number | null;
  zRaw: number;
  zRes: number;
  beta: number;
  r2: number;
  percentile: number;
  sigmaBaseline: number;
  class: string;
  quadrant: string;
  breadth: number | null;
  explainedFraction: number;
  drivers: PositionMoveDriver[];
  forward: PositionMoveForward | null;
  label: string;
  interpretation: string;
}

export interface PositionReachability {
  horizonBars: number;
  /** Price every forward distance is measured from: mark (live) or entry (pre-entry). */
  referencePrice: number;
  referenceSource: "mark" | "entry" | "manual";
  sigmaH: number;
  sigmaHEmpirical: number | null;
  sigmaDivergence: number | null;
  /** ATR (price) and its percent of the mark, with the statistical/empirical ratio. */
  atr: number;
  atrPct: number | null;
  sigmaBaselinePct: number | null;
  sigmaRatio: number | null;
  dTp: number | null;
  dSl: number | null;
  kTp: number | null;
  kSl: number | null;
  pTouchTp: number | null;
  pTouchSl: number | null;
  pTpFirstDriftless: number | null;
  sweepRatioTp: number | null;
  sweepRatioSl: number | null;
  depthImbalance: number | null;
  tpInCluster: boolean | null;
  slExposed: boolean | null;
  fundingInWindow: number;
  /** Entry-based geometry kept separate from the forward verdict. */
  tradeQuality: PositionTradeQuality;
  label: string;
  interpretation: string;
}

export interface PositionOutcome {
  pTp: number | null;
  pSl: number | null;
  pTimeout: number | null;
  pTpCi: [number, number] | null;
  pSlCi: [number, number] | null;
  n: number;
  /** raw nearest-neighbour count and the H-spaced effective count driving the CIs. */
  nRaw: number;
  nEff: number;
  analog: PositionAnalog;
  /** Set when the mark has already crossed a barrier: probabilities are withheld. */
  status: "STOP_BREACHED" | "TARGET_REACHED" | null;
  ciWidthTp: number | null;
  ciWidthSl: number | null;
  dateStart: number | null;
  dateEnd: number | null;
  medianBarsToExit: number | null;
  mfeMedian: number | null;
  maeMedian: number | null;
  ev: number | null;
  evLower: number | null;
  payoffRatio: number | null;
  noEdge: boolean;
  note: string;
}

export interface PositionMarketRelative {
  marketType: PositionMarketType;
  mcapUsd: number | null;
  fdvUsd: number | null;
  vol24Usd: number | null;
  volMcap: number | null;
  oiUsd: number | null;
  oiMcap: number | null;
  oiVol: number | null;
  fdvMcap: number | null;
  universePercentiles: null;
  tierPercentiles: null;
  vDayUsd: number | null;
  vHorizonUsd: number | null;
  qRequiredDayUsd: number | null;
  qRequiredHorizonUsd: number | null;
  fMaxUsd: number | null;
  plausFlow: number | null;
  /** Fractional target move used by Q_required (from the reference price). */
  targetMove: number | null;
  /** Spot-perp basis (perp mark / spot mark - 1); null when either is missing. */
  basisPct: number | null;
  /** Constants actually used, surfaced on the card. */
  constants: { yImpact: number; liqFraction: number; sigmaH: number; vHorizonUsd: number | null; vDayUsd: number | null };
  empiricalMovePercentile: number | null;
  label: "PLAUSIBLE" | "STRETCHED" | "IMPLAUSIBLE" | "UNAVAILABLE";
  flags: string[];
  note: string;
}

export interface PositionFundingVenue {
  venue: string;
  rate: number | null;
  status: PositionFieldStatus;
}

export interface PositionFunding {
  venues: PositionFundingVenue[];
  /** Notional-weighted across venues with OI, not a single-venue copy. */
  oiWeightedRate: number | null;
  nextSettlement: number | null;
  settlementsInWindow: number[];
  crowdingPercentile: number | null;
  /** Set only when the coin's own stored funding history is deep enough. */
  crowdingBasis: "ok" | "insufficient_history";
  note: string;
}

export interface PositionFlow {
  windowHours: number;
  liqLongUsd: number;
  liqShortUsd: number;
  liqSeries: { t: number; longNotional: number; shortNotional: number }[];
  cvd: number | null;
  cvdSeries: { t: number; value: number }[];
  bigTrades: { time: number; side: "long" | "short"; price: number; notionalUsd: number; exchange: string }[];
  relevantSide: PositionSide;
  note: string;
}

export interface PositionHeader {
  side: PositionSide;
  entry: number;
  mark: number | null;
  /** mark for a live position, entry for a pre-entry analysis, or manual. */
  referencePrice: number;
  referenceSource: "mark" | "entry" | "manual";
  sizeUsd: number | null;
  leverage: number | null;
  uPnlUsd: number | null;
  uPnlPct: number | null;
  rMultiple: number | null;
  takeProfit: number | null;
  stopLoss: number | null;
  distanceToTpPct: number | null;
  distanceToSlPct: number | null;
  distanceToTpSigma: number | null;
  distanceToSlSigma: number | null;
  horizonHours: number;
  elapsedHours: number | null;
  remainingHours: number | null;
  timeoutAt: number | null;
  expired: boolean;
  /** Alerts (expiry, stop/target crossing, imminent stop), listed first. */
  alerts: PositionAlert[];
}

export interface PositionConfidenceReason {
  label: string;
  penalty: number;
}

export interface PositionVerdictBlock {
  verdict: PositionVerdict;
  evLower: number | null;
  suggestedFraction: number | null;
  suggestedSizeUsd: number | null;
  reasonsFor: string[];
  reasonsAgainst: string[];
  /** Neutral book observations (previously misfiled as reasons for). */
  notes: string[];
  invalidation: string[];
  alerts: PositionAlert[];
  confidence: number;
  confidenceReasons: PositionConfidenceReason[];
  degradedInputs: string[];
}

export interface PositionAnalysisResponse {
  analysisId: string;
  generatedAt: number;
  symbol: string;
  baseAsset: string;
  name: string;
  market: Market;
  /** Spot or perp analytics; a leveraged position is analysed on the perp book. */
  marketType: PositionMarketType;
  interval: Interval;
  input: PositionInput;
  asOf: {
    timestamp: number;
    iso: string;
    lagMinutes: number;
    bars: number;
    firstBarTime: number | null;
    historyDays: number;
    historyClamped: boolean;
  };
  header: PositionHeader;
  verdictBlock: PositionVerdictBlock;
  move: PositionMove;
  reachability: PositionReachability;
  orderBook: PositionOrderBook;
  openInterest: PositionOpenInterest;
  levels: PositionLevels;
  outcome: PositionOutcome;
  marketRelative: PositionMarketRelative;
  funding: PositionFunding;
  flow: PositionFlow;
  health: PositionField[];
  warnings: string[];
  caveats: string[];
}
