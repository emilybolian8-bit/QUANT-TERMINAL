/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  TrendingUp,
  BarChart2,
  Activity,
  Terminal,
  FileText,
  RefreshCw,
  Search,
  Briefcase,
  ShieldAlert,
  DollarSign,
  Zap,
  ChevronRight,
  Sparkles,
  Trash2,
  Plus,
  X,
  Code2,
  Radar,
  Flame,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { CoinOption, AnalysisResponse, ZScoreMode } from "./types";
import { isoDaysAgo, todayISO, formatUtcStamp } from "./utils/dates";
import { rankCatalogMatches, resolveTicker, formatHistoryAge } from "./utils/catalog";
import { useSymbolCatalog } from "./utils/useSymbolCatalog";
import { prefetchTerminal, defaultTerminalParams } from "./utils/terminalPrefetch";
import MetricCard from "./components/MetricCard";
import ScatterPlot from "./components/ScatterPlot";
import RollingCorrelationChart from "./components/RollingCorrelationChart";
import LeadLagChart from "./components/LeadLagChart";
import PairsSpreadChart from "./components/PairsSpreadChart";
import TerminalModule from "./components/TerminalModule";
import CodeLab from "./components/CodeLab";
import Scanner from "./components/Scanner";
import PositionManagementPage from "./components/PositionManagementPage";
import LiquidationsPage from "./components/LiquidationsPage";
import type { ScanParams } from "./types";

