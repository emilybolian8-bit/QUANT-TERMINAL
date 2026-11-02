/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Code2, Cpu, Play, RotateCcw, Terminal as TerminalIcon } from "lucide-react";
import { CodeSeriesResponse, Interval } from "../types";
import { MAX_LOOKBACK_DAYS, defaultLookbackDays } from "../utils/terminal_calculations";
import { formatUtcStamp } from "../utils/dates";
import {
  KernelStatus,
  drainOutput,
  getKernel,
  loadFrame,
  restartKernel,
  runCode,
} from "../utils/pyodide";
import { TerminalPanel } from "./terminal/TerminalCharts";

const INTERVALS: Interval[] = ["15m", "1h", "4h", "1d"];

/**
 * Deliberately shorter than the terminal's own ladder. A 45-day 15m pull is
 * ~4.3k bars and has to cross the network as JSON before pandas sees it; this
 * tab is a scratchpad, not a bulk export.
 */
const LOOKBACK_CHOICES = [7, 14, 30, 45, 90, 180];

function lookbacksFor(interval: Interval): number[] {
  return LOOKBACK_CHOICES.filter((days) => days <= MAX_LOOKBACK_DAYS[interval]);
}

function starterFor(symbol: string, benchmark: string): string {
  return `# df is the aligned ${symbol} / ${benchmark} OHLCV frame, UTC-indexed.
# liq is the subject's recent liquidation tape (or None if the window had
# no prints): time, event_time, exchange, position, price, qty, notional.
# Preloaded: numpy as np, pandas as pd, matplotlib.pyplot as plt.
# A trailing expression prints its value, like a notebook.
#
# Taker-buy tape (who is winning the order flow, bar by bar):
#   subject_taker_buy        base volume filled by aggressive (market) BUY orders
#   subject_taker_buy_share  taker_buy / volume -> >0.5 buyers out-muscle sellers
# Every bar: net_taker_buy = 2 * subject_taker_buy - subject_volume

print(f"{len(df):,} bars | {df.time.min()} -> {df.time.max()}")
print(f"avg taker-buy share: {df.subject_taker_buy_share.mean():.1%}")
if liq is None or len(liq) == 0:
    print("no liquidation prints buffered for this coin")
else:
    print(f"{len(liq):,} liquidation prints | {liq.time.min()} -> {liq.time.max()}")

df[["subject_close", "subject_volume", "subject_taker_buy_share"]].tail(5)

# Try:
#   df.subject_return.corr(df.bench_return)           # contemporaneous corr
#   df.groupby(df.time.dt.hour).subject_return.std()  # hourly vol profile
#   buyer_days = df.groupby(df.time.dt.date).subject_taker_buy_share.mean() > 0.5
#   buyer_days.loc[buyer_days].value_counts().loc[True]  # days buyers won
#   df.subject_taker_buy_share.rolling(96).mean().plot(); plt.show()
#   plt.plot(df.subject_close / df.bench_close)       # ratio
#   liq.groupby("position").notional.sum()            # who got wiped
#   plt.show()
`;
}

interface RunOutput {
  value: string;
  stdout: string;
  stderr: string;
  error: string | null;
  figures: string[];
}

function datasetKey(symbol: string, benchmark: string, interval: Interval, lookbackDays: number): string {
  return `${symbol}|${benchmark}|${interval}|${lookbackDays}`;
}

