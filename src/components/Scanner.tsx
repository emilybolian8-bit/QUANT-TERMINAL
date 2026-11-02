/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  Play,
  Radio,
  Radar,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import {
  AUTO_SCAN_MAX_SYMBOLS,
  AutoScanConfigResponse,
  AutoScanParams,
  AutoScanSnapshot,
  SCAN_MAX_SYMBOLS,
  ScanExtra,
  ScanParams,
  ScanResponse,
  ScanResultItem,
  ScanStability,
  ScanTodayZ,
  ScanVolRegime,
} from "../types";
import { rankCatalogMatches, resolveTicker } from "../utils/catalog";
import {
  MAX_LOOKBACK_DAYS,
  defaultLookbackDays,
  defaultRollingWindow,
} from "../utils/terminal_calculations";
import { useSymbolCatalog } from "../utils/useSymbolCatalog";

const INTERVALS: ScanParams["interval"][] = ["1h", "15m"];

const ZSCORE_MODES: ScanParams["zscoreMode"][] = ["expanding", "rolling", "batch"];

/**
 * Rolling window options in bars. The 1h/15m split matters: a 168-bar window is
 * a week on the hourly frame but 42 hours at 15m, so the same number means two
 * very different things and the ladder is swapped per interval. Both ladders
 * contain the shared default, so switching interval lands on the same window
 * the dashboard and terminal open with.
 */
const ROLLING_WINDOWS: Record<ScanParams["interval"], number[]> = {
  "1h": [24, 48, 72, 120, 168, 336, 720],
  "15m": [48, 96, 192, 336, 672],
};

/**
 * Lookback choices, filtered at render by MAX_LOOKBACK_DAYS for the active
 * interval. Offering 60d on a frame the endpoint caps at 45d would only ever
 * get silently narrowed, so the cap is surfaced as an absent option instead.
 */
const LOOKBACK_CHOICES = [7, 14, 30, 45, 60, 90];

function num(v: number | null | undefined, decimals = 4): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toFixed(decimals);
}

