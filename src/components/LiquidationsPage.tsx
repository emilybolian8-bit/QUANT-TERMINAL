/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Flame,
  RefreshCw,
  Search,
} from "lucide-react";
import type {
  CoinLiqResponse,
  LiqLeaderRow,
  LiqLeadersResponse,
  LiqStatusResponse,
  LiqWindow,
} from "../types";
import LiquidationLadderChart from "./LiquidationLadderChart";

const WINDOWS: LiqWindow[] = ["1h", "4h", "24h"];
const REFRESH_MS = 20_000;

/**
 * Mirrors the server's symbol normalization so a typed "SOL" or
 * "BTC-USDT-SWAP" resolves to the same tape key before it leaves the browser.
 */
function normalizeClient(raw: string): string {
  const tokens = raw
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  while (tokens.length > 2 && ["SWAP", "PERP", "FUT", "FUTURES"].includes(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  const joined = tokens.join("");
  if (!joined) return "";
  if (joined.endsWith("USDC")) return `${joined.slice(0, -4)}USDT`;
  if (joined.endsWith("USDT")) return joined;
  if (joined.endsWith("USD")) return `${joined}T`;
  return `${joined}USDT`;
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtQty(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  if (n >= 1) return n.toFixed(3);
  return n.toPrecision(3);
}

function fmtCount(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "0";
}

/** "+12.4%" / "-3.1%" / "NEW" (no baseline) / "—" (undefined). */
function fmtPct(pct: number | null | undefined, hasBaseline: boolean): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) {
    return hasBaseline ? "—" : "NEW";
  }
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function pctTone(pct: number | null | undefined, inverse = false): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "text-slate-500";
  const up = pct > 0;
  const positive = inverse ? !up : up;
  if (pct === 0) return "text-slate-500";
  return positive ? "text-emerald-400" : "text-rose-400";
}

function utcClock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

const POSITION_STYLE: Record<string, { label: string; className: string }> = {
  long: { label: "LONG WIPED", className: "text-rose-400 bg-rose-500/10 border-rose-500/30" },
  short: { label: "SHORT WIPED", className: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30" },
  unknown: { label: "UNCLASSIFIED", className: "text-slate-400 bg-[#141417] border-[#1f1f23]" },
};

function SectionTitle({ children, tone }: { children: React.ReactNode; tone: "emerald" | "rose" }) {
  return (
    <span
      className={`text-[11px] font-mono uppercase tracking-widest font-bold flex items-center ${
        tone === "emerald" ? "text-emerald-400" : "text-rose-400"
      }`}
    >
      {tone === "emerald" ? <ArrowUpRight size={13} className="mr-1.5" /> : <ArrowDownRight size={13} className="mr-1.5" />}
      {children}
    </span>
  );
}

function LeaderTable({
  rows,
  side,
  onPick,
  activeSymbol,
  window,
}: {
  rows: LiqLeaderRow[];
  side: "gainers" | "losers";
  onPick: (symbol: string) => void;
  activeSymbol: string;
  window: LiqWindow;
}) {
  const isGainer = side === "gainers";

  if (rows.length === 0) {
    return (
      <div className="px-5 py-10 text-center">
        <span className="text-[11px] font-mono text-slate-600 italic leading-relaxed block">
          {isGainer
            ? `No coin's liquidation flow rose against the previous ${window}.`
            : `No coin's liquidation flow fell against the previous ${window}.`}
        </span>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead>
          <tr className="text-[9px] font-mono uppercase tracking-widest text-slate-600 border-b border-[#1f1f23]">
            <th className="px-4 py-2 font-semibold">#</th>
            <th className="px-2 py-2 font-semibold">Symbol</th>
            <th className="px-2 py-2 font-semibold text-right">Events</th>
            <th className="px-2 py-2 font-semibold text-right">Δ Events</th>
            <th className="px-2 py-2 font-semibold text-right">Liquidated $</th>
            <th className="px-4 py-2 font-semibold text-right">Δ $</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const active = row.symbol === activeSymbol;
            return (
              <tr
                key={row.symbol}
                onClick={() => onPick(row.symbol)}
                title={`Open the ${row.symbol} liquidation tape`}
                className={`text-[11px] font-mono cursor-pointer border-b border-[#1f1f23]/40 transition-colors ${
                  active ? "bg-emerald-500/10" : "hover:bg-[#141417]/60"
                }`}
              >
                <td className="px-4 py-2 text-slate-600">{idx + 1}</td>
                <td className="px-2 py-2">
                  <span className="font-bold text-white">{row.symbol}</span>
                  <span className="ml-2 text-[9px] text-slate-600">
                    L {fmtUsd(row.current.longNotional)} · S {fmtUsd(row.current.shortNotional)}
                  </span>
                </td>
                <td className="px-2 py-2 text-right text-slate-300">{fmtCount(row.current.events)}</td>
                <td className={`px-2 py-2 text-right font-semibold ${pctTone(row.deltaEventsPct, !isGainer)}`}>
                  {row.deltaEvents > 0 ? "+" : ""}
                  {fmtCount(row.deltaEvents)}
                  <span className="ml-1 text-[9px] opacity-70">
                    {fmtPct(row.deltaEventsPct, row.previous.events > 0)}
                  </span>
                </td>
                <td className="px-2 py-2 text-right text-slate-300">{fmtUsd(row.current.notional)}</td>
                <td className={`px-4 py-2 text-right font-semibold ${pctTone(row.deltaNotionalPct, !isGainer)}`}>
                  {row.deltaNotional > 0 ? "+" : ""}
                  {fmtUsd(row.deltaNotional)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function LiquidationsPage({ symbol }: { symbol: string }) {
  const [activeWindow, setActiveWindow] = useState<LiqWindow>("1h");
  const [viewSymbol, setViewSymbol] = useState(() => normalizeClient(symbol) || "BTCUSDT");
  const [coinQuery, setCoinQuery] = useState(symbol);

  const [leaders, setLeaders] = useState<LiqLeadersResponse | null>(null);
  const [coin, setCoin] = useState<CoinLiqResponse | null>(null);
  const [status, setStatus] = useState<LiqStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // The tape follows the workspace selection, so searching a coin in the
  // sidebar and opening this page shows that coin immediately.
  useEffect(() => {
    const next = normalizeClient(symbol);
    if (next) {
      setViewSymbol(next);
      setCoinQuery(symbol);
    }
  }, [symbol]);

  const load = useCallback(
    async (initial: boolean) => {
      if (initial) setLoading(true);
      else setRefreshing(true);
      try {
        const [leadersRes, coinRes, statusRes] = await Promise.all([
          fetch(`/api/liq/leaders?window=${activeWindow}`),
          fetch(`/api/liq/coin?symbol=${encodeURIComponent(viewSymbol)}&window=${activeWindow}`),
          fetch(`/api/liq/status`),
        ]);

        const leadersJson = await leadersRes.json().catch(() => ({}));
        if (!leadersRes.ok) {
          throw new Error(leadersJson?.error || `Liquidation leaderboard failed (${leadersRes.status}).`);
        }
        const coinJson = await coinRes.json().catch(() => ({}));
        if (!coinRes.ok) {
          throw new Error(coinJson?.error || `Coin liquidation lookup failed (${coinRes.status}).`);
        }

        setLeaders(leadersJson as LiqLeadersResponse);
        setCoin(coinJson as CoinLiqResponse);
        if (statusRes.ok) setStatus((await statusRes.json()) as LiqStatusResponse);
        setError(null);
      } catch (err: any) {
        setError(err?.message || "Liquidation feed unavailable.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [activeWindow, viewSymbol]
  );

  useEffect(() => {
    void load(true);
    const timer = setInterval(() => void load(false), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const normalized = normalizeClient(coinQuery);
    if (normalized) setViewSymbol(normalized);
  };

  const pickSymbol = (next: string) => {
    setCoinQuery(next);
    setViewSymbol(next);
  };

  const current = coin?.current;
  const previous = coin?.previous;
  const maxBucket = Math.max(1, ...(coin?.series ?? []).map((b) => b.notional));
  const followsWorkspace = viewSymbol === (normalizeClient(symbol) || "BTCUSDT");
  const lastEventAt = Math.max(
    0,
    ...(status?.exchanges ?? []).map((ex) => ex.lastEventAt ?? 0)
  );

  const venueTone = (connected: boolean) =>
    connected ? "bg-emerald-500" : "bg-amber-500";

  return (
    <motion.div
      initial={{ opacity: 0, y: 3 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -3 }}
      transition={{ duration: 0.15 }}
      className="space-y-6"
    >
      {/* Feed health strip */}
      <div className="bg-[#0e0e10] border border-[#1f1f23] rounded-xl px-5 py-3.5 flex flex-wrap items-center gap-x-6 gap-y-2 justify-between">
        <div className="flex flex-wrap items-center gap-4">
          <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500 font-bold flex items-center">
            <Flame size={12} className="mr-1.5 text-orange-400" /> LIQUIDATION COLLECTOR
          </span>
          {(status?.exchanges ?? []).map((ex) => (
            <span
              key={ex.exchange}
              className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400"
              title={`${fmtCount(ex.eventsReceived)} events received · ${ex.reconnects} reconnect(s)${ex.error ? ` · ${ex.error}` : ""}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${venueTone(ex.connected)} ${ex.connected ? "animate-pulse" : ""}`} />
              <span className="uppercase font-bold text-slate-300">{ex.exchange}</span>
              <span className="text-slate-600">{fmtCount(ex.eventsReceived)}</span>
            </span>
          ))}
          {!status && <span className="text-[10px] font-mono text-slate-600 italic">probing feed…</span>}
        </div>
        <div className="flex items-center gap-5 text-[10px] font-mono text-slate-500">
          <span>BUFFER {fmtCount(status?.bufferedEvents ?? 0)} EVENTS</span>
          <span>
            LAST PRINT{" "}
            {lastEventAt > 0 ? `${utcClock(lastEventAt)} UTC` : "—"}
          </span>
          <button
            type="button"
            onClick={() => void load(false)}
            className="flex items-center gap-1.5 text-slate-400 hover:text-emerald-400 transition-colors cursor-pointer"
            title="Refresh the liquidation tape now"
          >
            <RefreshCw size={11} className={refreshing ? "animate-spin" : ""} />
            REFRESH
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3.5 bg-rose-950/60 border border-rose-800/40 text-rose-300 rounded text-xs font-mono">
          {error}
        </div>
      )}

      {/* Window selector: click 1H / 4H / 24H */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500 font-bold">
            LIQUIDATION WINDOW
          </span>
          <div className="flex items-center gap-1 p-0.5 border border-[#1f1f23] rounded bg-[#0a0a0b]">
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                aria-pressed={activeWindow === w}
                onClick={() => setActiveWindow(w)}
                className={`px-4 py-1.5 text-[11px] font-mono font-bold rounded transition-all cursor-pointer ${
                  activeWindow === w
                    ? "bg-[#141417] border border-emerald-500/40 text-emerald-400"
                    : "border border-transparent text-slate-500 hover:text-slate-300"
                }`}
              >
                {w.toUpperCase()}
              </button>
            ))}
          </div>
          <span className="text-[10px] font-mono text-slate-600">
            vs previous {activeWindow} · {leaders ? `${leaders.symbolsActive} active symbols` : "…"}
          </span>
        </div>
        {leaders && (
          <span className="text-[10px] font-mono text-slate-600">
            {new Date(leaders.windowStart).toISOString().slice(5, 16).replace("T", " ")} →{" "}
            {new Date(leaders.windowEnd).toISOString().slice(5, 16).replace("T", " ")} UTC
          </span>
        )}
      </div>

      {/* Gainers / Losers */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="bg-[#0e0e10] border border-emerald-500/20 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-[#1f1f23] bg-emerald-500/5 flex items-center justify-between">
            <SectionTitle tone="emerald">GAINERS — LIQUIDATIONS RISING</SectionTitle>
            <span className="text-[9px] font-mono text-slate-600">ranked by events, then quantity</span>
          </div>
          {loading && !leaders ? (
            <div className="px-5 py-10 text-center text-[11px] font-mono text-slate-600 animate-pulse">
              Ranking liquidation flow…
            </div>
          ) : (
            <LeaderTable
              rows={leaders?.gainers ?? []}
              side="gainers"
              onPick={pickSymbol}
              activeSymbol={viewSymbol}
              window={activeWindow}
            />
          )}
        </div>

        <div className="bg-[#0e0e10] border border-rose-500/20 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-[#1f1f23] bg-rose-500/5 flex items-center justify-between">
            <SectionTitle tone="rose">LOSERS — LIQUIDATIONS FALLING</SectionTitle>
            <span className="text-[9px] font-mono text-slate-600">ranked by events, then quantity</span>
          </div>
          {loading && !leaders ? (
            <div className="px-5 py-10 text-center text-[11px] font-mono text-slate-600 animate-pulse">
              Ranking liquidation flow…
            </div>
          ) : (
            <LeaderTable
              rows={leaders?.losers ?? []}
              side="losers"
              onPick={pickSymbol}
              activeSymbol={viewSymbol}
              window={activeWindow}
            />
          )}
        </div>
      </div>

      {/* Per-coin tape */}
      <div className="bg-[#0e0e10] border border-[#1f1f23] rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[#1f1f23] bg-[#141417] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-mono uppercase tracking-widest text-slate-200 font-bold flex items-center">
              <Activity size={13} className="mr-1.5 text-emerald-400" /> COIN LIQUIDATION TAPE
            </span>
            <span className="text-[10px] font-mono font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded">
              {coin?.symbol ?? viewSymbol}
            </span>
            {followsWorkspace && (
              <span className="text-[9px] font-mono text-slate-600">tracking workspace selection</span>
            )}
          </div>
          <form onSubmit={submitSearch} className="flex items-center gap-2">
            <div className="relative">
              <input
                type="text"
                value={coinQuery}
                onChange={(e) => setCoinQuery(e.target.value)}
                placeholder="Search a coin (e.g. SOL, PEPEUSDT)…"
                className="w-56 bg-[#0a0a0b] border border-[#1f1f23] rounded pl-8 pr-3 py-1.5 text-[11px] font-mono text-slate-300 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50 transition-colors"
              />
              <Search size={11} className="absolute left-2.5 top-2.5 text-slate-600" />
            </div>
            <button
              type="submit"
              className="px-3.5 py-1.5 text-[10px] font-mono font-bold bg-[#0a0a0b] border border-[#1f1f23] hover:border-emerald-500/40 hover:text-emerald-400 text-slate-400 rounded transition-all cursor-pointer"
            >
              LOAD TAPE
            </button>
          </form>
        </div>

        {loading && !coin ? (
          <div className="px-5 py-16 text-center text-[11px] font-mono text-slate-600 animate-pulse">
            Reading the liquidation buffer…
          </div>
        ) : coin && current && previous ? (
          <div className="p-5 space-y-5">
            {/* Summary cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              <div className="bg-[#0a0a0b] border border-[#1f1f23] rounded-lg p-4">
                <span className="text-[9px] font-mono uppercase tracking-widest text-slate-500 block mb-1.5">
                  LIQUIDATED ({activeWindow})
                </span>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-mono font-bold text-white">{fmtUsd(current.notional)}</span>
                  <span className={`text-[10px] font-mono font-bold ${pctTone(coin.delta.notionalPct)}`}>
                    {fmtPct(coin.delta.notionalPct, previous.notional > 0)}
                  </span>
                </div>
                <span className="text-[10px] font-mono text-slate-600 block mt-1.5">
                  prev {activeWindow}: {fmtUsd(previous.notional)}
                </span>
              </div>

              <div className="bg-[#0a0a0b] border border-[#1f1f23] rounded-lg p-4">
                <span className="text-[9px] font-mono uppercase tracking-widest text-slate-500 block mb-1.5">
                  LIQUIDATION EVENTS
                </span>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-mono font-bold text-white">{fmtCount(current.events)}</span>
                  <span className={`text-[10px] font-mono font-bold ${pctTone(coin.delta.eventsPct)}`}>
                    {fmtPct(coin.delta.eventsPct, previous.events > 0)}
                  </span>
                </div>
                <span className="text-[10px] font-mono text-slate-600 block mt-1.5">
                  prev {activeWindow}: {fmtCount(previous.events)} · buffer {fmtCount(coin.buffered)}
                </span>
              </div>

              <div className="bg-[#0a0a0b] border border-[#1f1f23] rounded-lg p-4">
                <span className="text-[9px] font-mono uppercase tracking-widest text-slate-500 block mb-1.5">
                  LONG vs SHORT WIPED
                </span>
                {current.notional > 0 ? (
                  <>
                    <div className="flex h-2.5 w-full rounded overflow-hidden bg-[#141417] mb-2">
                      <div
                        className="bg-rose-500"
                        style={{ width: `${Math.max(1, (current.longNotional / current.notional) * 100)}%` }}
                        title={`Longs wiped ${fmtUsd(current.longNotional)}`}
                      />
                      <div
                        className="bg-emerald-500"
                        style={{ width: `${Math.max(1, (current.shortNotional / current.notional) * 100)}%` }}
                        title={`Shorts wiped ${fmtUsd(current.shortNotional)}`}
                      />
                    </div>
                    <div className="flex justify-between text-[10px] font-mono">
                      <span className="text-rose-400">
                        LONG {fmtUsd(current.longNotional)} · {fmtCount(current.longEvents)}
                      </span>
                      <span className="text-emerald-400">
                        {fmtCount(current.shortEvents)} · {fmtUsd(current.shortNotional)} SHORT
                      </span>
                    </div>
                  </>
                ) : (
                  <span className="text-xl font-mono text-slate-600">—</span>
                )}
              </div>

              <div className="bg-[#0a0a0b] border border-[#1f1f23] rounded-lg p-4">
                <span className="text-[9px] font-mono uppercase tracking-widest text-slate-500 block mb-1.5">
                  VENUE BREAKDOWN
                </span>
                <div className="space-y-1.5">
                  {(["binance", "bybit", "okx"] as const).map((venue) => {
                    const bucket = current.byExchange[venue];
                    return (
                      <div key={venue} className="flex items-center justify-between text-[10px] font-mono">
                        <span className="text-slate-500 uppercase">{venue}</span>
                        <span className="text-slate-300">
                          {bucket ? `${fmtCount(bucket.events)} · ${fmtUsd(bucket.notional)}` : "—"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Kline + liquidation ladder: bands at the price levels where
                force-orders printed, thickness scaled by notional. */}
            <LiquidationLadderChart symbol={viewSymbol} window={activeWindow} />

            {/* Flow chart */}
            <div className="bg-[#0a0a0b] border border-[#1f1f23] rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500 font-bold">
                  FLOW PROFILE — LAST {activeWindow.toUpperCase()} (12 BUCKETS)
                </span>
                <div className="flex items-center gap-4 text-[9px] font-mono text-slate-500">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-sm bg-rose-500 inline-block" /> LONG WIPED
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-sm bg-emerald-500 inline-block" /> SHORT WIPED
                  </span>
                  <span>MAX {fmtUsd(maxBucket)}/BUCKET</span>
                </div>
              </div>
              <div className="flex items-end gap-1.5 h-40">
                {coin.series.map((bucket) => {
                  const longShare = bucket.notional > 0 ? bucket.longNotional / bucket.notional : 0;
                  const shortShare = bucket.notional > 0 ? bucket.shortNotional / bucket.notional : 0;
                  const otherShare = Math.max(0, 1 - longShare - shortShare);
                  const height = (bucket.notional / maxBucket) * 100;
                  return (
                    <div
                      key={bucket.t}
                      className="flex-1 flex flex-col justify-end h-full group"
                      title={`${new Date(bucket.t).toISOString().slice(5, 16).replace("T", " ")} UTC · ${bucket.events} events · ${fmtUsd(bucket.notional)}`}
                    >
                      {height > 0 ? (
                        <div style={{ height: `${height}%` }} className="flex flex-col justify-end w-full transition-all">
                          {otherShare > 0 && (
                            <div className="bg-slate-600 w-full" style={{ height: `${otherShare * 100}%` }} />
                          )}
                          <div className="bg-emerald-500 w-full" style={{ height: `${shortShare * 100}%` }} />
                          <div className="bg-rose-500 w-full" style={{ height: `${longShare * 100}%` }} />
                        </div>
                      ) : (
                        <div className="h-[2px] w-full bg-[#1f1f23] group-hover:bg-slate-700" />
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-between text-[9px] font-mono text-slate-600 mt-1.5">
                <span>{utcClock(coin.windowStart)} UTC</span>
                <span>{utcClock(coin.windowStart + (coin.windowEnd - coin.windowStart) / 2)} UTC</span>
                <span>{utcClock(coin.windowEnd)} UTC</span>
              </div>
            </div>

            {/* Recent events tape */}
            <div className="bg-[#0a0a0b] border border-[#1f1f23] rounded-lg overflow-hidden">
              <div className="px-4 py-2.5 border-b border-[#1f1f23] flex items-center justify-between">
                <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500 font-bold">
                  RECENT LIQUIDATION EVENTS ({coin.recent.length})
                </span>
                <span className="text-[9px] font-mono text-slate-600">newest first · auto-refreshes</span>
              </div>
              {coin.recent.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <span className="text-[11px] font-mono text-slate-600 italic block leading-relaxed">
                    No {activeWindow} liquidation events for {coin.symbol} yet.
                  </span>
                  <span className="text-[10px] font-mono text-slate-700 mt-1 block">
                    The collector buffers live force-orders — prints appear as venues emit them.
                  </span>
                </div>
              ) : (
                <div className="max-h-[340px] overflow-y-auto custom-scrollbar">
                  <table className="w-full text-left">
                    <thead className="sticky top-0 bg-[#0e0e10]">
                      <tr className="text-[9px] font-mono uppercase tracking-widest text-slate-600 border-b border-[#1f1f23]">
                        <th className="px-4 py-2 font-semibold">Time (UTC)</th>
                        <th className="px-2 py-2 font-semibold">Venue</th>
                        <th className="px-2 py-2 font-semibold">Position</th>
                        <th className="px-2 py-2 font-semibold text-right">Price</th>
                        <th className="px-2 py-2 font-semibold text-right">Qty</th>
                        <th className="px-4 py-2 font-semibold text-right">Notional</th>
                      </tr>
                    </thead>
                    <tbody>
                      {coin.recent.map((event) => {
                        const tone = POSITION_STYLE[event.position] ?? POSITION_STYLE.unknown;
                        return (
                          <tr key={event.id} className="text-[11px] font-mono border-b border-[#1f1f23]/40 hover:bg-[#141417]/50 transition-colors">
                            <td className="px-4 py-1.5 text-slate-400">{utcClock(event.receivedAtMs)}</td>
                            <td className="px-2 py-1.5 text-slate-500 uppercase">{event.exchange}</td>
                            <td className="px-2 py-1.5">
                              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${tone.className}`}>
                                {tone.label}
                              </span>
                            </td>
                            <td className="px-2 py-1.5 text-right text-slate-300">
                              {event.price > 0 ? event.price.toLocaleString("en-US", { maximumFractionDigits: 6 }) : "—"}
                            </td>
                            <td className="px-2 py-1.5 text-right text-slate-400">{fmtQty(event.qty)}</td>
                            <td className="px-4 py-1.5 text-right text-white font-semibold">
                              {event.notional > 0 ? fmtUsd(event.notional) : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="px-5 py-12 text-center text-[11px] font-mono text-slate-600">
            Enter a ticker above to load its liquidation tape.
          </div>
        )}
      </div>

      {/* Methodology note */}
      <div className="text-[10px] font-mono text-slate-600 leading-relaxed border-t border-[#1f1f23] pt-4">
        Windows compare [{activeWindow} back, now) against the matching span behind it, cut on the collector's receive
        clock. Gainers rank by the change in liquidation event count, then USD quantity; losers rank the same metrics
        downward. Source: in-process Binance / Bybit / OKX force-order streams (fused liq-collector). Event counts are
        raw prints, not net position.
      </div>
    </motion.div>
  );
}
