/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-coin liquidation metrics for the Quant Terminal tab.
 *
 * A compact read of the fused liq-collector tape for the coin currently
 * loaded in the terminal: notional force-closed, event count, long/short
 * split and the newest raw event, each compared against the previous
 * matching window so the panel reads as a change, not a level. The same
 * 1h/4h/24h windows as the Liquidations page, cut on the server's receive
 * clock, so numbers agree with the full tape.
 */

import { useCallback, useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { CoinLiqResponse, LiqWindow } from "../../types";
import { EmptyState, TerminalPanel } from "./TerminalCharts";

const WINDOW_OPTIONS: { value: LiqWindow; label: string }[] = [
  { value: "1h", label: "1H" },
  { value: "4h", label: "4H" },
  { value: "24h", label: "24H" },
];

const EXCHANGE_LABEL: Record<string, string> = {
  binance: "Binance",
  bybit: "Bybit",
  okx: "OKX",
};

const REFRESH_MS = 30_000;

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtCount(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "0";
}

/** "+12.4%" / "-3.1%" / "new baseline" when the previous window was empty. */
function fmtPct(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "new baseline";
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function signed(n: number): string {
  return `${n > 0 ? "+" : ""}${fmtCount(n)}`;
}

/** "12s ago" / "5m ago" / "3h 4m ago" for the latest force-order. */
function ageLabel(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * More liquidations than the previous window reads as stress (rose), fewer
 * as cooling (emerald). A missing baseline is neutral, not an improvement.
 */
function stressTone(delta: number, pct: number | null): string {
  if (pct === null) return "text-slate-200";
  if (delta > 0) return "text-rose-400";
  if (delta < 0) return "text-emerald-400";
  return "text-slate-200";
}

function Tile({
  label,
  value,
  sub,
  tone = "text-slate-200",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div className="bg-[#0a0a0b] border border-[#1f1f23] rounded p-3 min-w-0">
      <div className="text-[9px] font-mono text-slate-500 uppercase tracking-wider truncate">
        {label}
      </div>
      <div className={`text-lg font-mono font-bold leading-tight mt-0.5 ${tone}`}>{value}</div>
      {sub && <div className="text-[9px] font-mono text-slate-600 mt-0.5 leading-snug">{sub}</div>}
    </div>
  );
}

export default function CoinLiquidationMetrics({
  symbol,
  label,
  onOpenTape,
}: {
  /** Normalized terminal symbol, e.g. "BTCUSDT". */
  symbol: string;
  /** Display name of the coin, e.g. "Bitcoin". */
  label: string;
  /** Switches the app to the Liquidations tab for the full tape. */
  onOpenTape?: () => void;
}) {
  const [liqWindow, setLiqWindow] = useState<LiqWindow>("1h");
  const [data, setData] = useState<CoinLiqResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (silent: boolean) => {
      if (!silent) setLoading(true);
      try {
        const res = await fetch(
          `/api/liq/coin?symbol=${encodeURIComponent(symbol)}&window=${liqWindow}`
        );
        const payload = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(payload?.error || `Liquidation lookup failed (${res.status}).`);
        }
        setData(payload as CoinLiqResponse);
        setError(null);
      } catch (err: any) {
        if (!silent) setError(err?.message || "Liquidation feed unavailable.");
      } finally {
        setLoading(false);
      }
    },
    [symbol, liqWindow]
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  // The tape moves without anyone watching; poll so the panel stays current.
  useEffect(() => {
    const id = setInterval(() => void load(true), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const current = data?.current;
  const previous = data?.previous;
  const delta = data?.delta;

  const longNotional = current?.longNotional ?? 0;
  const shortNotional = current?.shortNotional ?? 0;
  const splitTotal = longNotional + shortNotional;
  const longShare = splitTotal > 0 ? (longNotional / splitTotal) * 100 : 0;

  const topVenue = current
    ? Object.entries(current.byExchange).sort((a, b) => b[1].notional - a[1].notional)[0]
    : undefined;

  const latest = data?.recent[0];

  const venueMix = current
    ? Object.entries(current.byExchange)
        .sort((a, b) => b[1].notional - a[1].notional)
        .map(([exchange, totals]) => {
          const share = current.notional > 0 ? (totals.notional / current.notional) * 100 : 0;
          return `${EXCHANGE_LABEL[exchange] || exchange.toUpperCase()} ${share.toFixed(0)}%`;
        })
        .join(" · ")
    : "";

  return (
    <TerminalPanel
      id="terminal-liquidation-metrics"
      eyebrow="Forced flow"
      title={`Liquidation Metrics — ${label}`}
      subtitle={
        `Force-orders wiped on Binance, Bybit and OKX for ${symbol}, measured over the last ` +
        `${liqWindow} against the matching window before it. Rising liquidations read as stress, ` +
        `falling ones as cooling; the long/short split says which side of the book was taken out.`
      }
      right={
        <div className="flex flex-col items-end gap-2">
          <div>
            <div className="text-[9px] font-mono text-slate-500 uppercase tracking-widest mb-1">
              Window
            </div>
            <div className="flex gap-1 justify-end">
              {WINDOW_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setLiqWindow(option.value)}
                  className={`px-2 h-7 text-[10px] font-mono rounded border cursor-pointer transition-colors ${
                    liqWindow === option.value
                      ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-300"
                      : "bg-[#0a0a0b] border-[#1f1f23] text-slate-500 hover:text-slate-300"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          {onOpenTape && (
            <button
              type="button"
              onClick={onOpenTape}
              className="h-7 px-2.5 text-[10px] font-mono rounded border border-[#1f1f23] bg-[#0a0a0b] text-slate-400 hover:text-emerald-400 hover:border-emerald-500/40 cursor-pointer flex items-center gap-1.5"
            >
              <ExternalLink size={11} /> OPEN TAPE
            </button>
          )}
        </div>
      }
    >
      {error && !data ? (
        <div className="p-4 bg-rose-950/60 border border-rose-900/50 rounded text-[11px] font-mono text-rose-300">
          {error}
        </div>
      ) : loading && !data ? (
        <div className="py-8 text-center text-[10px] font-mono text-slate-500 uppercase tracking-widest animate-pulse">
          Reading the liquidation buffer…
        </div>
      ) : data && current && previous && delta ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
            <Tile
              label={`Liquidated ${liqWindow}`}
              value={fmtUsd(current.notional)}
              sub={`${fmtPct(delta.notionalPct)} vs prev ${liqWindow} (${fmtUsd(previous.notional)})`}
              tone={stressTone(delta.notional, delta.notionalPct)}
            />
            <Tile
              label="Force orders"
              value={fmtCount(current.events)}
              sub={`${signed(delta.events)} events vs prev ${liqWindow}`}
              tone={stressTone(delta.events, delta.eventsPct)}
            />
            <Tile
              label="Long wipe share"
              value={splitTotal > 0 ? `${longShare.toFixed(0)}%` : "—"}
              sub={`${fmtUsd(longNotional)} longs · ${fmtUsd(shortNotional)} shorts`}
            />
            <Tile
              label="Latest force-order"
              value={latest ? ageLabel(latest.receivedAtMs) : "none in window"}
              sub={
                latest
                  ? `${EXCHANGE_LABEL[latest.exchange] || latest.exchange} · ${fmtUsd(latest.notional)}`
                  : data.buffered > 0
                  ? `${fmtCount(data.buffered)} events buffered overall`
                  : "waiting for the first event"
              }
              tone={latest ? "text-slate-200" : "text-slate-500"}
            />
          </div>

          {current.events === 0 ? (
            <EmptyState
              message={`No ${liqWindow} liquidations for ${label} — the tape fills when volatility picks up.`}
            />
          ) : (
            <div>
              <div className="flex justify-between text-[9px] font-mono uppercase tracking-wider mb-1">
                <span className="text-rose-400">
                  Longs wiped · {fmtUsd(longNotional)}
                </span>
                <span className="text-emerald-400">
                  Shorts wiped · {fmtUsd(shortNotional)}
                </span>
              </div>
              <div className="h-2 rounded overflow-hidden bg-[#141417] flex">
                <div
                  className="bg-rose-500/80 transition-all duration-500"
                  style={{ width: `${longShare}%` }}
                />
                <div
                  className="bg-emerald-500/80 transition-all duration-500"
                  style={{ width: `${100 - longShare}%` }}
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 border-t border-[#1f1f23] text-[10px] font-mono text-slate-500">
            {latest && (
              <span className="flex items-center gap-1.5">
                <span className="text-slate-600">latest:</span>
                <span
                  className={
                    latest.position === "long"
                      ? "text-rose-400"
                      : latest.position === "short"
                      ? "text-emerald-400"
                      : ""
                  }
                >
                  {latest.position === "long"
                    ? "LONG WIPED"
                    : latest.position === "short"
                    ? "SHORT WIPED"
                    : "UNCLASSIFIED"}
                </span>
                <span>{latest.venueSymbol}</span>
                <span>@ {latest.price.toLocaleString("en-US")}</span>
              </span>
            )}
            {venueMix && <span>venue mix: {venueMix}</span>}
            {topVenue && current.notional > 0 && (
              <span>
                top: {EXCHANGE_LABEL[topVenue[0]] || topVenue[0].toUpperCase()} (
                {((topVenue[1].notional / current.notional) * 100).toFixed(0)}%)
              </span>
            )}
            <span className="ml-auto text-slate-600">
              receive-clock windows · current {liqWindow} vs previous {liqWindow}
            </span>
          </div>
        </div>
      ) : null}
    </TerminalPanel>
  );
}
