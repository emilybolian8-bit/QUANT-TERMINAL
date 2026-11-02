/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import { SessionAnalysis, SessionStat } from "../../types";
import { TerminalPanel, EmptyState, Legend } from "./TerminalCharts";

/** Session mean returns are rarely uniform, so the colour scale is data-driven. */
function buildColorScale(values: number[]) {
  const maxAbs = Math.max(1, ...values.map((v) => Math.abs(v)));
  return (v: number) => {
    const intensity = Math.min(1, Math.abs(v) / maxAbs);
    // Rose for negative, emerald for positive, with alpha carrying magnitude so
    // a near-zero session reads as flat grey rather than a weak green.
    return v >= 0 ? `rgba(16, 185, 129, ${0.08 + intensity * 0.62})` : `rgba(244, 63, 94, ${0.08 + intensity * 0.62})`;
  };
}

function significanceClass(tStat: number): string {
  if (Math.abs(tStat) >= 2.5) return "text-emerald-300 font-bold";
  if (Math.abs(tStat) >= 2) return "text-emerald-400";
  return "text-slate-500";
}

function SessionRow({ session, rank }: { session: SessionStat; rank: number }) {
  return (
    <tr className="border-b border-[#1f1f23]/60 last:border-0 hover:bg-[#0a0a0b]/60 transition-colors">
      <td className="py-2 pl-2 pr-2 whitespace-nowrap">
        <span className="text-[10px] font-mono font-bold text-slate-200">{session.label}</span>
        <span className="block text-[9px] font-mono text-slate-600">{session.window}</span>
      </td>
      <td className="py-2 px-2 text-right font-mono text-[10px] text-slate-400">{session.observations}</td>
      <td
        className={`py-2 px-2 text-right font-mono text-[11px] font-bold ${
          session.meanReturnBps > 0 ? "text-emerald-400" : session.meanReturnBps < 0 ? "text-rose-400" : "text-slate-500"
        }`}
      >
        {session.meanReturnBps > 0 ? "+" : ""}
        {session.meanReturnBps.toFixed(2)}
      </td>
      <td className="py-2 px-2 text-right font-mono text-[10px] text-slate-500">
        {session.projectedAnnualPct > 0 ? "+" : ""}
        {session.projectedAnnualPct.toFixed(0)}%
      </td>
      <td className="py-2 px-2 text-right font-mono text-[10px] text-slate-400">
        {session.volatilityBps.toFixed(1)}
      </td>
      <td className="py-2 px-2 text-right font-mono text-[10px] text-slate-400">
        {session.hitRatePct.toFixed(1)}%
      </td>
      <td className={`py-2 px-2 text-right font-mono text-[10px] ${significanceClass(session.tStat)}`}>
        {session.tStat.toFixed(2)}
        {Math.abs(session.tStat) >= 2 && (
          <span className="ml-1 text-[8px] text-emerald-500" title="Significant at |t| >= 2">
            *
          </span>
        )}
      </td>
      <td className="py-2 px-2 text-right font-mono text-[10px] text-slate-400">
        {session.volumeSharePct.toFixed(1)}%
      </td>
      <td className="py-2 px-2 text-right font-mono text-[10px] text-slate-300">
        {session.beta.toFixed(2)}
      </td>
      <td className="py-2 px-2 text-right font-mono text-[10px] text-slate-400">
        {session.correlation.toFixed(3)}
      </td>
      <td className="py-2 px-2 pr-2 text-right font-mono text-[10px] text-slate-500">{rank}</td>
    </tr>
  );
}

