/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { ReactNode, useMemo, useState } from "react";
import {
  BetaAsymmetry,
  CorrelationStability,
  CrossCorrelationSpectrum,
  VolatilityRegime,
  RollingCoupling,
} from "../../types";
import { formatUtcStamp } from "../../utils/dates";
import { useChartViewport } from "../../utils/useChartViewport";

/*
 * Every chart below is stretched to full width with `preserveAspectRatio="none"`
 * so it keeps a fixed height on any viewport. That stretching distorts text and
 * stroke widths inside the SVG, so two rules apply throughout:
 *
 *   1. NO text is rendered inside a stretched SVG. Labels live in HTML around
 *      the figure, where they stay legible.
 *   2. Strokes that must stay 1.5px carry `vectorEffect="non-scaling-stroke"`.
 */

const VB_WIDTH = 720;

export function TerminalPanel({
  id,
  eyebrow,
  title,
  subtitle,
  right,
  children,
  className = "",
}: {
  id?: string;
  eyebrow: string;
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      className={`bg-[#0e0e10] border border-[#1f1f23] rounded-xl p-5 hover:border-slate-700/60 transition-all flex flex-col ${className}`}
    >
      <div className="flex justify-between items-start gap-4 mb-4">
        <div className="min-w-0">
          <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest block">
            {eyebrow}
          </span>
          <h3 className="text-sm font-mono text-white font-semibold mt-0.5">{title}</h3>
          {subtitle && (
            <p className="text-[11px] text-slate-400 mt-1.5 leading-relaxed max-w-4xl">{subtitle}</p>
          )}
        </div>
        {right && <div className="shrink-0 text-right">{right}</div>}
      </div>
      {children}
    </section>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-[140px] items-center justify-center border border-[#1f1f23] border-dashed rounded bg-[#0a0a0b]/25">
      <span className="text-xs text-slate-500 font-mono">{message}</span>
    </div>
  );
}

/** Compact colour-key used instead of in-SVG axis labels. */
export function Legend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[9px] font-mono text-slate-500 border-t border-[#1f1f23] pt-2 mt-2">
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-[2px] rounded-full" style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

function formatLagDuration(lag: number, minutesPerBar: number): string {
  const minutes = Math.abs(lag) * minutesPerBar;
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}

/* -------------------------------------------------------------------------- *
 * Lead/Lag cross-correlation spectrum
 * -------------------------------------------------------------------------- */

export function CrossCorrelationSpectrumChart({
  id,
  spectrum,
  minutesPerBar,
}: {
  id: string;
  spectrum: CrossCorrelationSpectrum;
  minutesPerBar: number;
}) {
  const [hoverLag, setHoverLag] = useState<number | null>(null);

  const width = VB_WIDTH;
  const height = 210;
  const paddingX = 26;
  const paddingY = 18;

  const points = spectrum.points;

  // Autoscale so the near-zero off-peak lags stay readable, but never narrower
  // than 0.15 so a flat spectrum cannot look dramatic.
  const limit = useMemo(() => {
    const peak = points.reduce((acc, p) => Math.max(acc, Math.abs(p.coefficient)), 0);
    return Math.max(0.15, peak * 1.35);
  }, [points]);

  const mapY = (v: number) => paddingY + ((limit - v) / (2 * limit)) * (height - 2 * paddingY);
  const zeroY = mapY(0);
  const mapX = (i: number) =>
    points.length <= 1 ? paddingX : paddingX + (i / (points.length - 1)) * (width - 2 * paddingX);

  const hovered = hoverLag !== null ? points.find((p) => p.lag === hoverLag) ?? null : null;

  // Thin the tick labels out as the lag range widens, so 100 bars stay readable.
  const labelStride = Math.max(1, Math.ceil(points.length / 17));
  const thresholdY = mapY(Math.min(spectrum.threshold, limit * 0.98));

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (points.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    // Normalize against the real pixel width, not the viewBox: the SVG is
    // stretched, so viewBox coordinates do not match client coordinates.
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHoverLag(points[Math.round(ratio * (points.length - 1))].lag);
  };

  return (
    <div id={id} className="flex flex-col">
      <div className="flex justify-between items-end mb-3 gap-4">
        <div className="text-[10px] font-mono text-slate-500 leading-relaxed">
          <span className="text-rose-300/90">
            family-wise |r| &gt; {spectrum.threshold.toFixed(3)}
          </span>{" "}
          &nbsp;|&nbsp; 95% single-pair {spectrum.threshold95.toFixed(3)} &nbsp;|&nbsp;{" "}
          {points[0]?.observations ?? 0} pairs at lag 0
        </div>
        <div className="text-right font-mono min-h-[34px]">
          {hovered ? (
            <>
              <div className="text-[10px] text-slate-500">
                LAG {hovered.lag > 0 ? "+" : ""}
                {hovered.lag} ({hovered.lag > 0 ? "BASE LEADS" : hovered.lag < 0 ? "COIN LEADS" : "SYNC"})
                &nbsp;=&nbsp;{formatLagDuration(hovered.lag, minutesPerBar)}
              </div>
              <div
                className={`text-sm font-bold ${
                  hovered.significant ? "text-emerald-400" : hovered.significant95 ? "text-slate-200" : "text-slate-500"
                }`}
              >
                r = {hovered.coefficient.toFixed(4)}
                <span className="text-[9px] ml-1.5 text-slate-500">
                  se {hovered.standardError.toFixed(4)} · n_eff {hovered.effectiveSamples}
                </span>
              </div>
            </>
          ) : (
            <span className="text-[10px] font-mono text-slate-500 italic">
              Hover the spectrum to inspect any offset
            </span>
          )}
        </div>
      </div>

      {points.length === 0 ? (
        <EmptyState message="No overlapping bars available for a lead/lag scan." />
      ) : (
        <>
          <svg
            width="100%"
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            className="overflow-visible select-none cursor-crosshair"
            onMouseMove={handleMove}
            onMouseLeave={() => setHoverLag(null)}
          >
            {/* family-wise significance thresholds */}
            <line
              x1={paddingX}
              y1={thresholdY}
              x2={width - paddingX}
              y2={thresholdY}
              className="stroke-rose-400/50"
              strokeWidth={1}
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={paddingX}
              y1={height - thresholdY}
              x2={width - paddingX}
              y2={height - thresholdY}
              className="stroke-rose-400/50"
              strokeWidth={1}
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />

            <line
              x1={paddingX}
              y1={zeroY}
              x2={width - paddingX}
              y2={zeroY}
              className="stroke-slate-600"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />

            {points.map((point, i) => {
              const cx = mapX(i);
              const cy = mapY(point.coefficient);
              const barW = Math.max(2, ((width - 2 * paddingX) / points.length) * 0.72);
              const yStart = Math.min(zeroY, cy);
              const barH = Math.max(1, Math.abs(cy - zeroY));

              let fill = "fill-slate-800";
              if (point.significant) fill = "fill-emerald-400";
              else if (point.significant95) fill = "fill-slate-400";
              if (point.isPeak) fill = "fill-emerald-500";

              return (
                <rect
                  key={point.lag}
                  x={cx - barW / 2}
                  y={yStart}
                  width={barW}
                  height={barH}
                  rx={1}
                  className={`${fill} transition-opacity duration-150 ${
                    hoverLag === null || hoverLag === point.lag ? "opacity-100" : "opacity-45"
                  }`}
                  stroke={point.lag === 0 ? "rgba(255,255,255,0.35)" : "none"}
                  strokeWidth={point.lag === 0 ? 1 : 0}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}

            {hovered && (
              <line
                x1={mapX(points.findIndex((p) => p.lag === hovered.lag))}
                y1={paddingY - 8}
                x2={mapX(points.findIndex((p) => p.lag === hovered.lag))}
                y2={height - paddingY + 8}
                className="stroke-white/40"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>

          <div className="flex justify-between text-[9px] font-mono text-slate-600 border-t border-[#1f1f23] pt-1.5 mt-1">
            <span>-{spectrum.points.length > 0 ? Math.abs(points[0].lag) : 0} bars</span>
            <span>0</span>
            <span>+{points.length > 0 ? Math.abs(points[points.length - 1].lag) : 0} bars</span>
          </div>

          <Legend
            items={[
              { color: "#10b981", label: "survives multiple-testing correction" },
              { color: "#94a3b8", label: "significant at plain 95% only" },
              { color: "#1e293b", label: "not significant" },
              { color: "#fb7185", label: "family-wise threshold" },
            ]}
          />
        </>
      )}

      {/* Tick row: only every Nth lag, so wide scans stay legible. */}
      <div className="flex justify-between text-[9px] font-mono text-slate-600 mt-1 px-0.5">
        {points
          .filter((_, i) => i % labelStride === 0 || i === points.length - 1)
          .map((p) => (
            <span key={p.lag}>{p.lag > 0 ? `+${p.lag}` : p.lag}</span>
          ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Conditional beta asymmetry
 * -------------------------------------------------------------------------- */

export function BetaAsymmetryChart({ id, asymmetry }: { id: string; asymmetry: BetaAsymmetry }) {
  const segments = [
    { label: "Market Up", value: asymmetry.marketUp.beta, n: asymmetry.marketUp.observations },
    { label: "Market Down", value: asymmetry.marketDown.beta, n: asymmetry.marketDown.observations },
    { label: "Downside p10", value: asymmetry.marketTailDown.beta, n: asymmetry.marketTailDown.observations },
    { label: "Extreme p05", value: asymmetry.marketExtremeDown.beta, n: asymmetry.marketExtremeDown.observations },
  ];

  const maxAbs = Math.max(0.5, ...segments.map((s) => Math.abs(s.value)));

  return (
    <div id={id} className="space-y-2.5">
      {segments.map((s) => {
        const pct = (Math.abs(s.value) / maxAbs) * 50;
        const isDown = s.label !== "Market Up";
        return (
          <div key={s.label} className="flex items-center gap-3">
            <span className="w-24 shrink-0 text-[10px] font-mono text-slate-400 text-right">{s.label}</span>
            <div className="flex-1 relative h-5 bg-[#0a0a0b] border border-[#1f1f23]/60 rounded-sm overflow-hidden">
              {/* zero line at the centre */}
              <div className="absolute left-1/2 top-0 h-full w-px bg-slate-600" />
              {/* Beta is signed, so the bar has to grow the correct side of zero.
                  A negative downside beta is a genuine reading, not a broken
                  bar, so it extends left rather than being clamped away. */}
              <div
                className={`absolute top-0 h-full ${
                  isDown ? "bg-rose-500/70" : "bg-emerald-500/70"
                }`}
                style={
                  s.value >= 0
                    ? { left: "50%", width: `${pct}%` }
                    : { left: `${50 - pct}%`, width: `${pct}%` }
                }
              />
              <span className="absolute inset-y-0 right-2 flex items-center text-[10px] font-mono text-white">
                {s.value.toFixed(3)}
              </span>
              <span className="absolute inset-y-0 left-2 flex items-center text-[9px] font-mono text-slate-500">
                n={s.n}
              </span>
            </div>
          </div>
        );
      })}
      <Legend
        items={[
          { color: "#10b981", label: "benchmark up bars" },
          { color: "#f43f5e", label: "benchmark down / tail bars" },
        ]}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Correlation stability
 * -------------------------------------------------------------------------- */

export function StabilitySeriesChart({ id, stability }: { id: string; stability: CorrelationStability }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const series = stability.series;

  const width = VB_WIDTH;
  const height = 190;
  const paddingX = 8;
  const paddingY = 16;

  const mapX = (i: number) =>
    series.length <= 1 ? paddingX : paddingX + (i / (series.length - 1)) * (width - 2 * paddingX);
  const mapY = (v: number) => paddingY + ((1 - v) / 2) * (height - 2 * paddingY);

  const linePath = useMemo(
    () => series.map((d, i) => `${i === 0 ? "M" : "L"} ${mapX(i)} ${mapY(d.value)}`).join(" "),
    [series]
  );

  // Mean +/- 1 sd envelope: the visual definition of "stable".
  const bandPath = useMemo(() => {
    if (series.length === 0) return "";
    const upper = stability.mean + stability.stdDev;
    const lower = stability.mean - stability.stdDev;
    const top = series.map((_, i) => `${mapX(i)} ${mapY(Math.min(1, upper))}`).join(" L ");
    const bottom = series
      .map((_, i) => `${mapX(i)} ${mapY(Math.max(-1, lower))}`)
      .reverse()
      .join(" L ");
    return `M ${top} L ${bottom} Z`;
  }, [series, stability.mean, stability.stdDev]);

  const hovered = hoverIndex !== null ? series[hoverIndex] ?? null : null;

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (series.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHoverIndex(Math.round(ratio * (series.length - 1)));
  };

  return (
    <div id={id} className="flex flex-col">
      <div className="flex justify-between items-end mb-2 gap-4">
        <span className="text-[10px] font-mono text-slate-500">
          {stability.window}-bar rolling window · {series.length} readings
        </span>
        <div className="text-right font-mono min-h-[32px]">
          {hovered ? (
            <>
              <div className="text-[10px] text-slate-500">{formatUtcStamp(hovered.time)} UTC</div>
              <div className="text-sm font-bold text-emerald-400">r = {hovered.value.toFixed(4)}</div>
            </>
          ) : (
            <span className="text-[10px] font-mono text-slate-500 italic">Hover to inspect</span>
          )}
        </div>
      </div>

      {series.length === 0 ? (
        <EmptyState message="Rolling correlation needs more bars than the window consumes." />
      ) : (
        <>
          <svg
            width="100%"
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            className="overflow-visible select-none cursor-crosshair"
            onMouseMove={handleMove}
            onMouseLeave={() => setHoverIndex(null)}
          >
            <rect x={paddingX} y={paddingY} width={width - 2 * paddingX} height={height - 2 * paddingY} className="fill-[#0a0a0b]/40" />
            {[1, 0.5, 0, -0.5, -1].map((tick) => (
              <line
                key={tick}
                x1={paddingX}
                y1={mapY(tick)}
                x2={width - paddingX}
                y2={mapY(tick)}
                className={tick === 0 ? "stroke-slate-600" : "stroke-[#1f1f23]"}
                strokeWidth={1}
                strokeDasharray={tick === 0 ? undefined : "4 4"}
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {bandPath && <path d={bandPath} className="fill-emerald-500/10" />}

            <line
              x1={paddingX}
              y1={mapY(stability.mean)}
              x2={width - paddingX}
              y2={mapY(stability.mean)}
              className="stroke-amber-400/60"
              strokeWidth={1}
              strokeDasharray="6 3"
              vectorEffect="non-scaling-stroke"
            />

            <path d={linePath} className="stroke-emerald-400" strokeWidth={1.5} fill="none" vectorEffect="non-scaling-stroke" />

            {/* current reading, pinned to the right edge */}
            <circle cx={mapX(series.length - 1)} cy={mapY(stability.current)} r={3.5} className="fill-emerald-500" />

            {hovered && (
              <>
                <line x1={mapX(hoverIndex ?? 0)} y1={paddingY} x2={mapX(hoverIndex ?? 0)} y2={height - paddingY} className="stroke-white/30" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                <circle cx={mapX(hoverIndex ?? 0)} cy={mapY(hovered.value)} r={3.5} className="fill-white" />
              </>
            )}
          </svg>
          <Legend
            items={[
              { color: "#34d399", label: `rolling r (current ${stability.current.toFixed(3)})` },
              { color: "#fbbf24", label: `window mean ${stability.mean.toFixed(3)}` },
              { color: "#065f46", label: "mean ± 1 sd" },
            ]}
          />
        </>
      )}
    </div>
  );
}

export function StabilityHistogram({ id, stability }: { id: string; stability: CorrelationStability }) {
  const maxShare = Math.max(1, ...stability.buckets.map((b) => b.sharePct));
  return (
    <div id={id} className="space-y-1.5">
      {stability.buckets.map((bucket) => (
        <div key={bucket.label} className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-[9px] font-mono text-slate-500 text-right">{bucket.label}</span>
          <div className="flex-1 h-3 bg-[#0a0a0b] border border-[#1f1f23]/60 rounded-sm overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-emerald-600/70 to-emerald-400/70"
              style={{ width: `${(bucket.sharePct / maxShare) * 100}%` }}
            />
          </div>
          <span className="w-12 shrink-0 text-[9px] font-mono text-slate-400">
            {bucket.sharePct.toFixed(1)}%
          </span>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Residual z-score
 * -------------------------------------------------------------------------- */

export function ResidualZScoreChart({
  id,
  series,
  title,
  bands,
  unit,
}: {
  id: string;
  series: { time: number; value: number }[];
  title: string;
  bands: number[];
  unit: string;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const width = VB_WIDTH;
  const height = 170;
  const paddingX = 8;
  const paddingY = 14;

  const limit = Math.max(
    2.5,
    ...series.map((d) => Math.abs(d.value)),
    ...bands.map((b) => Math.abs(b))
  ) * 1.1;

  // Drag a rectangle to zoom into a dense stretch of hourly bars; Shift+drag
  // pans, double-click restores. `yRange` gives the vertical window its scale.
  const {
    svgRef,
    viewport,
    span,
    yDomain,
    selection,
    isZoomed,
    reset,
    fractionFromClientX,
    svgProps,
  } = useChartViewport(series.length, {
    leftPadPx: paddingX,
    rightPadPx: paddingX,
    boxZoom: true,
    yRange: [-limit, limit],
    topPadPx: paddingY,
    bottomPadPx: paddingY,
  });

  const yTop = yDomain ? yDomain.max : limit;
  const yBottom = yDomain ? yDomain.min : -limit;
  const ySpan = Math.max(1e-9, yTop - yBottom);

  const mapX = (i: number) =>
    span <= 0 ? paddingX : paddingX + ((i - viewport.start) / span) * (width - 2 * paddingX);
  const mapY = (v: number) => paddingY + ((yTop - v) / ySpan) * (height - 2 * paddingY);
  const zeroY = mapY(0);

  // Only the visible slice is emitted, so a zoomed window stays cheap and the
  // path never runs far past the card.
  const visible = useMemo(() => {
    const from = Math.max(0, Math.floor(viewport.start) - 1);
    const to = Math.min(series.length - 1, Math.ceil(viewport.end) + 1);
    return series.slice(from, to + 1).map((d, i) => ({ ...d, index: from + i }));
  }, [series, viewport.start, viewport.end]);

  const linePath = useMemo(
    () => visible.map((d, i) => `${i === 0 ? "M" : "L"} ${mapX(d.index)} ${mapY(d.value)}`).join(" "),
    [visible, viewport.start, span, yTop, ySpan, width]
  );

  const hovered = hoverIndex !== null ? series[hoverIndex] ?? null : null;

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (series.length === 0) return;
    const index = Math.round(viewport.start + fractionFromClientX(e.clientX) * span);
    if (index >= 0 && index < series.length) setHoverIndex(index);
    else setHoverIndex(null);
  };

  return (
    <div id={id} className="flex flex-col">
      <div className="flex justify-between items-end mb-2 gap-4">
        <span className="text-[10px] font-mono text-slate-500">{title}</span>
        <div className="text-right font-mono min-h-[30px]">
          {hovered ? (
            <>
              <div className="text-[10px] text-slate-500">{formatUtcStamp(hovered.time)} UTC</div>
              <div className={`text-sm font-bold ${hovered.value > 0 ? "text-rose-400" : "text-emerald-400"}`}>
                {hovered.value > 0 ? "+" : ""}
                {hovered.value.toFixed(3)} {unit}
              </div>
            </>
          ) : (
            <span className="text-[10px] font-mono text-slate-500 italic">Hover to inspect</span>
          )}
        </div>
      </div>

      {series.length === 0 ? (
        <EmptyState message="Residual series unavailable for this sample." />
      ) : (
        <>
          <svg
            ref={svgRef}
            width="100%"
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            className="select-none cursor-crosshair touch-none"
            onMouseMove={handleMove}
            onMouseLeave={() => setHoverIndex(null)}
            {...svgProps}
          >
            <defs>
              <clipPath id={`${id}-clip`}>
                <rect x={paddingX} y={paddingY} width={width - 2 * paddingX} height={height - 2 * paddingY} />
              </clipPath>
            </defs>

            <rect x={paddingX} y={paddingY} width={width - 2 * paddingX} height={height - 2 * paddingY} className="fill-[#0a0a0b]/40" />

            <g clipPath={`url(#${id}-clip)`}>
              {/* shade outside the alert bands so "unusual" is visually obvious */}
              {bands.map((band) => {
                const upperY = mapY(band);
                const lowerY = mapY(-band);
                return (
                  <g key={band}>
                    <rect x={paddingX} y={paddingY} width={width - 2 * paddingX} height={Math.max(0, upperY - paddingY)} className="fill-rose-500/[0.06]" />
                    <rect
                      x={paddingX}
                      y={lowerY}
                      width={width - 2 * paddingX}
                      height={Math.max(0, height - paddingY - lowerY)}
                      className="fill-emerald-500/[0.06]"
                    />
                    <line x1={paddingX} y1={upperY} x2={width - paddingX} y2={upperY} className="stroke-slate-500/60" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
                    <line x1={paddingX} y1={lowerY} x2={width - paddingX} y2={lowerY} className="stroke-slate-500/60" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
                  </g>
                );
              })}

              <line x1={paddingX} y1={zeroY} x2={width - paddingX} y2={zeroY} className="stroke-slate-600" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <path d={linePath} className="stroke-emerald-400" strokeWidth={1.5} fill="none" vectorEffect="non-scaling-stroke" />

              <circle cx={mapX(series.length - 1)} cy={mapY(series[series.length - 1].value)} r={3.5} className="fill-emerald-500" />

              {hovered && (
                <>
                  <line x1={mapX(hoverIndex ?? 0)} y1={paddingY} x2={mapX(hoverIndex ?? 0)} y2={height - paddingY} className="stroke-white/30" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                  <circle cx={mapX(hoverIndex ?? 0)} cy={mapY(hovered.value)} r={3.5} className="fill-white" />
                </>
              )}
            </g>

            {selection && (
              <rect
                x={paddingX + selection.x0 * (width - 2 * paddingX)}
                y={paddingY + selection.y0 * (height - 2 * paddingY)}
                width={Math.max(0, (selection.x1 - selection.x0) * (width - 2 * paddingX))}
                height={Math.max(0, (selection.y1 - selection.y0) * (height - 2 * paddingY))}
                className="fill-emerald-400/10 stroke-emerald-400/70"
                strokeWidth={1}
                strokeDasharray="3 3"
                pointerEvents="none"
              />
            )}
          </svg>

          <div className="flex items-center justify-between mt-1 text-[9px] font-mono text-slate-600 gap-3">
            <span className="truncate">
              {isZoomed ? "Box-zoomed window" : "Drag a box to zoom · Shift+drag to pan · double-click to reset"}
            </span>
            {isZoomed && (
              <button
                type="button"
                onClick={reset}
                className="shrink-0 px-1.5 h-5 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 cursor-pointer"
              >
                RESET
              </button>
            )}
          </div>

          <Legend
            items={[
              { color: "#34d399", label: title },
              { color: "#64748b", label: `alert bands ±${bands.join("/")} ${unit}` },
            ]}
          />
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Volatility regime
 * -------------------------------------------------------------------------- */

const REGIME_COLORS: Record<string, string> = {
  CRISIS: "#e11d48",
  EXPANSION: "#f97316",
  ELEVATED: "#eab308",
  NORMAL: "#10b981",
  COMPRESSION: "#38bdf8",
};

export function VolatilityRegimeChart({ id, volatility }: { id: string; volatility: VolatilityRegime }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const series = volatility.series;
  const width = VB_WIDTH;
  const height = 190;
  const paddingX = 8;
  const paddingY = 14;

  const maxVol = useMemo(
    () => Math.max(0.05, ...series.map((s) => Math.max(s.coinVol, s.baseVol))) * 1.15,
    [series]
  );

  const mapX = (i: number) =>
    series.length <= 1 ? paddingX : paddingX + (i / (series.length - 1)) * (width - 2 * paddingX);
  const mapY = (v: number) => paddingY + (1 - v / maxVol) * (height - 2 * paddingY);

  const coinPath = useMemo(
    () => series.map((d, i) => `${i === 0 ? "M" : "L"} ${mapX(i)} ${mapY(d.coinVol)}`).join(" "),
    [series]
  );
  const basePath = useMemo(
    () => series.map((d, i) => `${i === 0 ? "M" : "L"} ${mapX(i)} ${mapY(d.baseVol)}`).join(" "),
    [series]
  );

  const hovered = hoverIndex !== null ? series[hoverIndex] ?? null : null;

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (series.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHoverIndex(Math.round(ratio * (series.length - 1)));
  };

  return (
    <div id={id} className="flex flex-col">
      <div className="flex justify-between items-end mb-2 gap-4">
        <span className="text-[10px] font-mono text-slate-500">
          {volatility.window}-bar realized vol, annualized · peak of scale {(maxVol * 100).toFixed(0)}%
        </span>
        <div className="text-right font-mono min-h-[32px]">
          {hovered ? (
            <>
              <div className="text-[10px] text-slate-500">{formatUtcStamp(hovered.time)} UTC</div>
              <div className="text-[11px] font-mono">
                <span className="text-emerald-400">{(hovered.coinVol * 100).toFixed(1)}%</span>
                <span className="text-slate-600"> / </span>
                <span className="text-sky-400">{(hovered.baseVol * 100).toFixed(1)}%</span>
                <span className="text-slate-600"> · {hovered.ratio.toFixed(2)}x</span>
              </div>
            </>
          ) : (
            <span className="text-[10px] font-mono text-slate-500 italic">Hover to inspect</span>
          )}
        </div>
      </div>

      {series.length === 0 ? (
        <EmptyState message="Volatility series unavailable for this sample." />
      ) : (
        <>
          <svg
            width="100%"
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            className="overflow-visible select-none cursor-crosshair"
            onMouseMove={handleMove}
            onMouseLeave={() => setHoverIndex(null)}
          >
            <rect x={paddingX} y={paddingY} width={width - 2 * paddingX} height={height - 2 * paddingY} className="fill-[#0a0a0b]/40" />
            {[0.25, 0.5, 0.75].map((frac) => (
              <line
                key={frac}
                x1={paddingX}
                y1={paddingY + frac * (height - 2 * paddingY)}
                x2={width - paddingX}
                y2={paddingY + frac * (height - 2 * paddingY)}
                className="stroke-[#1f1f23]"
                strokeWidth={1}
                strokeDasharray="4 4"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <path d={basePath} className="stroke-sky-400/70" strokeWidth={1.5} fill="none" vectorEffect="non-scaling-stroke" />
            <path d={coinPath} className="stroke-emerald-400" strokeWidth={1.5} fill="none" vectorEffect="non-scaling-stroke" />
            {hovered && (
              <line x1={mapX(hoverIndex ?? 0)} y1={paddingY} x2={mapX(hoverIndex ?? 0)} y2={height - paddingY} className="stroke-white/30" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            )}
          </svg>
          <Legend
            items={[
              { color: "#34d399", label: "subject annualized vol" },
              { color: "#38bdf8", label: "benchmark annualized vol" },
            ]}
          />
        </>
      )}
    </div>
  );
}

/**
 * Regime timeline: contiguous vol-regime bands across the window.
 * Only the most recent spans are drawn; a full window can flip regime dozens of
 * times and rendering all of them is unreadable rather than informative.
 */
export function RegimeSpanStrip({
  id,
  spans,
  maxSpans = 16,
}: {
  id: string;
  spans: { label: string; startTime: number; endTime: number; bars: number }[];
  maxSpans?: number;
}) {
  const visible = spans.slice(-maxSpans);
  if (visible.length === 0) return <EmptyState message="No regime spans computed." />;

  const first = visible[0].startTime;
  const last = visible[visible.length - 1].endTime;
  const span = Math.max(1, last - first);

  return (
    <div id={id} className="space-y-2">
      <div className="flex h-7 rounded overflow-hidden border border-[#1f1f23]">
        {visible.map((s, i) => (
          <div
            key={`${s.startTime}-${i}`}
            className="h-full"
            style={{
              width: `${Math.max(0.4, ((s.endTime - s.startTime) / span) * 100)}%`,
              background: REGIME_COLORS[s.label] ?? "#334155",
            }}
            title={`${s.label} · ${s.bars} bars · ${formatUtcStamp(s.startTime)} UTC`}
          />
        ))}
      </div>
      <div className="flex justify-between text-[9px] font-mono text-slate-600">
        <span>last {visible.length} regime change{visible.length === 1 ? "" : "s"}</span>
        <div className="flex flex-wrap gap-x-3">
          {Object.entries(REGIME_COLORS).map(([label, color]) => (
            <span key={label} className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-sm" style={{ background: color }} />
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export { REGIME_COLORS };

/* -------------------------------------------------------------------------- *
 * Rolling coupling: beta / correlation / vol ratio with own-history percentiles
 * -------------------------------------------------------------------------- */

const ROLLING_PANE_H = 70;
const ROLLING_PANE_GAP = 4;
const ROLLING_PAD_X = 8;
const ROLLING_PAD_TOP = 6;
const ROLLING_PAD_BOT = 6;
const ROLLING_HEIGHT = ROLLING_PAD_TOP + ROLLING_PAD_BOT + ROLLING_PANE_H * 3 + ROLLING_PANE_GAP * 2;

const ROLLING_COLORS = {
  beta: "#fb7185",
  correlation: "#34d399",
  volRatio: "#38bdf8",
} as const;

function percentilePillClass(label: string): string {
  switch (label) {
    case "HIGH":
      return "bg-rose-500/15 text-rose-400 border-rose-500/40";
    case "LOW":
      return "bg-emerald-500/15 text-emerald-400 border-emerald-500/40";
    default:
      return "bg-slate-500/15 text-slate-400 border-slate-500/40";
  }
}

/**
 * Rolling beta, correlation and coin/base vol ratio drawn on one time axis,
 * every metric's current reading ranked against its OWN history. Interactive:
 * drag a box to zoom, Shift+drag to pan, wheel zooms, double-click resets.
 * Hovering shows the three readings at the same bar.
 */
export function RollingCouplingChart({ id, rolling }: { id: string; rolling: RollingCoupling }) {
  const series = rolling.series;
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const {
    svgRef,
    width,
    viewport,
    span: viewSpan,
    selection,
    isZoomed,
    reset,
    fractionFromClientX,
    svgProps,
  } = useChartViewport(series.length, {
    leftPadPx: ROLLING_PAD_X,
    rightPadPx: ROLLING_PAD_X,
    boxZoom: true,
    topPadPx: ROLLING_PAD_TOP,
    bottomPadPx: ROLLING_PAD_BOT,
  });

  type RollingPaneKey = "beta" | "correlation" | "volRatio";

  const panes: { key: RollingPaneKey; values: number[]; fixed?: readonly [number, number] }[] = useMemo(
    () => [
      { key: "beta", values: series.map((s) => s.beta) },
      { key: "correlation", values: series.map((s) => s.correlation), fixed: [-1.15, 1.15] as const },
      { key: "volRatio", values: series.map((s) => s.volRatio) },
    ],
    [series]
  );

  const baselines: Record<string, number> = { beta: 0, correlation: 0, volRatio: 1 };

  // Vertical domains come from the FULL series so they stay stable while the
  // user zooms and pans in time.
  const domains = useMemo(
    () =>
      panes.map((p) => {
        if (p.fixed) return p.fixed;
        let lo = Math.min(...p.values);
        let hi = Math.max(...p.values);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [-1, 1];
        const range = hi - lo || Math.max(1, Math.abs(lo) * 0.1);
        return [lo - range * 0.08, hi + range * 0.08];
      }),
    [panes]
  );

  const mapX = (i: number) =>
    viewSpan <= 0 ? ROLLING_PAD_X : ROLLING_PAD_X + ((i - viewport.start) / viewSpan) * (width - 2 * ROLLING_PAD_X);

  const paneTop = (i: number) => ROLLING_PAD_TOP + i * (ROLLING_PANE_H + ROLLING_PANE_GAP);

  const mapY = (i: number, v: number) => {
    const lo = domains[i][0];
    const hi = domains[i][1];
    const y = paneTop(i) + ((hi - v) / (hi - lo)) * ROLLING_PANE_H;
    return Math.min(paneTop(i) + ROLLING_PANE_H, Math.max(paneTop(i), y));
  };

  const visible = useMemo(() => {
    const from = Math.max(0, Math.floor(viewport.start) - 1);
    const to = Math.min(series.length - 1, Math.ceil(viewport.end) + 1);
    return series.slice(from, to + 1).map((d, i) => ({ ...d, index: from + i }));
  }, [series, viewport.start, viewport.end]);

  const linePaths = useMemo(
    () =>
      panes.map((p, i) =>
        visible
          .map((d, j) => `${j === 0 ? "M" : "L"} ${mapX(d.index)} ${mapY(i, p.values[d.index])}`)
          .join(" ")
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, viewport.start, viewSpan, width, domains]
  );

  const hovered = hoverIndex !== null ? series[hoverIndex] ?? null : null;

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (series.length === 0) return;
    const index = Math.round(viewport.start + fractionFromClientX(e.clientX) * viewSpan);
    if (index >= 0 && index < series.length) setHoverIndex(index);
    else setHoverIndex(null);
  };

  const cells = panes.map((p) => {
    const stats = rolling[p.key];
    const value = hovered ? p.values[hoverIndex ?? 0] : stats.current;
    return {
      ...p,
      stats,
      value,
      decimals: p.key === "correlation" ? 3 : 2,
    };
  });

  return (
    <div id={id} className="flex flex-col">
      <div className="grid grid-cols-3 gap-2 mb-2">
        {cells.map((c) => (
          <div key={c.key} className="rounded border border-[#1f1f23] bg-[#0a0a0b]/40 px-2 py-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[9px] font-mono text-slate-500 uppercase" style={{ color: ROLLING_COLORS[c.key] }}>
                {c.key === "volRatio" ? "vol ratio" : c.key}
              </span>
              <span
                className={`rounded border px-1 py-px text-[9px] font-mono leading-3 ${percentilePillClass(c.stats.label)}`}
              >
                p{Math.round(c.stats.percentile)} · {c.stats.label}
              </span>
            </div>
            <div className="text-sm font-bold font-mono text-slate-100">{c.value.toFixed(c.decimals)}</div>
            <div className="text-[9px] font-mono text-slate-600">
              {hovered ? `@ ${formatUtcStamp(hovered.time)} UTC` : "latest"}
            </div>
          </div>
        ))}
      </div>

      {series.length === 0 ? (
        <EmptyState message="Rolling coupling series unavailable for this sample." />
      ) : (
        <>
          <svg
            ref={svgRef}
            width="100%"
            height={ROLLING_HEIGHT}
            viewBox={`0 0 ${width} ${ROLLING_HEIGHT}`}
            preserveAspectRatio="none"
            className="select-none cursor-crosshair touch-none"
            onMouseMove={handleMove}
            onMouseLeave={() => setHoverIndex(null)}
            {...svgProps}
          >
            {panes.map((p, i) => {
              const lo = domains[i][0];
              const hi = domains[i][1];
              const top = paneTop(i);
              const baseline = baselines[p.key];
              return (
                <g key={p.key}>
                  <rect
                    x={ROLLING_PAD_X}
                    y={top}
                    width={width - 2 * ROLLING_PAD_X}
                    height={ROLLING_PANE_H}
                    className="fill-[#0a0a0b]/40"
                  />
                  {[0.25, 0.5, 0.75].map((f) => (
                    <line
                      key={f}
                      x1={ROLLING_PAD_X}
                      y1={top + f * ROLLING_PANE_H}
                      x2={width - ROLLING_PAD_X}
                      y2={top + f * ROLLING_PANE_H}
                      className="stroke-slate-800/50"
                      strokeWidth={1}
                      strokeDasharray="2 4"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                  <line
                    x1={ROLLING_PAD_X}
                    y1={mapY(i, baseline)}
                    x2={width - ROLLING_PAD_X}
                    y2={mapY(i, baseline)}
                    className="stroke-slate-500/70"
                    strokeWidth={1}
                    strokeDasharray="4 3"
                    vectorEffect="non-scaling-stroke"
                  />
                  <path d={linePaths[i]} className="select-none" style={{ stroke: ROLLING_COLORS[p.key] }} strokeWidth={1.5} fill="none" vectorEffect="non-scaling-stroke" />
                  <circle
                    cx={mapX(series.length - 1)}
                    cy={mapY(i, p.values[series.length - 1])}
                    r={3}
                    style={{ fill: ROLLING_COLORS[p.key] }}
                  />
                  {hovered && (
                    <circle
                      cx={mapX(hoverIndex ?? 0)}
                      cy={mapY(i, p.values[hoverIndex ?? 0])}
                      r={3.5}
                      className="fill-white"
                    />
                  )}
                </g>
              );
            })}

            {hovered && (
              <line
                x1={mapX(hoverIndex ?? 0)}
                y1={ROLLING_PAD_TOP}
                x2={mapX(hoverIndex ?? 0)}
                y2={ROLLING_HEIGHT - ROLLING_PAD_BOT}
                className="stroke-white/30"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            )}

            {selection && (
              <g pointerEvents="none">
                <rect
                  x={ROLLING_PAD_X + selection.x0 * (width - 2 * ROLLING_PAD_X)}
                  y={ROLLING_PAD_TOP + selection.y0 * (ROLLING_HEIGHT - ROLLING_PAD_TOP - ROLLING_PAD_BOT)}
                  width={Math.max(0, (selection.x1 - selection.x0) * (width - 2 * ROLLING_PAD_X))}
                  height={Math.max(0, (selection.y1 - selection.y0) * (ROLLING_HEIGHT - ROLLING_PAD_TOP - ROLLING_PAD_BOT))}
                  className="fill-emerald-400/10 stroke-emerald-400/70"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                />
              </g>
            )}
          </svg>

          <div className="flex items-center justify-between mt-1 text-[9px] font-mono text-slate-600 gap-3">
            <span className="truncate">
              {isZoomed ? "Box-zoomed window" : "Drag a box to zoom · Shift+drag to pan · wheel zooms · double-click to reset"}
            </span>
            {isZoomed && (
              <button
                type="button"
                onClick={reset}
                className="shrink-0 px-1.5 h-5 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 cursor-pointer"
              >
                RESET
              </button>
            )}
          </div>

          <Legend
            items={[
              { color: ROLLING_COLORS.beta, label: "beta" },
              { color: ROLLING_COLORS.correlation, label: "correlation" },
              { color: ROLLING_COLORS.volRatio, label: "coin/base vol ratio" },
            ]}
          />
        </>
      )}
    </div>
  );
}