function pct(v: number | null | undefined, decimals = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(decimals)}%`;
}

/**
 * Compact USD for the size columns. Market caps span nine orders of magnitude
 * across a 20-symbol scan, so anything past four significant figures is noise.
 */
function usd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

function signalBadge(signal: string | null): { text: string; className: string } {
  if (signal === "BUY_COIN_SELL_BTC") {
    return { text: "BUY COIN", className: "bg-emerald-950 text-emerald-400 border-emerald-800/40" };
  }
  if (signal === "SELL_COIN_BUY_BTC") {
    return { text: "SELL COIN", className: "bg-rose-950 text-rose-400 border-rose-800/40" };
  }
  if (signal) {
    return { text: "EQUILIBRIUM", className: "bg-[#141417] text-slate-400 border-[#1f1f23]" };
  }
  return { text: "—", className: "bg-[#141417] text-slate-400 border-[#1f1f23]" };
}

/** Z-score tone: the further from zero, the stronger the pairs signal. */
function zTone(z: number | null): string {
  if (z === null || !Number.isFinite(z)) return "text-slate-500";
  if (Math.abs(z) >= 2) return "text-amber-400";
  if (Math.abs(z) >= 1) return "text-slate-200";
  return "text-slate-400";
}

/**
 * The "hit ±2 today" badge. A breach that already happened is a stronger
 * statement than the current reading, so it is called out explicitly rather
 * than left for the reader to infer from the Z-Score cell.
 */
function todayZBadge(todayZ: ScanTodayZ | null): { text: string; className: string } {
  if (!todayZ || todayZ.bars === 0) {
    return { text: "—", className: "bg-[#141417] text-slate-600 border-[#1f1f23]" };
  }
  if (todayZ.hitUp && todayZ.hitDown) {
    return { text: "BOTH", className: "bg-amber-950 text-amber-300 border-amber-800/40" };
  }
  if (todayZ.hitUp) {
    return { text: "YES ▲", className: "bg-rose-950 text-rose-400 border-rose-800/40" };
  }
  if (todayZ.hitDown) {
    return { text: "YES ▼", className: "bg-emerald-950 text-emerald-400 border-emerald-800/40" };
  }
  return { text: "no", className: "bg-[#141417] text-slate-500 border-[#1f1f23]" };
}

function stabilityTone(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return "text-slate-500";
  if (score >= 70) return "text-emerald-400";
  if (score >= 45) return "text-slate-200";
  return "text-amber-400";
}

/**
 * Inline sparkline of a rolling series. The scan table has no room for a real
 * chart, but the shape of the correlation history is most of what tells you
 * whether a single reading is a regime or a blip.
 */
function Sparkline({
  points,
  width = 120,
  height = 22,
}: {
  points: { value: number }[];
  width?: number;
  height?: number;
}) {
  if (points.length < 2) {
    return <div className="text-[10px] text-slate-600">no series</div>;
  }

  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const path = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((v - min) / span) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} className="overflow-visible">
      <line
        x1={0}
        x2={width}
        y1={height / 2}
        y2={height / 2}
        stroke="#1f1f23"
        strokeWidth={1}
      />
      <path d={path} fill="none" stroke="#10b981" strokeWidth={1.25} />
    </svg>
  );
}

function DetailCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[10px] uppercase tracking-wider text-slate-600">{label}</span>
      <span className="tabular-nums text-slate-300">{value}</span>
    </div>
  );
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-[#1f1f23] bg-[#0b0b0e] p-3 space-y-2">
      <div>
        <div className="text-[10px] uppercase tracking-[0.08em] text-slate-500">{title}</div>
        {subtitle && <div className="text-[10px] text-slate-600 mt-0.5">{subtitle}</div>}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function ManualScanner({
  compareAsset,
  setCompareAsset,
  onGoToTerminal,
}: {
  compareAsset: string;
  setCompareAsset: (value: string) => void;
  onGoToTerminal?: (symbol: string, params: ScanParams) => void;
}) {
  const {
    symbols: catalog,
    loading: catalogLoading,
    error: catalogError,
    ensureLoaded,
  } = useSymbolCatalog();

  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [showSuggest, setShowSuggest] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [adding, setAdding] = useState(false);
  const [addNotice, setAddNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [params, setParams] = useState<ScanParams>({
    compareAsset,
    interval: "1h",
    // Shared defaults, so a scan opens on exactly the window the dashboard and
    // terminal open on rather than a scanner-only value that has to be matched
    // by hand before the numbers agree.
    rollingWindow: defaultRollingWindow("1h"),
    zscoreMode: "expanding",
    lookbackDays: defaultLookbackDays("1h"),
    includeMcap: true,
    include24hVol: true,
  });

  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const resultsRef = useRef<HTMLDivElement>(null);

  const atCapacity = selected.length >= SCAN_MAX_SYMBOLS;

  // The dashboard owns compareAsset, so the scanner reads it from props and
  // pushes edits back rather than holding a second copy that can drift.
  useEffect(() => {
    setParams((prev) => (prev.compareAsset === compareAsset ? prev : { ...prev, compareAsset }));
  }, [compareAsset]);

  const suggestions = useMemo(
    () => rankCatalogMatches(catalog, query, { exclude: selected, limit: 8 }),
    [catalog, query, selected]
  );

  const directAdd = useMemo(() => {
    if (rankCatalogMatches(catalog, query, { limit: 1 }).length > 0) return null;
    const typed = query.trim();
    return typed.length > 0 ? typed : null;
  }, [catalog, query]);

  useEffect(() => {
    setHighlight((prev) => (prev >= suggestions.length ? -1 : prev));
  }, [suggestions.length]);

  useEffect(() => {
    if (!showSuggest) setAddNotice(null);
  }, [showSuggest]);

  const commitSymbol = useCallback(
    (symbol: string) => {
      setSelected((prev) => (prev.includes(symbol) || prev.length >= SCAN_MAX_SYMBOLS ? prev : [...prev, symbol]));
      setQuery("");
      setShowSuggest(false);
      setHighlight(-1);
    },
    []
  );

  /**
   * Free-form entry falls through to the server, so a pair listed minutes ago is
   * still reachable even though the client's cached catalog cannot know it yet.
   */
  const commitTyped = async (raw: string) => {
    if (adding || atCapacity) return;
    setAdding(true);
    setAddNotice(null);
    try {
      const result = await resolveTicker(raw, catalog);
      if (result.status === "ok") {
        if (selected.includes(result.coin.symbol)) {
          setAddNotice({ tone: "error", text: `${result.coin.symbol} is already in the scan.` });
        } else {
          commitSymbol(result.coin.symbol);
          setAddNotice({ tone: "ok", text: `${result.coin.symbol} queued for the scan.` });
        }
      } else if (result.status === "not-found") {
        setAddNotice({ tone: "error", text: `${result.symbol} is not trading on Binance.` });
      } else {
        setAddNotice({ tone: "error", text: result.message });
      }
    } finally {
      setAdding(false);
    }
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && suggestions.length > 0) {
      event.preventDefault();
      setShowSuggest(true);
      setHighlight((prev) => (prev + 1) % suggestions.length);
    } else if (event.key === "ArrowUp" && suggestions.length > 0) {
      event.preventDefault();
      setHighlight((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (highlight >= 0 && suggestions[highlight]) {
        commitSymbol(suggestions[highlight].coin.symbol);
      } else if (query.trim()) {
        void commitTyped(query);
      }
    } else if (event.key === "Escape") {
      setShowSuggest(false);
      setHighlight(-1);
    }
  };

  const removeSymbol = (symbol: string) => {
    setSelected((prev) => prev.filter((s) => s !== symbol));
  };

  const runScan = async () => {
    if (selected.length === 0 || scanning) return;
    setScanning(true);
    setScanError(null);
    setOpen({});

    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols: selected, params }),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || `Scan failed with HTTP ${response.status}.`);
      }

      setScan(payload as ScanResponse);
    } catch (error: any) {
      setScanError(error.message || "Scan failed.");
    } finally {
      setScanning(false);
    }
  };

  const toggleRow = (symbol: string) => {
    setOpen((prev) => ({ ...prev, [symbol]: !prev[symbol] }));
  };

  const setParam = <K extends keyof ScanParams>(key: K, value: ScanParams[K]) => {
    setParams((prev) => {
      const next = { ...prev, [key]: value };
      // A window longer than the sample produces a single-point "stability"
      // reading, which reads as a bug. Pull it back under the bar count.
      const bars = Math.floor((next.lookbackDays * 86400000) / (next.interval === "1h" ? 3600000 : 900000));
      if (next.rollingWindow > bars) next.rollingWindow = Math.max(5, bars);
      if (key === "interval") {
        const ladder = ROLLING_WINDOWS[next.interval];
        if (!ladder.includes(next.rollingWindow)) {
          const sharedDefault = defaultRollingWindow(next.interval);
          next.rollingWindow = ladder.includes(sharedDefault) ? sharedDefault : ladder[0];
        }
      }
      return next;
    });
  };

  const benchmarkVol = scan?.results.find((r) => r.extra.vol24hBaseUsd != null)?.extra.vol24hBaseUsd;

  return (
    <div className="space-y-6">
      {/* Config */}
      <div className="border border-[#1f1f23] bg-[#0b0b0e]">
        <div className="px-4 py-3 border-b border-[#1f1f23] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Radar size={15} className="text-emerald-400" />
            <span className="text-xs uppercase tracking-[0.08em] text-slate-400">
              Batch Scanner
            </span>
          </div>
          <span className="text-[10px] text-slate-600 font-mono">
            {selected.length}/{SCAN_MAX_SYMBOLS} SELECTED
          </span>
        </div>

        <div className="p-4 space-y-5">
          {/* Symbol input */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[10px] uppercase tracking-[0.08em] text-slate-500">
                Subjects
              </label>
              {selected.length > 0 && (
                <button
                  onClick={() => {
                    setSelected([]);
                    setScan(null);
                    setScanError(null);
                  }}
                  className="text-[10px] uppercase tracking-wider text-slate-600 hover:text-slate-400"
                >
                  Clear
                </button>
              )}
            </div>

            {selected.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selected.map((symbol) => (
                  <span
                    key={symbol}
                    className="inline-flex items-center gap-1.5 border border-[#1f1f23] bg-[#101013] px-2 py-1 font-mono text-[11px] text-slate-300"
                  >
                    {symbol}
                    <button
                      onClick={() => removeSymbol(symbol)}
                      className="text-slate-600 hover:text-rose-400"
                      aria-label={`Remove ${symbol}`}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="relative">
              <div className="flex items-center gap-2 border border-[#1f1f23] bg-[#0f0f12] px-3 py-2 focus-within:border-[#2a2a30]">
                <Search size={13} className="text-slate-600 shrink-0" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    if (event.target.value.trim()) {
                      setShowSuggest(true);
                      ensureLoaded();
                    }
                  }}
                  onFocus={() => {
                    if (query.trim()) setShowSuggest(true);
                    ensureLoaded();
                  }}
                  onBlur={() => window.setTimeout(() => setShowSuggest(false), 140)}
                  onKeyDown={onSearchKeyDown}
                  disabled={atCapacity}
                  placeholder={
                    atCapacity
                      ? `Scan is capped at ${SCAN_MAX_SYMBOLS} symbols`
                      : "Add a symbol: sol, LDOUSDT, 1000PEPE..."
                  }
                  className="flex-1 bg-transparent text-xs outline-none placeholder:text-slate-700 disabled:placeholder:text-slate-700"
                />
                {adding && <Loader2 size={12} className="animate-spin text-slate-600" />}
                {query && (
                  <button onClick={() => setQuery("")} className="text-slate-600 hover:text-slate-400">
                    <X size={12} />
                  </button>
                )}
              </div>

              <AnimatePresence>
                {showSuggest && (suggestions.length > 0 || directAdd) && !atCapacity && (
                  <motion.div
                    initial={{ opacity: 0, y: -3 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -3 }}
                    transition={{ duration: 0.12 }}
                    className="absolute z-30 mt-1 w-full border border-[#1f1f23] bg-[#0b0b0e] shadow-xl"
                  >
                    {suggestions.map((match, index) => (
                      <button
                        key={match.coin.symbol}
                        onMouseEnter={() => setHighlight(index)}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          commitSymbol(match.coin.symbol);
                        }}
                        className={`flex w-full items-center justify-between px-3 py-2 text-left text-[11px] ${
                          index === highlight ? "bg-[#141417]" : "hover:bg-[#101013]"
                        }`}
                      >
                        <span className="font-mono text-slate-200">{match.coin.symbol}</span>
                        <span className="text-[10px] text-slate-600">
                          {match.coin.market === "futures" ? "PERPETUAL" : match.coin.category}
                        </span>
                      </button>
                    ))}

                    {directAdd && (
                      <button
                        onMouseDown={(event) => {
                          event.preventDefault();
                          void commitTyped(directAdd);
                        }}
                        className="flex w-full items-center justify-between border-t border-[#1f1f23] px-3 py-2 text-left text-[11px] hover:bg-[#101013]"
                      >
                        <span className="text-slate-400">
                          Resolve <span className="font-mono text-slate-200">{directAdd}</span> on the live tape
                        </span>
                        <span className="text-[10px] text-slate-600">ENTER</span>
                      </button>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {addNotice && (
              <div
                className={`flex items-center gap-1.5 text-[11px] ${
                  addNotice.tone === "ok" ? "text-emerald-400" : "text-rose-400"
                }`}
              >
                {addNotice.tone === "error" && <AlertTriangle size={11} />}
                {addNotice.text}
              </div>
            )}
          </div>

          {/* Params */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-[0.08em] text-slate-500">Benchmark</label>
              <input
                value={params.compareAsset}
                onChange={(event) => setCompareAsset(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                className="w-full border border-[#1f1f23] bg-[#0f0f12] px-2.5 py-2 font-mono text-xs outline-none focus:border-[#2a2a30]"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-[0.08em] text-slate-500">Interval</label>
              <select
                value={params.interval}
                onChange={(event) => setParam("interval", event.target.value as ScanParams["interval"])}
                className="w-full border border-[#1f1f23] bg-[#0f0f12] px-2.5 py-2 text-xs outline-none"
              >
                {INTERVALS.map((interval) => (
                  <option key={interval} value={interval}>
                    {interval}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-[0.08em] text-slate-500">Lookback</label>
              <select
                value={params.lookbackDays}
                onChange={(event) => setParam("lookbackDays", Number(event.target.value))}
                className="w-full border border-[#1f1f23] bg-[#0f0f12] px-2.5 py-2 text-xs outline-none"
              >
                {LOOKBACK_CHOICES.filter((days) => days <= MAX_LOOKBACK_DAYS[params.interval]).map(
                  (days) => (
                    <option key={days} value={days}>
                      {days} days
                    </option>
                  )
                )}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-[0.08em] text-slate-500">
                Rolling Window
              </label>
              <select
                value={params.rollingWindow}
                onChange={(event) => setParam("rollingWindow", Number(event.target.value))}
                className="w-full border border-[#1f1f23] bg-[#0f0f12] px-2.5 py-2 text-xs outline-none"
              >
                {ROLLING_WINDOWS[params.interval].map((bars) => (
                  <option key={bars} value={bars}>
                    {bars} bars
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-[0.08em] text-slate-500">Z-Score</label>
              <select
                value={params.zscoreMode}
                onChange={(event) => setParam("zscoreMode", event.target.value as ScanParams["zscoreMode"])}
                className="w-full border border-[#1f1f23] bg-[#0f0f12] px-2.5 py-2 text-xs outline-none"
              >
                {ZSCORE_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Toggles + run */}
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-[#141417] pt-4">
            <div className="flex flex-wrap items-center gap-5">
              <label className="flex cursor-pointer items-center gap-2 text-[11px] text-slate-400">
                <input
                  type="checkbox"
                  checked={params.includeMcap}
                  onChange={(event) => setParam("includeMcap", event.target.checked)}
                  className="accent-emerald-500"
                />
                Market cap
                <span className="text-slate-700">CoinGecko, symbol-matched</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-[11px] text-slate-400">
                <input
                  type="checkbox"
                  checked={params.include24hVol}
                  onChange={(event) => setParam("include24hVol", event.target.checked)}
                  className="accent-emerald-500"
                />
                24h volume
                <span className="text-slate-700">Binance quote volume</span>
              </label>
            </div>

            <button
              onClick={runScan}
              disabled={selected.length === 0 || scanning}
              className="inline-flex items-center gap-2 border border-emerald-800/40 bg-emerald-950/40 px-4 py-2 text-xs text-emerald-400 transition-colors hover:bg-emerald-950/60 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {scanning ? <Loader2 size={13} className="animate-spin" /> : <Radar size={13} />}
              {scanning ? "Scanning" : "Run Scan"}
            </button>
          </div>

          {catalogLoading && !catalog.length && (
            <div className="text-[10px] text-slate-600">Loading the live Binance catalog...</div>
          )}
          {catalogError && (
            <div className="text-[10px] text-rose-400">Catalog: {catalogError}</div>
          )}
          {scanError && (
            <div className="flex items-center gap-1.5 border border-rose-900/40 bg-rose-950/30 px-3 py-2 text-[11px] text-rose-400">
              <AlertTriangle size={12} />
              {scanError}
            </div>
          )}
        </div>
      </div>

      {/* Results */}
      {scan && (
        <div className="border border-[#1f1f23] bg-[#0b0b0e]" ref={resultsRef}>
          <div className="px-4 py-3 border-b border-[#1f1f23] flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="text-xs uppercase tracking-[0.08em] text-slate-400">
                Scan Results
              </span>
              <span className="font-mono text-[10px] text-slate-600">
                {scan.completed}/{scan.total} OK
                {scan.failed > 0 && ` | ${scan.failed} FAILED`}
              </span>
              <span className="font-mono text-[10px] text-slate-500 border border-[#1f1f23] px-2 py-0.5">
                {scan.params.lookbackDays}d lookback · {scan.params.rollingWindow}-bar window ·{" "}
                {scan.params.zscoreMode} z-score · {scan.params.interval}
              </span>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-slate-600">
                Data as of last confirmed close
              </div>
              <div className="font-mono text-[11px] text-slate-400">
                {scan.asOf.iso ? scan.asOf.iso.replace("T", " ").slice(0, 19) + "Z" : "n/a"}
                {scan.asOf.lagMinutes !== null && (
                  <span className="text-slate-600"> ({scan.asOf.lagMinutes}m behind)</span>
                )}
              </div>
            </div>
          </div>

          {scan.warnings.length > 0 && (
            <div className="border-b border-[#1f1f23] px-4 py-2 space-y-1">
              {scan.warnings.map((warning) => (
                <div key={warning} className="flex items-start gap-1.5 text-[10px] text-amber-400/90">
                  <AlertTriangle size={11} className="mt-px shrink-0" />
                  {warning}
                </div>
              ))}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-[#1f1f23] text-[10px] uppercase tracking-wider text-slate-600">
                  <th className="w-8 px-2 py-2" />
                  <th className="px-2 py-2 text-left font-normal">Symbol</th>
                  <th className="px-2 py-2 text-right font-normal">Corr</th>
                  <th className="px-2 py-2 text-right font-normal">Beta</th>
                  <th className="px-2 py-2 text-right font-normal">R²</th>
                  <th
                    className="px-2 py-2 text-right font-normal"
                    title="Return-residual z-score: the coin's move unexplained by the benchmark, on the selected rolling window."
                  >
                    Z-Score
                  </th>
                  <th
                    className="px-2 py-2 text-left font-normal"
                    title="Has the price-ratio Z-score pierced ±2 at any point since 00:00 UTC today?"
                  >
                    ±2 Today
                  </th>
                  <th className="px-2 py-2 text-left font-normal">Signal</th>
                  <th className="px-2 py-2 text-right font-normal">Vol / {scan.benchmarkBaseAsset}</th>
                  <th className="px-2 py-2 text-right font-normal">Stability</th>
                  <th className="px-2 py-2 text-right font-normal">Mkt Cap</th>
                  <th className="px-2 py-2 text-right font-normal">24h Vol</th>
                  <th className="px-2 py-2 text-right font-normal">Vol Ratio</th>
                </tr>
              </thead>
              <tbody>
                {scan.results.map((row) => (
      <ScanRow
        key={row.symbol}
        row={row}
        interval={scan.params.interval}
        benchmarkBaseAsset={scan.benchmarkBaseAsset}
        benchmarkVol={benchmarkVol ?? null}
        expanded={!!open[row.symbol]}
        onToggle={() => toggleRow(row.symbol)}
        onGoToTerminal={() => onGoToTerminal?.(row.symbol, scan.params)}
        scan={scan}
      />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {scanning && (
        <div className="border border-[#1f1f23] bg-[#0b0b0e] px-4 py-10 flex flex-col items-center gap-3">
          <Loader2 size={20} className="animate-spin text-emerald-400" />
          <div className="text-[11px] text-slate-500">
            Sweeping {selected.length} symbols against {params.compareAsset}...
          </div>
          <div className="text-[10px] text-slate-700">
            Metrics are computed server-side so the browser is not holding 20 series at once.
          </div>
        </div>
      )}
    </div>
  );
}

function ScanRow({
  row,
  interval,
  benchmarkBaseAsset,
  benchmarkVol,
  expanded,
  onToggle,
  onGoToTerminal,
  scan,
}: {
  row: ScanResultItem;
  interval: ScanParams["interval"];
  benchmarkBaseAsset: string;
  benchmarkVol: number | null;
  expanded: boolean;
  onToggle: () => void;
  onGoToTerminal?: () => void;
  scan?: ScanResponse;
}) {
  const failed = row.error !== null;
  const badge = signalBadge(row.spreadSignal);
  const todayZ = todayZBadge(row.todayZ);
  const extra: ScanExtra = row.extra ?? {};
  const regime: ScanVolRegime | null = row.volatilityRegime;
  const stability: ScanStability | null = row.stability;

  return (
    <>
      <tr
        className={`cursor-pointer border-b border-[#141417] transition-colors hover:bg-[#101013] ${
          failed ? "opacity-60" : ""
        }`}
      >
        <td className="px-2 py-2 text-slate-600" onClick={onToggle}>
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </td>

        <td className="px-2 py-2 whitespace-nowrap">
          <span className="font-mono text-slate-200">{row.symbol.replace(/USDT$/, "")}</span>
          {row.market === "futures" && (
            <span className="ml-1.5 text-[9px] uppercase text-slate-600">perp</span>
          )}
          {row.historyClamped && !failed && (
            <span
              className="ml-1.5 text-[9px] uppercase text-amber-500/80"
              title="This asset is younger than the requested lookback, so the sample was shortened."
            >
              clamped
            </span>
          )}
          {!failed && onGoToTerminal && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onGoToTerminal();
              }}
              className="ml-2 inline-flex items-center gap-1 border border-[#1f1f23] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-slate-500 hover:text-emerald-400 hover:border-emerald-800/40"
            >
              Go to Terminal
            </button>
          )}
        </td>

        <td className="px-2 py-2 text-right tabular-nums text-slate-300">{num(row.priceCorrelation, 3)}</td>
        <td className="px-2 py-2 text-right tabular-nums text-slate-400">{num(row.beta, 2)}</td>
        <td className="px-2 py-2 text-right tabular-nums text-slate-500">{pct(row.r2, 1)}</td>
        <td className={`px-2 py-2 text-right tabular-nums ${zTone(row.currentZScore)}`}>
          {num(row.currentZScore, 2)}
        </td>

        <td className="px-2 py-2">
          <span
            className={`inline-block border px-1.5 py-0.5 text-[9px] tracking-wider ${todayZ.className}`}
            title={
              row.todayZ && row.todayZ.bars > 0
                ? `${row.todayZ.bars} bar(s) since 00:00 UTC · extreme ${num(row.todayZ.extreme, 2)}`
                : "No bars since 00:00 UTC"
            }
          >
            {todayZ.text}
          </span>
        </td>

        <td className="px-2 py-2">
          <span className={`inline-block border px-1.5 py-0.5 text-[9px] tracking-wider ${badge.className}`}>
            {badge.text}
          </span>
        </td>

        <td className="px-2 py-2 text-right tabular-nums text-slate-400">
          {regime ? `${num(regime.ratio, 2)}x` : "—"}
        </td>

        <td className="px-2 py-2 text-right">
          <span className={`tabular-nums ${stabilityTone(stability?.score ?? null)}`}>
            {stability ? Math.round(stability.score) : "—"}
          </span>
        </td>

        <td className="px-2 py-2 text-right tabular-nums text-slate-400">{usd(extra.mcapUsd)}</td>
        <td className="px-2 py-2 text-right tabular-nums text-slate-400">{usd(extra.vol24hUsd)}</td>
        <td className="px-2 py-2 text-right tabular-nums text-slate-300">
          {extra.vol24hRatio != null ? `${num(extra.vol24hRatio, 3)}x` : "—"}
        </td>
      </tr>

      <AnimatePresence>
        {expanded && (
          <tr className="border-b border-[#1f1f23] bg-[#08080a]">
            <td colSpan={13} className="px-4 py-4">
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.15 }}
                className="overflow-hidden"
              >
                {failed ? (
                  <div className="flex items-start gap-2 text-[11px] text-rose-400">
                    <AlertTriangle size={12} className="mt-px shrink-0" />
                    <div>
                      <div className="uppercase tracking-wider text-[10px]">Symbol failed</div>
                      <div className="mt-1 text-slate-400">{row.error}</div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {/* Provenance strip: the numbers are only as good as this. */}
                    <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-[#141417] pb-3 text-[10px] text-slate-600">
                      <span>
                        {row.symbol} vs {row.baseAsset} on {row.market}/{row.baseMarket} @{" "}
                        {interval}
                      </span>
                      <span>{row.observations} aligned returns</span>
                      <span>{row.barCount} closed bars</span>
                      <span className="font-mono">
                        as of {row.asOfIso ? row.asOfIso.replace("T", " ").slice(0, 19) + "Z" : "n/a"}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                      <Panel title="Correlation" subtitle="Pearson on aligned returns">
                        <DetailCell label="Price return" value={num(row.priceCorrelation)} />
                        <DetailCell label="Beta" value={num(row.beta, 4)} />
                        <DetailCell label="Alpha" value={row.alpha != null ? row.alpha.toExponential(3) : "—"} />
                        <DetailCell label="R² (explained)" value={pct(row.r2, 2)} />
                        <DetailCell label="Tracking error" value={pct(row.trackingError, 3)} />
                        <DetailCell label="Volume sync" value={num(row.volumeCorrelation, 3)} />
                        <DetailCell label="Volatility sync" value={num(row.volatilityCorrelation, 3)} />
                        <div className="pt-2">
                          <Sparkline points={row.rollingCorrelation} width={200} height={26} />
                          <div className="mt-1 text-[9px] uppercase tracking-wider text-slate-700">
                            Rolling correlation ({row.rollingWindow} bars)
                          </div>
                        </div>
                      </Panel>

                      <Panel
                        title="Volatility Regime"
                        subtitle={stability ? `${row.observations} bar sample` : undefined}
                      >
                        {regime ? (
                          <>
                            <DetailCell
                              label={`${row.baseAsset.replace("USDT", "")} annualized`}
                              value={pct(regime.coinAnnualized, 1)}
                            />
                            <DetailCell
                              label={`${benchmarkBaseAsset} annualized`}
                              value={pct(regime.baseAnnualized, 1)}
                            />
                            <DetailCell label="Ratio" value={`${num(regime.ratio, 3)}x`} />
                            <DetailCell
                              label="Ratio percentile"
                              value={`${Math.round(regime.ratioPercentile)}th`}
                            />
                            <DetailCell label="Coin max drawdown" value={pct(regime.maxDrawdown, 1)} />
                            <div className="pt-2 text-[10px] leading-relaxed text-slate-500">
                              {regime.interpretation}
                            </div>
                            <div className="text-[10px] uppercase tracking-wider text-emerald-400/80">
                              {regime.label}
                            </div>
                          </>
                        ) : (
                          <div className="text-[10px] text-slate-600">
                            Sample too short for a volatility regime.
                          </div>
                        )}
                      </Panel>

                      <Panel title="Correlation Stability" subtitle="Is today's reading normal?">
                        {stability ? (
                          <>
                            <DetailCell label="Current" value={num(stability.current, 4)} />
                            <DetailCell label="Mean" value={num(stability.mean, 4)} />
                            <DetailCell label="Std dev" value={num(stability.stdDev, 4)} />
                            <DetailCell
                              label="Range"
                              value={`${num(stability.min, 2)} .. ${num(stability.max, 2)}`}
                            />
                            <DetailCell
                              label="Percentile"
                              value={`${Math.round(stability.percentile)}th`}
                            />
                            <DetailCell label="Stability score" value={`${Math.round(stability.score)}/100`} />
                            <DetailCell
                              label="Regime shift Z"
                              value={num(stability.regimeShiftZ, 2)}
                            />
                        <DetailCell
                          label="Drift / bar"
                          value={stability.trendSlopePerBar.toExponential(2)}
                        />
                        <DetailCell label="Window" value={`${stability.window} bars`} />
                            <div className="pt-2 text-[10px] leading-relaxed text-slate-500">
                              {stability.interpretation}
                            </div>
                            <div className="text-[10px] uppercase tracking-wider text-emerald-400/80">
                              {stability.label}
                            </div>
                          </>
                        ) : (
                          <div className="text-[10px] text-slate-600">
                            Sample too short for a stability reading.
                          </div>
                        )}
                      </Panel>

                      <Panel
                        title="Return Residual"
                        subtitle="Coin's return minus the benchmark-implied move, z-scored"
                      >
                        <DetailCell label="Price ratio" value={num(row.currentRatio, 6)} />
                        <DetailCell label="Residual z-score" value={num(row.currentZScore, 3)} />
                        <DetailCell label="Hit ±2 today" value={todayZ.text} />
                        {row.todayZ && row.todayZ.bars > 0 && (
                          <>
                            <DetailCell label="Bars since 00:00 UTC" value={String(row.todayZ.bars)} />
                            <DetailCell label="Today extreme Z" value={num(row.todayZ.extreme, 3)} />
                            <DetailCell
                              label="First breach"
                              value={
                                row.todayZ.firstHit
                                  ? `${new Date(row.todayZ.firstHit).toISOString().slice(11, 16)} UTC`
                                  : "—"
                              }
                            />
                          </>
                        )}
                        <DetailCell label="Signal" value={badge.text} />
                        <div className="pt-2">
                          <div className="mb-1 text-[9px] uppercase tracking-wider text-slate-700">
                            Lead / lag cross-correlation
                          </div>
                          <div className="space-y-0.5">
                            {row.leadLag.map((point) => {
                              const isPeak =
                                Math.abs(point.coefficient) ===
                                Math.max(...row.leadLag.map((p) => Math.abs(p.coefficient)));
                              return (
                                <div
                                  key={point.lag}
                                  className="flex items-center gap-2 text-[10px]"
                                >
                                  <span className="w-10 font-mono text-slate-600">
                                    {point.lag > 0 ? `+${point.lag}` : point.lag}
                                  </span>
                                  <div className="h-1.5 flex-1 bg-[#141417]">
                                    <div
                                      className={`h-full ${isPeak ? "bg-emerald-400" : "bg-[#2a2a30]"}`}
                                      style={{
                                        width: `${Math.min(100, Math.abs(point.coefficient) * 100)}%`,
                                        marginLeft: point.coefficient < 0 ? "auto" : 0,
                                      }}
                                    />
                                  </div>
                                  <span className="w-12 text-right tabular-nums text-slate-500">
                                    {num(point.coefficient, 3)}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                          {row.leadLag.length > 0 && (
                            <div className="mt-1.5 text-[10px] text-slate-500">
                              {row.leadLag.find((p) => p.lag === row.leadLag[0].lag)?.interpretation ??
                                row.leadLag[0].interpretation}
                            </div>
                          )}
                        </div>
                      </Panel>
                    </div>

                    {/* Size and turnover */}
                    <Panel
                      title="Size & Turnover"
                      subtitle={
                        benchmarkVol != null
                          ? `Benchmark 24h volume ${usd(benchmarkVol)}`
                          : "Benchmark 24h volume unavailable"
                      }
                    >
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <DetailCell label="Last price" value={usd(extra.lastPriceUsd)} />
                        <DetailCell label="Market cap" value={usd(extra.mcapUsd)} />
                        <DetailCell label="24h volume" value={usd(extra.vol24hUsd)} />
                        <DetailCell
                          label={`Volume vs ${benchmarkBaseAsset}`}
                          value={extra.vol24hRatio != null ? `${num(extra.vol24hRatio, 4)}x` : "—"}
                        />
                      </div>
                      {extra.mcapSource && (
                        <div className="text-[10px] text-slate-700">
                          Market cap from {extra.mcapSource}, matched on ticker symbol only. Tickers are not
                          unique off-exchange, so treat this as indicative.
                        </div>
                      )}
                    </Panel>
                  </div>
                )}
              </motion.div>
            </td>
          </tr>
        )}
      </AnimatePresence>
    </>
  );
}

/* ------------------------------------------------------------------------- *
 * Automated scanner view
 *
 * Wraps the two modes the Scanner page offers: the on-demand batch scan and the
 * always-on automated universe. The heavy lifting is server-side; this view is
 * a control surface plus a sortable read-out of the last completed sweep.
 * ------------------------------------------------------------------------- */

const AUTO_INTERVALS: AutoScanParams["interval"][] = ["15m", "1h"];

const AUTO_ROLLING_WINDOWS: Record<AutoScanParams["interval"], number[]> = {
  "1h": [24, 48, 72, 120, 168, 336, 720],
  "15m": [48, 96, 168, 192, 336, 672],
};

const AUTO_LOOKBACK_CHOICES = [7, 14, 30, 45];

type ScanMode = "manual" | "automated";

type AutoSortKey =
  | "symbol"
  | "corr"
  | "beta"
  | "r2"
  | "z"
  | "todayZ"
  | "signal"
  | "volRatio"
  | "takerBuy"
  | "buySell"
  | "takerDelta"
  | "vol24Ratio"
  | "stability"
  | "mcap"
  | "vol24"
  | "updated";

function autoSortValue(row: ScanResultItem, key: AutoSortKey): number | string | null {
  const extra = row.extra ?? {};
  switch (key) {
    case "symbol":
      return row.symbol;
    case "corr":
      return row.priceCorrelation;
    case "beta":
      return row.beta;
    case "r2":
      return row.r2;
    case "z":
      return row.currentZScore;
    case "todayZ":
      return row.todayZ ? row.todayZ.maxAbs : null;
    case "signal":
      return row.spreadSignal;
    case "volRatio":
      return row.volatilityRegime?.ratio ?? null;
    case "takerBuy":
      return extra.takerBuyShare ?? null;
    case "buySell":
      return extra.buySellRatio ?? null;
    case "takerDelta":
      return extra.takerDeltaUsd ?? null;
    case "vol24Ratio":
      return extra.vol24hRatio ?? null;
    case "stability":
      return row.stability?.score ?? null;
    case "mcap":
      return extra.mcapUsd ?? null;
    case "vol24":
      return extra.vol24hUsd ?? null;
    case "updated":
      return row.updatedAt ?? null;
  }
}

/** Coerces an auto config into the ScanParams the terminal expects. */
function autoToScanParams(params: AutoScanParams): ScanParams {
  return {
    compareAsset: params.compareAsset,
    interval: params.interval,
    rollingWindow: params.rollingWindow,
    zscoreMode: params.zscoreMode,
    lookbackDays: params.lookbackDays,
    includeMcap: params.includeMcap,
    include24hVol: params.include24hVol,
  };
}

function relTime(ms: number, now: number): string {
  const delta = Math.round((now - ms) / 60000);
  if (delta <= 0) return "just now";
  if (delta < 60) return `${delta}m ago`;
  return `${Math.floor(delta / 60)}h ${delta % 60}m ago`;
}

/** True when the tape flow leans to buyers / sellers / is balanced. */
function takerTone(share: number | null | undefined): string {
  if (share === null || share === undefined || !Number.isFinite(share)) return "text-slate-500";
  if (share > 0.55) return "text-emerald-400";
  if (share < 0.45) return "text-rose-400";
  return "text-slate-300";
}

function SortHeader({
  label,
  k,
  sort,
  onSort,
  className = "",
  title,
}: {
  label: string;
  k: AutoSortKey;
  sort: { key: AutoSortKey; dir: "asc" | "desc" };
  onSort: (k: AutoSortKey) => void;
  className?: string;
  title?: string;
}) {
  const active = sort.key === k;
  return (
    <th className={`px-2 py-2 font-normal ${className}`} title={title}>
      <button
        onClick={() => onSort(k)}
        className={`inline-flex items-center gap-1 whitespace-nowrap uppercase tracking-wider ${
          active ? "text-emerald-400" : "text-slate-600 hover:text-slate-300"
        }`}
      >
        {label}
        {active ? sort.dir === "asc" ? <ArrowUp size={10} /> : <ArrowDown size={10} /> : null}
      </button>
    </th>
  );
}

export default function Scanner(props: {
  compareAsset: string;
  setCompareAsset: (value: string) => void;
  onGoToTerminal?: (symbol: string, params: ScanParams) => void;
}) {
  const [mode, setMode] = useState<ScanMode>("manual");
  const modes: { id: ScanMode; label: string; icon: React.ReactNode }[] = [
    { id: "manual", label: "Manual Scan", icon: <Radar size={12} /> },
    { id: "automated", label: "Automated Scanner", icon: <Radio size={12} /> },
  ];

  return (
    <div className="space-y-6">
      <div className="inline-flex items-center gap-1 border border-[#1f1f23] bg-[#0b0b0e] p-1">
        {modes.map((item) => (
          <button
            key={item.id}
            onClick={() => setMode(item.id)}
            className={`inline-flex items-center gap-2 border px-3 py-1.5 text-[11px] uppercase tracking-wider transition-colors ${
              mode === item.id
                ? "border-emerald-800/40 bg-emerald-950/50 text-emerald-400"
                : "border-transparent text-slate-500 hover:text-slate-300"
            }`}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>

      {mode === "manual" ? (
        <ManualScanner {...props} />
      ) : (
        <AutoScanner
          compareAsset={props.compareAsset}
          setCompareAsset={props.setCompareAsset}
          onGoToTerminal={props.onGoToTerminal}
        />
      )}
    </div>
  );
}

function AutoScanner({
  compareAsset,
  setCompareAsset,
  onGoToTerminal,
}: {
  compareAsset: string;
  setCompareAsset: (value: string) => void;
  onGoToTerminal?: (symbol: string, params: ScanParams) => void;
}) {
  const { symbols: catalog, ensureLoaded } = useSymbolCatalog();

  const [snapshot, setSnapshot] = useState<AutoScanSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Editor state, seeded once from the server config so the universe is kept
  // in server memory unless the user explicitly edits and confirms it.
  const [symbols, setSymbols] = useState<string[]>([]);
  const [params, setParams] = useState<AutoScanParams>({
    compareAsset,
    interval: "1h",
    rollingWindow: defaultRollingWindow("1h"),
    zscoreMode: "expanding",
    lookbackDays: defaultLookbackDays("1h"),
    zThreshold: 2,
    includeMcap: true,
    include24hVol: true,
  });
  const adoptedConfig = useRef<string | null>(null);

  const [query, setQuery] = useState("");
  const [showSuggest, setShowSuggest] = useState(false);
  const [highlight, setHighlight] = useState(-1);

  const [reviewOpen, setReviewOpen] = useState(false);
  const [preview, setPreview] = useState<AutoScanConfigResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const [sort, setSort] = useState<{ key: AutoSortKey; dir: "asc" | "desc" }>({
    key: "z",
    dir: "desc",
  });
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const load = useCallback(async (): Promise<AutoScanSnapshot | null> => {
    try {
      const response = await fetch("/api/auto-scanner");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as AutoScanSnapshot;
      setSnapshot(payload);
      setLoadError(null);
      return payload;
    } catch (error: any) {
      setLoadError(error.message || "Could not reach the automated scanner.");
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = window.setInterval(() => void load(), 20000);
    return () => window.clearInterval(poll);
  }, [load]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    const serverKey = JSON.stringify(snapshot.config);
    if (serverKey === adoptedConfig.current) return;
    const editorKey = JSON.stringify({ symbols, params });
    const previousServer = adoptedConfig.current;
    // Adopt the server's universe on first load, and again whenever the editor
    // still matches the last config we adopted (the user has not staged edits).
    // This is what keeps the list consistent across devices and reloads: the
    // engine's config is server-side, so any device reconciles to it.
    if (previousServer === null || editorKey === previousServer) {
      setSymbols(snapshot.config.symbols);
      setParams(snapshot.config.params);
    }
    adoptedConfig.current = serverKey;
  }, [snapshot, symbols, params]);

  useEffect(() => {
    setParams((prev) => (prev.compareAsset === compareAsset ? prev : { ...prev, compareAsset }));
  }, [compareAsset]);

  const atCapacity = symbols.length >= AUTO_SCAN_MAX_SYMBOLS;

  const suggestions = useMemo(
    () => rankCatalogMatches(catalog, query, { exclude: symbols, limit: 8 }),
    [catalog, query, symbols]
  );

  const directAdd = useMemo(() => {
    if (rankCatalogMatches(catalog, query, { limit: 1 }).length > 0) return null;
    const typed = query.trim();
    return typed.length > 0 ? typed : null;
  }, [catalog, query]);

  useEffect(() => {
    setHighlight((prev) => (prev >= suggestions.length ? -1 : prev));
  }, [suggestions.length]);

  const addSymbol = (symbol: string) => {
    setSymbols((prev) =>
      prev.includes(symbol) || prev.length >= AUTO_SCAN_MAX_SYMBOLS ? prev : [...prev, symbol]
    );
    setQuery("");
    setShowSuggest(false);
    setHighlight(-1);
  };

  const addTyped = async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed || atCapacity) return;
    setNotice(null);
    try {
      const result = await resolveTicker(trimmed, catalog);
      if (result.status === "ok") {
        addSymbol(result.coin.symbol);
      } else if (result.status === "not-found") {
        setNotice({ tone: "error", text: `${result.symbol} is not trading on Binance.` });
      } else {
        setNotice({ tone: "error", text: result.message });
      }
    } catch (error: any) {
      setNotice({ tone: "error", text: error.message || "Could not resolve that ticker." });
    }
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && suggestions.length > 0) {
      event.preventDefault();
      setShowSuggest(true);
      setHighlight((prev) => (prev + 1) % suggestions.length);
    } else if (event.key === "ArrowUp" && suggestions.length > 0) {
      event.preventDefault();
      setHighlight((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (highlight >= 0 && suggestions[highlight]) addSymbol(suggestions[highlight].coin.symbol);
      else if (query.trim()) void addTyped(query);
    } else if (event.key === "Escape") {
      setShowSuggest(false);
      setHighlight(-1);
    }
  };

  const setParam = <K extends keyof AutoScanParams>(key: K, value: AutoScanParams[K]) => {
    setParams((prev) => {
      const next = { ...prev, [key]: value };
      const bars = Math.floor(
        (next.lookbackDays * 86400000) / (next.interval === "1h" ? 3600000 : 900000)
      );
      if (next.rollingWindow > bars) next.rollingWindow = Math.max(5, bars);
      if (key === "interval") {
        const ladder = AUTO_ROLLING_WINDOWS[next.interval];
        if (!ladder.includes(next.rollingWindow)) {
          const sharedDefault = defaultRollingWindow(next.interval);
          next.rollingWindow = ladder.includes(sharedDefault) ? sharedDefault : ladder[0];
        }
      }
      return next;
    });
  };

  const dirty =
    !snapshot ||
    symbols.join(",") !== snapshot.config.symbols.join(",") ||
    JSON.stringify(params) !== JSON.stringify(snapshot.config.params);

  const reviewChanges = async () => {
    setPreviewing(true);
    setNotice(null);
    try {
      const response = await fetch("/api/auto-scanner/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols, params, confirm: false }),
      });
      const payload = (await response.json()) as AutoScanConfigResponse & { error?: string };
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
      setPreview(payload);
      setReviewOpen(true);
    } catch (error: any) {
      setNotice({ tone: "error", text: error.message || "Could not validate the universe." });
    } finally {
      setPreviewing(false);
    }
  };

  const confirmApply = async () => {
    setApplying(true);
    try {
      const response = await fetch("/api/auto-scanner/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols, params, confirm: true }),
      });
      const payload = (await response.json()) as AutoScanConfigResponse & { error?: string };
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
      setSymbols(payload.config.symbols);
      setParams(payload.config.params);
      setSnapshot((prev) => (prev ? { ...prev, config: payload.config } : prev));
      setReviewOpen(false);
      setPreview(null);
      const rejected = payload.rejected.length;
      setNotice({
        tone: rejected > 0 ? "error" : "ok",
        text:
          `Universe committed: ${payload.config.symbols.length} symbol(s)` +
          (rejected > 0 ? ` · ${rejected} unresolved and left as failed rows` : "") +
          ". Backfilling now.",
      });
      void load();
    } catch (error: any) {
      setNotice({ tone: "error", text: error.message || "Could not apply the universe." });
    } finally {
      setApplying(false);
    }
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const response = await fetch("/api/auto-scanner/run", { method: "POST" });
      const payload = (await response.json()) as AutoScanSnapshot;
      if (response.ok || response.status === 202) {
        setSnapshot(payload);
        setLoadError(null);
      } else {
        setSnapshot(payload);
        if ((payload as any)?.meta?.lastSweepError) {
          setLoadError((payload as any).meta.lastSweepError);
        }
      }
    } catch {
      // The 20s poll will catch up; a failed forced run is not fatal.
    } finally {
      setRunning(false);
    }
  };

  const toggleSort = (key: AutoSortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "symbol" || key === "signal" ? "asc" : "desc" }
    );
  };

  const rows = useMemo(() => {
    if (!snapshot) return [];
    return [...snapshot.rows].sort((a, b) => {
      const av = autoSortValue(a, sort.key);
      const bv = autoSortValue(b, sort.key);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (typeof av === "string" || typeof bv === "string") {
        const cmp = String(av).localeCompare(String(bv));
        return sort.dir === "asc" ? cmp : -cmp;
      }
      const cmp = av - bv;
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [snapshot, sort]);

  const meta = snapshot?.meta;
  const universe = snapshot?.universe;
  const secsToSweep =
    meta?.nextSweepAt != null ? Math.max(0, Math.round((meta.nextSweepAt - now) / 1000)) : null;
  const benchmarkVol =
    snapshot?.rows.find((r) => r.extra.vol24hBaseUsd != null)?.extra.vol24hBaseUsd ?? null;

  return (
    <div className="space-y-6">
      {/* Engine status */}
      <div className="border border-[#1f1f23] bg-[#0b0b0e]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1f1f23] px-4 py-3">
          <div className="flex items-center gap-2.5">
            <Radio
              size={15}
              className={meta?.active ? "text-emerald-400 animate-pulse" : "text-slate-600"}
            />
            <span className="text-xs uppercase tracking-[0.08em] text-slate-400">
              Automated Scanner
            </span>
            {meta?.active ? (
              <span className="border border-emerald-800/40 bg-emerald-950/40 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-emerald-400">
                Always On
              </span>
            ) : (
              <span className="border border-slate-800 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-slate-500">
                Offline
              </span>
            )}
            {meta?.running && (
              <span className="flex items-center gap-1 text-[10px] text-amber-400">
                <Loader2 size={11} className="animate-spin" /> sweeping
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => void load()}
              className="inline-flex items-center gap-1.5 border border-[#1f1f23] px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-slate-400 hover:text-slate-200"
            >
              <Clock size={11} /> Refresh
            </button>
            <button
              onClick={runNow}
              disabled={running || meta?.running || !snapshot}
              className="inline-flex items-center gap-1.5 border border-emerald-800/40 bg-emerald-950/40 px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-emerald-400 hover:bg-emerald-950/60 disabled:opacity-40"
            >
              {running ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />} Run
              Now
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4 lg:grid-cols-6">
          <StatusStat
            label="Next sweep"
            value={secsToSweep != null ? `in ${secsToSweep}s` : "—"}
            hint={meta?.nextCloseAt ? new Date(meta.nextCloseAt).toISOString().slice(11, 16) + "Z close" : undefined}
          />
          <StatusStat
            label="Last sweep"
            value={meta?.lastSweepFinishedAt ? relTime(meta.lastSweepFinishedAt, now) : "pending"}
            hint={
              meta?.lastSweepDurationMs != null ? `${meta.lastSweepDurationMs}ms` : undefined
            }
          />
          <StatusStat
            label="Universe"
            value={universe ? `${universe.ready}/${universe.total} ready` : "—"}
            hint={universe && universe.warming > 0 ? `${universe.warming} warming` : "backfilled"}
          />
          <StatusStat
            label="Failed"
            value={universe ? String(universe.failed) : "—"}
            tone={universe && universe.failed > 0 ? "text-rose-400" : "text-slate-200"}
          />
          <StatusStat
            label="Bars held"
            value={universe ? universe.barsStored.toLocaleString() : "—"}
            hint={universe ? `+${universe.baseBarsStored.toLocaleString()} bench` : undefined}
          />
          <StatusStat
            label="Sweeps"
            value={meta ? String(meta.sweeps) : "—"}
            hint={meta?.lastSweepOk != null ? `${meta.lastSweepOk} ok / ${meta.lastSweepFailed} failed` : undefined}
          />
        </div>

        {meta?.lastSweepError && (
          <div className="flex items-center gap-1.5 border-t border-[#1f1f23] px-4 py-2 text-[10px] text-rose-400">
            <AlertTriangle size={11} /> {meta.lastSweepError}
            {meta.consecutiveFailures > 1 && ` (${meta.consecutiveFailures} consecutive)`}
          </div>
        )}
        {loadError && (
          <div className="flex items-center gap-1.5 border-t border-[#1f1f23] px-4 py-2 text-[10px] text-rose-400">
            <AlertTriangle size={11} /> {loadError}
          </div>
        )}
      </div>

      {/* Universe editor */}
      <div className="border border-[#1f1f23] bg-[#0b0b0e]">
        <div className="flex items-center justify-between gap-3 border-b border-[#1f1f23] px-4 py-3">
          <div className="flex items-center gap-2.5">
            <Settings2 size={14} className="text-slate-400" />
            <span className="text-xs uppercase tracking-[0.08em] text-slate-400">
              Universe & Parameters
            </span>
          </div>
          <span className="font-mono text-[10px] text-slate-600">
            {symbols.length}/{AUTO_SCAN_MAX_SYMBOLS} SYMBOLS
          </span>
        </div>

        <div className="space-y-5 p-4">
          {/* Symbols */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[10px] uppercase tracking-[0.08em] text-slate-500">
                Subjects
              </label>
              {symbols.length > 0 && (
                <button
                  onClick={() => setSymbols([])}
                  className="text-[10px] uppercase tracking-wider text-slate-600 hover:text-slate-400"
                >
                  Clear all
                </button>
              )}
            </div>

            {symbols.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {symbols.map((symbol) => (
                  <span
                    key={symbol}
                    className="inline-flex items-center gap-1.5 border border-[#1f1f23] bg-[#101013] px-2 py-1 font-mono text-[11px] text-slate-300"
                  >
                    {symbol.replace(/USDT$/, "")}
                    <button
                      onClick={() => setSymbols((prev) => prev.filter((s) => s !== symbol))}
                      className="text-slate-600 hover:text-rose-400"
                      aria-label={`Remove ${symbol}`}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="relative">
              <div className="flex items-center gap-2 border border-[#1f1f23] bg-[#0f0f12] px-3 py-2 focus-within:border-[#2a2a30]">
                <Search size={13} className="shrink-0 text-slate-600" />
                <input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    if (event.target.value.trim()) {
                      setShowSuggest(true);
                      ensureLoaded();
                    }
                  }}
                  onFocus={() => {
                    if (query.trim()) setShowSuggest(true);
                    ensureLoaded();
                  }}
                  onBlur={() => window.setTimeout(() => setShowSuggest(false), 140)}
                  onKeyDown={onSearchKeyDown}
                  disabled={atCapacity}
                  placeholder={
                    atCapacity
                      ? `Universe is capped at ${AUTO_SCAN_MAX_SYMBOLS} symbols`
                      : "Add a symbol: sol, LDOUSDT, 1000PEPE..."
                  }
                  className="flex-1 bg-transparent text-xs outline-none placeholder:text-slate-700 disabled:placeholder:text-slate-700"
                />
                {query && (
                  <button onClick={() => setQuery("")} className="text-slate-600 hover:text-slate-400">
                    <X size={12} />
                  </button>
                )}
              </div>

              <AnimatePresence>
                {showSuggest && (suggestions.length > 0 || directAdd) && !atCapacity && (
                  <motion.div
                    initial={{ opacity: 0, y: -3 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -3 }}
                    transition={{ duration: 0.12 }}
                    className="absolute z-30 mt-1 w-full border border-[#1f1f23] bg-[#0b0b0e] shadow-xl"
                  >
                    {suggestions.map((match, index) => (
                      <button
                        key={match.coin.symbol}
                        onMouseEnter={() => setHighlight(index)}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          addSymbol(match.coin.symbol);
                        }}
                        className={`flex w-full items-center justify-between px-3 py-2 text-left text-[11px] ${
                          index === highlight ? "bg-[#141417]" : "hover:bg-[#101013]"
                        }`}
                      >
                        <span className="font-mono text-slate-200">{match.coin.symbol}</span>
                        <span className="text-[10px] text-slate-600">
                          {match.coin.market === "futures" ? "PERPETUAL" : match.coin.category}
                        </span>
                      </button>
                    ))}
                    {directAdd && (
                      <button
                        onMouseDown={(event) => {
                          event.preventDefault();
                          void addTyped(directAdd);
                        }}
                        className="flex w-full items-center justify-between border-t border-[#1f1f23] px-3 py-2 text-left text-[11px] hover:bg-[#101013]"
                      >
                        <span className="text-slate-400">
                          Resolve <span className="font-mono text-slate-200">{directAdd}</span> on the
                          live tape
                        </span>
                        <span className="text-[10px] text-slate-600">ENTER</span>
                      </button>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Params */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-[0.08em] text-slate-500">
                Benchmark
              </label>
              <input
                value={params.compareAsset}
                onChange={(event) => setCompareAsset(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                className="w-full border border-[#1f1f23] bg-[#0f0f12] px-2.5 py-2 font-mono text-xs outline-none focus:border-[#2a2a30]"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-[0.08em] text-slate-500">
                Timeframe
              </label>
              <select
                value={params.interval}
                onChange={(event) => setParam("interval", event.target.value as AutoScanParams["interval"])}
                className="w-full border border-[#1f1f23] bg-[#0f0f12] px-2.5 py-2 text-xs outline-none"
              >
                {AUTO_INTERVALS.map((interval) => (
                  <option key={interval} value={interval}>
                    {interval}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-[0.08em] text-slate-500">Lookback</label>
              <select
                value={params.lookbackDays}
                onChange={(event) => setParam("lookbackDays", Number(event.target.value))}
                className="w-full border border-[#1f1f23] bg-[#0f0f12] px-2.5 py-2 text-xs outline-none"
              >
                {AUTO_LOOKBACK_CHOICES.filter((days) => days <= MAX_LOOKBACK_DAYS[params.interval]).map(
                  (days) => (
                    <option key={days} value={days}>
                      {days} days
                    </option>
                  )
                )}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-[0.08em] text-slate-500">
                Rolling Window
              </label>
              <select
                value={params.rollingWindow}
                onChange={(event) => setParam("rollingWindow", Number(event.target.value))}
                className="w-full border border-[#1f1f23] bg-[#0f0f12] px-2.5 py-2 text-xs outline-none"
              >
                {AUTO_ROLLING_WINDOWS[params.interval].map((bars) => (
                  <option key={bars} value={bars}>
                    {bars} bars
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-[0.08em] text-slate-500">Z-Score</label>
              <select
                value={params.zscoreMode}
                onChange={(event) => setParam("zscoreMode", event.target.value as AutoScanParams["zscoreMode"])}
                className="w-full border border-[#1f1f23] bg-[#0f0f12] px-2.5 py-2 text-xs outline-none"
              >
                {(["expanding", "rolling", "batch"] as AutoScanParams["zscoreMode"][]).map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-[0.08em] text-slate-500">
                Alert |z| ≥
              </label>
              <input
                type="number"
                step={0.1}
                min={0.5}
                max={6}
                value={params.zThreshold}
                onChange={(event) => setParam("zThreshold", Number(event.target.value))}
                className="w-full border border-[#1f1f23] bg-[#0f0f12] px-2.5 py-2 text-xs outline-none focus:border-[#2a2a30]"
              />
            </div>
          </div>

          {/* Toggles + apply */}
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-[#141417] pt-4">
            <div className="flex flex-wrap items-center gap-5">
              <label className="flex cursor-pointer items-center gap-2 text-[11px] text-slate-400">
                <input
                  type="checkbox"
                  checked={params.includeMcap}
                  onChange={(event) => setParam("includeMcap", event.target.checked)}
                  className="accent-emerald-500"
                />
                Market cap
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-[11px] text-slate-400">
                <input
                  type="checkbox"
                  checked={params.include24hVol}
                  onChange={(event) => setParam("include24hVol", event.target.checked)}
                  className="accent-emerald-500"
                />
                24h volume
              </label>
            </div>

            <button
              onClick={reviewChanges}
              disabled={previewing || !dirty}
              className="inline-flex items-center gap-2 border border-emerald-800/40 bg-emerald-950/40 px-4 py-2 text-xs text-emerald-400 transition-colors hover:bg-emerald-950/60 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {previewing ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
              Review &amp; Apply
            </button>
          </div>

          {!dirty && snapshot && (
            <div className="text-[10px] text-slate-600">
              The live engine is running exactly this configuration. Edit a symbol or parameter to
              stage a change.
            </div>
          )}
          {notice && (
            <div
              className={`flex items-center gap-1.5 border px-3 py-2 text-[11px] ${
                notice.tone === "ok"
                  ? "border-emerald-900/40 bg-emerald-950/30 text-emerald-400"
                  : "border-rose-900/40 bg-rose-950/30 text-rose-400"
              }`}
            >
              {notice.tone === "error" && <AlertTriangle size={11} />}
              {notice.text}
            </div>
          )}
        </div>
      </div>

      {/* Results */}
      {snapshot && snapshot.rows.length === 0 ? (
        <div className="border border-[#1f1f23] bg-[#0b0b0e] px-4 py-12 text-center text-[11px] text-slate-500">
          The universe is empty. Add symbols above and apply to start the 24/7 sweep.
        </div>
      ) : snapshot ? (
        <div className="border border-[#1f1f23] bg-[#0b0b0e]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1f1f23] px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="text-xs uppercase tracking-[0.08em] text-slate-400">
                Automated Results
              </span>
              <span className="font-mono text-[10px] text-slate-600">
                rev {snapshot.revision} · {snapshot.config.params.interval} ·{" "}
                {snapshot.config.params.lookbackDays}d · rev-updated on every close
              </span>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-slate-600">
                Data as of last confirmed close
              </div>
              <div className="font-mono text-[11px] text-slate-400">
                {snapshot.asOf.iso
                  ? snapshot.asOf.iso.replace("T", " ").slice(0, 19) + "Z"
                  : "waiting for first sweep"}
                {snapshot.asOf.lagMinutes !== null && (
                  <span className="text-slate-600"> ({snapshot.asOf.lagMinutes}m behind)</span>
                )}
              </div>
            </div>
          </div>

          {snapshot.warnings.length > 0 && (
            <div className="space-y-1 border-b border-[#1f1f23] px-4 py-2">
              {snapshot.warnings.map((warning) => (
                <div key={warning} className="flex items-start gap-1.5 text-[10px] text-amber-400/90">
                  <AlertTriangle size={11} className="mt-px shrink-0" />
                  {warning}
                </div>
              ))}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-[#1f1f23] text-[10px] text-slate-600">
                  <th className="w-8 px-2 py-2" />
                  <SortHeader label="Symbol" k="symbol" sort={sort} onSort={toggleSort} className="text-left" />
                  <SortHeader label="Corr" k="corr" sort={sort} onSort={toggleSort} className="text-right" />
                  <SortHeader label="Beta" k="beta" sort={sort} onSort={toggleSort} className="text-right" />
                  <SortHeader label="R²" k="r2" sort={sort} onSort={toggleSort} className="text-right" />
                  <SortHeader
                    label="Z-Score"
                    k="z"
                    sort={sort}
                    onSort={toggleSort}
                    className="text-right"
                    title="Return-residual z-score on the selected window."
                  />
                  <SortHeader label="±2 Today" k="todayZ" sort={sort} onSort={toggleSort} className="text-left" />
                  <SortHeader label="Signal" k="signal" sort={sort} onSort={toggleSort} className="text-left" />
                  <SortHeader
                    label="Vol Ratio"
                    k="volRatio"
                    sort={sort}
                    onSort={toggleSort}
                    className="text-right"
                    title="Annualized subject vol / benchmark vol over the window."
                  />
                  <SortHeader
                    label="Taker Buy"
                    k="takerBuy"
                    sort={sort}
                    onSort={toggleSort}
                    className="text-right"
                    title="Last closed bar: aggressive BUY volume / total volume."
                  />
                  <SortHeader
                    label="Buy/Sell"
                    k="buySell"
                    sort={sort}
                    onSort={toggleSort}
                    className="text-right"
                    title="Last closed bar: aggressive BUY volume / aggressive SELL volume."
                  />
                  <SortHeader
                    label="Delta USD"
                    k="takerDelta"
                    sort={sort}
                    onSort={toggleSort}
                    className="text-right"
                    title="Last closed bar net taker delta in USD: (2*buy - volume) * close."
                  />
                  <SortHeader label="24h Vol Ratio" k="vol24Ratio" sort={sort} onSort={toggleSort} className="text-right" />
                  <SortHeader label="Stability" k="stability" sort={sort} onSort={toggleSort} className="text-right" />
                  <SortHeader label="Mkt Cap" k="mcap" sort={sort} onSort={toggleSort} className="text-right" />
                  <SortHeader label="24h Vol" k="vol24" sort={sort} onSort={toggleSort} className="text-right" />
                  <SortHeader label="Updated" k="updated" sort={sort} onSort={toggleSort} className="text-right" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <AutoRow
                    key={row.symbol}
                    row={row}
                    interval={snapshot.config.params.interval}
                    zThreshold={snapshot.config.params.zThreshold}
                    benchmarkBaseAsset={snapshot.benchmarkBaseAsset}
                    benchmarkVol={benchmarkVol}
                    now={now}
                    expanded={!!open[row.symbol]}
                    onToggle={() =>
                      setOpen((prev) => ({ ...prev, [row.symbol]: !prev[row.symbol] }))
                    }
                    onGoToTerminal={
                      onGoToTerminal
                        ? () => onGoToTerminal(row.symbol, autoToScanParams(snapshot.config.params))
                        : undefined
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 border border-[#1f1f23] bg-[#0b0b0e] px-4 py-12">
          <Loader2 size={20} className="animate-spin text-emerald-400" />
          <div className="text-[11px] text-slate-500">Reading the automated scanner engine...</div>
        </div>
      )}

      {/* Confirmation dialog */}
      <AnimatePresence>
        {reviewOpen && preview && snapshot && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
            onClick={() => !applying && setReviewOpen(false)}
          >
            <motion.div
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.15 }}
              onClick={(event) => event.stopPropagation()}
              className="max-h-[85vh] w-full max-w-lg overflow-y-auto border border-[#1f1f23] bg-[#0b0b0e]"
            >
              <div className="border-b border-[#1f1f23] px-4 py-3">
                <div className="text-xs uppercase tracking-[0.08em] text-slate-300">
                  Confirm Scanner Configuration
                </div>
                <div className="mt-0.5 text-[10px] text-slate-600">
                  These changes are applied to the always-on engine and the universe is rebuilt.
                </div>
              </div>

              <div className="space-y-1.5 p-4 text-[11px]">
                <ChangeRow
                  label="Subjects"
                  before={`${snapshot.config.symbols.length}`}
                  after={`${preview.config.symbols.length}`}
                />
                <ChangeRow
                  label="Benchmark"
                  before={snapshot.config.params.compareAsset}
                  after={preview.config.params.compareAsset}
                />
                <ChangeRow
                  label="Timeframe"
                  before={snapshot.config.params.interval}
                  after={preview.config.params.interval}
                />
                <ChangeRow
                  label="Lookback"
                  before={`${snapshot.config.params.lookbackDays}d`}
                  after={`${preview.config.params.lookbackDays}d`}
                />
                <ChangeRow
                  label="Rolling window"
                  before={`${snapshot.config.params.rollingWindow} bars`}
                  after={`${preview.config.params.rollingWindow} bars`}
                />
                <ChangeRow
                  label="Z-score mode"
                  before={snapshot.config.params.zscoreMode}
                  after={preview.config.params.zscoreMode}
                />
                <ChangeRow
                  label="Alert |z|"
                  before={`${snapshot.config.params.zThreshold}`}
                  after={`${preview.config.params.zThreshold}`}
                />
              </div>

              {preview.config.symbols.length > 0 && (
                <div className="border-t border-[#141417] px-4 py-3">
                  <div className="mb-1.5 text-[10px] uppercase tracking-wider text-slate-600">
                    Confirmed subjects ({preview.config.symbols.length})
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {preview.config.symbols.map((symbol) => (
                      <span
                        key={symbol}
                        className="border border-[#1f1f23] bg-[#101013] px-1.5 py-0.5 font-mono text-[10px] text-slate-300"
                      >
                        {symbol}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {preview.rejected.length > 0 && (
                <div className="border-t border-[#141417] px-4 py-3">
                  <div className="mb-1.5 text-[10px] uppercase tracking-wider text-amber-400">
                    Unresolved ({preview.rejected.length})
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {preview.rejected.map((symbol) => (
                      <span
                        key={symbol}
                        className="border border-amber-900/40 bg-amber-950/30 px-1.5 py-0.5 font-mono text-[10px] text-amber-400"
                      >
                        {symbol}
                      </span>
                    ))}
                  </div>
                  <div className="mt-1.5 text-[10px] text-slate-600">
                    These will be kept but marked failed until Binance lists them.
                  </div>
                </div>
              )}

              {preview.warnings.length > 0 && (
                <div className="space-y-1 border-t border-[#141417] px-4 py-3">
                  {preview.warnings.map((warning) => (
                    <div key={warning} className="flex items-start gap-1.5 text-[10px] text-amber-400/90">
                      <AlertTriangle size={11} className="mt-px shrink-0" />
                      {warning}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 border-t border-[#1f1f23] px-4 py-3">
                <button
                  onClick={() => setReviewOpen(false)}
                  disabled={applying}
                  className="border border-[#1f1f23] px-3 py-1.5 text-[11px] text-slate-400 hover:text-slate-200 disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmApply}
                  disabled={applying}
                  className="inline-flex items-center gap-1.5 border border-emerald-800/40 bg-emerald-950/40 px-3 py-1.5 text-[11px] text-emerald-400 hover:bg-emerald-950/60 disabled:opacity-40"
                >
                  {applying ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                  Confirm &amp; Apply
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function StatusStat({
  label,
  value,
  hint,
  tone = "text-slate-200",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] uppercase tracking-wider text-slate-600">{label}</div>
      <div className={`tabular-nums text-sm ${tone}`}>{value}</div>
      {hint && <div className="text-[9px] text-slate-700">{hint}</div>}
    </div>
  );
}

function ChangeRow({ label, before, after }: { label: string; before: string; after: string }) {
  const changed = before !== after;
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className="font-mono">
        {changed ? (
          <>
            <span className="text-slate-600 line-through">{before}</span>
            <span className="mx-1.5 text-slate-600">→</span>
            <span className="text-emerald-400">{after}</span>
          </>
        ) : (
          <span className="text-slate-300">{after}</span>
        )}
      </span>
    </div>
  );
}

function AutoRow({
  row,
  interval,
  zThreshold,
  benchmarkBaseAsset,
  benchmarkVol,
  now,
  expanded,
  onToggle,
  onGoToTerminal,
}: {
  row: ScanResultItem;
  interval: AutoScanParams["interval"];
  zThreshold: number;
  benchmarkBaseAsset: string;
  benchmarkVol: number | null;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  onGoToTerminal?: () => void;
}) {
  const failed = row.error !== null;
  const badge = signalBadge(row.spreadSignal);
  const todayZ = todayZBadge(row.todayZ);
  const extra: ScanExtra = row.extra ?? {};
  const regime: ScanVolRegime | null = row.volatilityRegime;
  const stability: ScanStability | null = row.stability;
  const alerted =
    row.currentZScore !== null && Math.abs(row.currentZScore) >= zThreshold;

  return (
    <>
      <tr
        className={`cursor-pointer border-b border-[#141417] transition-colors hover:bg-[#101013] ${
          failed ? "opacity-60" : ""
        }`}
      >
        <td className="px-2 py-2 text-slate-600" onClick={onToggle}>
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </td>

        <td className="whitespace-nowrap px-2 py-2">
          <span className={`font-mono ${alerted ? "text-amber-400" : "text-slate-200"}`}>
            {row.symbol.replace(/USDT$/, "")}
          </span>
          {row.market === "futures" && (
            <span className="ml-1.5 text-[9px] uppercase text-slate-600">perp</span>
          )}
          {row.historyClamped && !failed && (
            <span
              className="ml-1.5 text-[9px] uppercase text-amber-500/80"
              title="This asset is younger than the requested lookback, so the sample was shortened."
            >
              clamped
            </span>
          )}
          {!failed && onGoToTerminal && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onGoToTerminal();
              }}
              className="ml-2 inline-flex items-center gap-1 border border-[#1f1f23] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-slate-500 hover:border-emerald-800/40 hover:text-emerald-400"
            >
              Go to Terminal
            </button>
          )}
        </td>

        <td className="px-2 py-2 text-right tabular-nums text-slate-300">
          {num(row.priceCorrelation, 3)}
        </td>
        <td className="px-2 py-2 text-right tabular-nums text-slate-400">{num(row.beta, 2)}</td>
        <td className="px-2 py-2 text-right tabular-nums text-slate-500">{pct(row.r2, 1)}</td>
        <td className={`px-2 py-2 text-right tabular-nums ${zTone(row.currentZScore)}`}>
          {num(row.currentZScore, 2)}
        </td>

        <td className="px-2 py-2">
          <span
            className={`inline-block border px-1.5 py-0.5 text-[9px] tracking-wider ${todayZ.className}`}
            title={
              row.todayZ && row.todayZ.bars > 0
                ? `${row.todayZ.bars} bar(s) since 00:00 UTC · extreme ${num(row.todayZ.extreme, 2)}`
                : "No bars since 00:00 UTC"
            }
          >
            {todayZ.text}
          </span>
        </td>

        <td className="px-2 py-2">
          <span className={`inline-block border px-1.5 py-0.5 text-[9px] tracking-wider ${badge.className}`}>
            {badge.text}
          </span>
        </td>

        <td className="px-2 py-2 text-right tabular-nums text-slate-400">
          {regime ? `${num(regime.ratio, 2)}x` : "—"}
        </td>

        <td className={`px-2 py-2 text-right tabular-nums ${takerTone(extra.takerBuyShare)}`}>
          {extra.takerBuyShare != null ? pct(extra.takerBuyShare, 1) : "—"}
        </td>
        <td className="px-2 py-2 text-right tabular-nums text-slate-300">
          {extra.buySellRatio != null ? `${num(extra.buySellRatio, 2)}x` : "—"}
        </td>
        <td
          className={`px-2 py-2 text-right tabular-nums ${
            extra.takerDeltaUsd == null
              ? "text-slate-500"
              : extra.takerDeltaUsd >= 0
                ? "text-emerald-400"
                : "text-rose-400"
          }`}
        >
          {usd(extra.takerDeltaUsd)}
        </td>

        <td className="px-2 py-2 text-right tabular-nums text-slate-300">
          {extra.vol24hRatio != null ? `${num(extra.vol24hRatio, 3)}x` : "—"}
        </td>

        <td className="px-2 py-2 text-right">
          <span className={`tabular-nums ${stabilityTone(stability?.score ?? null)}`}>
            {stability ? Math.round(stability.score) : "—"}
          </span>
        </td>

        <td className="px-2 py-2 text-right tabular-nums text-slate-400">{usd(extra.mcapUsd)}</td>
        <td className="px-2 py-2 text-right tabular-nums text-slate-400">{usd(extra.vol24hUsd)}</td>
        <td className="px-2 py-2 text-right tabular-nums text-slate-600">
          {row.updatedAt != null ? relTime(row.updatedAt, now) : "—"}
        </td>
      </tr>

      <AnimatePresence>
        {expanded && (
          <tr className="border-b border-[#1f1f23] bg-[#08080a]">
            <td colSpan={17} className="px-4 py-4">
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.15 }}
                className="overflow-hidden"
              >
                {failed ? (
                  <div className="flex items-start gap-2 text-[11px] text-rose-400">
                    <AlertTriangle size={12} className="mt-px shrink-0" />
                    <div>
                      <div className="text-[10px] uppercase tracking-wider">Symbol failed</div>
                      <div className="mt-1 text-slate-400">{row.error}</div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-[#141417] pb-3 text-[10px] text-slate-600">
                      <span>
                        {row.symbol} vs {row.baseAsset} on {row.market}/{row.baseMarket} @ {interval}
                      </span>
                      <span>{row.observations} aligned returns</span>
                      <span>{row.barCount} closed bars</span>
                      <span className="font-mono">
                        as of{" "}
                        {row.asOfIso ? row.asOfIso.replace("T", " ").slice(0, 19) + "Z" : "n/a"}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                      <Panel title="Taker Flow" subtitle="Who is crossing the spread">
                        <DetailCell
                          label="Last bar buy share"
                          value={extra.takerBuyShare != null ? pct(extra.takerBuyShare, 1) : "—"}
                        />
                        <DetailCell
                          label="Window buy share"
                          value={
                            extra.takerBuyShareWindow != null
                              ? pct(extra.takerBuyShareWindow, 1)
                              : "—"
                          }
                        />
                        <DetailCell
                          label="Last bar buy/sell"
                          value={extra.buySellRatio != null ? `${num(extra.buySellRatio, 3)}x` : "—"}
                        />
                        <DetailCell label="Net taker delta" value={usd(extra.takerDeltaUsd)} />
                        <div className="pt-2 text-[10px] leading-relaxed text-slate-500">
                          {extra.takerBuyShareWindow == null
                            ? "This venue does not publish taker-buy volume."
                            : extra.takerBuyShareWindow > 0.55
                              ? "Aggressive buyers have dominated the window."
                              : extra.takerBuyShareWindow < 0.45
                                ? "Aggressive sellers have dominated the window."
                                : "Order flow has been balanced across the window."}
                        </div>
                      </Panel>

                      <Panel title="Correlation" subtitle="Pearson on aligned returns">
                        <DetailCell label="Price return" value={num(row.priceCorrelation)} />
                        <DetailCell label="Beta" value={num(row.beta, 4)} />
                        <DetailCell
                          label="Alpha"
                          value={row.alpha != null ? row.alpha.toExponential(3) : "—"}
                        />
                        <DetailCell label="R² (explained)" value={pct(row.r2, 2)} />
                        <DetailCell label="Tracking error" value={pct(row.trackingError, 3)} />
                        <DetailCell label="Volume sync" value={num(row.volumeCorrelation, 3)} />
                        <DetailCell label="Volatility sync" value={num(row.volatilityCorrelation, 3)} />
                        <div className="pt-2">
                          <Sparkline points={row.rollingCorrelation} width={200} height={26} />
                          <div className="mt-1 text-[9px] uppercase tracking-wider text-slate-700">
                            Rolling correlation ({row.rollingWindow} bars)
                          </div>
                        </div>
                      </Panel>

                      <Panel
                        title="Volatility Regime"
                        subtitle={stability ? `${row.observations} bar sample` : undefined}
                      >
                        {regime ? (
                          <>
                            <DetailCell
                              label={`${row.baseAsset} annualized`}
                              value={pct(regime.coinAnnualized, 1)}
                            />
                            <DetailCell
                              label={`${benchmarkBaseAsset} annualized`}
                              value={pct(regime.baseAnnualized, 1)}
                            />
                            <DetailCell label="Ratio" value={`${num(regime.ratio, 3)}x`} />
                            <DetailCell
                              label="Ratio percentile"
                              value={`${Math.round(regime.ratioPercentile)}th`}
                            />
                            <DetailCell label="Coin max drawdown" value={pct(regime.maxDrawdown, 1)} />
                            <div className="pt-2 text-[10px] uppercase tracking-wider text-emerald-400/80">
                              {regime.label}
                            </div>
                          </>
                        ) : (
                          <div className="text-[10px] text-slate-600">
                            Sample too short for a volatility regime.
                          </div>
                        )}
                      </Panel>

                      <Panel title="Correlation Stability" subtitle="Is the reading a regime or a blip?">
                        {stability ? (
                          <>
                            <DetailCell label="Current" value={num(stability.current, 4)} />
                            <DetailCell label="Mean" value={num(stability.mean, 4)} />
                            <DetailCell label="Std dev" value={num(stability.stdDev, 4)} />
                            <DetailCell
                              label="Percentile"
                              value={`${Math.round(stability.percentile)}th`}
                            />
                            <DetailCell
                              label="Stability score"
                              value={`${Math.round(stability.score)}/100`}
                            />
                            <DetailCell label="Regime shift Z" value={num(stability.regimeShiftZ, 2)} />
                            <DetailCell label="Window" value={`${stability.window} bars`} />
                            <div className="pt-2 text-[10px] uppercase tracking-wider text-emerald-400/80">
                              {stability.label}
                            </div>
                          </>
                        ) : (
                          <div className="text-[10px] text-slate-600">
                            Sample too short for a stability reading.
                          </div>
                        )}
                      </Panel>
                    </div>

                    <Panel
                      title="Return Residual"
                      subtitle="Coin's return minus the benchmark-implied move, z-scored"
                    >
                      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                        <DetailCell label="Price ratio" value={num(row.currentRatio, 6)} />
                        <DetailCell label="Residual z-score" value={num(row.currentZScore, 3)} />
                        <DetailCell label="Hit ±2 today" value={todayZ.text} />
                        <DetailCell label="Signal" value={badge.text} />
                      </div>
                    </Panel>

                    <Panel
                      title="Size & Turnover"
                      subtitle={
                        benchmarkVol != null
                          ? `Benchmark 24h volume ${usd(benchmarkVol)}`
                          : "Benchmark 24h volume unavailable"
                      }
                    >
                      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                        <DetailCell label="Last price" value={usd(extra.lastPriceUsd)} />
                        <DetailCell label="Market cap" value={usd(extra.mcapUsd)} />
                        <DetailCell label="24h volume" value={usd(extra.vol24hUsd)} />
                        <DetailCell
                          label={`Volume vs ${benchmarkBaseAsset}`}
                          value={extra.vol24hRatio != null ? `${num(extra.vol24hRatio, 4)}x` : "—"}
                        />
                      </div>
                    </Panel>
                  </div>
                )}
              </motion.div>
            </td>
          </tr>
        )}
      </AnimatePresence>
    </>
  );
}