/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  Activity,
  Clock3,
  Gauge,
  Layers,
  RefreshCw,
  Repeat,
  Sigma,
  TrendingDown,
  Waves,
  Zap,
} from "lucide-react";
import { Interval, TerminalResponse, ZScoreMode } from "../types";
import {
  MAX_LOOKBACK_DAYS,
  TERMINAL_INTERVAL_MS,
  defaultLookbackDays,
  defaultRollingWindow,
} from "../utils/terminal_calculations";
import {
  TerminalRequestParams,
  fetchTerminal,
  peekTerminalCache,
} from "../utils/terminalPrefetch";
import MetricCard from "./MetricCard";
import { formatUtcStamp } from "../utils/dates";
import TerminalBoot from "./terminal/TerminalBoot";
import SessionPanel from "./terminal/SessionPanel";
import CoinLiquidationMetrics from "./terminal/CoinLiquidationMetrics";
import { MoveProbabilityCard } from "./MoveProbability";
import {
  BetaAsymmetryChart,
  CrossCorrelationSpectrumChart,
  EmptyState,
  RegimeSpanStrip,
  ResidualZScoreChart,
  RollingCouplingChart,
  StabilityHistogram,
  StabilitySeriesChart,
  TerminalPanel,
  VolatilityRegimeChart,
} from "./terminal/TerminalCharts";

const INTERVALS: Interval[] = ["15m", "1h", "4h", "1d"];

const LOOKBACK_OPTIONS: { value: number; label: string }[] = [
  { value: 7, label: "7D" },
  { value: 14, label: "14D" },
  { value: 30, label: "30D" },
  { value: 45, label: "45D" },
  { value: 90, label: "90D" },
  { value: 180, label: "180D" },
  { value: 365, label: "365D" },
];

const LAG_OPTIONS = [1, 2, 4, 6, 8, 12, 18, 24, 36, 48, 72];

/**
 * Z-score standardisation modes, matching the dashboard and scanner. Exposed
 * here because the terminal's two residual series must be standardised the
 * same way the ratio Z-score is elsewhere, or the same pair reads differently
 * depending on which tab is open.
 */
const ZSCORE_MODES: ZScoreMode[] = ["expanding", "rolling", "batch"];

function StatChip({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "positive" | "negative" | "neutral";
}) {
  const toneClass =
    tone === "positive"
      ? "text-emerald-400"
      : tone === "negative"
      ? "text-rose-400"
      : "text-slate-200";
  return (
    <div className="bg-[#0a0a0b] border border-[#1f1f23] rounded p-3 min-w-0">
      <div className="text-[9px] font-mono text-slate-500 uppercase tracking-wider truncate">
        {label}
      </div>
      <div className={`text-lg font-mono font-bold leading-tight mt-0.5 ${toneClass}`}>{value}</div>
      {sub && <div className="text-[9px] font-mono text-slate-600 mt-0.5 leading-snug">{sub}</div>}
    </div>
  );
}