export default function CodeLab({
  symbol,
  benchmark,
  name,
}: {
  symbol: string;
  benchmark: string;
  name: string;
}) {
  const [interval, setInterval] = useState<Interval>("1h");
  const [lookbackDays, setLookbackDays] = useState<number>(defaultLookbackDays("1h"));
  const [series, setSeries] = useState<CodeSeriesResponse | null>(null);
  const [code, setCode] = useState(() => starterFor(symbol, benchmark));
  const [kernel, setKernel] = useState<KernelStatus>({ phase: "idle", message: "Kernel cold" });
  const [busy, setBusy] = useState(false);
  const [dataBusy, setDataBusy] = useState(false);
  const [run, setRun] = useState<RunOutput | null>(null);
  const [runCount, setRunCount] = useState(0);

  /** Which dataset is currently resident in the Python kernel. */
  const residentRef = useRef<string | null>(null);

  useEffect(() => {
    setCode(starterFor(symbol, benchmark));
  }, [symbol, benchmark]);

  useEffect(() => {
    setSeries(null);
    setRun(null);
  }, [symbol, benchmark, interval, lookbackDays]);

  const key = datasetKey(symbol, benchmark, interval, lookbackDays);

  const applyKernelStatus = useCallback((status: KernelStatus) => setKernel(status), []);

  /** Fetches the aligned OHLCV payload. Returns null and surfaces the error. */
  const requestSeries = useCallback(async (): Promise<CodeSeriesResponse | null> => {
    const query = new URLSearchParams({ symbol, baseAsset: benchmark, interval });
    query.set("lookbackDays", String(lookbackDays));
    const response = await fetch(`/api/code-series?${query.toString()}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
    return payload as CodeSeriesResponse;
  }, [symbol, benchmark, interval, lookbackDays]);

  const loadData = useCallback(async () => {
    setDataBusy(true);
    try {
      const payload = await requestSeries();
      setSeries(payload);
    } catch (error: any) {
      setSeries(null);
      setRun({
        value: "",
        stdout: "",
        stderr: "",
        error: `Could not load ${symbol}/${benchmark}: ${error?.message ?? error}`,
        figures: [],
      });
    } finally {
      setDataBusy(false);
    }
  }, [requestSeries, symbol, benchmark]);

  const execute = useCallback(async () => {
    if (!code.trim()) return;
    setBusy(true);
    setRun(null);
    try {
      // Reuse the fetched payload when it matches the current controls,
      // otherwise pull it now so Run never needs a second click.
      let payload =
        series &&
        datasetKey(series.symbol, series.baseAsset, series.interval, series.lookbackDays) === key
          ? series
          : null;
      if (!payload) {
        payload = await requestSeries();
        setSeries(payload);
      }

      await getKernel(applyKernelStatus);

      if (residentRef.current !== key) {
        await loadFrame(
          {
            columns: payload.columns,
            rows: payload.rows,
            meta: payload.meta,
            liquidations: payload.liquidations,
          },
          applyKernelStatus
        );
        residentRef.current = key;
      }

      const result = await runCode(code);
      const output = drainOutput();
      setRun({
        value: result.value,
        stdout: output.out,
        stderr: output.err,
        error: null,
        figures: result.figures,
      });
      setRunCount((n) => n + 1);
    } catch (error: any) {
      const output = drainOutput();
      setRun({
        value: "",
        stdout: output.out,
        stderr: output.err,
        error: cleanPythonError(error),
        figures: [],
      });
    } finally {
      setBusy(false);
    }
  }, [code, key, series, requestSeries, applyKernelStatus]);

  const restart = useCallback(async () => {
    setBusy(true);
    try {
      await restartKernel();
      residentRef.current = null;
      setKernel({ phase: "idle", message: "Kernel reset" });
      setRun(null);
    } finally {
      setBusy(false);
    }
  }, []);

  const asOfLabel = useMemo(
    () => (series ? formatUtcStamp(series.meta.asOfTimestamp) : null),
    [series]
  );

  return (
    <div className="space-y-5">
      <TerminalPanel
        id="code-lab-control"
        eyebrow="Workspace"
        title={`${name} / ${benchmark} Python Console`}
        subtitle="Real CPython running in your browser via WebAssembly. Nothing you type is sent to the server; the selected pair arrives as the df DataFrame, its force-orders as liq."
        right={
          <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">
            {kernel.phase === "ready" ? "Kernel ready" : kernel.message}
          </span>
        }
      >
        <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
          <div>
            <span className="block text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-1.5">
              Timeframe
            </span>
            <div className="flex gap-1">
              {INTERVALS.map((iv) => (
                <button
                  key={iv}
                  type="button"
                  onClick={() => {
                    setInterval(iv);
                    const options = lookbacksFor(iv);
                    if (!options.includes(lookbackDays)) setLookbackDays(defaultLookbackDays(iv));
                  }}
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
          </div>

          <div>
            <span className="block text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-1.5">
              Lookback
            </span>
            <div className="flex flex-wrap gap-1">
              {lookbacksFor(interval).map((days) => (
                <button
                  key={days}
                  type="button"
                  onClick={() => setLookbackDays(days)}
                  className={`px-2 h-7 text-[10px] font-mono rounded border cursor-pointer transition-colors ${
                    lookbackDays === days
                      ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-300"
                      : "bg-[#0a0a0b] border-[#1f1f23] text-slate-500 hover:text-slate-300"
                  }`}
                >
                  {days}d
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={loadData}
              disabled={dataBusy}
              className="h-8 px-3 text-[10px] font-mono rounded border border-[#1f1f23] bg-[#0a0a0b] text-slate-300 hover:text-white disabled:opacity-40 cursor-pointer transition-colors"
            >
              {dataBusy ? "Loading..." : "Load data"}
            </button>
            <button
              type="button"
              onClick={restart}
              disabled={busy || kernel.phase !== "ready"}
              title="Clear the dataframe and imported names"
              className="h-8 px-3 text-[10px] font-mono rounded border border-[#1f1f23] bg-[#0a0a0b] text-slate-300 hover:text-white disabled:opacity-40 cursor-pointer transition-colors inline-flex items-center gap-1.5"
            >
              <RotateCcw size={11} />
              Reset kernel
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-[10px] font-mono text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <TerminalIcon size={11} />
            {series
              ? `${series.barCount.toLocaleString()} aligned bars · as of ${asOfLabel} UTC`
              : "No dataset loaded"}
          </span>
          {series && (
            <span className={series.liquidations.count > 0 ? "text-orange-400/90" : "text-slate-600"}>
              {series.liquidations.count > 0
                ? `${series.liquidations.count.toLocaleString()} liq prints · ${series.liquidations.retentionHours.toFixed(0)}h tape`
                : "liq empty (tape retention only)"}
            </span>
          )}
          {series && series.warnings.length > 0 && (
            <span className="text-amber-400/90">{series.warnings[0]}</span>
          )}
          {kernel.phase === "booting" && <span className="text-emerald-400/90">{kernel.message}</span>}
        </div>
      </TerminalPanel>

      <TerminalPanel
        id="code-lab-editor"
        eyebrow="Editor"
        title="Run Python on this pair"
        subtitle="Ctrl+Enter (Cmd+Enter on macOS) executes. A trailing expression prints its value; figures render below."
        right={
          <button
            type="button"
            onClick={execute}
            disabled={busy}
            className="inline-flex items-center gap-1.5 h-8 px-3.5 text-[10px] font-mono rounded border border-emerald-500/50 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40 cursor-pointer transition-colors"
          >
            <Play size={11} />
            {busy ? "Running..." : "Run"}
          </button>
        }
      >
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              void execute();
              return;
            }
            if (e.key === "Tab") {
              e.preventDefault();
              const el = e.currentTarget;
              const start = el.selectionStart;
              const end = el.selectionEnd;
              setCode(`${code.slice(0, start)}    ${code.slice(end)}`);
              requestAnimationFrame(() => {
                el.selectionStart = el.selectionEnd = start + 4;
              });
            }
          }}
          spellCheck={false}
          rows={16}
          className="w-full bg-[#0a0a0b] border border-[#1f1f23] rounded p-4 text-[12px] leading-relaxed font-mono text-slate-200 focus:outline-none focus:border-emerald-500/40 resize-y"
        />
      </TerminalPanel>

      <TerminalPanel
        id="code-lab-output"
        eyebrow="Output"
        title={runCount > 0 ? `Result · run ${runCount}` : "Result"}
        right={
          <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest inline-flex items-center gap-1.5">
            <Cpu size={11} />
            {kernel.phase === "ready" ? "Local WASM" : "Cold"}
          </span>
        }
      >
        {!run && (
          <div className="border border-dashed border-[#1f1f23] rounded bg-[#0a0a0b]/25 px-4 py-8 text-center">
            <Code2 size={18} className="mx-auto text-slate-600 mb-2" />
            <span className="text-xs text-slate-500 font-mono">
              Press Run to execute against {symbol}/{benchmark}.
            </span>
          </div>
        )}

        {run?.error && (
          <pre className="bg-[#0a0a0b] border border-red-900/40 text-red-300 text-[12px] leading-relaxed font-mono rounded p-4 whitespace-pre-wrap overflow-auto">
            {run.error}
          </pre>
        )}

        {run && !run.error && (
          <div className="space-y-4">
            {run.stdout && (
              <pre className="bg-[#0a0a0b] border border-[#1f1f23] text-slate-300 text-[12px] leading-relaxed font-mono rounded p-4 whitespace-pre-wrap overflow-auto">
                {run.stdout}
              </pre>
            )}
            {run.value && (
              <pre className="bg-[#0a0a0b] border border-[#1f1f23] text-emerald-200 text-[12px] leading-relaxed font-mono rounded p-4 whitespace-pre-wrap overflow-auto max-h-[420px]">
                {run.value}
              </pre>
            )}
            {run.stderr && (
              <pre className="bg-[#0a0a0b] border border-amber-900/40 text-amber-300 text-[12px] leading-relaxed font-mono rounded p-4 whitespace-pre-wrap overflow-auto">
                {run.stderr}
              </pre>
            )}
            {run.figures.map((png, i) => (
              <img
                key={i}
                src={`data:image/png;base64,${png}`}
                alt={`Figure ${i + 1}`}
                className="w-full bg-white rounded border border-[#1f1f23]"
              />
            ))}
          </div>
        )}
      </TerminalPanel>
    </div>
  );
}

/** Strips Pyodide's wrapper noise so the user sees the Python traceback. */
function cleanPythonError(error: any): string {
  return String(error?.message || error)
    .replace(/^PythonError:\s*/i, "")
    .replace(/\s*at Object\.\w+ \([^)]*\)/g, "")
    .trim();
}