/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Clock3, RefreshCw, TrendingDown, TrendingUp, Zap } from "lucide-react";
import {
  Interval,
  MoveProbabilityBrief,
  MoveProbabilityResponse,
} from "../types";
import {
  PROBABILITY_MAX_LOOKBACK_DAYS,
} from "../utils/probability_engine";
import { formatUtcStamp } from "../utils/dates";
import { CLASS_COLORS, CumulativeIncidenceChart } from "./ProbabilityCharts";
import { EmptyState, TerminalPanel } from "./terminal/TerminalCharts";

const INTERVALS: Interval[] = ["15m", "1h", "4h", "1d"];

const INTERVAL_MS: Record<Interval, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};

const PCT_PRESETS = [2, 5, 10, 15, 20];
const HOUR_PRESETS = [1, 3, 6, 12, 24, 48];
const LOOKBACK_OPTIONS = [7, 14, 30, 60, 90, 180, 365];

function fmtPct(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}

function fmtCi(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}

function hoursOf(intervalMs: number, bars: number): string {
  const h = (bars * intervalMs) / 3600000;
  return h % 1 === 0 ? `${h}h` : `${h.toFixed(1)}h`;
}

interface MoveQuery {
  symbol: string;
  interval: Interval;
  lookbackDays: number;
  pct: number;
  hours: number;
}

function useMoveProbability<T>(q: MoveQuery, live: boolean, view: "full" | "brief") {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        symbol: q.symbol,
        view,
        interval: q.interval,
        lookbackDays: String(q.lookbackDays),
        pct: String(q.pct),
        hours: String(q.hours),
      });
      const res = await fetch(`/api/move-prob?${params.toString()}`);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || `Move probability failed (${res.status}).`);
      setData(payload as T);
      setLastUpdated(Date.now());
    } catch (err: any) {
      setError(err?.message || "Failed to compute the move probability.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [q.symbol, q.interval, q.lookbackDays, q.pct, q.hours, view]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => void load(), 45000);
    return () => clearInterval(id);
  }, [live, load]);

  return { data, loading, error, reload: load, lastUpdated };
}

