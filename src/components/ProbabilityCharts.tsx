/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import {
  EpisodeSeries,
  RegimeBlockPoint,
  TimingAnalysis,
} from "../types";

/*
 * Chart conventions shared with terminal/TerminalCharts.tsx: SVGs are
 * stretched with preserveAspectRatio="none", so NO text lives inside them -
 * axis labels are HTML around the figure, and fixed-width strokes carry
 * vectorEffect="non-scaling-stroke".
 */

const VB_WIDTH = 720;

export const CLASS_COLORS = {
  collapse: "#fb7185",
  extension: "#34d399",
  consolidation: "#38bdf8",
  neutral: "#94a3b8",
} as const;

function pct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

/* -------------------------------------------------------------------------- *
 * Probability bar rows with credible-interval whiskers
 * -------------------------------------------------------------------------- */

export interface BarRow {
  label: string;
  p: number;
  ci80?: [number, number] | null;
  ci95?: [number, number] | null;
  count?: number;
  color?: string;
  muted?: boolean;
}

export function ProbabilityBars({
  rows,
  note,
}: {
  rows: BarRow[];
  note?: string;
}) {
  return (
    <div className="space-y-2.5">
      {rows.map((r) => {
        const lo80 = r.ci80 ? Math.min(...r.ci80) : null;
        const hi80 = r.ci80 ? Math.max(...r.ci80) : null;
        const lo95 = r.ci95 ? Math.min(...r.ci95) : null;
        const hi95 = r.ci95 ? Math.max(...r.ci95) : null;
        const color = r.color ?? CLASS_COLORS.neutral;
        return (
          <div key={r.label} className={r.muted ? "opacity-45" : ""}>
            <div className="flex items-baseline justify-between gap-3 mb-1">
              <span className="text-[10px] font-mono text-slate-400 uppercase tracking-wider truncate">
                {r.label}
              </span>
              <span className="text-[11px] font-mono text-slate-200 shrink-0">
                {pct(r.p)}
                {r.ci80 && (
                  <span className="text-slate-500">
                    {" "}
                    [{pct(lo80 as number)}, {pct(hi80 as number)}]
                  </span>
                )}
                {typeof r.count === "number" && (
                  <span className="text-slate-600"> · n={r.count}</span>
                )}
              </span>
            </div>
            <div className="relative h-[18px] bg-[#0a0a0b] border border-[#1f1f23] rounded overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 rounded-l transition-[width] duration-300"
                style={{ width: `${r.p * 100}%`, background: color, opacity: 0.32 }}
              />
              <div
                className="absolute inset-y-0 left-0"
                style={{ width: `${r.p * 100}%`, borderRight: `2px solid ${color}` }}
              />
              {lo95 !== null && hi95 !== null && (
                <div
                  className="absolute top-1/2 h-px -translate-y-1/2"
                  style={{
                    left: `${lo95 * 100}%`,
                    width: `${(hi95 as number - lo95) * 100}%`,
                    background: color,
                    opacity: 0.55,
                  }}
                />
              )}
              {lo80 !== null && hi80 !== null && (
                <div
                  className="absolute top-1/2 h-[3px] -translate-y-1/2"
                  style={{
                    left: `${lo80 * 100}%`,
                    width: `${Math.max(0.4, (hi80 as number - lo80) * 100)}%`,
                    background: color,
                  }}
                />
              )}
            </div>
          </div>
        );
      })}
      {note && <p className="text-[10px] text-slate-500 leading-relaxed pt-0.5">{note}</p>}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Competing-risks cumulative incidence (timing)
 * -------------------------------------------------------------------------- */

export function CumulativeIncidenceChart({
  id,
  timing,
  baseCollapse,
  labels,
  x0Label = "t_break",
  formatX,
}: {
  id: string;
  timing: TimingAnalysis;
  baseCollapse: number;
  labels?: {
    primary?: string;
    secondary?: string;
    base?: string;
    median?: string;
  };
  x0Label?: string;
  formatX?: (bars: number, frac: number) => string;
}) {
  const primary = labels?.primary ?? "collapse";
  const secondary = labels?.secondary ?? "extension";
  const baseLabel = labels?.base ?? "base collapse";
  const medianLabel = labels?.median ?? "median collapse";
  const tick = (bars: number, frac: number) =>
    frac === 0 ? x0Label : formatX ? formatX(bars, frac) : `${bars}b`;
  const H = 190;
  const padT = 8;
  const padB = 10;
  const pts = timing.points.filter((p) => Number.isFinite(p.collapse));
  const x = (frac: number) => frac * VB_WIDTH;
  const y = (v: number) => padT + (1 - v) * (H - padT - padB);
  const line = (key: "collapse" | "extension") =>
    pts.map((p) => `${x(p.frac)},${y(p[key])}`).join(" ");
  const medianFrac =
    timing.medianCollapseBars !== null ? timing.medianCollapseBars / timing.horizonBars : null;
  return (
    <div>
      <div className="relative">
        <div className="absolute left-0 top-0 bottom-5 w-9 flex flex-col justify-between items-end pr-1.5 text-[9px] font-mono text-slate-500 pointer-events-none">
          <span>100%</span>
          <span>50%</span>
          <span>0%</span>
        </div>
        <svg
          id={id}
          viewBox={`0 0 ${VB_WIDTH} ${H}`}
          preserveAspectRatio="none"
          className="w-full h-[190px] pl-9"
          role="img"
        >
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <line
              key={v}
              x1={0}
              x2={VB_WIDTH}
              y1={y(v)}
              y2={y(v)}
              stroke="#1f1f23"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <line
            x1={0}
            x2={VB_WIDTH}
            y1={y(baseCollapse)}
            y2={y(baseCollapse)}
            stroke="#64748b"
            strokeWidth={1}
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
          {medianFrac !== null && (
            <line
              x1={x(medianFrac)}
              x2={x(medianFrac)}
              y1={padT}
              y2={H - padB}
              stroke={CLASS_COLORS.collapse}
              strokeWidth={1}
              strokeDasharray="3 5"
              opacity={0.7}
              vectorEffect="non-scaling-stroke"
            />
          )}
          <polyline
            points={line("extension")}
            fill="none"
            stroke={CLASS_COLORS.extension}
            strokeWidth={1.75}
            vectorEffect="non-scaling-stroke"
          />
          <polyline
            points={line("collapse")}
            fill="none"
            stroke={CLASS_COLORS.collapse}
            strokeWidth={1.75}
            vectorEffect="non-scaling-stroke"
          />
          {pts.map((p) => (
            <g key={p.frac}>
              <circle cx={x(p.frac)} cy={y(p.collapse)} r={3} fill={CLASS_COLORS.collapse}>
                <title>{`t=${p.bars} bars · collapse ${pct(p.collapse)}`}</title>
              </circle>
              <circle cx={x(p.frac)} cy={y(p.extension)} r={3} fill={CLASS_COLORS.extension}>
                <title>{`t=${p.bars} bars · extension ${pct(p.extension)}`}</title>
              </circle>
            </g>
          ))}
        </svg>
        <div className="flex justify-between pl-9 text-[9px] font-mono text-slate-500 mt-1">
          {timing.points.map((p) => (
            <span key={p.frac}>{tick(p.bars, p.frac)}</span>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[9px] font-mono text-slate-500">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-4" style={{ background: CLASS_COLORS.collapse }} />
          {primary}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-4" style={{ background: CLASS_COLORS.extension }} />
          {secondary}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-px w-4 border-t border-dashed border-slate-500" />
          {baseLabel} {pct(baseCollapse, 0)}
        </span>
        <span>
          {medianLabel}:{" "}
          {timing.medianCollapseBars !== null
            ? `${timing.medianCollapseBars} bars`
            : `> ${timing.horizonBars} bars (never reached)`}
        </span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Regime drift: shrunk P(collapse) per time block
 * -------------------------------------------------------------------------- */

export function RegimeDriftChart({
  id,
  blocks,
  baseCollapse,
}: {
  id: string;
  blocks: RegimeBlockPoint[];
  baseCollapse: number;
}) {
  const H = 170;
  const padT = 8;
  const padB = 8;
  const n = blocks.length;
  const x = (i: number) => (n <= 1 ? VB_WIDTH / 2 : (i / (n - 1)) * VB_WIDTH);
  const y = (v: number) => padT + (1 - v) * (H - padT - padB);
  const band = [
    ...blocks.map((b, i) => `${x(i)},${y(b.ci80[1])}`),
    ...blocks.map((_, i) => `${x(n - 1 - i)},${y(blocks[n - 1 - i].ci80[0])}`),
  ].join(" ");
  const line = blocks.map((b, i) => `${x(i)},${y(b.collapse)}`).join(" ");
  return (
    <div>
      <div className="relative">
        <div className="absolute left-0 top-0 bottom-5 w-9 flex flex-col justify-between items-end pr-1.5 text-[9px] font-mono text-slate-500 pointer-events-none">
          <span>100%</span>
          <span>50%</span>
          <span>0%</span>
        </div>
        <svg
          id={id}
          viewBox={`0 0 ${VB_WIDTH} ${H}`}
          preserveAspectRatio="none"
          className="w-full h-[170px] pl-9"
          role="img"
        >
          {[0, 0.5, 1].map((v) => (
            <line
              key={v}
              x1={0}
              x2={VB_WIDTH}
              y1={y(v)}
              y2={y(v)}
              stroke="#1f1f23"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <line
            x1={0}
            x2={VB_WIDTH}
            y1={y(baseCollapse)}
            y2={y(baseCollapse)}
            stroke="#64748b"
            strokeWidth={1}
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
          {n > 1 && (
            <polygon points={band} fill={CLASS_COLORS.collapse} opacity={0.14} />
          )}
          <polyline
            points={line}
            fill="none"
            stroke={CLASS_COLORS.collapse}
            strokeWidth={1.75}
            vectorEffect="non-scaling-stroke"
          />
          {blocks.map((b, i) => (
            <circle key={b.iso + i} cx={x(i)} cy={y(b.collapse)} r={3} fill={CLASS_COLORS.collapse}>
              <title>{`${b.label} · P(collapse) ${pct(b.collapse)} [${pct(b.ci80[0])}, ${pct(b.ci80[1])}] · n=${b.n} (nEff ${b.nEff.toFixed(1)})`}</title>
            </circle>
          ))}
        </svg>
        <div className="flex justify-between pl-9 text-[9px] font-mono text-slate-500 mt-1">
          <span>{blocks[0]?.label}</span>
          {n > 2 && <span>{blocks[Math.floor(n / 2)]?.label}</span>}
          <span>{blocks[n - 1]?.label}</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[9px] font-mono text-slate-500">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-4" style={{ background: CLASS_COLORS.collapse }} />
          shrunk P(collapse | breakdown)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4" style={{ background: CLASS_COLORS.collapse, opacity: 0.22 }} />
          80% credible band
        </span>
        <span>dashed = pooled base rate</span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Per-episode probability shift across the horizon
 * -------------------------------------------------------------------------- */

export function EpisodeShiftChart({
  id,
  episode,
}: {
  id: string;
  episode: EpisodeSeries;
}) {
  const H = 190;
  const padT = 8;
  const padB = 10;
  const pts = episode.points;
  const x = (phase: number) => phase * VB_WIDTH;
  const y = (v: number) => padT + (1 - v) * (H - padT - padB);
  const line = (key: "collapse" | "extension" | "consolidation") =>
    pts.map((p) => `${x(p.phase)},${y(p[key])}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <div>
      <div className="relative">
        <div className="absolute left-0 top-0 bottom-5 w-9 flex flex-col justify-between items-end pr-1.5 text-[9px] font-mono text-slate-500 pointer-events-none">
          <span>100%</span>
          <span>50%</span>
          <span>0%</span>
        </div>
        <svg
          id={id}
          viewBox={`0 0 ${VB_WIDTH} ${H}`}
          preserveAspectRatio="none"
          className="w-full h-[190px] pl-9"
          role="img"
        >
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <line
              key={v}
              x1={0}
              x2={VB_WIDTH}
              y1={y(v)}
              y2={y(v)}
              stroke="#1f1f23"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <polyline
            points={line("consolidation")}
            fill="none"
            stroke={CLASS_COLORS.consolidation}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
          <polyline
            points={line("extension")}
            fill="none"
            stroke={CLASS_COLORS.extension}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
          <polyline
            points={line("collapse")}
            fill="none"
            stroke={CLASS_COLORS.collapse}
            strokeWidth={1.75}
            vectorEffect="non-scaling-stroke"
          />
          {pts.map((p, i) => (
            <circle
              key={i}
              cx={x(p.phase)}
              cy={y(p.collapse)}
              r={p.gated ? 3 : 2.5}
              fill={p.gated ? CLASS_COLORS.collapse : "transparent"}
              stroke={CLASS_COLORS.collapse}
              strokeWidth={p.gated ? 0 : 1.5}
              opacity={p.gated ? 1 : 0.5}
            >
              <title>{`${p.iso} · t+${p.barsSinceBreak} bars (phase ${pct(p.phase, 0)}) · collapse ${pct(p.collapse)} · rho ${p.rho.toFixed(2)} · nEff ${p.nEff.toFixed(1)}${p.gated ? "" : " · GATE FAILED (base rate shown)"}`}</title>
            </circle>
          ))}
          {last && (
            <circle cx={x(last.phase)} cy={y(last.collapse)} r={6} fill="none" stroke={CLASS_COLORS.collapse} strokeWidth={1.5} vectorEffect="non-scaling-stroke" opacity={0.8} />
          )}
        </svg>
        <div className="flex justify-between pl-9 text-[9px] font-mono text-slate-500 mt-1">
          <span>t_break</span>
          <span>phase 0.5</span>
          <span>+{episode.horizonBars} bars (h)</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[9px] font-mono text-slate-500">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-4" style={{ background: CLASS_COLORS.collapse }} />
          collapse
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-4" style={{ background: CLASS_COLORS.extension }} />
          extension
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-4" style={{ background: CLASS_COLORS.consolidation }} />
          consolidation
        </span>
        <span>hollow = gate failed (base rate substituted)</span>
        <span>
          resolved:{" "}
          {episode.resolvedLabel === null
            ? episode.active
              ? "open"
              : "expired"
            : episode.resolvedLabel === -1
            ? "COLLAPSE"
            : episode.resolvedLabel === 1
            ? "EXTENSION"
            : "CONSOLIDATION"}
        </span>
      </div>
    </div>
  );
}