export default function SessionPanel({
  id,
  sessions,
  subjectLabel,
  benchmarkLabel,
}: {
  id: string;
  sessions: SessionAnalysis;
  subjectLabel: string;
  benchmarkLabel: string;
}) {
  const hourColor = buildColorScale(sessions.hours.map((h) => h.meanReturnBps));
  const active = sessions.sessions.filter((s) => s.observations > 0);

  const best = sessions.sessions.find((s) => s.id === sessions.bestSessionId);
  const worst = sessions.sessions.find((s) => s.id === sessions.worstSessionId);

  return (
    <div id={id} className="space-y-6">
      <TerminalPanel
        eyebrow="Time of day effects"
        title="Trading Session Split (fixed UTC windows)"
        subtitle={
          `Each session is measured on the bars that fall inside it: mean return per bar in basis points, the linear projection of that mean onto a year, realized vol, hit rate, and a t-statistic testing whether the session mean differs from zero. Beta and correlation are against ${benchmarkLabel} measured within the same session, which is how you find out whether the pair only tracks during one of them.`
        }
        right={
          <div className="font-mono">
            <div className="text-[10px] text-slate-500">BEST / WORST</div>
            <div className="text-xs">
              <span className="text-emerald-400">{best?.label ?? "-"}</span>
              <span className="text-slate-600"> vs </span>
              <span className="text-rose-400">{worst?.label ?? "-"}</span>
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">
              spread {sessions.dispersionBps.toFixed(2)} bps
            </div>
          </div>
        }
      >
        {active.length === 0 ? (
          <EmptyState message="Not enough bars to split the window into sessions." />
        ) : (
          <>
            <div className="overflow-x-auto custom-scrollbar">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-[#1f1f23]">
                    {[
                      "SESSION",
                      "BARS",
                      "MEAN bps",
                      "PROJ ANN",
                      "VOL bps",
                      "HIT %",
                      "t-STAT",
                      "VOL SHARE",
                      "BETA",
                      "r vs BASE",
                      "RANK",
                    ].map((head) => (
                      <th
                        key={head}
                        className="py-2 px-2 text-[9px] font-mono text-slate-500 uppercase tracking-wider font-bold whitespace-nowrap"
                      >
                        {head}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...sessions.sessions]
                    .sort((a, b) => (a.rank || 99) - (b.rank || 99))
                    .map((session) => (
                      <SessionRow key={session.id} session={session} rank={session.rank} />
                    ))}
                </tbody>
              </table>
            </div>
            <Legend
              items={[
                { color: "#fb7185", label: "session mean below zero" },
                { color: "#34d399", label: "session mean above zero" },
              ]}
            />
          </>
        )}

        <div className="mt-4 p-3 bg-[#0a0a0b] border border-[#1f1f23] rounded">
          <p className="text-[11px] text-slate-300 leading-relaxed font-sans">
            {sessions.interpretation}
          </p>
          <p className="text-[10px] text-slate-500 leading-relaxed font-sans mt-2">{sessions.boundaryNote}</p>
        </div>
      </TerminalPanel>

      <TerminalPanel
        eyebrow="Hour of day"
        title="24-Hour Return Heatmap (UTC)"
        subtitle={
          `Mean return per bar for every hour of the UTC day, shaded green for positive and red for negative, with the hit rate underneath. This view asserts no session boundary, so it stays valid across a daylight-saving change that would silently shift a fixed session split. Hover any cell for its vol, hit rate, bar count and volume share.`
        }
        right={
          <div className="font-mono text-[10px] text-slate-500">
            <div>hours with data</div>
            <div className="text-slate-300 text-xs">
              {sessions.hours.filter((h) => h.observations > 0).length}/24
            </div>
          </div>
        }
      >
        <HourHeatmap sessions={sessions} colorFor={hourColor} subjectLabel={subjectLabel} />
        <Legend
          items={[
            { color: "#10b981", label: "positive mean return" },
            { color: "#f43f5e", label: "negative mean return" },
            { color: "#1e293b", label: "no bars in this hour" },
          ]}
        />
      </TerminalPanel>

      <TerminalPanel
        eyebrow="Session risk attribution"
        title="Up / Down Capture by Session"
        subtitle={
          `How much of ${benchmarkLabel}'s session move ${subjectLabel} participates in, split by whether the benchmark rose or fell inside that session. A capture near 100% means it tracks one-for-one; the asymmetry between the two columns is the session-level version of the downside beta.`
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {sessions.sessions.map((s) => (
            <div key={s.id} className="bg-[#0a0a0b] border border-[#1f1f23] rounded p-3">
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-[10px] font-mono font-bold text-slate-200">{s.label}</span>
                <span className="text-[9px] font-mono text-slate-600">{s.window}</span>
              </div>
              <div className="space-y-1.5">
                <CaptureBar label="UP CAPTURE" value={s.upCapturePct} positive />
                <CaptureBar label="DOWN CAPTURE" value={s.downCapturePct} positive={false} />
              </div>
              <div className="mt-2 pt-2 border-t border-[#1f1f23] flex justify-between text-[9px] font-mono">
                <span className="text-slate-500">capture ratio</span>
                <span className="text-slate-200">
                  {s.downCapturePct !== 0
                    ? (s.upCapturePct / Math.abs(s.downCapturePct)).toFixed(2)
                    : "n/a"}
                </span>
              </div>
            </div>
          ))}
        </div>
      </TerminalPanel>
    </div>
  );
}

function CaptureBar({
  label,
  value,
  positive,
}: {
  label: string;
  value: number;
  positive: boolean;
}) {
  const cap = 160;
  const width = Math.min(100, (Math.abs(value) / cap) * 100);
  return (
    <div>
      <div className="flex justify-between text-[9px] font-mono text-slate-500 mb-0.5">
        <span>{label}</span>
        <span className={positive ? "text-emerald-400" : "text-rose-400"}>{value.toFixed(1)}%</span>
      </div>
      <div className="h-1.5 bg-[#0e0e10] border border-[#1f1f23]/60 rounded-full overflow-hidden">
        <div
          className={`h-full ${positive ? "bg-emerald-500" : "bg-rose-500"}`}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

function HourHeatmap({
  sessions,
  colorFor,
  subjectLabel,
}: {
  sessions: SessionAnalysis;
  colorFor: (v: number) => string;
  subjectLabel: string;
}) {
  return (
    <div>
      <div className="grid grid-cols-12 gap-1 mb-1">
        {sessions.hours.map((h) => (
          <div key={h.hour} className="text-center text-[9px] font-mono text-slate-600">
            {String(h.hour).padStart(2, "0")}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-12 gap-1">
        {sessions.hours.map((h) => (
          <div
            key={h.hour}
            className="h-11 rounded-sm border border-[#1f1f23]/60 flex flex-col items-center justify-center cursor-default transition-transform hover:scale-105"
            style={{ background: h.observations === 0 ? "#0a0a0b" : colorFor(h.meanReturnBps) }}
            title={
              h.observations === 0
                ? `Hour ${String(h.hour).padStart(2, "0")}:00 UTC — no bars in window`
                : `Hour ${String(h.hour).padStart(2, "0")}:00 UTC — mean ${h.meanReturnBps.toFixed(2)} bps, vol ${h.volatilityBps.toFixed(1)} bps, hit ${h.hitRatePct.toFixed(1)}%, ${h.observations} bars, ${h.volumeSharePct.toFixed(1)}% of volume`
            }
          >
            {h.observations === 0 ? (
              <span className="text-[9px] font-mono text-slate-700">—</span>
            ) : (
              <>
                <span
                  className={`text-[10px] font-mono font-bold ${
                    h.meanReturnBps > 0 ? "text-emerald-50" : "text-rose-50"
                  }`}
                >
                  {h.meanReturnBps > 0 ? "+" : ""}
                  {h.meanReturnBps.toFixed(1)}
                </span>
                <span className="text-[8px] font-mono text-white/55">
                  {(h.hitRatePct ?? 0).toFixed(0)}%
                </span>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
        {sessions.hours
          .filter((h) => h.observations > 0)
          .sort((a, b) => b.meanReturnBps - a.meanReturnBps)
          .slice(0, 1)
          .map((h) => (
            <StatChip
              key="best"
              label={`BEST HOUR ${String(h.hour).padStart(2, "0")}:00 UTC`}
              value={`${h.meanReturnBps > 0 ? "+" : ""}${h.meanReturnBps.toFixed(2)} bps`}
              tone="positive"
              sub={`${h.observations} bars · ${h.volumeSharePct.toFixed(1)}% of volume`}
            />
          ))}
        {sessions.hours
          .filter((h) => h.observations > 0)
          .sort((a, b) => b.volumeSharePct - a.volumeSharePct)
          .slice(0, 1)
          .map((h) => (
            <StatChip
              key="busiest"
              label={`BUSIEST HOUR ${String(h.hour).padStart(2, "0")}:00 UTC`}
              value={`${h.volumeSharePct.toFixed(1)}% vol`}
              tone="neutral"
              sub={`${h.observations} bars · ${subjectLabel} turnover`}
            />
          ))}
        {sessions.hours
          .filter((h) => h.observations > 0)
          .sort((a, b) => a.meanReturnBps - b.meanReturnBps)
          .slice(0, 1)
          .map((h) => (
            <StatChip
              key="worst"
              label={`WORST HOUR ${String(h.hour).padStart(2, "0")}:00 UTC`}
              value={`${h.meanReturnBps > 0 ? "+" : ""}${h.meanReturnBps.toFixed(2)} bps`}
              tone="negative"
              sub={`${h.observations} bars · ${h.hitRatePct.toFixed(1)}% hit rate`}
            />
          ))}
      </div>
    </div>
  );
}

function StatChip({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "positive" | "negative" | "neutral";
}) {
  const toneClass =
    tone === "positive" ? "text-emerald-400" : tone === "negative" ? "text-rose-400" : "text-sky-400";
  return (
    <div className="bg-[#0a0a0b] border border-[#1f1f23] rounded p-2.5">
      <div className="text-[9px] font-mono text-slate-500">{label}</div>
      <div className={`text-sm font-mono font-bold ${toneClass}`}>{value}</div>
      <div className="text-[9px] font-mono text-slate-600">{sub}</div>
    </div>
  );
}