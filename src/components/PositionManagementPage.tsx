/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Position Management tab (position_analyst_spec.md).
 *
 * Replaces the old Event Probability page. The operator enters a position
 * (side, entry, TP, SL, size, leverage, open time, horizon) and the page POSTs
 * it to /api/position, which returns the four analytical layers plus the
 * position header, order book, open interest, funding, flow and data-health
 * cards. Auto-refreshes every 60s and persists the form per symbol.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Info,
  Play,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { PositionAlert, PositionAnalysisResponse, PositionInput, PositionSide } from "../types";
import { formatUtcStamp } from "../utils/dates";
import { EmptyState, TerminalPanel } from "./terminal/TerminalCharts";

/* --------------------------------------------------------------------------- *
 * Formatting helpers.
 * ------------------------------------------------------------------------- */

function isNum(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

function fmtPrice(v: number | null | undefined): string {
  if (!isNum(v)) return "—";
  const a = Math.abs(v);
  const digits = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtUsd(v: number | null | undefined): string {
  if (!isNum(v)) return "—";
  // Sign before the symbol ($-0.05, not $-0) and decimals for small notionals.
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (a === 0) return "$0.00";
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  if (a >= 1) return `${sign}$${a.toFixed(2)}`;
  if (a >= 0.01) return `${sign}$${a.toFixed(3)}`;
  return `${sign}$${a.toFixed(6)}`;
}

/** Local-time stamp; always carries an explicit zone label (P6). */
function fmtLocalStamp(t: number | null | undefined): string {
  if (!isNum(t)) return "—";
  return `${new Date(t).toLocaleString()} (local)`;
}

/** Both clocks for one instant so the local input and UTC timeout agree. */
function fmtTimeBoth(t: number | null | undefined): string {
  if (!isNum(t)) return "—";
  return `${formatUtcStamp(t)} · ${new Date(t).toLocaleString()} local`;
}

function marketLabel(marketType: string | undefined): string {
  return marketType === "spot" ? "SPOT" : marketType === "perp" ? "PERP" : "—";
}

function fmtPct(v: number | null | undefined, digits = 2): string {
  if (!isNum(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

function fmtSignedPct(v: number | null | undefined, digits = 2): string {
  if (!isNum(v)) return "—";
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;
}

function fmtNum(v: number | null | undefined, digits = 2): string {
  if (!isNum(v)) return "—";
  return v.toFixed(digits);
}

function toneForClass(cls: string): string {
  if (/idiosyncratic|leveraged|driver_explained/.test(cls)) return "text-amber-300";
  if (/squeeze|unwind|beta|covering/.test(cls)) return "text-emerald-300";
  return "text-slate-300";
}

/** Minutes per base interval, for the kline staleness label (P6). */
const INTERVAL_MINUTES: Record<string, number> = {
  "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "2h": 120, "4h": 240, "6h": 360, "12h": 720, "1d": 1440,
};

/**
 * Lag since the newest CLOSED bar. Binance bar times are open times, so a live
 * tape sits between one and two bar lengths behind `now`; within two bars the
 * newest closed bar is present, shown as `≤ 1 bar` (P6).
 */
function fmtLag(lagMinutes: number | null | undefined, interval: string): string {
  if (!isNum(lagMinutes)) return "—";
  const bar = INTERVAL_MINUTES[interval] ?? 0;
  if (bar > 0 && lagMinutes <= 2 * bar + 1e-6) return "≤ 1 bar";
  return `${fmtNum(lagMinutes, 1)}m`;
}

/** Human-readable move class (P4); falls back to the raw code. */
const CLASS_LABEL: Record<string, string> = {
  unexplained: "UNEXPLAINED",
  driver_explained: "DRIVER-EXPLAINED",
  explained_informed: "EXPLAINED (INFORMED)",
  explained_forced: "EXPLAINED (FORCED)",
  liquidity_vacuum: "LIQUIDITY VACUUM",
};

function classLabel(cls: string): string {
  return CLASS_LABEL[cls] ?? cls.replace(/_/g, " ").toUpperCase();
}

const ALERT_STYLE: Record<PositionAlert["severity"], string> = {
  info: "text-sky-200 border-sky-500/40 bg-sky-500/10",
  warning: "text-amber-200 border-amber-500/40 bg-amber-500/10",
  critical: "text-rose-200 border-rose-500/50 bg-rose-500/10",
};

/** P1/P5 alert banner, rendered above the card reasons. */
function AlertList({ alerts }: { alerts: PositionAlert[] | null | undefined }) {
  if (!alerts || !alerts.length) return null;
  return (
    <div className="space-y-1.5 mb-3">
      {alerts.map((a, i) => (
        <div key={`${a.code}-${i}`} className={`text-[10px] font-mono border rounded px-3 py-1.5 flex items-center gap-2 ${ALERT_STYLE[a.severity]}`}>
          <AlertTriangle size={11} />
          <span className="font-bold tracking-wide">{a.code}</span>
          <span className="opacity-90">{a.message}</span>
        </div>
      ))}
    </div>
  );
}

/** Every card must name its market and venues (general rule P0). */
function Provenance({ marketType, venues }: { marketType: string; venues: (string | null | undefined)[] }) {
  const list = Array.from(new Set(venues.filter((v): v is string => !!v)));
  return (
    <div className="text-[9px] font-mono text-slate-500 mb-3">
      market <span className="text-slate-400">{marketType.toUpperCase()}</span> · {list.length ? `venues ${list.join(", ")}` : "venues unavailable"}
    </div>
  );
}

const VERDICT_STYLE: Record<string, string> = {
  FAVORABLE: "text-emerald-400 border-emerald-500/40 bg-emerald-500/10",
  NEUTRAL: "text-sky-300 border-sky-500/40 bg-sky-500/10",
  ADVERSE: "text-rose-400 border-rose-500/40 bg-rose-500/10",
  NO_EDGE: "text-amber-400 border-amber-500/40 bg-amber-500/10",
  INSUFFICIENT: "text-slate-400 border-[#1f1f23] bg-[#0a0a0b]",
};

const STATUS_STYLE: Record<string, string> = {
  ok: "text-emerald-400 border-emerald-500/30 bg-emerald-500/5",
  manual: "text-sky-300 border-sky-500/30 bg-sky-500/5",
  stale: "text-amber-400 border-amber-500/30 bg-amber-500/5",
  failed: "text-rose-400 border-rose-500/30 bg-rose-500/5",
  unavailable: "text-slate-500 border-[#1f1f23] bg-[#0a0a0b]",
};

function FieldBadge({ status }: { status: string }) {
  return (
    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border uppercase ${STATUS_STYLE[status] ?? STATUS_STYLE.unavailable}`}>
      {status}
    </span>
  );
}

function Row({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 border-b border-[#161618] last:border-0">
      <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wide">{label}</span>
      <span className="text-right">
        <span className={`text-xs font-mono ${tone ?? "text-slate-200"}`}>{value}</span>
        {sub && <span className="block text-[9px] font-mono text-slate-600">{sub}</span>}
      </span>
    </div>
  );
}

/* --------------------------------------------------------------------------- *
 * Form model.
 * --------------------------------------------------------------------------- */

interface FormState {
  side: PositionSide;
  entry: string;
  takeProfit: string;
  stopLoss: string;
  size: string;
  leverage: string;
  /** "" = auto (perp when the symbol exists on perp), else force spot/perp. */
  marketType: "" | "perp" | "spot";
  openedAt: string;
  horizonHours: string;
  feeBpsOneSide: string;
  slippageBps: string;
  manualMark: string;
  manualVol24: string;
  manualOi: string;
  manualMcap: string;
  manualSigma: string;
  locks: string[];
}

const STORAGE_KEY = "quant_position_input_v1";

function defaultForm(): FormState {
  return {
    side: "long",
    entry: "",
    takeProfit: "",
    stopLoss: "",
    size: "",
    leverage: "",
    marketType: "",
    openedAt: "",
    horizonHours: "12",
    feeBpsOneSide: "5",
    slippageBps: "0",
    manualMark: "",
    manualVol24: "",
    manualOi: "",
    manualMcap: "",
    manualSigma: "",
    locks: [],
  };
}

function loadStored(symbol: string): FormState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultForm();
    const all = JSON.parse(raw) as Record<string, FormState>;
    return { ...defaultForm(), ...(all[symbol] ?? {}) };
  } catch {
    return defaultForm();
  }
}

function persist(symbol: string, form: FormState) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, FormState>) : {};
    all[symbol] = form;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* ignore quota / privacy-mode failures */
  }
}

function numOrUndefined(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function toInput(symbol: string, form: FormState): PositionInput | null {
  const entry = numOrUndefined(form.entry);
  if (entry == null || entry <= 0) return null;
  const openedAt = form.openedAt ? Date.parse(form.openedAt) : null;
  return {
    symbol,
    side: form.side,
    entry,
    takeProfit: numOrUndefined(form.takeProfit),
    stopLoss: numOrUndefined(form.stopLoss),
    size: numOrUndefined(form.size),
    leverage: numOrUndefined(form.leverage),
    marketType: form.marketType === "" ? undefined : form.marketType,
    openedAt: openedAt != null && Number.isFinite(openedAt) ? openedAt : null,
    horizonHours: numOrUndefined(form.horizonHours) ?? 12,
    feeBpsOneSide: numOrUndefined(form.feeBpsOneSide) ?? 5,
    slippageBps: numOrUndefined(form.slippageBps) ?? 0,
  };
}

interface ManualBody {
  markPrice: number | null;
  vol24Usd: number | null;
  oiUsd: number | null;
  mcapUsd: number | null;
  sigmaDay: number | null;
  locks: string[];
}

type PositionRequestBody = PositionInput & { manual: ManualBody };

function toManual(form: FormState): ManualBody {
  return {
    markPrice: numOrUndefined(form.manualMark),
    vol24Usd: numOrUndefined(form.manualVol24),
    oiUsd: numOrUndefined(form.manualOi),
    mcapUsd: numOrUndefined(form.manualMcap),
    sigmaDay: numOrUndefined(form.manualSigma),
    locks: form.locks,
  };
}

function toRequest(symbol: string, form: FormState): PositionRequestBody | null {
  const input = toInput(symbol, form);
  if (!input) return null;
  return { ...input, manual: toManual(form) };
}

const INPUT_CLS =
  "w-full bg-[#0a0a0b] border border-[#1f1f23] rounded px-2 py-1.5 text-[11px] font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50";

/** Health-card fields the operator can supply by hand when a feed fails. */
const MANUAL_FIELDS: Record<string, { field: keyof FormState; lock: string; hint: string }> = {
  mark: { field: "manualMark", lock: "mark", hint: "price" },
  oi: { field: "manualOi", lock: "oi", hint: "USD" },
  vol24: { field: "manualVol24", lock: "vol24", hint: "USD" },
  mcap: { field: "manualMcap", lock: "mcap", hint: "USD" },
  sigma: { field: "manualSigma", lock: "sigma", hint: "σ/day e.g. 0.04" },
};

/* --------------------------------------------------------------------------- *
 * Small inline charts (no text inside stretched SVGs).
 * --------------------------------------------------------------------------- */

function DepthCurve({ cumulative, markers }: { cumulative: { price: number; cumBidUsd: number; cumAskUsd: number }[]; markers: { price: number; label: string; color: string }[] }) {
  if (cumulative.length < 2) return <EmptyState message="No order-book depth to plot." />;
  const prices = cumulative.map((c) => c.price);
  const maxUsd = Math.max(...cumulative.map((c) => Math.max(c.cumBidUsd, c.cumAskUsd)), 1);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const x = (p: number) => ((p - minP) / (maxP - minP || 1)) * 720;
  const y = (u: number) => 180 - (u / maxUsd) * 170;
  const bidPath = cumulative.map((c) => `${x(c.price).toFixed(1)},${y(c.cumBidUsd).toFixed(1)}`).join(" ");
  const askPath = cumulative.map((c) => `${x(c.price).toFixed(1)},${y(c.cumAskUsd).toFixed(1)}`).join(" ");

  return (
    <div>
      <svg viewBox="0 0 720 190" preserveAspectRatio="none" className="w-full h-[190px]">
        <polyline points={bidPath} fill="none" stroke="#34d399" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        <polyline points={askPath} fill="none" stroke="#f87171" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        {markers.map(
          (m) =>
            m.price >= minP &&
            m.price <= maxP && (
              <line
                key={m.label}
                x1={x(m.price)}
                x2={x(m.price)}
                y1={6}
                y2={184}
                stroke={m.color}
                strokeDasharray="4 3"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            )
        )}
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[9px] font-mono text-slate-500 border-t border-[#1f1f23] pt-2 mt-1">
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-[2px] bg-emerald-400" /> Cumulative bids</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-[2px] bg-rose-400" /> Cumulative asks</span>
        {markers.map((m) => (
          <span key={m.label} className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-[2px]" style={{ background: m.color }} /> {m.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function CvdSpark({ series }: { series: { t: number; value: number }[] }) {
  if (series.length < 2) return <EmptyState message="No taker-delta history." />;
  const vals = series.map((s) => s.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const x = (i: number) => (i / (series.length - 1)) * 720;
  const y = (v: number) => 120 - ((v - min) / (max - min || 1)) * 110;
  const path = series.map((s, i) => `${x(i).toFixed(1)},${y(s.value).toFixed(1)}`).join(" ");
  const zeroY = y(0);
  return (
    <div>
      <svg viewBox="0 0 720 130" preserveAspectRatio="none" className="w-full h-[110px]">
        {min < 0 && max > 0 && (
          <line x1={0} x2={720} y1={zeroY} y2={zeroY} stroke="#2f2f35" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        )}
        <polyline points={path} fill="none" stroke="#60a5fa" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between text-[9px] font-mono text-slate-500 border-t border-[#1f1f23] pt-1.5">
        <span>7d cumulative taker delta (base)</span>
        <span className={vals[vals.length - 1] >= 0 ? "text-emerald-400" : "text-rose-400"}>
          {fmtNum(vals[vals.length - 1], 0)}
        </span>
      </div>
    </div>
  );
}

function LiqSeriesBars({ series }: { series: { t: number; longNotional: number; shortNotional: number }[] }) {
  if (series.length === 0) return <EmptyState message="No liquidation tape for this symbol." />;
  const max = Math.max(...series.map((b) => Math.max(b.longNotional, b.shortNotional)), 1);
  return (
    <div className="flex items-end gap-[3px] h-[110px]">
      {series.map((b, i) => (
        <div key={i} className="flex-1 flex flex-col justify-end gap-[2px]" title={`${fmtUsd(b.longNotional)} long · ${fmtUsd(b.shortNotional)} short`}>
          <div className="w-full bg-rose-500/70 rounded-sm" style={{ height: `${(b.shortNotional / max) * 100}%` }} />
          <div className="w-full bg-emerald-500/70 rounded-sm" style={{ height: `${(b.longNotional / max) * 100}%` }} />
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------------- *
 * Levels ladder (vertical, HTML list so labels stay legible).
 * --------------------------------------------------------------------------- */

function LevelLadder({
  rows,
  mark,
  entry,
  tp,
  sl,
  side,
}: {
  rows: PositionAnalysisResponse["levels"]["ladder"];
  mark: number | null;
  entry: number;
  tp: number | null;
  sl: number | null;
  side: PositionSide;
}) {
  if (!isNum(mark) || rows.length === 0) return <EmptyState message="No level profile available." />;

  const lo = mark * 0.9;
  const hi = mark * 1.1;
  const visible = rows.filter((r) => r.price >= lo && r.price <= hi);
  const step = Math.max(1, Math.floor(visible.length / 48));
  const sampled = visible.filter((_, i) => i % step === 0);
  const maxUsd = Math.max(...sampled.map((r) => r.totalUsd), 1);
  const maxLiq = Math.max(...sampled.map((r) => Math.max(r.liqLongUsd, r.liqShortUsd)), 1);

  const markers = [
    { price: entry, label: "Entry", color: "#eab308" },
    { price: mark, label: "Mark", color: "#e5e7eb" },
    ...(tp != null ? [{ price: tp, label: "TP", color: "#34d399" }] : []),
    ...(sl != null ? [{ price: sl, label: "SL", color: "#f87171" }] : []),
  ].filter((m) => isNum(m.price));

  return (
    <div>
      <div className="flex items-center gap-4 text-[9px] font-mono text-slate-500 mb-2">
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-2 bg-emerald-500/60" /> Support (resting demand)</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-2 bg-rose-500/60" /> Resistance (resting supply)</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-2 bg-amber-500/60" /> Modelled liq cluster</span>
        <span className="text-slate-600">position: {side.toUpperCase()}</span>
      </div>
      <div className="max-h-[420px] overflow-y-auto custom-scrollbar pr-1">
        {sampled.map((r, i) => {
          const nearMarker = markers.filter((m) => Math.abs(m.price - r.price) / mark < 0.004);
          return (
            <div key={i} className="grid grid-cols-[92px_1fr_1fr] items-center gap-2 py-[1px]">
              <span className="text-[10px] font-mono text-slate-500 text-right">{fmtPrice(r.price)}</span>
              <div className="flex">
                <div className="flex-1 flex justify-end">
                  <div className="h-2.5 bg-emerald-500/60" style={{ width: `${(r.supportUsd / maxUsd) * 100}%` }} />
                </div>
                <div className="w-px bg-[#1f1f23]" />
                <div className="flex-1">
                  <div className="h-2.5 bg-rose-500/60" style={{ width: `${(r.resistanceUsd / maxUsd) * 100}%` }} />
                </div>
              </div>
              <div className="flex items-center gap-1">
                {r.liqLongUsd > 0 && <div className="h-2 bg-amber-500/60" style={{ width: `${(r.liqLongUsd / maxLiq) * 100}%` }} />}
                {r.liqShortUsd > 0 && <div className="h-2 bg-amber-500/40" style={{ width: `${(r.liqShortUsd / maxLiq) * 100}%` }} />}
                {nearMarker.map((m) => (
                  <span key={m.label} className="text-[8px] font-mono px-1 rounded" style={{ color: m.color, border: `1px solid ${m.color}55` }}>
                    {m.label}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------- *
 * Page.
 * --------------------------------------------------------------------------- */

export default function PositionManagementPage({
  symbol,
  name,
}: {
  symbol: string;
  benchmark: string;
  name: string;
}) {
  const [form, setForm] = useState<FormState>(() => loadStored(symbol));
  const [data, setData] = useState<PositionAnalysisResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const submittedRef = useRef<PositionRequestBody | null>(null);

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const toggleLock = (key: string) =>
    setForm((prev) => ({
      ...prev,
      locks: prev.locks.includes(key) ? prev.locks.filter((k) => k !== key) : [...prev.locks, key],
    }));

  useEffect(() => {
    setForm(loadStored(symbol));
    setData(null);
    submittedRef.current = null;
  }, [symbol]);

  const analyse = useCallback(async (req: PositionRequestBody) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/position", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Position analysis failed (${res.status}).`);
      }
      setData((await res.json()) as PositionAnalysisResponse);
    } catch (err: any) {
      setError(err.message || "Position analysis failed.");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSubmit = () => {
    const req = toRequest(symbol, form);
    if (!req) {
      setError("A positive entry price is required.");
      return;
    }
    submittedRef.current = req;
    persist(symbol, form);
    void analyse(req);
  };

  const handleUseMark = async () => {
    try {
      const res = await fetch(`/api/position/mark?symbol=${encodeURIComponent(symbol)}`);
      if (!res.ok) return;
      const payload = await res.json();
      if (isNum(payload.mark)) setField("entry", String(payload.mark));
    } catch {
      /* ignore */
    }
  };

  // Auto-refresh the last submitted position every 60s.
  useEffect(() => {
    if (!autoRefresh || !submittedRef.current) return;
    const id = setInterval(() => {
      if (submittedRef.current) void analyse(submittedRef.current);
    }, 60000);
    return () => clearInterval(id);
  }, [autoRefresh, analyse]);

  const marks = useMemo(() => {
    if (!data) return [];
    return [
      { price: data.header.entry, label: "Entry", color: "#eab308" },
      ...(isNum(data.header.takeProfit) ? [{ price: data.header.takeProfit as number, label: "TP", color: "#34d399" }] : []),
      ...(isNum(data.header.stopLoss) ? [{ price: data.header.stopLoss as number, label: "SL", color: "#f87171" }] : []),
    ];
  }, [data]);

  if (!symbol) return <EmptyState message="Select an asset to manage a position." />;

  return (
    <div className="space-y-6">
      {/* Position input strip */}
      <TerminalPanel
        id="position-input"
        eyebrow="Position Management"
        title={`${name} · ${symbol}`}
        subtitle="Enter the position to analyse. The engine reads Binance klines, order book, open interest and funding; unsupported multi-venue fields are marked unavailable rather than guessed."
        right={
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[10px] font-mono text-slate-500 cursor-pointer">
              <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} className="accent-emerald-500" />
              auto 60s
            </label>
            <button
              onClick={handleSubmit}
              disabled={loading}
              className="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-white text-[11px] font-mono font-semibold rounded flex items-center gap-1.5 cursor-pointer"
            >
              {loading ? <RefreshCw size={12} className="animate-spin" /> : <Play size={12} />}
              Analyse
            </button>
          </div>
        }
      >
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[9px] font-mono text-slate-500 uppercase">Side</span>
            <div className="flex gap-1">
              {(["long", "short"] as PositionSide[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setField("side", s)}
                  className={`flex-1 py-1.5 text-[11px] font-mono rounded border cursor-pointer ${
                    form.side === s
                      ? s === "long"
                        ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-300"
                        : "bg-rose-500/15 border-rose-500/50 text-rose-300"
                      : "bg-[#0a0a0b] border-[#1f1f23] text-slate-500"
                  }`}
                >
                  {s === "long" ? "LONG" : "SHORT"}
                </button>
              ))}
            </div>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[9px] font-mono text-slate-500 uppercase flex items-center justify-between">
              Entry <button onClick={handleUseMark} className="text-emerald-400 hover:text-emerald-300 normal-case cursor-pointer">use mark</button>
            </span>
            <input value={form.entry} onChange={(e) => setField("entry", e.target.value)} placeholder="0.00" className={INPUT_CLS} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[9px] font-mono text-slate-500 uppercase">Take profit</span>
            <input value={form.takeProfit} onChange={(e) => setField("takeProfit", e.target.value)} placeholder="optional" className={INPUT_CLS} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[9px] font-mono text-slate-500 uppercase">Stop loss</span>
            <input value={form.stopLoss} onChange={(e) => setField("stopLoss", e.target.value)} placeholder="optional" className={INPUT_CLS} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[9px] font-mono text-slate-500 uppercase">Size (base)</span>
            <input value={form.size} onChange={(e) => setField("size", e.target.value)} placeholder="optional" className={INPUT_CLS} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[9px] font-mono text-slate-500 uppercase">Leverage</span>
            <input value={form.leverage} onChange={(e) => setField("leverage", e.target.value)} placeholder="e.g. 10" className={INPUT_CLS} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[9px] font-mono text-slate-500 uppercase">Opened at (local)</span>
            <input type="datetime-local" value={form.openedAt} onChange={(e) => setField("openedAt", e.target.value)} className={INPUT_CLS} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[9px] font-mono text-slate-500 uppercase">Horizon (h)</span>
            <input value={form.horizonHours} onChange={(e) => setField("horizonHours", e.target.value)} className={INPUT_CLS} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[9px] font-mono text-slate-500 uppercase">Fee / side (bps)</span>
            <input value={form.feeBpsOneSide} onChange={(e) => setField("feeBpsOneSide", e.target.value)} className={INPUT_CLS} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[9px] font-mono text-slate-500 uppercase">Slippage (bps)</span>
            <input value={form.slippageBps} onChange={(e) => setField("slippageBps", e.target.value)} className={INPUT_CLS} />
          </label>
        </div>
        {error && (
          <div className="mt-3 text-[10px] font-mono text-rose-300 border border-rose-500/30 bg-rose-500/5 rounded px-3 py-2 flex items-center gap-2">
            <AlertTriangle size={12} /> {error}
          </div>
        )}
      </TerminalPanel>

      {!data ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 border border-[#1f1f23] border-dashed rounded-xl bg-[#0a0a0b]/40">
          {loading ? (
            <>
              <RefreshCw size={22} className="animate-spin text-emerald-400" />
              <span className="text-xs font-mono text-slate-500 uppercase tracking-widest">Running position analysis…</span>
            </>
          ) : (
            <>
              <ShieldAlert size={22} className="text-slate-600" />
              <span className="text-xs font-mono text-slate-500">Enter a position and press Analyse.</span>
            </>
          )}
        </div>
      ) : (
        <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
          {(data.warnings.length > 0 || data.verdictBlock.degradedInputs.length > 0) && (
            <div className="bg-[#0e0e10] border border-amber-500/20 rounded-xl p-4 space-y-1.5">
              {data.warnings.map((w, i) => (
                <div key={`w${i}`} className="text-[10px] font-mono text-amber-300 flex items-start gap-2">
                  <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {w}
                </div>
              ))}
              {data.verdictBlock.degradedInputs.length > 0 && (
                <div className="text-[10px] font-mono text-amber-400/80 flex items-start gap-2">
                  <Info size={11} className="mt-0.5 shrink-0" /> Degraded inputs: {data.verdictBlock.degradedInputs.join(", ")}
                </div>
              )}
            </div>
          )}

          {/* 1. Position header */}
          <TerminalPanel
            id="position-header"
            eyebrow="Card 1 · Position Header"
            title={`${data.baseAsset} ${data.header.side.toUpperCase()} @ ${fmtPrice(data.header.entry)}`}
            right={
              <span className={`text-[10px] font-mono text-slate-500 ${data.header.expired ? "text-rose-400" : ""}`}>
                {data.header.elapsedHours != null
                  ? `${fmtNum(data.header.elapsedHours, 1)}h elapsed · ${fmtNum(data.header.remainingHours, 1)}h left`
                  : "no open time set"}
              </span>
            }
          >
            <AlertList alerts={data.header.alerts} />
            <Provenance marketType={data.marketType} venues={[data.orderBook.venue, ...data.openInterest.venues.map((v) => v.venue), ...data.funding.venues.map((v) => v.venue)]} />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6">
              <Row label="Mark" value={fmtPrice(data.header.mark)} />
              <Row label="Reference price" value={fmtPrice(data.reachability.referencePrice)} sub={`source: ${data.reachability.referenceSource}`} />
              <Row label="Unrealised PnL" value={fmtUsd(data.header.uPnlUsd)} tone={isNum(data.header.uPnlUsd) ? (data.header.uPnlUsd >= 0 ? "text-emerald-400" : "text-rose-400") : undefined} sub={fmtSignedPct(data.header.uPnlPct)} />
              <Row label="R-multiple" value={isNum(data.header.rMultiple) ? `${data.header.rMultiple.toFixed(2)}R` : "—"} />
              <Row label="Size notional" value={fmtUsd(data.header.sizeUsd)} sub={data.header.leverage ? `${data.header.leverage}× lev` : undefined} />
              <Row label="Take profit" value={fmtPrice(data.header.takeProfit)} sub={isNum(data.header.distanceToTpPct) ? `${fmtPct(data.header.distanceToTpPct)} · ${fmtNum(data.header.distanceToTpSigma, 2)}σ` : undefined} tone="text-emerald-400" />
              <Row label="Stop loss" value={fmtPrice(data.header.stopLoss)} sub={isNum(data.header.distanceToSlPct) ? `${fmtPct(data.header.distanceToSlPct)} · ${fmtNum(data.header.distanceToSlSigma, 2)}σ` : undefined} tone="text-rose-400" />
              <Row label="Timeout" value={data.header.timeoutAt ? formatUtcStamp(data.header.timeoutAt) : "—"} sub={data.header.timeoutAt ? fmtLocalStamp(data.header.timeoutAt) : data.header.expired ? "EXPIRED" : undefined} />
              <Row label="As of" value={formatUtcStamp(data.asOf.timestamp)} sub={`${data.asOf.bars} bars · lag ${fmtLag(data.asOf.lagMinutes, data.interval)}`} />
            </div>
          </TerminalPanel>

          {/* 2. Verdict + 3. Move */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <TerminalPanel id="position-verdict" eyebrow="Card 2 · Verdict & Risk" title="Combined verdict">
              <AlertList alerts={data.verdictBlock.alerts} />
              <Provenance marketType={data.marketType} venues={[data.orderBook.venue, ...data.openInterest.venues.map((v) => v.venue), ...data.funding.venues.map((v) => v.venue)]} />
              <div className="flex items-center gap-3 mb-2">
                <span className={`text-sm font-mono font-bold px-3 py-1.5 rounded border ${VERDICT_STYLE[data.verdictBlock.verdict]}`}>
                  {data.verdictBlock.verdict}
                </span>
                <div className="flex-1">
                  <div className="flex justify-between text-[9px] font-mono text-slate-500 mb-1">
                    <span>Data confidence</span>
                    <span>{data.verdictBlock.confidence}%</span>
                  </div>
                  <div className="h-1.5 bg-[#0a0a0b] rounded overflow-hidden border border-[#1f1f23]">
                    <div
                      className={`h-full ${data.verdictBlock.confidence >= 70 ? "bg-emerald-500" : data.verdictBlock.confidence >= 40 ? "bg-amber-500" : "bg-rose-500"}`}
                      style={{ width: `${data.verdictBlock.confidence}%` }}
                    />
                  </div>
                </div>
              </div>
              {(data.verdictBlock.confidenceReasons?.length ?? 0) > 0 && (
                <div className="mb-4 rounded border border-[#1f1f23] bg-[#0a0a0b] px-3 py-2">
                  <span className="text-[9px] font-mono text-slate-500 uppercase tracking-wide block mb-1">Confidence reasons (−{100 - data.verdictBlock.confidence} pts)</span>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                    {(data.verdictBlock.confidenceReasons ?? []).map((r, i) => (
                      <span key={i} className="text-[9px] font-mono text-amber-300/80">{r.label} −{r.penalty}</span>
                    ))}
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="bg-[#0a0a0b] border border-[#1f1f23] rounded p-3">
                  <span className="text-[9px] font-mono text-slate-500 uppercase block">EV (lower bound)</span>
                  <span className={`text-sm font-mono ${isNum(data.verdictBlock.evLower) && data.verdictBlock.evLower > 0 ? "text-emerald-400" : "text-rose-400"}`}>
                    {fmtSignedPct(data.verdictBlock.evLower)}
                  </span>
                </div>
                <div className="bg-[#0a0a0b] border border-[#1f1f23] rounded p-3">
                  <span className="text-[9px] font-mono text-slate-500 uppercase block">Suggested size (capped)</span>
                  <span className="text-sm font-mono text-slate-200">{fmtPct(data.verdictBlock.suggestedFraction, 2)} of equity</span>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <span className="text-[9px] font-mono text-emerald-400 uppercase tracking-wide flex items-center gap-1 mb-1"><CheckCircle2 size={11} /> Reasons for</span>
                  <ul className="space-y-1">
                    {(data.verdictBlock.reasonsFor.length ? data.verdictBlock.reasonsFor : ["—"]).map((r, i) => (
                      <li key={i} className="text-[10px] font-mono text-slate-400 leading-snug">• {r}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <span className="text-[9px] font-mono text-rose-400 uppercase tracking-wide flex items-center gap-1 mb-1"><XCircle size={11} /> Reasons against</span>
                  <ul className="space-y-1">
                    {(data.verdictBlock.reasonsAgainst.length ? data.verdictBlock.reasonsAgainst : ["—"]).map((r, i) => (
                      <li key={i} className="text-[10px] font-mono text-slate-400 leading-snug">• {r}</li>
                    ))}
                  </ul>
                </div>
              </div>
              {(data.verdictBlock.notes?.length ?? 0) > 0 && (
                <div className="mt-4">
                  <span className="text-[9px] font-mono text-slate-400 uppercase tracking-wide">Book notes</span>
                  <ul className="mt-1 space-y-1">
                    {data.verdictBlock.notes.map((r, i) => (
                      <li key={i} className="text-[10px] font-mono text-slate-400 leading-snug">• {r}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="mt-4">
                <span className="text-[9px] font-mono text-amber-400 uppercase tracking-wide">Invalidation</span>
                <ul className="mt-1 space-y-1">
                  {data.verdictBlock.invalidation.map((r, i) => (
                    <li key={i} className="text-[10px] font-mono text-slate-500 leading-snug">• {r}</li>
                  ))}
                </ul>
              </div>
            </TerminalPanel>

            <TerminalPanel
              id="position-move"
              eyebrow="Card 3 · Move Anomaly (L1)"
              title={data.move.label}
              right={<span className={`text-[11px] font-mono ${toneForClass(data.move.class)}`}>{classLabel(data.move.class)}</span>}
            >
              <Provenance marketType={data.marketType} venues={[data.orderBook.venue, ...data.openInterest.venues.map((v) => v.venue)]} />
              <div className="grid grid-cols-3 gap-3 mb-3">
                <div className="bg-[#0a0a0b] border border-[#1f1f23] rounded p-2.5 text-center">
                  <span className="text-[9px] font-mono text-slate-500 block">z_raw</span>
                  <span className="text-sm font-mono text-slate-200">{fmtNum(data.move.zRaw, 2)}</span>
                </div>
                <div className="bg-[#0a0a0b] border border-[#1f1f23] rounded p-2.5 text-center">
                  <span className="text-[9px] font-mono text-slate-500 block">z_res</span>
                  <span className="text-sm font-mono text-slate-200">{fmtNum(data.move.zRes, 2)}</span>
                </div>
                <div className="bg-[#0a0a0b] border border-[#1f1f23] rounded p-2.5 text-center">
                  <span className="text-[9px] font-mono text-slate-500 block">percentile</span>
                  <span className="text-sm font-mono text-slate-200">{fmtPct(data.move.percentile, 0)}</span>
                </div>
              </div>
              <p className="text-[10px] font-mono text-slate-400 leading-relaxed mb-3">{data.move.interpretation}</p>
              <Row label="Quadrant" value={data.move.quadrant} />
              <Row
                label="Move"
                value={`${fmtSignedPct(data.move.moveReturn)} / ${data.move.moveBars} bars`}
                sub={isNum(data.move.moveStartTime) && isNum(data.move.moveEndTime) ? `${formatUtcStamp(data.move.moveStartTime)} → ${formatUtcStamp(data.move.moveEndTime)} (UTC)` : undefined}
              />
              <Row label="BTC R² (explained)" value={fmtNum(data.move.r2, 3)} />
              <Row label="Breadth" value={data.move.breadth != null ? fmtNum(data.move.breadth, 2) : "unavailable (layer ran degraded)"} />
              <div className="mt-3">
                <span className="text-[9px] font-mono text-slate-500 uppercase block mb-1.5">Attribution</span>
                <div className="space-y-1">
                  {data.move.drivers.map((d) => {
                    const z = d.z;
                    const width = z == null ? 0 : Math.min(100, Math.abs(z) / 3 * 100);
                    return (
                      <div key={d.key} className="grid grid-cols-[110px_1fr_44px] items-center gap-2" title={d.note}>
                        <span className="text-[9px] font-mono text-slate-500 truncate">{d.label}</span>
                        <div className="h-2 bg-[#0a0a0b] rounded border border-[#1f1f23] overflow-hidden flex">
                          <div className="w-1/2 flex justify-end">
                            {z != null && z < 0 && <div className="h-full bg-rose-500/70" style={{ width: `${width}%` }} />}
                          </div>
                          <div className="w-1/2">
                            {z != null && z >= 0 && <div className="h-full bg-emerald-500/70" style={{ width: `${width}%` }} />}
                          </div>
                        </div>
                        <span className="text-[9px] font-mono text-slate-400 text-right">{z == null ? "n/a" : z.toFixed(2)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
              {data.move.forward && (
                <div className="mt-3 text-[10px] font-mono text-slate-400 border-t border-[#1f1f23] pt-2">
                  <div className="text-slate-500 mb-1">
                    Forward {fmtNum(data.move.forward.horizonHours, 0)}h ({data.move.forward.horizonBars} bars) from now{data.header.expired ? " (re-baselined after expiry)" : ""} after similar moves:
                  </div>
                  P(up) {fmtPct(data.move.forward.pPositive, 0)} · median {fmtSignedPct(data.move.forward.median)} · p10/p90 {fmtSignedPct(data.move.forward.p10)}/{fmtSignedPct(data.move.forward.p90)} · N={data.move.forward.n}
                  {data.move.forward.extra.length > 0 && (
                    <div className="mt-1 text-slate-500">
                      {data.move.forward.extra.map((e) => `${e.bars} bars: P(up) ${fmtPct(e.pPositive, 0)} · median ${fmtSignedPct(e.median)} · N=${e.n}`).join("   |   ")}
                    </div>
                  )}
                </div>
              )}
            </TerminalPanel>
          </div>

          {/* 4. Reachability + 8. Outcome */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <TerminalPanel
              id="position-reach"
              eyebrow="Card 4 · TP/SL Reachability (L2)"
              title={data.reachability.label}
              right={
                <span className="text-[10px] font-mono text-slate-500">
                  forward {fmtNum(data.input.horizonHours, 0)}h from {data.header.expired ? "now (re-baselined)" : "ref"} · ref {fmtPrice(data.reachability.referencePrice)} ({data.reachability.referenceSource})
                </span>
              }
            >
              <Provenance marketType={data.marketType} venues={[data.orderBook.venue, ...data.openInterest.venues.map((v) => v.venue)]} />
              <div className="grid grid-cols-2 gap-x-6">
                <Row label="d_tp (from ref)" value={fmtPct(data.reachability.dTp)} />
                <Row label="d_sl (from ref)" value={fmtPct(data.reachability.dSl)} />
                <Row label="k_tp (σ_H)" value={fmtNum(data.reachability.kTp, 2)} />
                <Row label="k_sl (σ_H)" value={fmtNum(data.reachability.kSl, 2)} />
                <Row label="P_touch TP" value={fmtPct(data.reachability.pTouchTp, 0)} tone="text-emerald-400" />
                <Row label="P_touch SL" value={fmtPct(data.reachability.pTouchSl, 0)} tone="text-rose-400" />
                <Row label="P(TP first, driftless)" value={fmtPct(data.reachability.pTpFirstDriftless, 0)} />
                <Row label="σ_H statistical" value={fmtPct(data.reachability.sigmaH)} />
                <Row label="σ_H empirical" value={fmtPct(data.reachability.sigmaHEmpirical)} sub={isNum(data.reachability.sigmaDivergence) ? `${fmtSignedPct(data.reachability.sigmaDivergence)} vs statistical` : undefined} />
                <Row label="Volatility baseline (per bar)" value={fmtPct(data.reachability.sigmaBaselinePct)} sub="MAD × 1.4826" />
                <Row
                  label="ATR (per bar)"
                  value={fmtPct(data.reachability.atrPct)}
                  tone={isNum(data.reachability.atrPct) && isNum(data.reachability.sigmaBaselinePct) && data.reachability.sigmaBaselinePct > 0 && data.reachability.atrPct / data.reachability.sigmaBaselinePct > 3 ? "text-amber-300" : undefined}
                  sub={isNum(data.reachability.atrPct) && isNum(data.reachability.sigmaBaselinePct) && data.reachability.sigmaBaselinePct > 0 ? `ratio ${fmtNum(data.reachability.atrPct / data.reachability.sigmaBaselinePct, 2)}× baseline${data.reachability.atrPct / data.reachability.sigmaBaselinePct > 3 ? " ⚠ >3×" : ""}` : undefined}
                />
                <Row label="TP in liq cluster" value={data.reachability.tpInCluster != null ? (data.reachability.tpInCluster ? "yes" : "no") : "unavailable"} />
                <Row label="SL exposed to cluster" value={data.reachability.slExposed != null ? (data.reachability.slExposed ? "yes" : "no") : "unavailable"} />
              </div>
              <p className="text-[10px] font-mono text-slate-400 leading-relaxed mt-2">{data.reachability.interpretation}</p>
              <details className="mt-3 border-t border-[#1f1f23] pt-2">
                <summary className="text-[9px] font-mono text-slate-500 uppercase tracking-wide cursor-pointer">Trade quality (from entry)</summary>
                <div className="grid grid-cols-2 gap-x-6 mt-2">
                  <Row label="k_tp (entry)" value={fmtNum(data.reachability.tradeQuality.entryKTp, 2)} />
                  <Row label="k_sl (entry)" value={fmtNum(data.reachability.tradeQuality.entryKSl, 2)} />
                  <Row label="d_tp (entry)" value={fmtPct(data.reachability.tradeQuality.entryDTp)} />
                  <Row label="d_sl (entry)" value={fmtPct(data.reachability.tradeQuality.entryDSl)} />
                  <Row label="P_touch TP (entry)" value={fmtPct(data.reachability.tradeQuality.entryPTouchTp, 0)} tone="text-emerald-400" />
                  <Row label="P_touch SL (entry)" value={fmtPct(data.reachability.tradeQuality.entryPTouchSl, 0)} tone="text-rose-400" />
                  <Row label="P(TP first, entry)" value={fmtPct(data.reachability.tradeQuality.entryTpFirstDriftless, 0)} />
                </div>
                <p className="text-[9px] font-mono text-slate-600 mt-2">Measured from the entry (sunk cost). Never fed into the verdict.</p>
              </details>
            </TerminalPanel>

            <TerminalPanel
              id="position-outcome"
              eyebrow="Card 8 · Outcome Distribution"
              title={
                data.outcome.status
                  ? `Barrier crossed (${data.outcome.status}) · probabilities withheld`
                  : `P(TP) ${fmtPct(data.outcome.pTp, 0)} · P(SL) ${fmtPct(data.outcome.pSl, 0)} · P(timeout) ${fmtPct(data.outcome.pTimeout, 0)}`
              }
              right={
                data.outcome.noEdge ? (
                  <span className="text-[10px] font-mono font-bold text-amber-400 border border-amber-500/40 bg-amber-500/10 px-2 py-1 rounded">NO EDGE</span>
                ) : (
                  <span className="text-[10px] font-mono font-bold text-emerald-400 border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 rounded">EDGE</span>
                )
              }
            >
              <Provenance marketType={data.marketType} venues={[data.orderBook.venue]} />
              {data.outcome.status && (
                <div className={`text-[10px] font-mono border rounded px-3 py-1.5 mb-3 flex items-center gap-2 ${ALERT_STYLE.critical}`}>
                  <AlertTriangle size={11} /> <span className="font-bold">{data.outcome.status}</span> the mark has already crossed a barrier; forward probabilities withheld.
                </div>
              )}
              {data.outcome.analog.gate !== "ok" && (
                <div className={`text-[10px] font-mono border rounded px-3 py-1.5 mb-3 flex items-center gap-2 ${ALERT_STYLE.warning}`}>
                  <AlertTriangle size={11} /> <span className="font-bold">INSUFFICIENT EVIDENCE</span> N_eff {data.outcome.nEff} &lt; 30; no probabilities shown.
                </div>
              )}
              <div className="h-6 w-full flex rounded overflow-hidden border border-[#1f1f23] mb-1">
                <div className="bg-emerald-500/70" style={{ width: `${(data.outcome.pTp ?? 0) * 100}%` }} />
                <div className="bg-rose-500/70" style={{ width: `${(data.outcome.pSl ?? 0) * 100}%` }} />
                <div className="bg-slate-600/60" style={{ width: `${(data.outcome.pTimeout ?? 0) * 100}%` }} />
              </div>
              <div className="flex gap-4 text-[9px] font-mono text-slate-500 mb-3">
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-emerald-500/70 rounded-sm" /> TP</span>
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-rose-500/70 rounded-sm" /> SL</span>
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-slate-600/60 rounded-sm" /> Timeout</span>
              </div>
              <div className="grid grid-cols-2 gap-x-6">
                <Row label="TP 95% CI" value={data.outcome.pTpCi ? `[${fmtPct(data.outcome.pTpCi[0], 0)}, ${fmtPct(data.outcome.pTpCi[1], 0)}]` : "unavailable"} sub={isNum(data.outcome.ciWidthTp) ? `width ${fmtPct(data.outcome.ciWidthTp, 0)}` : undefined} />
                <Row label="SL 95% CI" value={data.outcome.pSlCi ? `[${fmtPct(data.outcome.pSlCi[0], 0)}, ${fmtPct(data.outcome.pSlCi[1], 0)}]` : "unavailable"} sub={isNum(data.outcome.ciWidthSl) ? `width ${fmtPct(data.outcome.ciWidthSl, 0)}` : undefined} />
                <Row label="N_raw / N_eff" value={`${data.outcome.nRaw} / ${data.outcome.nEff}`} sub={`CIs use N_eff (analogs ≥ ${data.outcome.analog.minSpacingBars} bars apart)${data.outcome.analog.pooled ? " · pooled fallback" : ""}`} />
                <Row
                  label="Feature distance"
                  value={isNum(data.outcome.analog.featureDistanceMin) && isNum(data.outcome.analog.featureDistanceMax) ? `${fmtNum(data.outcome.analog.featureDistanceMin, 2)} – ${fmtNum(data.outcome.analog.featureDistanceMax, 2)}` : "unavailable"}
                />
                <Row
                  label="Analog date range"
                  value={isNum(data.outcome.analog.dateStart) && isNum(data.outcome.analog.dateEnd) ? `${formatUtcStamp(data.outcome.analog.dateStart)} → ${formatUtcStamp(data.outcome.analog.dateEnd)}` : "unavailable"}
                  sub={data.outcome.analog.allPrecede ? "all analogs precede as-of bar" : "⚠ set includes the as-of bar"}
                  tone={data.outcome.analog.allPrecede ? undefined : "text-amber-300"}
                />
                <Row label="Features used" value={data.outcome.analog.featuresUsed.length ? data.outcome.analog.featuresUsed.join(", ") : "none"} />
                <Row label="Features omitted" value={data.outcome.analog.featuresOmitted.length ? data.outcome.analog.featuresOmitted.join(", ") : "none"} />
                <Row label="Payoff ratio (ref)" value={fmtNum(data.outcome.payoffRatio, 2)} />
                <Row label="EV (from ref)" value={fmtSignedPct(data.outcome.ev)} tone={isNum(data.outcome.ev) && data.outcome.ev > 0 ? "text-emerald-400" : "text-rose-400"} />
                <Row label="EV lower bound" value={fmtSignedPct(data.outcome.evLower)} tone={isNum(data.outcome.evLower) && data.outcome.evLower > 0 ? "text-emerald-400" : "text-rose-400"} />
                <Row label="Median bars to exit" value={isNum(data.outcome.medianBarsToExit) ? data.outcome.medianBarsToExit.toFixed(0) : "—"} />
                <Row label="MFE / MAE (median)" value={`${fmtSignedPct(data.outcome.mfeMedian, 1)} / ${fmtSignedPct(data.outcome.maeMedian, 1)}`} />
              </div>
              <p className="text-[10px] font-mono text-slate-500 mt-3 leading-relaxed">{data.outcome.note}</p>
            </TerminalPanel>
          </div>

          {/* 5. Order book + 10. Flow */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <TerminalPanel
              id="position-book"
              eyebrow="Card 5 · Order Book"
              title={`${data.orderBook.venue} · mid ${fmtPrice(data.orderBook.midPrice)}`}
              right={<span className="text-[10px] font-mono text-slate-500">spread {isNum(data.orderBook.spreadBps) ? `${data.orderBook.spreadBps.toFixed(1)} bps` : "—"}{data.orderBook.ageMs != null ? ` · ${Math.round(data.orderBook.ageMs / 1000)}s old` : ""}</span>}
            >
              <Provenance marketType={data.marketType} venues={[data.orderBook.venue]} />
              <div className="grid grid-cols-3 gap-2 mb-3">
                {data.orderBook.bands.map((b) => (
                  <div key={b.bandBps} className="bg-[#0a0a0b] border border-[#1f1f23] rounded p-2.5">
                    <span className="text-[9px] font-mono text-slate-500 block">±{b.bandBps} bps</span>
                    <div className="flex justify-between text-[10px] font-mono mt-1">
                      <span className="text-emerald-400">{fmtUsd(b.bidUsd)}</span>
                      <span className="text-rose-400">{fmtUsd(b.askUsd)}</span>
                    </div>
                    <div className="text-[9px] font-mono text-slate-500 mt-0.5">imb {fmtNum(b.imbalance, 2)}</div>
                  </div>
                ))}
              </div>
              <DepthCurve cumulative={data.orderBook.cumulative} markers={marks} />
              {data.orderBook.walls.length > 0 && (
                <div className="mt-3">
                  <span className="text-[9px] font-mono text-slate-500 uppercase block mb-1">Persistent walls</span>
                  <div className="space-y-1">
                    {data.orderBook.walls.slice(0, 6).map((w, i) => (
                      <div key={i} className="flex justify-between text-[10px] font-mono">
                        <span className={w.side === "bid" ? "text-emerald-400" : "text-rose-400"}>{w.side.toUpperCase()}</span>
                        <span className="text-slate-400">{fmtPrice(w.price)}</span>
                        <span className="text-slate-500">{fmtUsd(w.sizeUsd)}</span>
                        <span className="text-slate-600">{fmtSignedPct(w.distancePct)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <p className="text-[9px] font-mono text-slate-600 mt-2">{data.orderBook.note}</p>
            </TerminalPanel>

            <TerminalPanel
              id="position-flow"
              eyebrow="Card 10 · Liquidation & Flow Pulse"
              title={`Liquidations ${fmtUsd(data.flow.liqLongUsd + data.flow.liqShortUsd)} (24h)`}
              right={<span className="text-[10px] font-mono text-slate-500">relevant: {data.flow.relevantSide.toUpperCase()}</span>}
            >
              <Provenance marketType={data.marketType} venues={[data.orderBook.venue, ...data.flow.bigTrades.map((t) => t.exchange)]} />
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div className="bg-[#0a0a0b] border border-[#1f1f23] rounded p-2.5">
                  <span className="text-[9px] font-mono text-slate-500 block">Long liqs (forced sells)</span>
                  <span className="text-sm font-mono text-rose-400">{fmtUsd(data.flow.liqLongUsd)}</span>
                </div>
                <div className="bg-[#0a0a0b] border border-[#1f1f23] rounded p-2.5">
                  <span className="text-[9px] font-mono text-slate-500 block">Short liqs (forced buys)</span>
                  <span className="text-sm font-mono text-emerald-400">{fmtUsd(data.flow.liqShortUsd)}</span>
                </div>
              </div>
              <LiqSeriesBars series={data.flow.liqSeries} />
              <div className="mt-3">
                <CvdSpark series={data.flow.cvdSeries} />
              </div>
              {data.flow.bigTrades.length > 0 && (
                <div className="mt-3">
                  <span className="text-[9px] font-mono text-slate-500 uppercase block mb-1">Recent big prints (&gt;$100k)</span>
                  <div className="space-y-1 max-h-28 overflow-y-auto custom-scrollbar">
                    {data.flow.bigTrades.slice(0, 8).map((t, i) => (
                      <div key={i} className="flex justify-between text-[10px] font-mono">
                        <span className={t.side === "long" ? "text-rose-400" : "text-emerald-400"}>{t.side === "long" ? "LONG liq" : "SHORT liq"}</span>
                        <span className="text-slate-400">{fmtPrice(t.price)}</span>
                        <span className="text-slate-500">{fmtUsd(t.notionalUsd)}</span>
                        <span className="text-slate-600 uppercase">{t.exchange}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <p className="text-[9px] font-mono text-slate-600 mt-2">{data.flow.note}</p>
            </TerminalPanel>
          </div>

          {/* 6. OI + 11. Funding */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <TerminalPanel id="position-oi" eyebrow="Card 6 · OI Composition" title={`Total OI ${fmtUsd(data.openInterest.totalUsd)}`}>
              <Provenance marketType={data.marketType} venues={data.openInterest.venues.map((v) => v.venue)} />
              <div className="space-y-1 mb-3">
                {data.openInterest.venues.map((v) => (
                  <div key={v.venue} className="flex items-center justify-between text-[10px] font-mono border-b border-[#161618] py-1">
                    <span className="text-slate-400 uppercase w-24">{v.venue}</span>
                    <span className="text-slate-200">{fmtUsd(v.oiUsd)}</span>
                    <span className="text-slate-500 w-24 text-right">{v.oiBase != null ? `${v.oiBase.toLocaleString(undefined, { maximumFractionDigits: 0 })} base` : "—"}</span>
                    <FieldBadge status={v.status} />
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
                {data.openInterest.deltas.map((d) => (
                  <div key={d.window} className="bg-[#0a0a0b] border border-[#1f1f23] rounded p-2 text-center">
                    <span className="text-[9px] font-mono text-slate-500 block">ΔOI {d.window}</span>
                    <span className={`text-[11px] font-mono ${isNum(d.deltaPct) && d.deltaPct >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                      {fmtSignedPct(d.deltaPct, 2)}
                    </span>
                    <span className="text-[8px] font-mono text-slate-600 block mt-0.5">
                      {isNum(d.fromTime) && isNum(d.toTime) ? `${formatUtcStamp(d.fromTime)} → ${formatUtcStamp(d.toTime)} (UTC)` : "one sample — unavailable"}
                    </span>
                  </div>
                ))}
              </div>
              <Row label="Quadrant" value={data.openInterest.quadrant} />
              <Row label="OI vs 24h volume" value={fmtNum(data.openInterest.oiVsVol, 2)} sub={isNum(data.openInterest.lastDataAt) ? `last sample ${formatUtcStamp(data.openInterest.lastDataAt)} (UTC)` : undefined} />
              <p className="text-[9px] font-mono text-slate-600 mt-2">{data.openInterest.note}</p>
            </TerminalPanel>

            <TerminalPanel
              id="position-funding"
              eyebrow="Card 11 · Funding & Positioning"
              title={`OI-weighted funding ${fmtPct(data.funding.oiWeightedRate, 4)}`}
              right={
                data.funding.nextSettlement ? (
                  <span className="text-[10px] font-mono text-slate-500 flex items-center gap-1"><Clock size={10} /> next {formatUtcStamp(data.funding.nextSettlement)} (UTC)</span>
                ) : undefined
              }
            >
              <Provenance marketType={data.marketType} venues={data.funding.venues.map((v) => v.venue)} />
              <div className="space-y-1 mb-3">
                {data.funding.venues.map((v) => (
                  <div key={v.venue} className="flex items-center justify-between text-[10px] font-mono border-b border-[#161618] py-1">
                    <span className="text-slate-400 uppercase w-24">{v.venue}</span>
                    <span className={isNum(v.rate) ? (v.rate >= 0 ? "text-emerald-400" : "text-rose-400") : "text-slate-500"}>{isNum(v.rate) ? fmtPct(v.rate, 4) : "—"}</span>
                    <FieldBadge status={v.status} />
                  </div>
                ))}
              </div>
              <Row
                label="Crowding percentile"
                value={data.funding.crowdingBasis === "ok" && data.funding.crowdingPercentile != null ? `${(data.funding.crowdingPercentile * 100).toFixed(0)}%` : "unavailable"}
                sub={data.funding.crowdingBasis === "insufficient_history" ? "insufficient stored funding history" : undefined}
              />
              <Row label="Funding settles in horizon" value={`${data.reachability.fundingInWindow}×`} />
              <Row label="Settlements in window" value={String(data.funding.settlementsInWindow.length)} />
              {data.funding.settlementsInWindow.length > 0 && (
                <div className="text-[9px] font-mono text-slate-500 mt-1">
                  {data.funding.settlementsInWindow.map((t) => formatUtcStamp(t)).join(" · ")} (UTC)
                </div>
              )}
              <p className="text-[9px] font-mono text-slate-600 mt-2">{data.funding.note}</p>
            </TerminalPanel>
          </div>

          {/* 9. Market relative */}
          <TerminalPanel
            id="position-market"
            eyebrow="Card 9 · Market-Relative (L4)"
            title={data.marketRelative.label}
            right={
              <span className="text-[10px] font-mono text-slate-500">
                plausibility {data.marketRelative.plausFlow != null ? fmtPct(data.marketRelative.plausFlow, 0) : "—"}
              </span>
            }
          >
            <Provenance marketType={data.marketRelative.marketType} venues={[data.orderBook.venue, ...data.openInterest.venues.map((v) => v.venue)]} />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6">
              <Row label="Market cap" value={fmtUsd(data.marketRelative.mcapUsd)} />
              <Row label="FDV" value={data.marketRelative.fdvUsd != null ? fmtUsd(data.marketRelative.fdvUsd) : "unavailable"} />
              <Row label="vol / mcap" value={fmtNum(data.marketRelative.volMcap, 4)} />
              <Row label="OI / mcap" value={fmtNum(data.marketRelative.oiMcap, 4)} />
              <Row label="OI / vol" value={fmtNum(data.marketRelative.oiVol, 3)} />
              <Row label="V_day" value={fmtUsd(data.marketRelative.vDayUsd)} />
              <Row label="Q_required (horizon)" value={fmtUsd(data.marketRelative.qRequiredHorizonUsd)} />
              <Row label="F_max (liq fuel)" value={fmtUsd(data.marketRelative.fMaxUsd)} />
              <Row label="Universe percentile" value="unavailable" sub="layer ran degraded" />
              <Row label="Tier percentile" value="unavailable" sub="layer ran degraded" />
              <Row
                label="Target move vs this coin's 12h history"
                value={data.marketRelative.empiricalMovePercentile != null ? fmtPct(data.marketRelative.empiricalMovePercentile, 0) : "unavailable"}
                sub={isNum(data.marketRelative.targetMove) ? `|ref→TP| = ${fmtPct(data.marketRelative.targetMove)}` : undefined}
              />
              <Row label="Spot–perp basis" value={fmtSignedPct(data.marketRelative.basisPct, 3)} sub="perp mark / spot mark − 1" />
            </div>
            <div className="mt-3 rounded border border-[#1f1f23] bg-[#0a0a0b] px-3 py-2">
              <span className="text-[9px] font-mono text-slate-500 uppercase tracking-wide block mb-1">Calibrated constants used</span>
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[9px] font-mono text-slate-400">
                <span>Y = {fmtNum(data.marketRelative.constants.yImpact, 2)}</span>
                <span>liq_fraction = {fmtNum(data.marketRelative.constants.liqFraction, 3)}</span>
                <span>σ_H = {fmtPct(data.marketRelative.constants.sigmaH)}</span>
                <span>V_H = {fmtUsd(data.marketRelative.constants.vHorizonUsd)}</span>
                <span>V_day = {fmtUsd(data.marketRelative.constants.vDayUsd)}</span>
              </div>
            </div>
            {/* Required vs available flow bar */}
            <div className="mt-3">
              <div className="flex justify-between text-[9px] font-mono text-slate-500 mb-1">
                <span>Q_required (horizon)</span>
                <span>V_day slice + F_max</span>
              </div>
              <div className="h-2.5 bg-[#0a0a0b] border border-[#1f1f23] rounded overflow-hidden flex">
                <div className="bg-rose-500/70" style={{ width: `${data.marketRelative.plausFlow != null ? Math.min(100, (1 - data.marketRelative.plausFlow) * 100) : 0}%` }} />
              </div>
            </div>
            {data.marketRelative.flags.length > 0 && (
              <div className="mt-2 space-y-1">
                {data.marketRelative.flags.map((f, i) => (
                  <div key={i} className="text-[10px] font-mono text-amber-400/80 flex items-center gap-1.5"><AlertTriangle size={10} /> {f}</div>
                ))}
              </div>
            )}
            <p className="text-[9px] font-mono text-slate-600 mt-2">{data.marketRelative.note}</p>
          </TerminalPanel>

          {/* 7. Levels ladder */}
          <TerminalPanel
            id="position-ladder"
            eyebrow="Card 7 · Levels Ladder (L3)"
            title="Opposing levels, air pockets & estimated liquidation clusters"
            right={
              <span className="text-[10px] font-mono text-slate-500">
                ATR {fmtPrice(data.levels.atr)} · bucket {fmtPct(data.levels.bucketPct, 2)}
              </span>
            }
          >
            <Provenance marketType={data.marketType} venues={[data.orderBook.venue]} />
            <div className="grid grid-cols-1 xl:grid-cols-[1fr_260px] gap-5">
              <LevelLadder rows={data.levels.ladder} mark={data.header.mark} entry={data.header.entry} tp={data.header.takeProfit} sl={data.header.stopLoss} side={data.header.side} />
              <div className="space-y-3">
                <div className="bg-[#0a0a0b] border border-[#1f1f23] rounded p-3">
                  <span className="text-[9px] font-mono text-slate-500 uppercase block mb-1">Nearest levels</span>
                  <Row label="Resistance" value={fmtPrice(data.levels.nearestResistance?.price ?? null)} sub={data.levels.nearestResistance ? `${fmtNum(data.levels.nearestResistance.distanceAtr, 2)} ATR · strength ${data.levels.nearestResistance.strengthPct.toFixed(0)}%` : undefined} />
                  <Row label="Support" value={fmtPrice(data.levels.nearestSupport?.price ?? null)} sub={data.levels.nearestSupport ? `${fmtNum(data.levels.nearestSupport.distanceAtr, 2)} ATR · strength ${data.levels.nearestSupport.strengthPct.toFixed(0)}%` : undefined} />
                </div>
                <div className="bg-[#0a0a0b] border border-[#1f1f23] rounded p-3">
                  <span className="text-[9px] font-mono text-slate-500 uppercase block mb-1">Corridors</span>
                  <Row label="Entry → TP" value={`${data.levels.betweenEntryTp.count} levels`} sub={fmtUsd(data.levels.betweenEntryTp.resistanceUsd)} />
                  <Row label="Entry → SL" value={`${data.levels.betweenEntrySl.count} levels`} sub={fmtUsd(data.levels.betweenEntrySl.supportUsd)} />
                </div>
                <div className="bg-[#0a0a0b] border border-[#1f1f23] rounded p-3">
                  <span className="text-[9px] font-mono text-slate-500 uppercase block mb-1">Air pockets</span>
                  {data.levels.airPockets.length === 0 ? (
                    <span className="text-[10px] font-mono text-slate-600">none within ±10%</span>
                  ) : (
                    data.levels.airPockets.slice(0, 5).map((a, i) => (
                      <div key={i} className="flex justify-between text-[10px] font-mono">
                        <span className="text-slate-400">{fmtPrice(a.low)} – {fmtPrice(a.high)}</span>
                        <span className="text-slate-500">{fmtSignedPct(a.distancePct)}</span>
                      </div>
                    ))
                  )}
                </div>
                <div className="bg-[#0a0a0b] border border-[#1f1f23] rounded p-3">
                  <span className="text-[9px] font-mono text-slate-500 uppercase block mb-1">Estimated liq clusters (model-based)</span>
                  <div className="space-y-0.5">
                    {data.levels.liquidationEstimates.slice(0, 12).map((l, i) => (
                      <div key={i} className="flex justify-between text-[10px] font-mono">
                        <span className={l.side === "long" ? "text-rose-400" : "text-emerald-400"}>{l.leverage}× {l.side}</span>
                        <span className="text-slate-400">{fmtPrice(l.price)}</span>
                        <span className="text-slate-500">{fmtUsd(l.notionalUsd)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <p className="text-[9px] font-mono text-slate-600 mt-3">{data.levels.method}</p>
          </TerminalPanel>

          {/* 12. Data health */}
          <TerminalPanel
            id="position-health"
            eyebrow="Card 12 · Data Health & Inputs"
            title={`Last refresh ${formatUtcStamp(data.generatedAt)}`}
            right={
              <button onClick={handleSubmit} disabled={loading} className="px-3 py-1.5 border border-[#1f1f23] hover:border-slate-600 text-slate-300 text-[11px] font-mono rounded flex items-center gap-1.5 cursor-pointer disabled:opacity-50">
                <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
              </button>
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="text-[9px] font-mono text-slate-500 uppercase border-b border-[#1f1f23]">
                    <th className="py-1.5 pr-3">Field</th>
                    <th className="py-1.5 pr-3">Value</th>
                    <th className="py-1.5 pr-3">Source</th>
                    <th className="py-1.5 pr-3">Age</th>
                    <th className="py-1.5 pr-3">Used in</th>
                    <th className="py-1.5 pr-3">Manual override</th>
                    <th className="py-1.5">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.health.map((f) => {
                    const manual = MANUAL_FIELDS[f.key];
                    return (
                      <tr key={f.key} className="border-b border-[#161618] last:border-0">
                        <td className="py-1.5 pr-3 text-[10px] font-mono text-slate-300">{f.label}</td>
                        <td className="py-1.5 pr-3 text-[10px] font-mono text-slate-400">{f.value}</td>
                        <td className="py-1.5 pr-3 text-[10px] font-mono text-slate-500">{f.source}</td>
                        <td className="py-1.5 pr-3 text-[10px] font-mono text-slate-500">{f.ageMs != null ? `${Math.round(f.ageMs / 1000)}s` : "—"}</td>
                        <td className="py-1.5 pr-3 text-[10px] font-mono text-slate-500">{f.usedIn}</td>
                        <td className="py-1.5 pr-3">
                          {manual ? (
                            <div className="flex items-center gap-1.5">
                              <input
                                className="w-24 bg-[#0a0a0b] border border-[#1f1f23] rounded px-1.5 py-1 text-[10px] font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50"
                                placeholder={manual.hint}
                                value={String(form[manual.field] ?? "")}
                                onChange={(e) => setField(manual.field, e.target.value as FormState[typeof manual.field])}
                              />
                              <label className="flex items-center gap-1 text-[9px] font-mono text-slate-500 cursor-pointer" title="Force this value even if the feed succeeds">
                                <input
                                  type="checkbox"
                                  checked={form.locks.includes(manual.lock)}
                                  onChange={() => toggleLock(manual.lock)}
                                />
                                lock
                              </label>
                            </div>
                          ) : (
                            <span className="text-[10px] font-mono text-slate-700">—</span>
                          )}
                        </td>
                        <td className="py-1.5"><FieldBadge status={f.status} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-3 text-[9px] font-mono text-slate-600 space-y-1">
              <div>• Leave a manual field blank to use the live feed. A value is applied automatically only when the feed fails; tick <span className="text-slate-400">lock</span> to force it regardless. Then press Refresh.</div>
              {data.caveats.map((c, i) => (
                <div key={i}>• {c}</div>
              ))}
            </div>
          </TerminalPanel>

          <div className="text-[9px] font-mono text-slate-600 text-right">
            analysis_id {data.analysisId} · interval {data.interval} · horizon {data.input.horizonHours}h ({data.reachability.horizonBars} bars)
          </div>
        </motion.div>
      )}
    </div>
  );
}