function commitNumber(draft: string, fallback: number): number {
  const v = Number(draft);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/* -------------------------------------------------------------------------- *
 * Full panel for the probability page
 * -------------------------------------------------------------------------- */

export function MoveProbabilityPanel({
  symbol,
  name,
}: {
  symbol: string;
  name: string;
}) {
  const [interval, setInterval] = useState<Interval>("1h");
  const [lookbackDays, setLookbackDays] = useState(90);
  const [pct, setPct] = useState(10);
  const [hours, setHours] = useState(3);
  const [pctDraft, setPctDraft] = useState("10");
  const [hoursDraft, setHoursDraft] = useState("3");
  const [live, setLive] = useState(true);

  const intervalMs = INTERVAL_MS[interval];
  const minHours = intervalMs / 3600000;
  const maxLookback = PROBABILITY_MAX_LOOKBACK_DAYS[interval];
  const hourPresets = HOUR_PRESETS.filter(
    (h) => h >= minHours && h * 60 * 60 * 1000 <= (lookbackDays * 24 * 60 * 60 * 1000) / 3
  );

  const query: MoveQuery = useMemo(
    () => ({ symbol, interval, lookbackDays, pct, hours }),
    [symbol, interval, lookbackDays, pct, hours]
  );
  const { data, loading, error, reload, lastUpdated } = useMoveProbability<MoveProbabilityResponse>(
    query,
    live,
    "full"
  );

  useEffect(() => {
    setLookbackDays((current) => (current > maxLookback ? 90 : current));
  }, [maxLookback]);

  const barrier = data ? `${data.params.thresholdPct}%` : `${pct}%`;
  const horizon = data ? hoursOf(intervalMs, data.params.horizonBars) : hoursOf(intervalMs, Math.max(1, Math.round((hours * 3600000) / intervalMs)));

  return (
    <div className="relative">
      <div className="bg-[#0e0e10] border border-[#1f1f23] rounded-xl p-4 mb-5">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <span className="text-[10px] font-mono text-emerald-400 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            LIVE MOVE PROBABILITY
          </span>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-slate-400">
              Can <span className="text-slate-200">{name}</span> trade
            </span>
            <input
              type="number"
              min={0.25}
              max={300}
              step={0.5}
              value={pctDraft}
              onChange={(e) => setPctDraft(e.target.value)}
              onBlur={() => { const v = commitNumber(pctDraft, pct); setPct(v); setPctDraft(String(v)); }}
              onKeyDown={(e) => { if (e.key === "Enter") { const v = commitNumber(pctDraft, pct); setPct(v); setPctDraft(String(v)); } }}
              className="w-16 h-7 px-2 text-[11px] font-mono rounded border border-[#1f1f23] bg-[#0a0a0b] text-emerald-300 text-right outline-none focus:border-emerald-500/50"
            />
            <span className="text-[10px] font-mono text-slate-400">%</span>
            <span className="text-[10px] font-mono text-slate-400">within the next</span>
            <input
              type="number"
              min={0.25}
              step={0.25}
              value={hoursDraft}
              onChange={(e) => setHoursDraft(e.target.value)}
              onBlur={() => { const v = commitNumber(hoursDraft, hours); setHours(v); setHoursDraft(String(v)); }}
              onKeyDown={(e) => { if (e.key === "Enter") { const v = commitNumber(hoursDraft, hours); setHours(v); setHoursDraft(String(v)); } }}
              className="w-16 h-7 px-2 text-[11px] font-mono rounded border border-[#1f1f23] bg-[#0a0a0b] text-emerald-300 text-right outline-none focus:border-emerald-500/50"
            />
            <span className="text-[10px] font-mono text-slate-400">hours?</span>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={() => setLive((v) => !v)}
              title="Auto-refresh every 45s as new bars settle"
              className={`h-7 px-2.5 text-[10px] font-mono rounded border cursor-pointer flex items-center gap-1.5 transition-colors ${
                live
                  ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-300"
                  : "bg-[#0a0a0b] border-[#1f1f23] text-slate-500 hover:text-slate-300"
              }`}
            >
              <Zap size={11} /> LIVE
            </button>
            <button
              type="button"
              onClick={() => void reload()}
              className="h-7 px-2.5 text-[10px] font-mono rounded border border-[#1f1f23] bg-[#0a0a0b] text-slate-400 hover:text-emerald-400 hover:border-emerald-500/40 cursor-pointer flex items-center gap-1.5"
            >
              <RefreshCw size={11} className={loading ? "animate-spin" : ""} /> RECOMPUTE
            </button>
          </div>
        </div>

        <div className="mt-3 pt-3 border-t border-[#1f1f23] flex flex-wrap items-center gap-x-6 gap-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[9px] font-mono text-slate-500 uppercase tracking-wider mr-1">
              Move size
            </span>
            {PCT_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => { setPct(p); setPctDraft(String(p)); }}
                className={`px-2 h-6 text-[10px] font-mono rounded border cursor-pointer transition-colors ${
                  pct === p
                    ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-300"
                    : "bg-[#0a0a0b] border-[#1f1f23] text-slate-500 hover:text-slate-300"
                }`}
              >
                ±{p}%
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[9px] font-mono text-slate-500 uppercase tracking-wider mr-1">
              Horizon
            </span>
            {hourPresets.map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => { setHours(h); setHoursDraft(String(h)); }}
                className={`px-2 h-6 text-[10px] font-mono rounded border cursor-pointer transition-colors ${
                  hours === h
                    ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-300"
                    : "bg-[#0a0a0b] border-[#1f1f23] text-slate-500 hover:text-slate-300"
                }`}
              >
                {h}h
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[9px] font-mono text-slate-500 uppercase tracking-wider mr-1">
              Timeframe
            </span>
            {INTERVALS.map((iv) => (
              <button
                key={iv}
                type="button"
                onClick={() => setInterval(iv)}
                className={`px-2 h-6 text-[10px] font-mono rounded border cursor-pointer transition-colors ${
                  interval === iv
                    ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-300"
                    : "bg-[#0a0a0b] border-[#1f1f23] text-slate-500 hover:text-slate-300"
                }`}
              >
                {iv}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[9px] font-mono text-slate-500 uppercase tracking-wider mr-1">
              History
            </span>
            {LOOKBACK_OPTIONS.filter((d) => d <= maxLookback).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setLookbackDays(d)}
                className={`px-2 h-6 text-[10px] font-mono rounded border cursor-pointer transition-colors ${
                  lookbackDays === d
                    ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-300"
                    : "bg-[#0a0a0b] border-[#1f1f23] text-slate-500 hover:text-slate-300"
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>

        {data && (
          <div className="mt-3 pt-3 border-t border-[#1f1f23] flex flex-wrap items-center gap-x-5 gap-y-1 text-[9px] font-mono text-slate-500">
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              {name} {data.lastPrice.toLocaleString(undefined, { maximumFractionDigits: 6 })}
            </span>
            <span className="flex items-center gap-1">
              <Clock3 size={10} />
              as of {formatUtcStamp(data.asOf.timestamp)} UTC
            </span>
            <span>
              {data.params.horizonBars} {interval} bars ({hoursOf(intervalMs, data.params.horizonBars)})
            </span>
            <span>
              {data.nWindows.toLocaleString()} windows · n_eff {data.nEff.toFixed(0)} (deff{" "}
              {data.designEffect.toFixed(1)})
            </span>
            {live && lastUpdated !== null && (
              <span>updated {Math.max(0, Math.round((Date.now() - lastUpdated) / 1000))}s ago</span>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="mb-5 p-4 bg-rose-950/80 border border-rose-800/40 text-rose-300 rounded flex items-start space-x-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div>
            <span className="text-xs font-semibold block font-mono">MOVE PROBABILITY FAILED</span>
            <p className="text-xs text-rose-400/90 mt-1 leading-normal font-sans">{error}</p>
          </div>
        </div>
      )}

      {loading && !data ? (
        <div className="py-16 flex flex-col items-center justify-center">
          <div className="relative">
            <div className="w-14 h-14 rounded-full border-2 border-[#1f1f23] animate-pulse" />
            <div className="absolute inset-0 w-14 h-14 rounded-full border-t-2 border-emerald-400 animate-spin" />
          </div>
          <span className="text-xs font-mono text-slate-500 uppercase tracking-widest mt-6 animate-pulse">
            Sweeping every historical bar...
          </span>
        </div>
      ) : data ? (
        <div className="space-y-6">
          <div className="bg-[#0e0e10] border border-[#1f1f23] rounded-xl p-5">
            <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 md:gap-8">
              <div className="min-w-0">
                <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest block">
                  Question
                </span>
                <p className="text-sm font-mono text-white font-semibold mt-1 leading-relaxed">
                  P({name} trades {`≥ +${barrier}`} or {`−${barrier}`} at any point within the next{" "}
                  {horizon}) ={" "}
                  <span className="text-emerald-400">{fmtPct(data.everTouch.either.p)}</span>
                </p>
                <p className="text-[11px] text-slate-500 mt-1.5 leading-relaxed max-w-3xl">
                  Touched on the high/low basis, not just closed: this is how often the price
                  actually reached either level during an equivalent window in the sample.
                </p>
              </div>
              <div className="flex gap-6 shrink-0">
                <div className="text-right">
                  <div className="text-[9px] font-mono text-emerald-400 uppercase tracking-wider flex items-center justify-end gap-1">
                    <TrendingUp size={10} /> up
                  </div>
                  <div className="text-2xl font-mono font-bold text-emerald-400 leading-tight">
                    {fmtPct(data.everTouch.up.p)}
                  </div>
                  <div className="text-[9px] font-mono text-slate-500">{fmtCi(data.everTouch.up.ci95[0])}–{fmtCi(data.everTouch.up.ci95[1])}</div>
                </div>
                <div className="text-right">
                  <div className="text-[9px] font-mono text-rose-400 uppercase tracking-wider flex items-center justify-end gap-1">
                    <TrendingDown size={10} /> down
                  </div>
                  <div className="text-2xl font-mono font-bold text-rose-400 leading-tight">
                    {fmtPct(data.everTouch.down.p)}
                  </div>
                  <div className="text-[9px] font-mono text-slate-500">{fmtCi(data.everTouch.down.ci95[0])}–{fmtCi(data.everTouch.down.ci95[1])}</div>
                </div>
                <div className="text-right">
                  <div className="text-[9px] font-mono text-sky-400 uppercase tracking-wider">
                    either way
                  </div>
                  <div className="text-2xl font-mono font-bold text-sky-400 leading-tight">
                    {fmtPct(data.everTouch.either.p)}
                  </div>
                  <div className="text-[9px] font-mono text-slate-500">{fmtCi(data.everTouch.either.ci95[0])}–{fmtCi(data.everTouch.either.ci95[1])}</div>
                </div>
              </div>
            </div>
          </div>

          {data.warnings.length > 0 && (
            <div className="p-3 bg-amber-500/[0.06] border border-amber-500/25 rounded flex items-start gap-2.5">
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

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <TerminalPanel
              id="move-timing"
              eyebrow="First to arrive (competing risks)"
              title="Cumulative incidence of a ±% barrier touch"
              subtitle="Up and down compete inside every window: the curves show the share of windows that have already seen the first touch by each point of the horizon."
              right={
                <span className="text-[10px] font-mono text-slate-500">
                  median down {data.medianDownBars !== null ? hoursOf(intervalMs, data.medianDownBars) : "never"} · up{" "}
                  {data.medianUpBars !== null ? hoursOf(intervalMs, data.medianUpBars) : "never"}
                </span>
              }
            >
              <CumulativeIncidenceChart
                id="move-cif"
                timing={data.timing}
                baseCollapse={data.everTouch.down.p}
                labels={{
                  primary: `down −${barrier}`,
                  secondary: `up +${barrier}`,
                  base: "base down",
                  median: "median down",
                }}
                x0Label="now"
                formatX={(bars) => hoursOf(intervalMs, bars)}
              />
            </TerminalPanel>

            <TerminalPanel
              id="move-breakdown"
              eyebrow="Barrier basis"
              title="Touched vs closed through"
              subtitle="The gap between the two rows is the wick: how often price traded at the level without the bar settling beyond it."
            >
              <MiniTable
                headers={["Metric", `Up +${barrier}`, `Down −${barrier}`, "Either"]}
                rows={[
                  [
                    <span key="t" style={{ color: "#e2e8f0" }}>Touched (high/low basis)</span>,
                    statCell(data.everTouch.up),
                    statCell(data.everTouch.down),
                    statCell(data.everTouch.either),
                  ],
                  [
                    <span key="c" style={{ color: "#94a3b8" }}>Closed through (close basis)</span>,
                    statCell(data.everClose.up),
                    statCell(data.everClose.down),
                    statCell(data.everClose.either),
                  ],
                  [
                    <span key="f" style={{ color: "#38bdf8" }}>First barrier reached</span>,
                    statCell(data.firstTouch.up),
                    statCell(data.firstTouch.down),
                    <span key="a" className="text-slate-500">
                      {fmtPct(data.firstTouch.ambiguousShare)} ambiguous
                    </span>,
                  ],
                ]}
              />
              <p className="text-[10px] text-slate-500 mt-3 leading-relaxed">
                n_eff = {data.nEff.toFixed(0)} of {data.nWindows.toLocaleString()} windows: adjacent
                windows share most of their horizon, so the raw count would flatter the sample.
              </p>
            </TerminalPanel>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <TerminalPanel
              id="move-forward"
              eyebrow="Horizon return"
              title="Close-to-close return over the window"
              subtitle="Distribution of the settled return at horizon end, in percent, across every window in the sample."
            >
              <MiniTable
                headers={["Quantile", "Return"]}
                rows={[
                  ["p05", signedPct(data.forward.p05)],
                  ["p25", signedPct(data.forward.p25)],
                  ["median", signedPct(data.forward.p50)],
                  ["p75", signedPct(data.forward.p75)],
                  ["p95", signedPct(data.forward.p95)],
                  ["mean", signedPct(data.forward.mean)],
                  ["P(positive return)", fmtPct(data.forward.pPositive)],
                ]}
              />
            </TerminalPanel>

            <TerminalPanel
              id="move-regime"
              eyebrow="Live conditioning"
              title={`P(touch) by trailing ${VOL_WINDOW_LABEL}`}
              subtitle="The sample splits into thirds of trailing volatility; today's regime is marked. This is why the estimate changes between refreshes."
              right={
                <span className="text-[10px] font-mono text-emerald-400">
                  current vol percentile {data.currentVolPct}%
                </span>
              }
            >
              <div className="space-y-2">
                {data.regimes.map((r) => (
                  <div
                    key={r.label}
                    className={`rounded border p-2.5 ${r.current ? "border-emerald-500/50 bg-emerald-500/[0.06]" : "border-[#1f1f23] bg-[#0a0a0b]"}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[10px] font-mono text-slate-300">
                        {r.current && <span className="text-emerald-400 mr-1.5">●</span>}
                        {r.label}
                      </span>
                      <span className="text-[9px] font-mono text-slate-600">n={r.n}</span>
                    </div>
                    <div className="mt-1.5 grid grid-cols-2 gap-3">
                      <span className="text-[11px] font-mono text-emerald-400">
                        up {fmtPct(r.up.p)}
                        <span className="text-slate-600"> [{fmtCi(r.up.ci80[0])}, {fmtCi(r.up.ci80[1])}]</span>
                      </span>
                      <span className="text-[11px] font-mono text-rose-400">
                        down {fmtPct(r.down.p)}
                        <span className="text-slate-600"> [{fmtCi(r.down.ci80[0])}, {fmtCi(r.down.ci80[1])}]</span>
                      </span>
                    </div>
                  </div>
                ))}
                {data.regimes.length === 0 && (
                  <EmptyState message="Not enough history to split into volatility regimes." />
                )}
              </div>
            </TerminalPanel>
          </div>

          <div className="p-4 bg-[#0e0e10] border border-[#1f1f23] rounded-xl">
            <p className="text-[10px] font-mono text-slate-500 uppercase tracking-wider mb-2">
              Honesty notes
            </p>
            <ul className="space-y-1.5">
              {data.caveats.map((c) => (
                <li key={c} className="flex items-start gap-2 text-[11px] text-slate-400 leading-relaxed">
                  <span className="text-slate-600 mt-px">—</span>
                  <span>{c}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[10px] font-mono text-slate-600">
              last price {data.lastPrice.toLocaleString(undefined, { maximumFractionDigits: 6 })} · computed{" "}
              {formatUtcStamp(data.asOf.serverTime)} UTC
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const VOL_WINDOW_LABEL = "24 bars";

function statCell(s: { p: number; ci95: [number, number]; count: number }) {
  return (
    <span className="text-slate-200">
      {fmtPct(s.p)}
      <span className="text-slate-500"> [{fmtCi(s.ci95[0])}, {fmtCi(s.ci95[1])}]</span>
      <span className="text-slate-600"> · n={s.count}</span>
    </span>
  );
}

function signedPct(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return "—";
  const sign = x > 0 ? "+" : "";
  return `${sign}${(x * 100).toFixed(digits)}%`;
}

/* -------------------------------------------------------------------------- *
 * Compact summary card for the Quant Terminal
 * -------------------------------------------------------------------------- */

export function MoveProbabilityCard({
  symbol,
  name,
  interval,
  lookbackDays,
}: {
  symbol: string;
  name: string;
  interval: Interval;
  lookbackDays: number;
}) {
  const [pct, setPct] = useState(10);
  const [hours, setHours] = useState(3);
  const intervalMs = INTERVAL_MS[interval];

  useEffect(() => {
    setHours((h) => Math.max(h, intervalMs / 3600000));
  }, [intervalMs]);

  const query: MoveQuery = useMemo(
    () => ({ symbol, interval, lookbackDays, pct, hours }),
    [symbol, interval, lookbackDays, pct, hours]
  );
  const { data, loading, error, reload, lastUpdated } = useMoveProbability<MoveProbabilityBrief>(
    query,
    false,
    "brief"
  );

  return (
    <div className="bg-[#0e0e10] border border-[#1f1f23] rounded-xl p-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="text-[10px] font-mono text-emerald-400 flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
          MOVE PROBABILITY
        </span>
        <label className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400">
          ±
          <select
            value={String(pct)}
            onChange={(e) => setPct(Number(e.target.value))}
            className="h-6 px-1.5 text-[10px] font-mono rounded border border-[#1f1f23] bg-[#0a0a0b] text-emerald-300 cursor-pointer outline-none focus:border-emerald-500/50"
          >
            {PCT_PRESETS.map((p) => (
              <option key={p} value={p}>{p}%</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400">
          in
          <select
            value={String(hours)}
            onChange={(e) => setHours(Number(e.target.value))}
            className="h-6 px-1.5 text-[10px] font-mono rounded border border-[#1f1f23] bg-[#0a0a0b] text-emerald-300 cursor-pointer outline-none focus:border-emerald-500/50"
          >
            {HOUR_PRESETS.filter(
              (h) => h >= intervalMs / 3600000 && h * 3600000 <= (lookbackDays * 86400000) / 3
            ).map((h) => (
              <option key={h} value={h}>{h}h</option>
            ))}
          </select>
        </label>
        <span className="text-[10px] font-mono text-slate-400 truncate max-w-[280px]">
          Can {name} reach ±{data ? data.params.thresholdPct : pct}% within{" "}
          {data ? hoursOf(intervalMs, data.params.horizonBars) : hoursOf(intervalMs, Math.max(1, Math.round((hours * 3600000) / intervalMs)))}?
        </span>
        <div className="flex items-center gap-2 ml-auto">
          {data && (
            <span className="text-[9px] font-mono text-slate-600">
              {data.nWindows.toLocaleString()} windows · n_eff {data.nEff.toFixed(0)} ·{" "}
              {formatUtcStamp(data.asOf.timestamp).slice(11, 16)} UTC
            </span>
          )}
          <button
            type="button"
            onClick={() => void reload()}
            title="Recompute"
            className="h-6 px-2 text-[9px] font-mono rounded border border-[#1f1f23] bg-[#0a0a0b] text-slate-400 hover:text-emerald-400 hover:border-emerald-500/40 cursor-pointer flex items-center gap-1"
          >
            <RefreshCw size={10} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {error ? (
        <p className="mt-3 text-[11px] text-rose-400 font-mono">{error}</p>
      ) : data ? (
        <div className="mt-3 pt-3 border-t border-[#1f1f23] grid grid-cols-3 gap-4">
          {(
            [
              ["UP +" + data.params.thresholdPct + "%", data.everTouch.up.p, data.everTouch.up.ci95, CLASS_COLORS.extension],
              ["DOWN −" + data.params.thresholdPct + "%", data.everTouch.down.p, data.everTouch.down.ci95, CLASS_COLORS.collapse],
              ["EITHER WAY", data.everTouch.either.p, data.everTouch.either.ci95, "#38bdf8"],
            ] as const
          ).map(([label, value, ci95, color]) => (
            <div key={label} className="min-w-0">
              <div className="text-[9px] font-mono uppercase tracking-wider" style={{ color }}>
                {label}
              </div>
              <div className="text-xl font-mono font-bold leading-tight mt-0.5" style={{ color }}>
                {fmtPct(value)}
              </div>
              <div className="text-[9px] font-mono text-slate-500">
                [{fmtCi(ci95[0])}–{fmtCi(ci95[1])}]
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3 pt-3 border-t border-[#1f1f23] text-[11px] font-mono text-slate-500">
          Computing from the live tape...
        </div>
      )}
    </div>
  );
}

function MiniTable({ headers, rows }: { headers: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto custom-scrollbar">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-[#1f1f23]">
            {headers.map((h) => (
              <th
                key={h}
                className="py-2 px-2 text-[9px] font-mono text-slate-500 uppercase tracking-wider font-bold whitespace-nowrap text-left"
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
                <td
                  key={j}
                  className="py-1.5 px-2 font-mono text-[10px] text-slate-300 whitespace-nowrap"
                >
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