export default function App() {
  // Application State
  const [coins, setCoins] = useState<CoinOption[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState("ETHUSDT");
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedTab, setSelectedTab] = useState<"unified" | "spread" | "liquidations" | "terminal" | "code" | "scanner" | "position">("unified");
  // The 1H and 15M quant tables are fused into the unified summary behind
  // this chooser, so the desk picks a timeframe without leaving the tab.
  const [timeframeView, setTimeframeView] = useState<"1h" | "15m">("1h");
  // Default to a rolling 45d window that terminates today, so the feed is live on first paint
  const [universalAnchorDate, setUniversalAnchorDate] = useState<string>(() => isoDaysAgo(45));
  const [zscoreMode, setZscoreMode] = useState<ZScoreMode>("expanding");
  const [compareAsset, setCompareAsset] = useState<string>("BTC");
  const [scannerCtx, setScannerCtx] = useState<{ symbol: string; params: ScanParams; compareAsset: string } | null>(null);

  const [metrics, setMetrics] = useState<AnalysisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [generatingReport, setGeneratingReport] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  // Autocomplete and custom asset addition states
  const {
    symbols: binanceSymbols,
    loading: loadingSymbols,
    error: catalogError,
    stale: catalogStale,
    ensureLoaded: ensureCatalogLoaded,
    refresh: refreshCatalog,
  } = useSymbolCatalog();
  // -1 means "nothing highlighted", so Enter never fires a selection by accident
  const [searchIndex, setSearchIndex] = useState(-1);
  const [tickerNotice, setTickerNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [resolving, setResolving] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // 1. Fetch supported coins on mount and restore custom assets from localStorage
  useEffect(() => {
    async function loadCoins() {
      try {
        const res = await fetch("/api/coins");
        if (!res.ok) throw new Error("Failed to serve supported coin sets.");
        const primaryCoins = await res.json();

        const storedCustom = localStorage.getItem("quant_custom_coins");
        const customCoins: CoinOption[] = storedCustom ? JSON.parse(storedCustom) : [];

        // Flag custom coins precisely as isCustom
        const customFlagged = customCoins.map((cc) => ({
          ...cc,
          isCustom: true,
          category: "Custom Active"
        }));

        // A stored custom coin can shadow a curated default of the same symbol
        // (e.g. the user added SOLUSDT before it was curated). Curated wins so
        // its real name/category survives, and the duplicate never double-keys.
        const curatedSymbols = new Set(primaryCoins.map((c: CoinOption) => c.symbol));
        const dedupedCustom = customFlagged.filter((cc) => !curatedSymbols.has(cc.symbol));

        setCoins([...primaryCoins, ...dedupedCustom]);
      } catch (err: any) {
        console.error(err);
        setError("Unable to communicate with the quant core backend server.");
      }
    }
    loadCoins();
  }, []);

  // Typed input that resolves to nothing in the catalog: offer it as a direct
  // add, verified server-side, instead of a dead "No active match found".
  const directEntry = useMemo(() => {
    const term = searchTerm.trim();
    if (!term) return null;
    const matches = rankCatalogMatches(binanceSymbols, term, { limit: 1 });
    return matches.length > 0 ? null : term;
  }, [binanceSymbols, searchTerm]);

  // Add custom Binance coin to workspace and local storage
  const handleAddCustomCoin = (coin: CoinOption) => {
    // A symbol can already be present as a curated default (e.g. SOLUSDT).
    // Promoting it in place keeps the curated name/category and avoids a
    // duplicate React key in the sidebar list.
    const existing = coins.find((c) => c.symbol === coin.symbol);
    if (existing) {
      setScannerCtx(null);
      setSelectedSymbol(existing.symbol);
      setSearchTerm("");
      setSearchIndex(-1);
      setTickerNotice({ tone: "ok", text: `${existing.symbol} is already in the workspace. Selected.` });
      return;
    }

    const newCustomCoin: CoinOption = {
      ...coin,
      // Catalog entries are labelled "Altcoin"/"Perpetual"; retag them as
      // workspace additions. Venue is carried separately by the market field.
      category: coin.category === "Altcoin" || coin.category === "Perpetual" ? "Custom Active" : coin.category,
      isCustom: true,
    };

    const updatedCoins = [...coins, newCustomCoin];
    setCoins(updatedCoins);

    // Save custom array to localStorage
    const customOnly = updatedCoins.filter((c) => c.isCustom);
    localStorage.setItem("quant_custom_coins", JSON.stringify(customOnly));

    // Focus and load metrics immediately
    setScannerCtx(null);
    setSelectedSymbol(newCustomCoin.symbol);
    setSearchTerm("");
    setSearchIndex(-1);
    setTickerNotice({
      tone: "ok",
      text: coin.provisional
        ? `${newCustomCoin.symbol} added from the live tape (newer than the cached catalog).`
        : `${newCustomCoin.symbol} added to the workspace.`,
    });
  };

  /**
   * Accepts free-form ticker text: normalizes it, checks the catalog, then
   * falls back to a server-side probe so a pair listed minutes ago still works.
   */
  const handleAddTypedTicker = async (raw: string) => {
    const input = raw.trim();
    if (!input || resolving) return;

    setResolving(true);
    setTickerNotice(null);
    try {
      const result = await resolveTicker(input, binanceSymbols);
      if (result.status === "ok") {
        handleAddCustomCoin(result.coin);
      } else if (result.status === "not-found") {
        setTickerNotice({
          tone: "error",
          text: `${result.symbol} is not trading on Binance spot. Check the ticker, or it may be delisted.`,
        });
      } else {
        setTickerNotice({ tone: "error", text: result.message });
      }
    } finally {
      setResolving(false);
    }
  };

  // Arrow-key navigation + Enter to accept, Escape to clear/dismiss. The single
  // field filters the workspace/catalog list and, when nothing matches, offers
  // the typed ticker as a direct add.
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (filteredCoins.length === 0) return;
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setSearchIndex((prev) => {
        const next = prev + delta;
        if (next < 0) return filteredCoins.length - 1;
        if (next >= filteredCoins.length) return 0;
        return next;
      });
      return;
    }

    if (e.key === "Escape") {
      setSearchTerm("");
      setSearchIndex(-1);
      e.currentTarget.blur();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      const coin = searchIndex >= 0 ? filteredCoins[searchIndex] : filteredCoins[0];
      if (coin) {
        if (isInWorkspace(coin.symbol)) {
          setScannerCtx(null);
          setSelectedSymbol(coin.symbol);
        } else handleAddCustomCoin(coin);
        return;
      }
      // No list match: treat as a direct manual entry
      if (directEntry) void handleAddTypedTicker(directEntry);
    }
  };

  // Remove custom added coin cleanly
  const handleRemoveCustomCoin = (e: React.MouseEvent, symbol: string) => {
    e.stopPropagation(); // Avoid triggering card selection

    if (selectedSymbol === symbol) {
      setScannerCtx(null);
      setSelectedSymbol("ETHUSDT"); // Fallback to ETHUSDT if removing the active test coin
    }

    const remaining = coins.filter((c) => c.symbol !== symbol);
    setCoins(remaining);

    const customOnly = remaining.filter((c) => c.isCustom);
    localStorage.setItem("quant_custom_coins", JSON.stringify(customOnly));
  };

  // 2. Load metrics and trigger calculations when selection changes
  const handleReloadMetrics = async (symbol: string, anchorOverride?: string, compareAssetOverride?: string) => {
    setLoading(true);
    setError(null);
    try {
      const activeAnchor = anchorOverride !== undefined ? anchorOverride : universalAnchorDate;
      const activeCompare = compareAssetOverride !== undefined ? compareAssetOverride : compareAsset;
      const url = activeAnchor
        ? `/api/correlation?symbol=${symbol}&anchorDate=${activeAnchor}&zscoreMode=${zscoreMode}&baseAsset=${activeCompare}`
        : `/api/correlation?symbol=${symbol}&zscoreMode=${zscoreMode}&baseAsset=${activeCompare}`;
      const res = await fetch(url);
      if (!res.ok) {
        const errPayload = await res.json();
        throw new Error(errPayload.error || "System failed to process calculations.");
      }
      const data = await res.json();
      setMetrics(data);

      // Keep current tab when reloading metrics for same coin/context
    } catch (err: any) {
      setError(err.message || "Failed to sync historical and analytical calculations.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedSymbol) {
      handleReloadMetrics(selectedSymbol);
    }
  }, [selectedSymbol, universalAnchorDate, zscoreMode, compareAsset]);

  // Warm the Quant Terminal in the background as soon as a subject resolves, so
  // the tab opens on a ready frame instead of paying the deep-analytics round
  // trip on click. Keyed on the resolved symbol (not the raw selection) so the
  // prefetch matches what the terminal will actually request.
  useEffect(() => {
    if (!metrics?.symbol) return;
    // When the terminal is (or was) opened from a scanner row, warm the exact
    // frame it will request - the row's interval/lookback/window/mode - not the
    // 1h default. A prefetched key that disagrees with the terminal's first
    // request is a guaranteed cache miss, which is what made the tab pay the
    // deep-analytics round trip even though a prefetch had just run.
    if (scannerCtx && scannerCtx.symbol === metrics.symbol) {
      prefetchTerminal({
        symbol: metrics.symbol,
        benchmark: scannerCtx.compareAsset,
        interval: scannerCtx.params.interval,
        lookbackDays: scannerCtx.params.lookbackDays,
        maxLag: 12,
        rollingWindow: scannerCtx.params.rollingWindow,
        zscoreMode: scannerCtx.params.zscoreMode,
      });
      return;
    }
    prefetchTerminal(defaultTerminalParams(metrics.symbol, compareAsset));
  }, [metrics?.symbol, compareAsset, scannerCtx]);

  // Filter the workspace list, and fall through to the live exchange catalog so
  // a newly listed pair is reachable from the sidebar search alone — no need to
  // know it exists in advance. Catalog hits are capped so a broad query cannot
  // render hundreds of rows.
  const SIDEBAR_CATALOG_LIMIT = 25;

  const filteredCoins = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    const workspace = coins.filter(
      (c) =>
        c.symbol.toLowerCase().includes(term) ||
        c.name.toLowerCase().includes(term) ||
        c.baseAsset.toLowerCase().includes(term)
    );
    if (!term) return workspace;

    const workspaceSymbols = new Set<string>(coins.map((c) => c.symbol));
    const catalogHits = rankCatalogMatches(binanceSymbols, term, {
      exclude: [...workspaceSymbols],
      limit: SIDEBAR_CATALOG_LIMIT,
    }).map((m) => m.coin);

    return [...workspace, ...catalogHits];
  }, [coins, searchTerm, binanceSymbols]);

  // Catalog rows surfaced by the sidebar search are not in the workspace yet,
  // so selecting one adds it rather than switching to an existing tile.
  const isInWorkspace = useCallback(
    (symbol: string) => coins.some((c) => c.symbol === symbol),
    [coins]
  );

  // Keep the keyboard highlight inside the rendered list as its size changes.
  useEffect(() => {
    setSearchIndex((prev) => (prev >= filteredCoins.length ? -1 : prev));
  }, [filteredCoins.length]);

  // Ctrl/Cmd+S focuses the desk search from anywhere, overriding the browser's
  // own save dialog so the shortcut is free for the terminal's navigation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const activeCoin = useMemo(() => {
    return coins.find((c) => c.symbol === selectedSymbol);
  }, [coins, selectedSymbol]);

  // Provenance readout: the newest confirmed candle the metrics were computed from
  const feedAsOf = useMemo(() => {
    const meta = metrics?.asOf;
    if (!meta || !meta.timestamp) return null;
    const stamp = formatUtcStamp(meta.timestamp);
    const lagMinutes = meta.lagMinutes ?? 0;
    const lagText = lagMinutes < 60 ? `${lagMinutes}m` : `${(lagMinutes / 60).toFixed(1)}h`;
    const bars = meta.coverage["1h"]?.barCount ?? 0;
    return { stamp, lagText, bars, stale: lagMinutes > 180 };
  }, [metrics]);

  // Call Gemini to produce the report
  const handleTriggerReport = async () => {
    if (!metrics) return;
    setGeneratingReport(true);
    setReportError(null);
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metrics,
          symbol: metrics.symbol,
          baseAsset: metrics.baseAsset,
          name: metrics.name,
          compareAsset,
        }),
      });

      if (!res.ok) throw new Error("Quant agent report connection interrupted.");
      const data = await res.json();

      setMetrics((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          quantMemo: data.memo,
        };
      });
    } catch (err: any) {
      setReportError(err.message || "Generative Desk Report generation failed.");
    } finally {
      setGeneratingReport(false);
    }
  };

  // Automated custom Markdown renderer for premium style output
  const renderFormattedMemo = (text: string) => {
    if (!text) return null;
    const lines = text.split("\n");

    return lines.map((line, idx) => {
      const trimmed = line.trim();

      // Headers ###
      if (trimmed.startsWith("###")) {
        const titleText = trimmed.replace(/^###\s+/, "");
        return (
          <h4
            key={idx}
            className="text-sm font-mono uppercase tracking-wider text-amber-400 font-semibold mt-6 mb-2 border-b border-neutral-800 pb-1 flex items-center"
          >
            <Terminal size={12} className="mr-1.5" /> {titleText}
          </h4>
        );
      }

      // Headers ####
      if (trimmed.startsWith("####")) {
        const titleText = trimmed.replace(/^####\s+/, "");
        return (
          <h5 key={idx} className="text-xs font-mono font-bold text-neutral-300 mt-4 mb-2 uppercase">
            {titleText}
          </h5>
        );
      }

      // List Items
      if (trimmed.startsWith("-") || trimmed.startsWith("*")) {
        // Strip marker
        const itemText = trimmed.replace(/^[-*]\s+/, "");
        // Format bold segments **x**
        return (
          <li key={idx} className="text-xs text-neutral-400 ml-4 pl-1 list-disc mb-1 leading-relaxed">
            {formatBoldSegments(itemText)}
          </li>
        );
      }

      // Standard paragraphs
      if (trimmed.length > 0) {
        return (
          <p key={idx} className="text-xs text-neutral-400 mb-3 leading-relaxed">
            {formatBoldSegments(trimmed)}
          </p>
        );
      }

      // Spacing lines
      return <div key={idx} className="h-2" />;
    });
  };

  // Helper to parse **bold** and `code` segments
  const formatBoldSegments = (text: string) => {
    // Regex matching bold **pattern** or code `pattern`
    const regex = /(\*\*.*?\*\*|`.*?`)/g;
    const parts = text.split(regex);

    return parts.map((part, index) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return (
          <strong key={index} className="text-neutral-200 font-semibold font-mono">
            {part.slice(2, -2)}
          </strong>
        );
      }
      if (part.startsWith("`") && part.endsWith("`")) {
        return (
          <code key={index} className="font-mono text-[10px] px-1 py-0.5 bg-neutral-950 text-blue-400 rounded">
            {part.slice(1, -1)}
          </code>
        );
      }
      return part;
    });
  };

  return (
    <div className="h-screen overflow-hidden bg-[#0a0a0b] text-slate-300 flex flex-col font-sans select-none selection:bg-emerald-500 selection:text-white">
      {/* Header Segment */}
      <header className="border-b border-[#1f1f23] bg-[#0e0e10]/80 backdrop-blur-md sticky top-0 z-50 px-6 py-4 flex flex-col sm:flex-row items-center justify-between">
        <div className="flex items-center space-x-3 mb-4 sm:mb-0">
          <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-xl">
            <Activity size={20} className="stroke-[2px]" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h1 className="text-sm font-semibold tracking-wide text-white uppercase font-mono">
                CRYPTO QUANT CO-MOVEMENT TERMINAL
              </h1>
              <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded uppercase ${universalAnchorDate ? "bg-amber-500 text-black" : "bg-emerald-500 text-white"}`}>
                {universalAnchorDate ? `Anchored: ${universalAnchorDate}` : "Fixed 7d Lookback"}
              </span>
            </div>
            <p className="text-[11px] text-slate-500 font-mono mt-0.5">
              Live Cross-Asset Correlation Statistics, Hedge Math & Multi-Timeframe Lead-Lag Indication
            </p>
          </div>
        </div>

        {/* Universal Desk Telemetries */}
        <div className="flex flex-wrap sm:flex-nowrap items-center gap-4 mt-3 sm:mt-0">
          {/* Base Comparison Asset Selector */}
          <div className="flex flex-col text-left space-y-0.5 border-r border-[#1f1f23] pr-4">
            <span className="text-[9px] font-mono text-slate-500 uppercase tracking-widest font-bold">Base Benchmark Asset</span>
            <div className="flex items-center">
              <select
                value={compareAsset}
                onChange={(e) => {
                  setCompareAsset(e.target.value);
                }}
                className="bg-[#0e0e10] text-[#eaeaea] border border-[#1f1f23] hover:border-[#2f2f35] rounded p-1 px-1.5 focus:border-[#4f4f55] focus:outline-none text-[10.5px] h-7 font-mono outline-none cursor-pointer"
              >
                <option value="BTC">BTC (Bitcoin)</option>
                <option value="ETH">ETH (Ethereum)</option>
                <option value="BNB">BNB (Binance Coin)</option>
                <option value="SOL">SOL (Solana)</option>
              </select>
            </div>
          </div>

          {/* Universal Anchor Date Selector */}
          <div className="flex flex-col text-left space-y-0.5 border-r border-[#1f1f23] pr-4">
            <span className="text-[9px] font-mono text-slate-500 uppercase tracking-widest font-bold">Universal Spread Anchor</span>
            <div className="flex items-center space-x-1.5">
              <input
                type="date"
                value={universalAnchorDate}
                max={todayISO()}
                onChange={(e) => {
                  setUniversalAnchorDate(e.target.value);
                }}
                className="bg-[#0e0e10] text-[#eaeaea] border border-[#1f1f23] hover:border-[#2f2f35] rounded p-1 px-1.5 focus:border-emerald-500 focus:outline-none text-[10.5px] h-7 font-mono outline-none"
              />
              {universalAnchorDate && (
                <button
                  type="button"
                  onClick={() => {
                    setUniversalAnchorDate("");
                  }}
                  className="h-7 text-[9px] font-mono font-bold bg-[#1a1012] hover:bg-[#2e1519] border border-rose-500/20 hover:border-rose-500/40 text-rose-400 px-2 rounded cursor-pointer leading-7 flex items-center justify-center transition-colors"
                  title="Clear Anchor Date"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Z-Score Mode Selector. Drives the ratio Z-score the same way the
              scanner and terminal selectors do, so a mode chosen on one tab
              can be reproduced exactly on the others. */}
          <div className="flex flex-col text-left space-y-0.5 border-r border-[#1f1f23] pr-4">
            <span className="text-[9px] font-mono text-slate-500 uppercase tracking-widest font-bold">Z-Score Mode</span>
            <select
              value={zscoreMode}
              onChange={(e) => setZscoreMode(e.target.value as ZScoreMode)}
              className="bg-[#0e0e10] text-[#eaeaea] border border-[#1f1f23] hover:border-[#2f2f35] rounded p-1 px-1.5 focus:border-[#4f4f55] focus:outline-none text-[10.5px] h-7 font-mono outline-none cursor-pointer"
            >
              <option value="expanding">Expanding (live)</option>
              <option value="rolling">Rolling (168-bar)</option>
              <option value="batch">Batch (full sample)</option>
            </select>
          </div>

          <div className="text-right">
            <div className="text-[10px] font-mono text-slate-500">DATA AS OF</div>
            <div className={`text-xs font-mono font-semibold flex items-center justify-end ${feedAsOf?.stale ? "text-amber-400" : "text-emerald-400"}`}>
              <span
                className={`h-1.5 w-1.5 rounded-full inline-block mr-1.5 animate-pulse ${
                  feedAsOf?.stale ? "bg-amber-500" : "bg-emerald-500"
                }`}
              />
              {feedAsOf ? feedAsOf.stamp : "SYNCING"}
            </div>
            <div className="text-[9px] font-mono text-slate-600 mt-0.5">
              {feedAsOf
                ? `${feedAsOf.bars} closed bars · lag ${feedAsOf.lagText} · open bar excluded`
                : "awaiting settled candles"}
            </div>
          </div>
          {metrics && (
            <button
              onClick={() => handleReloadMetrics(selectedSymbol)}
              className="p-2 border border-[#1f1f23] hover:border-slate-700 bg-[#0e0e10] rounded text-slate-400 hover:text-white transition-all cursor-pointer"
              title="Refresh feed"
            >
              <RefreshCw size={14} className={loading ? "animate-spin text-emerald-400" : ""} />
            </button>
          )}
        </div>
      </header>

      {/* Workspace Wrapper */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
        {/* Sidebar Left: Asset Picker */}
        <aside className="w-full lg:w-80 border-b lg:border-b-0 lg:border-r border-[#1f1f23] bg-[#0e0e10]/35 p-5 flex flex-col lg:h-full lg:min-h-0 lg:overflow-hidden shrink-0 relative">
          {/* Fixed desk header: title, the asset currently under test, and one
              field that both filters the list and adds a new ticker. */}
          <div className="shrink-0">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">
                SEARCH COIN DESK
              </span>
              <button
                type="button"
                onClick={refreshCatalog}
                disabled={loadingSymbols}
                title={
                  catalogStale
                    ? "Catalog may be stale - click to re-sync from Binance"
                    : "Re-sync the symbol catalog from Binance"
                }
                className="flex items-center gap-1 text-[9px] font-mono text-slate-500 hover:text-emerald-400 disabled:opacity-40 transition-colors cursor-pointer"
              >
                <RefreshCw size={9} className={loadingSymbols ? "animate-spin" : ""} />
                {catalogStale ? "STALE" : "SYNC"}
              </button>
            </div>

            <div className="mb-3">
              <span className="text-[9px] font-mono text-slate-600 uppercase tracking-widest block mb-1.5">
                Now Viewing
              </span>
              {activeCoin ? (
                <div className="flex items-center gap-3 p-3 rounded bg-[#141417] border border-emerald-500/40 shadow-lg shadow-emerald-500/5">
                  <div className="h-8 w-8 rounded bg-emerald-500 text-white flex items-center justify-center text-[10px] font-mono font-bold uppercase shrink-0">
                    {activeCoin.baseAsset.length > 5 ? `${activeCoin.baseAsset.slice(0, 4)}…` : activeCoin.baseAsset}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-mono font-bold text-white truncate">{activeCoin.name}</span>
                      {activeCoin.market === "futures" && (
                        <span className="text-[9px] font-mono bg-amber-500/15 text-amber-400 px-1 py-0.2 rounded shrink-0">
                          PERP
                        </span>
                      )}
                    </div>
                    <span className="text-[10px] font-mono text-slate-500 block truncate">
                      {activeCoin.symbol} / {compareAsset}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 p-3 rounded bg-[#0a0a0b] border border-[#1f1f23]">
                  <RefreshCw size={12} className="animate-spin text-slate-600" />
                  <span className="text-[10px] font-mono text-slate-600 italic">Resolving active asset…</span>
                </div>
              )}
            </div>

            <div id="search-input" className="relative">
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search or add a ticker (e.g. SOL, BANANAS31)…"
                value={searchTerm}
                onFocus={() => ensureCatalogLoaded()}
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                  setSearchIndex(-1);
                  if (tickerNotice) setTickerNotice(null);
                }}
                onKeyDown={handleSearchKeyDown}
                className="w-full bg-[#0a0a0b] border border-[#1f1f23] rounded pl-9 pr-16 py-2 text-xs font-mono text-slate-300 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50 transition-colors"
              />
              <div className="absolute left-3 top-3 text-slate-500 flex items-center justify-center">
                {loadingSymbols || resolving ? (
                  <RefreshCw size={12} className="animate-spin text-emerald-400" />
                ) : (
                  <Search size={12} className="text-slate-600" />
                )}
              </div>
              {searchTerm ? (
                <button
                  type="button"
                  onClick={() => {
                    setSearchTerm("");
                    setSearchIndex(-1);
                    searchInputRef.current?.focus();
                  }}
                  className="absolute right-2 top-2 p-1 text-slate-500 hover:text-slate-200 rounded cursor-pointer"
                  title="Clear search"
                >
                  <X size={12} />
                </button>
              ) : (
                <span className="absolute right-2 top-2 text-[9px] font-mono text-slate-600 border border-[#1f1f23] bg-[#0e0e10] px-1.5 py-0.5 rounded pointer-events-none select-none">
                  CTRL+S
                </span>
              )}
            </div>

          {/* Inline feedback: not-found, network errors, adds */}
          {tickerNotice && (
            <div
              className={`mt-2 text-[9px] font-mono px-2.5 py-1.5 rounded border leading-relaxed ${
                tickerNotice.tone === "ok"
                  ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/5"
                  : "text-amber-400 border-amber-500/30 bg-amber-500/5"
              }`}
            >
              {tickerNotice.text}
            </div>
          )}
          {catalogError && !tickerNotice && (
            <div className="mt-2 text-[9px] font-mono text-amber-400/80 border border-amber-500/20 bg-amber-500/5 px-2.5 py-1.5 rounded leading-relaxed">
              Catalog unavailable: {catalogError}
            </div>
          )}
          </div>

          <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest block mb-2 mt-4 shrink-0">
            SELECT ASSET UNDER TEST ({filteredCoins.length})
          </span>

          <div
            id="coin-selector-list"
            className="flex-1 min-h-0 overflow-y-auto space-y-1.5 max-h-[300px] lg:max-h-none pr-1.5 custom-scrollbar"
          >
            {/* Direct add: nothing in the workspace or catalog matches the query. */}
            {directEntry && filteredCoins.length === 0 && (
              <button
                type="button"
                onClick={() => void handleAddTypedTicker(directEntry)}
                disabled={resolving}
                className="w-full text-left p-3.5 rounded border border-dashed border-amber-500/40 bg-amber-500/5 hover:bg-amber-500/10 flex items-center justify-between cursor-pointer disabled:opacity-50"
              >
                <div className="flex items-center space-x-3">
                  <div className="h-7 w-7 rounded bg-amber-500/15 flex items-center justify-center shrink-0">
                    <Plus size={13} className="text-amber-400" />
                  </div>
                  <div className="flex flex-col">
                    <span className="text-xs font-mono font-bold text-amber-300 leading-none">
                      Add {directEntry.toUpperCase()}
                    </span>
                    <span className="text-[10px] font-mono text-slate-500 mt-1">
                      Not in cached catalog - verify on the live tape (Enter)
                    </span>
                  </div>
                </div>
                <Plus size={12} className="text-amber-400" />
              </button>
            )}

            {filteredCoins.map((coin, idx) => {
              const isSelected = coin.symbol === selectedSymbol;
              const isHighlighted = idx === searchIndex;
              // Rows surfaced from the live catalog by the sidebar search are not
              // in the workspace yet, so they add on click instead of switching.
              const inWorkspace = isInWorkspace(coin.symbol);
              const activate = () => {
                if (inWorkspace) {
                  setScannerCtx(null);
                  setSelectedSymbol(coin.symbol);
                } else {
                  handleAddCustomCoin(coin);
                }
              };
              return (
                <div
                  key={coin.symbol}
                  id={`coin-item-${coin.symbol}`}
                  role="button"
                  tabIndex={0}
                  onMouseEnter={() => setSearchIndex(idx)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      activate();
                    }
                  }}
                  onClick={activate}
                  className={`w-full text-left p-3.5 rounded border transition-all flex justify-between items-center group relative cursor-pointer ${
                    isSelected
                      ? "bg-[#141417] border-emerald-500/40 shadow-lg shadow-emerald-500/5 text-white"
                      : isHighlighted
                      ? "bg-emerald-500/5 border-emerald-500/20 text-slate-200"
                      : "bg-[#0a0a0b]/40 border-transparent hover:bg-[#141417]/30 hover:border-[#1f1f23] text-slate-400 hover:text-slate-300"
                  } ${inWorkspace ? "" : "border-dashed border-[#1f1f23]"}`}
                >
                  <div className="flex items-center space-x-3">
                    <div
                      className={`h-7 w-7 rounded flex items-center justify-center text-[10px] font-mono font-bold uppercase ${
                        isSelected
                          ? "bg-emerald-500 text-white"
                          : "bg-[#141417] text-slate-300 border border-[#1f1f23] group-hover:bg-[#1a1a1e]"
                      }`}
                      title={coin.baseAsset}
                    >
                      {coin.baseAsset.length > 5 ? `${coin.baseAsset.slice(0, 4)}…` : coin.baseAsset}
                    </div>
                    <div>
                      <div className="flex items-center space-x-1.5">
                        <span className="text-xs font-mono font-bold">{coin.name}</span>
                        <span className="text-[9px] font-mono text-slate-500 bg-[#0a0a0b] border border-[#1f1f23]/60 px-1 py-0.2 rounded">
                          {inWorkspace ? coin.category : "Live Catalog"}
                        </span>
                        {coin.market === "futures" && (
                          <span
                            className="text-[9px] font-mono bg-amber-500/15 text-amber-400 px-1 py-0.2 rounded"
                            title="USD-margined perpetual future - this asset has no spot market"
                          >
                            PERP
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] font-mono text-slate-500 block mt-0.5 truncate max-w-[160px]">
                        {coin.symbol} / {compareAsset}
                        {coin.market === "futures" ? " (futures)" : ""}
                      </span>
                    </div>
                  </div>

                  {coin.isCustom ? (
                    <button
                      type="button"
                      onClick={(e) => handleRemoveCustomCoin(e, coin.symbol)}
                      className="p-1 hover:bg-rose-500/10 hover:text-rose-400 rounded transition-colors text-slate-500 group-hover:text-slate-400 relative z-10 cursor-pointer"
                      title="Remove custom coin"
                    >
                      <Trash2 size={13} />
                    </button>
                  ) : (
                    <ChevronRight
                      size={14}
                      className={`transform transition-all ${
                        isSelected
                          ? "text-emerald-400 translate-x-0"
                          : "text-slate-700 group-hover:text-slate-500 group-hover:translate-x-0.5"
                      }`}
                    />
                  )}
                </div>
              );
            })}

            {filteredCoins.length === 0 && !directEntry && (
              <div className="text-center py-8">
                <span className="text-xs text-slate-600 font-mono block italic">
                  No assets match query
                </span>
              </div>
            )}
          </div>

          {activeCoin && activeCoin.description && (
            <div id="coin-meta-summary" className="mt-4 shrink-0 max-h-28 overflow-y-auto custom-scrollbar p-4 bg-[#0a0a0b] rounded border border-[#1f1f23]">
              <span className="text-[9px] font-mono text-slate-500 uppercase tracking-wider block mb-1">
                ASSET METAFEED
              </span>
              <p className="text-[11px] text-slate-400 leading-relaxed font-sans">
                {activeCoin.description}
              </p>
            </div>
          )}
        </aside>

        {/* Main Panel */}
        <main className="flex-1 min-h-0 bg-[#0a0a0b] overflow-y-auto p-6 md:p-8 flex flex-col justify-start">
          {error && (
            <div className="mb-6 p-4 bg-rose-950/80 border border-rose-800/40 text-rose-300 rounded flex items-start space-x-3">
              <ShieldAlert size={16} className="mt-0.5 select-none" />
              <div>
                <span className="text-xs font-semibold block font-mono">CRITICAL EXCEPTION TRIGGERED</span>
                <p className="text-xs text-rose-400/90 mt-1 leading-normal font-sans">{error}</p>
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex-1 flex flex-col items-center justify-center py-20">
              <div className="relative">
                {/* Visual loading ring */}
                <div className="w-14 h-14 rounded-full border-2 border-[#1f1f23] animate-pulse" />
                <div className="absolute inset-0 w-14 h-14 rounded-full border-t-2 border-emerald-400 animate-spin" />
              </div>
              <span className="text-xs font-mono text-slate-500 uppercase tracking-widest mt-6 animate-pulse">
                Fetching Binance Feed & Syncing Math Coefficients...
              </span>
            </div>
          ) : metrics ? (
            <div className="space-y-6">
              {/* Top Selector Tabs */}
              <div id="dashboard-tab-rail" className="flex border-b border-[#1f1f23] space-x-1 p-0.5 bg-[#0a0a0b] rounded self-start">
                {[
                  { id: "unified", label: "Unified Quant Summary", icon: <Briefcase size={13} /> },
                  { id: "spread", label: "Spread & Pairs Alpha", icon: <Activity size={13} /> },
                  { id: "liquidations", label: "Liquidations", icon: <Flame size={13} /> },
                  { id: "terminal", label: "Quant Terminal", icon: <Terminal size={13} /> },
                  { id: "code", label: "Code Lab", icon: <Code2 size={13} /> },
                  { id: "scanner", label: "Batch Scanner", icon: <Radar size={13} /> },
                  { id: "position", label: "Position Management", icon: <ShieldAlert size={13} /> },
                ].map((tab) => {
                  const isActive = selectedTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setSelectedTab(tab.id as any)}
                      className={`flex items-center space-x-2 px-4 py-2 text-xs font-mono select-none rounded transition-all cursor-pointer ${
                        isActive
                          ? "bg-[#141417] border border-[#1f1f23] text-emerald-400"
                          : "text-slate-500 hover:text-slate-300 hover:bg-[#141417]/40 border border-transparent"
                      }`}
                    >
                      {tab.icon}
                      <span>{tab.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* View Controller */}
              <div className="min-h-[500px]">
                <AnimatePresence mode="wait">
                  {selectedTab === "unified" && (
                    <motion.div
                       key="unified"
                       initial={{ opacity: 0, y: 3 }}
                       animate={{ opacity: 1, y: 0 }}
                       exit={{ opacity: 0, y: -3 }}
                       transition={{ duration: 0.15 }}
                       className="space-y-6"
                    >
                      {/* Sub header metrics */}
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                        <MetricCard
                          id="unified-score-card"
                          title="Systematic Coupling Score"
                          value={`${metrics.unified.unifiedScore}/100`}
                          badge={metrics.unified.priceCoupling}
                          badgeColor={
                            metrics.unified.priceCoupling === "High"
                              ? "bg-emerald-950/80 text-emerald-400 border border-emerald-800/40"
                              : metrics.unified.priceCoupling === "Moderate"
                              ? "bg-amber-950/80 text-amber-400 border border-amber-800/40"
                              : "bg-blue-[#141417]/80 text-slate-300 border border-[#1f1f23]"
                          }
                          gaugePercent={metrics.unified.unifiedScore}
                          description="The unified score quantifies the total strength of mathematical synchronisation across returns, volumes, and volatility profiles in both timeframes."
                          icon={<Zap size={16} className="text-emerald-400" />}
                        />

                        <MetricCard
                          id="unified-regime-card"
                          title="Calculated Market Regime"
                          value={metrics.unified.marketRegime}
                          description="Derived using price returns co-movements and volume linkages. Helps quant desks evaluate systematic beta vs idiosyncratic returns opportunities."
                          icon={<Terminal size={16} className="text-emerald-400" />}
                        />

                        <MetricCard
                          id="unified-hedge-card"
                          title="Beta-Neutral Hedge Ratio"
                          value={metrics.unified.hedgeRatio.toFixed(6)}
                          subValue={`Short BTC per unit of ${metrics.baseAsset}`}
                          description="The exact units of BTC to short for every single unit of Altcoin held in order to manage systematic volatility and create a market-neutral portfolio."
                          icon={<Briefcase size={16} className="text-emerald-400" />}
                        />
                      </div>

                      {/* Summary Text Panel */}
                      <div className="bg-[#0e0e10] border border-[#1f1f23] rounded p-5">
                        <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest block font-bold mb-1">
                          DESK ANALYSIS OVERVIEW
                        </span>
                        <p className="text-xs text-slate-300 font-sans leading-relaxed">
                          {metrics.unified.overallSummary}
                        </p>
                      </div>

                      {/* Fused timeframe quant tables: the standalone 1H and
                          15M views, choosable right here below the summary. */}
                      <div className="bg-[#0e0e10] border border-[#1f1f23] rounded p-4 flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <BarChart2 size={13} className="text-emerald-400" />
                          <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest font-bold">
                            Timeframe Quant Tables · {timeframeView === "1h" ? "1-Hour" : "15-Minute"}
                          </span>
                        </div>
                        <div className="flex gap-1">
                          {(["1h", "15m"] as const).map((tf) => (
                            <button
                              key={tf}
                              type="button"
                              onClick={() => setTimeframeView(tf)}
                              className={`px-3 h-7 text-[10px] font-mono rounded border cursor-pointer transition-colors ${
                                timeframeView === tf
                                  ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-300"
                                  : "bg-[#0a0a0b] border-[#1f1f23] text-slate-500 hover:text-slate-300"
                              }`}
                            >
                              {tf === "1h" ? "1H" : "15M"}
                            </button>
                          ))}
                        </div>
                      </div>

                      <AnimatePresence mode="wait">
                        <motion.div
                          key={`timeframe-${timeframeView}`}
                          initial={{ opacity: 0, y: 3 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -3 }}
                          transition={{ duration: 0.15 }}
                          className="space-y-6"
                        >
                          {timeframeView === "1h" ? (
                            <>
                              {/* Metric widgets for 1 hour */}
                              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                                <MetricCard
                                  id="1h-price-corr-card"
                                  title="1H Price Return Correlation"
                                  value={metrics.metrics1h.priceCorrelation.toFixed(4)}
                                  badge={
                                    metrics.metrics1h.priceCorrelation > 0.75
                                      ? "High Systematic Sync"
                                      : metrics.metrics1h.priceCorrelation > 0.4
                                      ? "Moderate Sync"
                                      : "Decoupled Action"
                                  }
                                  badgeColor="bg-[#141417] text-slate-400 border border-[#1f1f23]"
                                  gaugePercent={Math.round((metrics.metrics1h.priceCorrelation + 1) * 50)}
                                  gaugeType="centered"
                                  description="Measures direct return co-movement on closing prices. High values suggest the coin moves closely under Bitcoin's price discovery."
                                />

                                <MetricCard
                                  id="1h-beta-card"
                                  title="1H Market Beta Sensitivity"
                                  value={metrics.metrics1h.beta.toFixed(3)}
                                  description="The systemic volatility risk variable. If Beta is 1.25, a 1% shift in Bitcoin's return correlates to a 1.25% shift on target altcoin."
                                />

                                <MetricCard
                                  id="1h-rolling-vol-card"
                                  title="1H Volatility Synchronicity"
                                  value={metrics.metrics1h.volatilityCorrelation.toFixed(4)}
                                  description="Correlation of absolute returns change. High levels suggest fear/excitement episodes align concurrently between BTC and the Altcoin."
                                />

                                <MetricCard
                                  id="1h-volume-corr-card"
                                  title="1H Trading Volume Sync"
                                  value={metrics.metrics1h.volumeCorrelation.toFixed(4)}
                                  description="Estimates systemic order flow alignment. Measures correlation of percentage volume change across both assets."
                                />

                                <MetricCard
                                  id="1h-tracking-error"
                                  title="1H Systematic Tracking Error"
                                  value={`${(metrics.metrics1h.trackingError * 100).toFixed(3)}%`}
                                  description="Residual volatility after removing beta systematic shifts. Measures idiosyncratic dispersion risk."
                                />

                                <MetricCard
                                  id="1h-optimal-lag"
                                  title="1H Lead-Lag Predictor"
                                  value={
                                    metrics.metrics1h.leadLagOptimal.lag === 0
                                      ? "Synchronous"
                                      : `${metrics.metrics1h.leadLagOptimal.lag > 0 ? "BTC" : "Coin"} leads`
                                  }
                                  subValue={metrics.metrics1h.leadLagOptimal.interpretation}
                                  description="Maximum cross-correlation pointer. Helps detect latency shifts for pricing delays."
                                />
                              </div>

                              {/* Main Charts: Scatter plot & Lead lag */}
                              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                <ScatterPlot
                                  id="1h-scatterplot"
                                  data={metrics.metrics1h.alignedData}
                                  beta={metrics.metrics1h.beta}
                                  alpha={metrics.metrics1h.alpha}
                                  coinName={metrics.baseAsset}
                                  barMs={3600000}
                                />

                                <LeadLagChart
                                  id="1h-lead-lag-chart"
                                  lagHistory={metrics.metrics1h.lagHistory}
                                  timeframe="1h"
                                  optimalLag={metrics.metrics1h.leadLagOptimal.lag}
                                />
                              </div>

                              {/* Timeline */}
                              <RollingCorrelationChart
                                id="1h-rolling-timeline"
                                data={metrics.metrics1h.rollingCorrelation}
                                timeframe="1h"
                                windowBars={metrics.metrics1h.rollingWindow}
                              />
                            </>
                          ) : (
                            <>
                              {/* Metric widgets for 15 min */}
                              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                                <MetricCard
                                  id="15m-price-corr-card"
                                  title="15M Price Return Correlation"
                                  value={metrics.metrics15m.priceCorrelation.toFixed(4)}
                                  badge={
                                    metrics.metrics15m.priceCorrelation > 0.75
                                      ? "High High-Freq Sync"
                                      : metrics.metrics15m.priceCorrelation > 0.4
                                      ? "Moderate Sync"
                                      : "Highly Decoupled"
                                  }
                                  badgeColor="bg-[#141417] text-slate-400 border border-[#1f1f23]"
                                  gaugePercent={Math.round((metrics.metrics15m.priceCorrelation + 1) * 50)}
                                  gaugeType="centered"
                                  description="Measures high-frequency price flow dependency. Excellent metric for market makers configuring bid/ask tolerances."
                                />

                                <MetricCard
                                  id="15m-beta-card"
                                  title="15M Market Beta Sensitivity"
                                  value={metrics.metrics15m.beta.toFixed(3)}
                                  description="The sensitivity slope on high-frequency intervals. Great for algorithmic traders sizing micro hedges."
                                />

                                <MetricCard
                                  id="15m-rolling-vol-card"
                                  title="15M Volatility Coherence"
                                  value={metrics.metrics15m.volatilityCorrelation.toFixed(4)}
                                  description="Correlation of extreme amplitude deviations across 15-minute windows, tracking structural panic/impulse spikes."
                                />

                                <MetricCard
                                  id="15m-volume-corr-card"
                                  title="15M Trading Volume Sync"
                                  value={metrics.metrics15m.volumeCorrelation.toFixed(4)}
                                  description="Estimates high-frequency execution alignment, indicating synchronized high-speed execution flows."
                                />

                                <MetricCard
                                  id="15m-tracking-error"
                                  title="15M Systematic Tracking Error"
                                  value={`${(metrics.metrics15m.trackingError * 100).toFixed(3)}%`}
                                  description="Residual volatility on high frequencies. Indicates short-term deviations from theoretical systemic pricing."
                                />

                                <MetricCard
                                  id="15m-optimal-lag"
                                  title="15M Lead-Lag Predictor"
                                  value={
                                    metrics.metrics15m.leadLagOptimal.lag === 0
                                      ? "Synchronous"
                                      : `${metrics.metrics15m.leadLagOptimal.lag > 0 ? "BTC" : "Coin"} leads`
                                  }
                                  subValue={metrics.metrics15m.leadLagOptimal.interpretation}
                                  description="Cross-correlation optimum under 15m lags. Captures rapid alpha flow lead indicators."
                                />
                              </div>

                              {/* Charts Grid */}
                              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                <ScatterPlot
                                  id="15m-scatterplot"
                                  data={metrics.metrics15m.alignedData}
                                  beta={metrics.metrics15m.beta}
                                  alpha={metrics.metrics15m.alpha}
                                  coinName={metrics.baseAsset}
                                  barMs={900000}
                                />

                                <LeadLagChart
                                  id="15m-lead-lag-chart"
                                  lagHistory={metrics.metrics15m.lagHistory}
                                  timeframe="15m"
                                  optimalLag={metrics.metrics15m.leadLagOptimal.lag}
                                />
                              </div>

                              {/* Timeline */}
                              <RollingCorrelationChart
                                id="15m-rolling-timeline"
                                data={metrics.metrics15m.rollingCorrelation}
                                timeframe="15m"
                                windowBars={metrics.metrics15m.rollingWindow}
                              />
                            </>
                          )}
                        </motion.div>
                      </AnimatePresence>

                      {/* Generative AI CRO Memo */}
                      <div className="border border-[#1f1f23] bg-[#0e0e10] rounded overflow-hidden relative">
                        {/* Shaded top header */}
                        <div className="px-5 py-3.5 border-b border-[#1f1f23]/80 bg-[#141417] flex items-center justify-between">
                          <div className="flex items-center space-x-2">
                            <Sparkles size={14} className="text-emerald-400" />
                            <span className="text-xs font-mono uppercase tracking-wider font-semibold text-slate-200">
                              Institutional Risk & Hedge Memo
                            </span>
                          </div>
                          {!metrics.quantMemo && !generatingReport && (
                            <button
                              onClick={handleTriggerReport}
                              className="px-3.5 py-1.5 bg-emerald-500 text-white text-xs font-semibold font-mono rounded hover:bg-emerald-400 active:scale-95 transition-all flex items-center space-x-1 cursor-pointer"
                            >
                              <FileText size={12} />
                              <span>Generate CRO Memo</span>
                            </button>
                          )}
                        </div>

                        {generatingReport ? (
                          <div className="p-12 text-center flex flex-col items-center justify-center">
                            <RefreshCw size={24} className="text-emerald-400 animate-spin mb-4" />
                            <span className="text-xs font-mono text-slate-500 uppercase tracking-widest animate-pulse">
                              Drafting Risk Report & Modeling Beta Dispersion ratios...
                            </span>
                          </div>
                        ) : reportError ? (
                          <div className="p-6 text-center text-xs font-mono text-rose-400 leading-normal">
                            Failed to connect with Quant Desk AI agent: {reportError}. Please ensure Gemini API is ready.
                          </div>
                        ) : metrics.quantMemo ? (
                          <div className="p-6 bg-[#0a0a0b] max-h-[500px] overflow-y-auto font-sans text-slate-100 select-text">
                            {renderFormattedMemo(metrics.quantMemo)}
                          </div>
                        ) : (
                          <div className="p-8 text-center flex flex-col items-center justify-center">
                            <p className="text-xs text-slate-500 leading-normal mb-4 font-sans max-w-sm">
                              Create an institutional risk assessment detailing market regimes, lead-lag lags, and pairs trading instructions using Gemini.
                            </p>
                            <button
                              onClick={handleTriggerReport}
                              className="px-4 py-2 bg-[#141417] border border-[#1f1f23] text-slate-300 hover:text-white hover:border-slate-700 text-xs font-mono rounded transition-all flex items-center space-x-2 cursor-pointer"
                            >
                              <Sparkles size={13} className="text-emerald-400" />
                              <span>Compute Desk Report</span>
                            </button>
                          </div>
                        )}
                      </div>
                    </motion.div>
                  )}

                  {selectedTab === "spread" && (
                    <motion.div
                      key="spread"
                      initial={{ opacity: 0, y: 3 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -3 }}
                      transition={{ duration: 0.15 }}
                      className="space-y-6"
                    >
                      {/* Metres */}
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                        <MetricCard
                          id="spread-ratio-card"
                          title="Current Spread Ratio"
                          value={metrics.metrics1h.currentRatio.toFixed(6)}
                          subValue={`Units of ${metrics.baseAsset} per BTC`}
                          description="The current relative dollar value spread of the assets (Altcoin Close / BTC Close)."
                          icon={<DollarSign size={16} className="text-zinc-400" />}
                        />

                        <MetricCard
                          id="spread-zscore"
                          title="Current Ratio Z-Score (1H)"
                          value={metrics.metrics1h.currentZScore.toFixed(2)}
                          badge={metrics.metrics1h.spreadSignal}
                          badgeColor={
                            metrics.metrics1h.currentZScore > 1.8
                              ? "bg-rose-950 text-rose-400 border border-rose-800/40"
                              : metrics.metrics1h.currentZScore < -1.8
                              ? "bg-emerald-950 text-emerald-400 border border-emerald-800/40"
                              : "bg-[#141417] text-slate-400 border border-[#1f1f23]"
                          }
                          gaugePercent={Math.round(((metrics.metrics1h.currentZScore + 3) / 6) * 100)}
                          description={`Statistical distance of the price ratio from its ${zscoreMode === "batch" ? "full-sample" : zscoreMode === "rolling" ? "trailing 168-bar" : "expanding"} mean. Boundaries of |Z-Score| > 2 indicate severe overbought/oversold relative trends, ideal for mean-reversion trades.`}
                          icon={<Activity size={16} className="text-emerald-400" />}
                        />

                        <MetricCard
                          id="spread-regime"
                          title="Reversion Risk Mitigation"
                          value={Math.abs(metrics.metrics1h.currentZScore) > 1.8 ? "Arbitrage Trade Setup" : "Standard Hold"}
                          description={`Identifies if the asset presents systematic arbitrage or pricing opportunities against ${compareAsset}.`}
                          icon={<Terminal size={16} className="text-emerald-400" />}
                        />
                      </div>

                      {/* Main Spread Chart */}
                      <PairsSpreadChart
                        id="spread-ratio-chart-component"
                        data={metrics.metrics1h.alignedData}
                        coinBase={metrics.baseAsset}
                        compareAsset={compareAsset}
                      />

                      {/* Trading Advice desk */}
                      <div className="bg-[#0e0e10] border border-[#1f1f23] rounded p-5">
                        <h4 className="text-xs font-mono uppercase text-emerald-400 tracking-wider font-bold mb-3 flex items-center">
                          <Terminal size={12} className="mr-1.5 inline" /> ARBITRAGE PLAYBOOK & SYSTEM REGIME
                        </h4>
                        <div className="space-y-3 font-mono text-xs text-slate-400 leading-normal">
                          <p>
                            • <strong className="text-white">System State:</strong> {metrics.name} (${metrics.baseAsset}) is trading at {metrics.metrics1h.currentZScore.toFixed(3)} standard deviations relative to {compareAsset} USD pricing.
                          </p>
                          <p>
                            • <strong className="text-white">Execution Strategy:</strong>{" "}
                            {metrics.metrics1h.currentZScore > 1.8 ? (
                              <span className="text-rose-400 font-bold">
                                SELL OVERVALUED {metrics.baseAsset} / BUY UNDERVALUED {compareAsset}. Overbought spread trigger. Target mean reversion to 0.0 Z-Score.
                              </span>
                            ) : metrics.metrics1h.currentZScore < -1.8 ? (
                              <span className="text-emerald-400 font-bold">
                                BUY UNDERVALUED {metrics.baseAsset} / SELL OVERVALUED {compareAsset}. Oversold spread trigger. Expect positive upward adjustment to mean.
                              </span>
                            ) : (
                              "Hold neutral positioning. Spot ratio is inside normal pricing bounds. Avoid aggressive arbitrage entry."
                            )}
                          </p>
                          <p>
                            • <strong className="text-white">Risk Guidance:</strong> Pairs trades are susceptible to sudden regime shifts (co-movement breakdown). Always set stop losses on spreads at {"|Z| > 3.0"} to prevent heavy tail loss events.
                          </p>
                        </div>
                      </div>
                    </motion.div>
                  )}

                  {selectedTab === "liquidations" && (
                    <motion.div
                      key="liquidations"
                      initial={{ opacity: 0, y: 3 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -3 }}
                      transition={{ duration: 0.15 }}
                    >
                      <LiquidationsPage symbol={metrics.symbol} />
                    </motion.div>
                  )}

                  {selectedTab === "terminal" && (
                    <motion.div
                      key="terminal"
                      initial={{ opacity: 0, y: 3 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -3 }}
                      transition={{ duration: 0.15 }}
                    >
                    <TerminalModule
                      symbol={metrics.symbol}
                      benchmark={scannerCtx?.compareAsset ?? compareAsset}
                      name={metrics.name}
                      onOpenTape={() => setSelectedTab("liquidations")}
                      initialInterval={scannerCtx?.params.interval as any}
                      initialLookbackDays={scannerCtx?.params.lookbackDays}
                      initialRollingWindow={scannerCtx?.params.rollingWindow}
                      initialZscoreMode={scannerCtx?.params.zscoreMode}
                    />
                    </motion.div>
                  )}

                  {selectedTab === "code" && (
                    <motion.div
                      key="code"
                      initial={{ opacity: 0, y: 3 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -3 }}
                      transition={{ duration: 0.15 }}
                    >
                      <CodeLab
                        symbol={metrics.symbol}
                        benchmark={compareAsset}
                        name={metrics.name}
                      />
                    </motion.div>
                  )}

                  {selectedTab === "scanner" && (
                    <motion.div
                      key="scanner"
                      initial={{ opacity: 0, y: 3 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -3 }}
                      transition={{ duration: 0.15 }}
                    >
                    <Scanner
                      compareAsset={compareAsset}
                      setCompareAsset={setCompareAsset}
                      onGoToTerminal={(sym, scanParams) => {
                        setSelectedSymbol(sym);
                        setSelectedTab("terminal");
                        setScannerCtx({
                          symbol: sym,
                          params: scanParams,
                          compareAsset: compareAsset,
                        });
                      }}
                    />
                    </motion.div>
                  )}

                  {selectedTab === "position" && (
                    <motion.div
                      key="position"
                      initial={{ opacity: 0, y: 3 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -3 }}
                      transition={{ duration: 0.15 }}
                    >
                      <PositionManagementPage
                        symbol={metrics.symbol}
                        benchmark={compareAsset}
                        name={metrics.name}
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          ) : (
            <div className="text-center py-20">
              <span className="text-xs text-slate-500 font-mono italic block">
                Quant feed calculation failure.
              </span>
            </div>
          )}
        </main>
      </div>

      {/* Footer System Status */}
      <footer className="border-t border-[#1f1f23] bg-[#0a0a0b] px-6 py-4 flex flex-col md:flex-row items-center justify-between font-mono text-[10px] text-slate-500">
        <div className="mb-2 md:mb-0">
          ALGORITHMIC CO-MOVEMENT DESK • REAL-TIME BINANCE PRICE FEED
        </div>
        <div className="flex space-x-6">
          <span>STOCHASTIC CALCULATIONS COMPLETED</span>
          <span>REGIME: SYSTEMIC DISCOVERY</span>
        </div>
      </footer>
    </div>
  );
}