function DataTable({
  headers,
  rows,
}: {
  headers: string[];
  rows: (React.ReactNode)[][];
}) {
  return (
    <div className="overflow-x-auto custom-scrollbar">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-[#1f1f23]">
            {headers.map((h) => (
              <th
                key={h}
                className="py-2 px-2 text-[9px] font-mono text-slate-500 uppercase tracking-wider font-bold whitespace-nowrap"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-[#1f1f23]/60 last:border-0">
              {row.map((cell, j) => (
                <td key={j} className="py-1.5 px-2 font-mono text-[10px] text-slate-300 whitespace-nowrap">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function TerminalModule(props: {
  symbol: string;
  benchmark: string;
  name: string;
  onOpenTape?: () => void;
  initialInterval?: Interval;
  initialLookbackDays?: number;
  initialRollingWindow?: number;
  initialZscoreMode?: ZScoreMode;
}) {
  const { symbol, benchmark, name, onOpenTape } = props;
  const [interval, setInterval] = useState<Interval>((props.initialInterval as any) ?? "1h");
  const [lookbackDays, setLookbackDays] = useState<number>((props.initialLookbackDays as any) ?? defaultLookbackDays("1h"));
  const [maxLag, setMaxLag] = useState<number>(12);
  const [rollingWindow, setRollingWindow] = useState<number>((props.initialRollingWindow as any) ?? defaultRollingWindow("1h"));
  const [zscoreMode, setZscoreMode] = useState<ZScoreMode>((props.initialZscoreMode as any) ?? "rolling");
 
   const [data, setData] = useState<TerminalResponse | null>(null);
   const [loading, setLoading] = useState(true);
   const [error, setError] = useState<string | null>(null);
  const [booting, setBooting] = useState(false);
  const [bootKey, setBootKey] = useState(0);
  const hasBooted = useRef(true);

  // Changing the interval invalidates the lookback, lag and window defaults for
  // the new bar size, so they are re-derived instead of being carried over.
  const handleIntervalChange = (next: Interval) => {
    setInterval(next);
    setLookbackDays((current) =>
      current > MAX_LOOKBACK_DAYS[next] ? defaultLookbackDays(next) : current
    );
    setRollingWindow((current) =>
      current > defaultRollingWindow(next) * 3 ? defaultRollingWindow(next) : current
    );
  };

  const load = useCallback(
    async (opts?: { force?: boolean }) => {
      const params: TerminalRequestParams = {
        symbol,
        benchmark,
        interval,
        lookbackDays,
        maxLag,
        rollingWindow,
        zscoreMode,
      };

      // A frame warmed by the background prefetch (or one opened earlier this
      // session) renders immediately. Only a miss or an explicit RECOMPUTE pays
      // the round trip; the boot overlay still plays over the ready data.
      if (!opts?.force) {
        const cached = peekTerminalCache(params);
        if (cached) {
          setData(cached);
          setError(null);
          setLoading(false);
          return;
        }
      }

      setLoading(true);
      setError(null);
      try {
        const json = await fetchTerminal(params, { force: opts?.force });
        setData(json);
      } catch (err: any) {
        setError(err.message || "Failed to compute the terminal panel.");
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [symbol, benchmark, interval, lookbackDays, maxLag, rollingWindow, zscoreMode]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const minutesPerBar = TERMINAL_INTERVAL_MS[interval] / 60000;
  const intervalLabel =
    interval === "15m" ? "15 min" : interval === "1h" ? "1 hour" : interval === "4h" ? "4 hour" : "Daily";

  const notableLags = useMemo(() => {
    if (!data) return [];
    return data.spectrum.points
      .filter((p) => p.significant || p.significant95 || p.lag === 0)
      .map((p) => [
        p.lag > 0 ? `+${p.lag}` : String(p.lag),
        p.lag > 0 ? "base leads" : p.lag < 0 ? "subject leads" : "synchronous",
        p.coefficient.toFixed(4),
        String(p.observations),
        String(p.effectiveSamples),
        p.standardError.toFixed(4),
        p.significant ? "family-wise" : p.significant95 ? "95% only" : "-",
      ]);
  }, [data]);

  const stabilityBlocks = useMemo(() => {
    if (!data) return [];
    return data.stability.blocks.map((b) => [
      b.label,
      String(b.observations),
      b.meanCorrelation.toFixed(4),
      b.medianCorrelation.toFixed(4),
      b.stdDev.toFixed(4),
      ((b.meanCorrelation - data.stability.mean) * 100).toFixed(1) + "%",
    ]);
  }, [data]);

  return (
    <div className="relative">
      {/* ---------------------------------------------------------------- *
       * Control rail
       * ---------------------------------------------------------------- */}
      <div className="bg-[#0e0e10] border border-[#1f1f23] rounded-xl p-4 mb-5">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
          <ControlGroup label="Timeframe">
            <div className="flex gap-1">
              {INTERVALS.map((iv) => (
                <button
                  key={iv}
                  type="button"
                  onClick={() => handleIntervalChange(iv)}
                  className={`px-2.5 h-7 text-[10px] font-mono rounded border cursor-pointer transition-colors ${
                    interval === iv
                      ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-300"
                      : "bg-[#0a0a0b] border-[#1f1f23] text-slate-500 hover:text-slate-300"
                  }`}
                >
                  {iv}
                </button>
              ))}
            </div>
          </ControlGroup>

          <ControlGroup label={`Lookback (max ${MAX_LOOKBACK_DAYS[interval]}d)`}>
            <div className="flex flex-wrap gap-1 max-w-[260px]">
              {LOOKBACK_OPTIONS.filter((o) => o.value <= MAX_LOOKBACK_DAYS[interval]).map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setLookbackDays(o.value)}
                  className={`px-2 h-7 text-[10px] font-mono rounded border cursor-pointer transition-colors ${
                    lookbackDays === o.value
                      ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-300"
                      : "bg-[#0a0a0b] border-[#1f1f23] text-slate-500 hover:text-slate-300"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </ControlGroup>

          <ControlGroup label="Lead/Lag range (± bars)">
            <div className="flex flex-wrap gap-1 max-w-[280px]">
              {LAG_OPTIONS.filter((v) => v * 8 <= 4000).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setMaxLag(v)}
                  className={`px-2 h-7 text-[10px] font-mono rounded border cursor-pointer transition-colors ${
                    maxLag === v
                      ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-300"
                      : "bg-[#0a0a0b] border-[#1f1f23] text-slate-500 hover:text-slate-300"
                  }`}
                >
                  ±{v}
                </button>
              ))}
            </div>
          </ControlGroup>

          <ControlGroup label="Rolling window (bars)">
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={5}
                max={Math.max(20, Math.min(400, data ? data.bars : 200))}
                step={1}
                value={rollingWindow}
                onChange={(e) => setRollingWindow(Number(e.target.value))}
                className="w-28 accent-emerald-500 cursor-pointer"
              />
              <span className="text-[11px] font-mono text-emerald-400 w-8 text-right">
                {rollingWindow}
              </span>
            </div>
          </ControlGroup>

          <ControlGroup label="Z-score mode">
            <div className="flex flex-wrap gap-1">
              {ZSCORE_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setZscoreMode(mode)}
                  className={`px-2 h-7 text-[10px] font-mono rounded border cursor-pointer transition-colors ${
                    zscoreMode === mode
                      ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-300"
                      : "bg-[#0a0a0b] border-[#1f1f23] text-slate-500 hover:text-slate-300"
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </ControlGroup>

          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={() => setBootKey((k) => k + 1)}
              title="Replay the boot sequence"
              className="h-7 px-2.5 text-[10px] font-mono rounded border border-[#1f1f23] bg-[#0a0a0b] text-slate-400 hover:text-emerald-400 hover:border-emerald-500/40 cursor-pointer flex items-center gap-1.5"
            >
              <Zap size={11} /> REBOOT
            </button>
            <button
              type="button"
              onClick={() => void load({ force: true })}
              title="Recompute from the live tape"
              className="h-7 px-2.5 text-[10px] font-mono rounded border border-[#1f1f23] bg-[#0a0a0b] text-slate-400 hover:text-emerald-400 hover:border-emerald-500/40 cursor-pointer flex items-center gap-1.5"
            >
              <RefreshCw size={11} className={loading ? "animate-spin" : ""} /> RECOMPUTE
            </button>
          </div>
        </div>

        {data && (
          <div className="mt-3 pt-3 border-t border-[#1f1f23] flex flex-wrap items-center gap-x-5 gap-y-1 text-[9px] font-mono text-slate-500">
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              {data.bars} aligned bars
            </span>
            <span className="flex items-center gap-1">
              <Clock3 size={10} />
              as of {formatUtcStamp(new Date(data.asOf.iso).getTime())} UTC · lag {data.asOf.lagMinutes}m
            </span>
            <span>
              {symbol} on {data.market} · {benchmarkSymbol(benchmark)} on {data.baseMarket}
            </span>
            {data.asOf.historyClamped && (
              <span className="text-amber-400">
                window clamped to listing history from{" "}
                {data.asOf.firstBarTimeAsset
                  ? formatUtcStamp(data.asOf.firstBarTimeAsset).slice(0, 10)
                  : "unknown"}
              </span>
            )}
            {data.maxLag < data.requestedMaxLag && (
              <span className="text-amber-400">lag range trimmed to ±{data.maxLag}</span>
            )}
          </div>
        )}
      </div>

      {/* Non-fatal notes from the calculation, shown above the panels. */}
      {data && data.warnings.length > 0 && (
        <div className="mb-5 p-3 bg-amber-500/[0.06] border border-amber-500/25 rounded flex items-start gap-2.5">
          <AlertTriangle size={13} className="text-amber-400 mt-0.5 shrink-0" />
          <div className="space-y-0.5">
            {data.warnings.map((w) => (
              <p key={w} className="text-[10px] font-mono text-amber-300/90 leading-relaxed">
                {w}
              </p>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="mb-5 p-4 bg-rose-950/80 border border-rose-800/40 text-rose-300 rounded flex items-start space-x-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div>
            <span className="text-xs font-semibold block font-mono">TERMINAL CALCULATION FAILED</span>
            <p className="text-xs text-rose-400/90 mt-1 leading-normal font-sans">{error}</p>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------- *
       * Headline strip
       * ---------------------------------------------------------------- */}
      {loading && !data ? (
        <div className="py-16 flex flex-col items-center justify-center">
          <div className="relative">
            <div className="w-14 h-14 rounded-full border-2 border-[#1f1f23] animate-pulse" />
            <div className="absolute inset-0 w-14 h-14 rounded-full border-t-2 border-emerald-400 animate-spin" />
          </div>
          <span className="text-xs font-mono text-slate-500 uppercase tracking-widest mt-6 animate-pulse">
            Computing deep analytics...
          </span>
        </div>
      ) : data ? (
        <div className="space-y-6">
          <MoveProbabilityCard
            symbol={symbol}
            name={name}
            interval={interval}
            lookbackDays={lookbackDays}
          />
          <motion.div
            initial="hidden"
            animate="shown"
            variants={{ shown: { transition: { staggerChildren: 0.055 } } }}
            className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3"
          >
            {[
              {
                label: "Lead/Lag Verdict",
                value:
                  data.spectrum.significantPeakLag !== null
                    ? `${data.spectrum.significantPeakLag > 0 ? benchmark : name} ${data.spectrum.significantPeakLag > 0 ? "LEADS" : "LEADS"}`
                    : data.spectrum.uncorrectedLeadLag
                    ? "HINT ONLY"
                    : "SYNCHRONOUS",
                sub: data.spectrum.significantPeakLag !== null
                  ? `${data.spectrum.significantPeakLag > 0 ? "+" : ""}${data.spectrum.significantPeakLag} bars (${(Math.abs(data.spectrum.significantPeakLag) * minutesPerBar).toFixed(0)}m)`
                  : data.spectrum.uncorrectedLeadLag
                  ? `lag ${data.spectrum.uncorrectedLeadLag.lag}, fails correction`
                  : `peak r ${data.spectrum.peakCoefficient.toFixed(3)} at ${data.spectrum.peakLag > 0 ? "+" : ""}${data.spectrum.peakLag}`,
                tone: "neutral" as const,
              },
              {
                label: "Downside Beta",
                value: data.asymmetry.downBeta.toFixed(3),
                sub: `upside ${data.asymmetry.upBeta.toFixed(3)} · skew ${data.asymmetry.betaSkewRatio.toFixed(2)}x · rolling ρ${Math.round(data.rolling.beta.percentile)}`,
                tone:
                  Math.abs(data.asymmetry.downBeta) > Math.abs(data.asymmetry.upBeta) * 1.2
                    ? ("negative" as const)
                    : ("neutral" as const),
              },
              {
                label: "Downside Correlation",
                value: data.asymmetry.marketDown.correlation.toFixed(4),
                sub: `${data.asymmetry.marketDown.observations} bars with base down`,
                tone: "neutral" as const,
              },
              {
                label: "Correlation Stability",
                value: `${data.stability.stabilityScore}/100`,
                sub: `${data.stability.label} · sd ${data.stability.stdDev.toFixed(3)}`,
                tone:
                  data.stability.stabilityScore >= 70
                    ? ("positive" as const)
                    : data.stability.stabilityScore < 40
                    ? ("negative" as const)
                    : ("neutral" as const),
              },
              {
                label: "Residual Z (return)",
                value: `${data.residual.returnResidual.currentZ > 0 ? "+" : ""}${data.residual.returnResidual.currentZ.toFixed(2)}`,
                sub: data.residual.returnResidual.label,
                tone:
                  Math.abs(data.residual.returnResidual.currentZ) >= data.residual.returnResidual.alertThreshold
                    ? data.residual.returnResidual.currentZ > 0
                      ? ("negative" as const)
                      : ("positive" as const)
                    : ("neutral" as const),
              },
              {
                label: "Vol Regime",
                value: data.volatility.label,
                sub: `${(data.volatility.coin.annualizedVol * 100).toFixed(0)}% vs ${(data.volatility.base.annualizedVol * 100).toFixed(0)}% · p${data.volatility.coin.percentile.toFixed(0)}`,
                tone:
                  data.volatility.coin.percentile >= 90
                    ? ("negative" as const)
                    : data.volatility.coin.percentile < 30
                    ? ("positive" as const)
                    : ("neutral" as const),
              },
            ].map((chip) => (
              <motion.div
                key={chip.label}
                variants={{ hidden: { opacity: 0, y: 10 }, shown: { opacity: 1, y: 0 } }}
                transition={{ duration: 0.3 }}
              >
                <StatChip {...chip} />
              </motion.div>
            ))}
          </motion.div>

          {/* Liquidation metrics for the coin under analysis: the forced-flow
              read of the same symbol the terminal is computing on. */}
          <CoinLiquidationMetrics symbol={symbol} label={name} onOpenTape={onOpenTape} />

          {/* -------------------------------------------------------------- *
           * 1. Lead / lag
           * -------------------------------------------------------------- */}
          <TerminalPanel
            eyebrow="Price discovery"
            title={`Lead/Lag Cross-Correlation, scanned ±${data.maxLag} bars (${intervalLabel} bars)`}
            subtitle={
              `Correlates ${benchmark} returns at t-k against ${name} returns at t. Positive offsets mean the benchmark leads, negative mean the subject leads. Bars are shaded by significance: green clears the family-wise threshold that accounts for all ${data.spectrum.points.length} lags being tested at once, light grey clears only an uncorrected 95% band. Sample sizes are overlap-corrected, because adjacent bar returns share information and the naive count overstates the evidence.`
            }
            right={
              <div className="font-mono">
                <div className="text-[9px] text-slate-500">VERDICT</div>
                <div className="text-[11px] font-mono text-emerald-400 max-w-[220px] leading-snug">
                  {data.spectrum.leaderLabel}
                </div>
              </div>
            }
          >
            <CrossCorrelationSpectrumChart
              id="terminal-spectrum-chart"
              spectrum={data.spectrum}
              minutesPerBar={minutesPerBar}
            />

            <div className="mt-5 grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div>
                <h4 className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-2 flex items-center gap-1.5">
                  <Repeat size={11} /> Notable offsets
                </h4>
                {notableLags.length === 0 ? (
                  <EmptyState message="No offset cleared any significance band." />
                ) : (
                  <DataTable
                    headers={["LAG", "DIRECTION", "r", "PAIRS", "n_eff", "S.E.", "VERDICT"]}
                    rows={notableLags}
                  />
                )}
              </div>
              <div className="space-y-3">
                <h4 className="text-[10px] font-mono text-slate-500 uppercase tracking-widest flex items-center gap-1.5">
                  <Gauge size={11} /> How to read this
                </h4>
                <p className="text-[11px] text-slate-300 leading-relaxed font-sans">
                  Scanning many lags and reporting the best one will always turn up something near zero. The
                  family-wise threshold exists to absorb exactly that, so a lag only reads as real when it clears
                  {` |r| > ${data.spectrum.threshold.toFixed(3)}`}. Anything between the plain 95% band
                  {` (${data.spectrum.threshold95.toFixed(3)})`} and the family-wise threshold is a candidate to
                  re-test on a longer sample, not a signal to trade.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <StatChip
                    label="PEAK |r| ANYWHERE"
                    value={data.spectrum.peakCoefficient.toFixed(4)}
                    sub={`at lag ${data.spectrum.peakLag > 0 ? "+" : ""}${data.spectrum.peakLag}`}
                  />
                  <StatChip
                    label="UNCORRECTED HINT"
                    value={
                      data.spectrum.uncorrectedLeadLag
                        ? `${data.spectrum.uncorrectedLeadLag.lag > 0 ? "+" : ""}${data.spectrum.uncorrectedLeadLag.lag}`
                        : "none"
                    }
                    sub={
                      data.spectrum.uncorrectedLeadLag
                        ? `r ${data.spectrum.uncorrectedLeadLag.coefficient.toFixed(4)}`
                        : "no offset clears plain 95%"
                    }
                  />
                </div>
              </div>
            </div>
          </TerminalPanel>

          {/* -------------------------------------------------------------- *
           * 2. Downside beta / correlation
           * -------------------------------------------------------------- */}
          <TerminalPanel
            eyebrow="Asymmetric beta"
            title="Downside Beta & Correlation Decomposition"
            subtitle={
              `A single beta averages every bar together and hides the behaviour that matters for risk. These are conditional regressions of ${name} returns on ${benchmark} returns, restricted to the bars where the benchmark rose, fell, or fell into its worst decile. If downside beta sits above upside beta, long exposure carries more risk than the headline number implies.`
            }
            right={
              <div className="font-mono">
                <div className="text-[9px] text-slate-500">CLASSIFICATION</div>
                <div className="text-[11px] font-bold text-emerald-400">{data.asymmetry.label}</div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  capture {data.asymmetry.upCapturePct.toFixed(1)}% / {data.asymmetry.downCapturePct.toFixed(1)}%
                </div>
              </div>
            }
          >
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div>
                <h4 className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-3">
                  Conditional beta by benchmark state
                </h4>
                <BetaAsymmetryChart id="terminal-beta-asymmetry" asymmetry={data.asymmetry} />

                <div className="mt-4 grid grid-cols-2 gap-2">
                  <StatChip
                    label="DOWNSIDE SEMI-DEV RATIO"
                    value={`${data.asymmetry.semiDeviationRatio.toFixed(2)}x`}
                    sub={`subject ${(data.asymmetry.coinSemiDeviation * 100).toFixed(3)}% vs base ${(data.asymmetry.baseSemiDeviation * 100).toFixed(3)}% per bar`}
                    tone={data.asymmetry.semiDeviationRatio > 1.2 ? "negative" : "neutral"}
                  />
                  <StatChip
                    label="CAPTURE RATIO"
                    value={`${data.asymmetry.captureRatio.toFixed(2)}x`}
                    sub="upside capture / |downside capture|"
                  />
                </div>
              </div>

              <div>
                <h4 className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-2">
                  Segment detail
                </h4>
                <DataTable
                  headers={["SEGMENT", "BARS", "BETA", "r", "R2", "BASE bps", "SUBJ bps"]}
                  rows={[
                    data.asymmetry.marketUp,
                    data.asymmetry.marketDown,
                    data.asymmetry.marketTailDown,
                    data.asymmetry.marketExtremeDown,
                    data.asymmetry.coinDown,
                  ].map((s) => [
                    s.label,
                    String(s.observations),
                    <span
                      key="b"
                      className={
                        s.label !== "Market Up" && Math.abs(s.beta) > Math.abs(data.asymmetry.upBeta) * 1.2
                          ? "text-rose-400 font-bold"
                          : ""
                      }
                    >
                      {s.beta.toFixed(3)}
                    </span>,
                    s.correlation.toFixed(3),
                    s.r2.toFixed(3),
                    s.meanBaseReturnBps.toFixed(1),
                    s.meanCoinReturnBps.toFixed(2),
                  ])}
                />
                <div className="mt-3 p-3 bg-[#0a0a0b] border border-[#1f1f23] rounded">
                  <p className="text-[11px] text-slate-300 leading-relaxed font-sans">
                    {data.asymmetry.interpretation}
                  </p>
                </div>
              </div>
            </div>

            {/* Rolling beta / correlation / vol-ratio over the same window,
                each ranked against the pair's own history. */}
            <div className="mt-6 pt-5 border-t border-[#1f1f23]">
              <h4 className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-2 flex items-center gap-1.5">
                <Activity size={11} /> Rolling coupling vs its own history
              </h4>
              <p className="text-[11px] text-slate-300 leading-relaxed font-sans mb-4">
                Beta, correlation and the coin/base vol ratio over the trailing {data.rolling.window}-bar window. Each
                reading is ranked against this pair's own rolling history, so a beta of{" "}
                {data.rolling.beta.current.toFixed(2)} (p{Math.round(data.rolling.beta.percentile)}) means something
                explicit about where the pair sits today, not against some other pair's baseline.
              </p>
              <RollingCouplingChart id="terminal-rolling-coupling" rolling={data.rolling} />
              <div className="mt-3 p-3 bg-[#0a0a0b] border border-[#1f1f23] rounded">
                <p className="text-[11px] text-slate-300 leading-relaxed font-sans">{data.rolling.interpretation}</p>
              </div>
            </div>
          </TerminalPanel>

          {/* -------------------------------------------------------------- *
           * 3. Correlation stability
           * -------------------------------------------------------------- */}
          <TerminalPanel
            eyebrow="Reliability"
            title="Correlation Stability"
            subtitle={
              `The useful question is not what the correlation is, but whether quoting a single number is honest. This rolls the return correlation over a ${data.stability.window}-bar window and measures how much that number moves. A high dispersion means the relationship is not a relationship, and the quartile means below show whether it is decoupling over time rather than oscillating.`
            }
            right={
              <div className="font-mono">
                <div className="text-[9px] text-slate-500">STABILITY</div>
                <div
                  className={`text-lg font-bold ${
                    data.stability.stabilityScore >= 70
                      ? "text-emerald-400"
                      : data.stability.stabilityScore < 40
                      ? "text-rose-400"
                      : "text-amber-400"
                  }`}
                >
                  {data.stability.stabilityScore}/100
                </div>
                <div className="text-[10px] text-slate-500">{data.stability.label}</div>
              </div>
            }
          >
            <div className="grid grid-cols-1 xl:grid-cols-[2fr_1fr] gap-6">
              <div>
                <StabilitySeriesChart id="terminal-stability-series" stability={data.stability} />
              </div>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-2">
                  <StatChip
                    label="CURRENT r"
                    value={data.stability.current.toFixed(4)}
                    sub={`${data.stability.percentile.toFixed(0)}th pct of its own history`}
                  />
                  <StatChip
                    label="WINDOW MEAN"
                    value={data.stability.mean.toFixed(4)}
                    sub={`sd ${data.stability.stdDev.toFixed(4)} · CV ${data.stability.coefficientOfVariation.toFixed(2)}`}
                  />
                  <StatChip
                    label="REGIME SHIFT"
                    value={`${data.stability.regimeShiftZ > 0 ? "+" : ""}${data.stability.regimeShiftZ.toFixed(2)}σ`}
                    sub="current vs window mean"
                    tone={Math.abs(data.stability.regimeShiftZ) > 2 ? "negative" : "neutral"}
                  />
                  <StatChip
                    label="TIME IN SYNC"
                    value={`${data.stability.strongSharePct.toFixed(0)}%`}
                    sub={`r ≥ 0.70 · ${data.stability.positiveSharePct.toFixed(0)}% positive overall`}
                  />
                </div>
                <div>
                  <h4 className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-2">
                    Distribution of readings
                  </h4>
                  <StabilityHistogram id="terminal-stability-hist" stability={data.stability} />
                </div>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div>
                <h4 className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-2">
                  Structural drift by quarter of the window
                </h4>
                {stabilityBlocks.length === 0 ? (
                  <EmptyState message="Window too short to split into quarters." />
                ) : (
                  <DataTable
                    headers={["BLOCK", "READINGS", "MEAN r", "MEDIAN r", "S.D.", "VS WINDOW"]}
                    rows={stabilityBlocks}
                  />
                )}
              </div>
              <div className="space-y-3">
                <p className="text-[11px] text-slate-300 leading-relaxed font-sans">
                  {data.stability.interpretation}
                </p>
                <div className="p-3 bg-[#0a0a0b] border border-[#1f1f23] rounded text-[10px] font-mono text-slate-400 leading-relaxed">
                  Drift across the full window:{" "}
                  <span className={data.stability.trendAcrossSample < -0.1 ? "text-rose-400" : data.stability.trendAcrossSample > 0.1 ? "text-emerald-400" : ""}>
                    {data.stability.trendAcrossSample > 0 ? "+" : ""}
                    {data.stability.trendAcrossSample.toFixed(3)}
                  </span>{" "}
                  in correlation units ({data.stability.trendSlopePerBar.toExponential(2)} per bar).
                </div>
              </div>
            </div>
          </TerminalPanel>

          {/* -------------------------------------------------------------- *
           * 4. Residual z-score
           * -------------------------------------------------------------- */}
          <TerminalPanel
            eyebrow="Idiosyncratic structure"
            title="Residual Z-Scores"
            subtitle={
              `Two residuals, because they answer different questions. The return residual is ${name}'s move minus what ${benchmark} explains; a large Z there is an idiosyncratic event, not a spread trade. The log-price residual regresses log prices on log prices, and a stationary residual is a cointegration gap of the kind pairs desks actually trade, with a mean-reversion half-life attached.`
            }
            right={
              <div className="font-mono text-right">
                <div className="text-[9px] text-slate-500">OLS FIT</div>
                <div className="text-[11px] text-slate-200">
                  beta {data.residual.beta.toFixed(3)} · R² {data.residual.r2.toFixed(3)}
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  residual sd {(data.residual.residualStdDev * 100).toFixed(3)}% per bar
                </div>
              </div>
            }
          >
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <div>
                <ResidualZScoreChart
                  id="terminal-residual-return-z"
                  series={data.residual.returnResidual.series.map((p) => ({ time: p.time, value: p.zScore }))}
                  title={`Return residual z-score (${data.residual.zscoreMode}, ${data.residual.returnResidual.zWindow}-bar)`}
                  bands={[data.residual.returnResidual.alertThreshold]}
                  unit="σ"
                />
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <StatChip
                    label="CURRENT RETURN RESIDUAL Z"
                    value={`${data.residual.returnResidual.currentZ > 0 ? "+" : ""}${data.residual.returnResidual.currentZ.toFixed(2)}σ`}
                    sub={data.residual.returnResidual.label}
                    tone={
                      Math.abs(data.residual.returnResidual.currentZ) >=
                      data.residual.returnResidual.alertThreshold
                        ? data.residual.returnResidual.currentZ > 0
                          ? "negative"
                          : "positive"
                        : "neutral"
                    }
                  />
                  <StatChip
                    label="RESIDUAL MOVE"
                    value={`${data.residual.returnResidual.currentResidualBps > 0 ? "+" : ""}${data.residual.returnResidual.currentResidualBps.toFixed(1)} bps`}
                    sub="latest bar, unexplained by the benchmark"
                  />
                </div>
                <p className="mt-3 text-[11px] text-slate-300 leading-relaxed font-sans">
                  {data.residual.returnResidual.interpretation}
                </p>
              </div>

              <div>
                <ResidualZScoreChart
                  id="terminal-residual-price-z"
                  series={data.residual.logPriceResidual.series.map((p) => ({
                    time: p.time,
                    value: p.zScore,
                  }))}
                  title={`Log-price residual z-score (${data.residual.zscoreMode})`}
                  bands={[2]}
                  unit="σ"
                />
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <StatChip
                    label="CURRENT PRICE GAP"
                    value={`${data.residual.logPriceResidual.currentZ > 0 ? "+" : ""}${data.residual.logPriceResidual.currentZ.toFixed(2)}σ`}
                    sub={`raw ${(Math.exp(data.residual.logPriceResidual.current) - 1) * 100 > 0 ? "+" : ""}${((Math.exp(data.residual.logPriceResidual.current) - 1) * 100).toFixed(2)}% vs fit`}
                    tone={Math.abs(data.residual.logPriceResidual.currentZ) > 2 ? "negative" : "neutral"}
                  />
                  <StatChip
                    label="MEAN REVERSION"
                    value={
                      data.residual.logPriceResidual.halfLifeBars !== null
                        ? `${data.residual.logPriceResidual.halfLifeBars.toFixed(1)} bars`
                        : "n/a"
                    }
                    sub={`AR(1) ${data.residual.logPriceResidual.ar1.toFixed(4)} · ${data.residual.logPriceResidual.stationarityFlag}`}
                    tone={
                      data.residual.logPriceResidual.halfLifeBars !== null ? "positive" : "negative"
                    }
                  />
                </div>
                <p className="mt-3 text-[11px] text-slate-300 leading-relaxed font-sans">
                  {data.residual.logPriceResidual.interpretation}
                </p>
              </div>
            </div>
          </TerminalPanel>

          {/* -------------------------------------------------------------- *
           * 5. Volatility regime
           * -------------------------------------------------------------- */}
          <TerminalPanel
            eyebrow="Volatility"
            title={`Volatility Regime — ${name} vs ${benchmark}`}
            subtitle={
              `Realized volatility over a ${data.volatility.window}-bar window, annualized so the axis reads the same on any timeframe. Regimes are percentiles of each asset's OWN history rather than fixed thresholds, because an absolute vol level means nothing across coins. The ratio line matters as much as the levels: vol regime shifts usually appear in the premium before they appear in the absolute number.`
            }
            right={
              <div className="font-mono text-right">
                <div className="text-[9px] text-slate-500">CURRENT REGIMES</div>
                <div className="text-[11px]">
                  <span className="text-emerald-400">{name} {data.volatility.coin.label}</span>
                  <span className="text-slate-600"> / </span>
                  <span className="text-sky-400">{benchmark} {data.volatility.base.label}</span>
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">{data.volatility.ratio.label}</div>
              </div>
            }
          >
            <div className="grid grid-cols-1 xl:grid-cols-[2fr_1fr] gap-6">
              <VolatilityRegimeChart id="terminal-vol-regime" volatility={data.volatility} />
              <div className="grid grid-cols-2 gap-2 content-start">
                <StatChip
                  label="SUBJ ANN VOL"
                  value={`${(data.volatility.coin.annualizedVol * 100).toFixed(1)}%`}
                  sub={`p${data.volatility.coin.percentile.toFixed(0)} · vol-of-vol ${data.volatility.coin.volOfVol.toFixed(2)}`}
                  tone={data.volatility.coin.percentile >= 90 ? "negative" : "neutral"}
                />
                <StatChip
                  label="BENCH ANN VOL"
                  value={`${(data.volatility.base.annualizedVol * 100).toFixed(1)}%`}
                  sub={`p${data.volatility.base.percentile.toFixed(0)}`}
                />
                <StatChip
                  label="VOL RATIO"
                  value={`${data.volatility.ratio.value.toFixed(2)}x`}
                  sub={`mean ${data.volatility.ratio.mean.toFixed(2)}x · p${data.volatility.ratio.percentile.toFixed(0)}`}
                  tone={data.volatility.ratio.percentile >= 80 ? "negative" : "neutral"}
                />
                <StatChip
                  label="MAX DRAWDOWN"
                  value={`${(data.volatility.coin.maxDrawdown * 100).toFixed(1)}%`}
                  sub={`over the trailing ${data.volatility.window} bars`}
                />
                <StatChip
                  label="BOLLINGER WIDTH"
                  value={`${data.volatility.coin.bollingerWidth.toFixed(2)}%`}
                  sub={`p${data.volatility.coin.bollingerPercentile.toFixed(0)} — squeeze risk`}
                  tone={data.volatility.coin.bollingerPercentile < 20 ? "positive" : "neutral"}
                />
                <StatChip
                  label="DOWNSIDE SEMI-DEV"
                  value={`${(data.volatility.coin.downSemiDeviation * Math.sqrt(data.volatility.periodsPerYear) * 100).toFixed(1)}%`}
                  sub="annualized, zero target"
                />
              </div>
            </div>

            <div className="mt-5">
              <h4 className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-2">
                Regime timeline (recent bands)
              </h4>
              <RegimeSpanStrip id="terminal-regime-strip" spans={data.volatility.spans} />
            </div>

            <div className="mt-4 p-3 bg-[#0a0a0b] border border-[#1f1f23] rounded">
              <p className="text-[11px] text-slate-300 leading-relaxed font-sans">
                {data.volatility.interpretation}
              </p>
            </div>
          </TerminalPanel>

          {/* -------------------------------------------------------------- *
           * 6. Sessions / time of day
           * -------------------------------------------------------------- */}
          <SessionPanel
            id="terminal-session-panel"
            sessions={data.sessions}
            subjectLabel={name}
            benchmarkLabel={benchmark}
          />

          <div className="flex items-center justify-center gap-2 py-4 text-[10px] font-mono text-slate-600">
            <Sigma size={11} />
            END OF TERMINAL · {data.bars} ALIGNED BARS · {data.asOf.lookbackDays}D WINDOW ·{" "}
            {INTERVALS.includes(data.interval) ? data.interval.toUpperCase() : data.interval} · OPEN BAR
            EXCLUDED
          </div>
        </div>
      ) : null}

      {/* Boot overlay sits above everything, including the error state. */}
      <AnimatePresence>
        {booting && (
          <TerminalBoot
            symbol={symbol}
            benchmark={benchmark}
            interval={interval}
            lookbackDays={lookbackDays}
            onComplete={() => setBooting(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function ControlGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[9px] font-mono text-slate-500 uppercase tracking-widest font-bold mb-1.5">
        {label}
      </div>
      {children}
    </div>
  );
}

/**
 * The benchmark arrives as a bare ticker but may still carry the quote suffix.
 * The API param is named `baseAsset` for historical reasons; here it always
 * means the benchmark, never the subject.
 */
function benchmarkSymbol(benchmark: string): string {
  return benchmark.replace(/USDT$/, "");
}