/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from "react";
import { useChartViewport } from "../utils/useChartViewport";
import { candleCloseUtc } from "../utils/dates";

interface RollingCorrelationChartProps {
  id: string;
  data: { time: number; value: number }[];
  timeframe: "1h" | "15m";
  /** Bars behind each point, echoed by the API after clamping to the sample. */
  windowBars: number;
}

const HEIGHT = 180;
const PADDING_X = 40;
const PADDING_Y = 20;
/** Nominal viewBox width for the single frame before measurement lands. */
const FALLBACK_WIDTH = 640;

const GRID_LINES = [1.0, 0.5, 0, -0.5, -1.0];

export default function RollingCorrelationChart({
  id,
  data,
  timeframe,
  windowBars,
}: RollingCorrelationChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const {
    svgRef,
    width,
    viewport,
    isZoomed,
    zoomFactor,
    reset,
    zoomBy,
    fractionFromClientX,
    svgProps,
  } = useChartViewport(data.length, { leftPadPx: PADDING_X });

  const cleanData = useMemo(
    () => data.filter((d) => !isNaN(d.value) && d.value !== null),
    [data]
  );

  const span = viewport.end - viewport.start;

  // Until the first measurement lands, geometry is drawn against a nominal
  // width. The svg stays mounted either way, so this is only ever one frame.
  const plotWidth = width || FALLBACK_WIDTH;

  const mapX = (index: number) => {
    if (span <= 0) return PADDING_X;
    return PADDING_X + ((index - viewport.start) / span) * (plotWidth - PADDING_X);
  };

  const mapY = (val: number) => {
    return PADDING_Y + ((1.0 - val) / 2.0) * (HEIGHT - 2 * PADDING_Y);
  };

  // Only the visible slice is emitted, so a zoomed path stays smooth instead of
  // carrying thousands of off-screen vertices.
  const visible = useMemo(() => {
    const from = Math.max(0, Math.floor(viewport.start));
    const to = Math.min(cleanData.length - 1, Math.ceil(viewport.end));
    return cleanData.slice(from, to + 1).map((d, i) => ({ ...d, index: from + i }));
  }, [cleanData, viewport]);

  const linePath = useMemo(
    () =>
      visible
        .map((d, i) => `${i === 0 ? "M" : "L"} ${mapX(d.index)} ${mapY(d.value)}`)
        .join(" "),
    [visible, viewport.start, span, plotWidth]
  );

  const areaPath = useMemo(() => {
    if (visible.length === 0) return "";
    const points = visible.map((d) => `${mapX(d.index)} ${mapY(d.value)}`);
    const firstX = mapX(visible[0].index);
    const lastX = mapX(visible[visible.length - 1].index);
    const zeroY = mapY(0);
    return `M ${firstX} ${zeroY} L ${points.join(" L ")} L ${lastX} ${zeroY} Z`;
  }, [visible, viewport.start, span, plotWidth]);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (cleanData.length === 0) return;
    const index = Math.round(viewport.start + fractionFromClientX(e.clientX) * span);
    if (index >= 0 && index < cleanData.length) setHoverIndex(index);
  };

  const hoverPoint = hoverIndex !== null ? cleanData[hoverIndex] : null;
  const firstVisible = cleanData[Math.ceil(viewport.start)];
  const lastVisible = cleanData[Math.floor(viewport.end)];

  // The feed drops the still-forming candle, so the newest bar's data is only
  // settled at its close boundary. Showing that boundary keeps this in step
  // with the header's DATA AS OF readout.
  const barMs = timeframe === "1h" ? 3600000 : 900000;

  return (
    <div
      id={id}
      className="bg-[#0e0e10] border border-[#1f1f23] rounded-xl p-5 hover:border-slate-700/60 transition-all flex flex-col"
    >
      <div className="flex justify-between items-center mb-4 gap-3">
        <div>
          <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest block">
            HISTORICAL CO-MOVEMENT TIMELINE
          </span>
          <h3 className="text-sm font-mono text-white font-semibold mt-0.5">
            Rolling Pearson Return Correlation ({windowBars}-Period Window)
          </h3>
        </div>
        <div className="text-right min-h-[36px] flex flex-col justify-center shrink-0">
          {hoverPoint ? (
            <div className="font-mono">
              <span className="text-[10px] text-slate-500 block">
                BAR CLOSE: {candleCloseUtc(hoverPoint.time, barMs)} UTC
              </span>
              <span
                className={`text-xs font-bold ${
                  hoverPoint.value >= 0.5
                    ? "text-emerald-400"
                    : hoverPoint.value <= -0.1
                    ? "text-rose-400"
                    : "text-slate-300"
                }`}
              >
                Correlation: {hoverPoint.value.toFixed(4)}
              </span>
            </div>
          ) : (
            <span className="text-[10px] font-mono text-slate-500 italic block">
              Hover timeline to inspect historical correlation shifts
            </span>
          )}
        </div>
      </div>

      <div className="relative flex-1 self-stretch">
        {cleanData.length > 0 ? (
          <svg
            ref={svgRef}
            width="100%"
            height={HEIGHT}
            // Before the first measurement lands the viewBox falls back to a
            // nominal width. The svg itself must always be mounted, because
            // that is the element the ResizeObserver measures.
            viewBox={`0 0 ${plotWidth} ${HEIGHT}`}
            className="select-none cursor-grab active:cursor-grabbing touch-none"
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setHoverIndex(null)}
            {...svgProps}
          >
            <defs>
              <linearGradient id="coolGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#10b981" stopOpacity="0.25" />
                <stop offset="50%" stopColor="#10b981" stopOpacity="0.02" />
                <stop offset="100%" stopColor="#ef4444" stopOpacity="0.10" />
              </linearGradient>
            </defs>

            {GRID_LINES.map((v) => (
              <g key={v}>
                <line
                  x1={PADDING_X}
                  y1={mapY(v)}
                  x2={plotWidth - PADDING_X}
                  y2={mapY(v)}
                  className={`${v === 0 ? "stroke-slate-700/50" : "stroke-[#1f1f23]"} stroke-1`}
                  strokeDasharray={v === 0 ? undefined : "4 4"}
                />
                <text
                  x={PADDING_X - 10}
                  y={mapY(v) + 3}
                  textAnchor="end"
                  className={`text-[9px] font-mono ${
                    v === 0 ? "fill-slate-400 font-semibold" : "fill-slate-500"
                  }`}
                >
                  {v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1)}
                </text>
              </g>
            ))}

            <path d={areaPath} fill="url(#coolGradient)" />
            <path
              d={linePath}
              className="stroke-emerald-400 stroke-[1.5px] fill-none transition-all duration-300"
              vectorEffect="non-scaling-stroke"
            />

            {hoverIndex !== null && hoverPoint && hoverIndex >= viewport.start && hoverIndex <= viewport.end && (
              <>
                <line
                  x1={mapX(hoverIndex)}
                  y1={PADDING_Y}
                  x2={mapX(hoverIndex)}
                  y2={HEIGHT - PADDING_Y}
                  className="stroke-[#10b981]/40 stroke-1"
                  strokeDasharray="2 2"
                />
                <circle
                  cx={mapX(hoverIndex)}
                  cy={mapY(hoverPoint.value)}
                  r={4}
                  className="fill-emerald-500 stroke-[#0e0e10] stroke-2"
                />
              </>
            )}
          </svg>
        ) : (
          <div className="flex h-[150px] items-center justify-center border border-[#1f1f23] border-dashed rounded bg-[#0a0a0b]/25">
            <span className="text-xs text-slate-500 font-mono text-center px-4 leading-relaxed">
              No rolling correlation points for this pair. The window needs more
              overlapping bars than the asset has in range.
            </span>
          </div>
        )}
      </div>

      <div className="flex justify-between items-center text-[10px] font-mono text-slate-500 mt-2 px-1 border-t border-[#1f1f23] pt-2 gap-3">
        <span className="shrink-0">{firstVisible ? `${candleCloseUtc(firstVisible.time, barMs)} UTC` : "START"}</span>

        <div className="flex items-center gap-2 justify-center flex-wrap">
          {isZoomed ? (
            <>
              <button
                type="button"
                onClick={() => zoomBy(1 / 1.4)}
                className="px-1.5 h-5 rounded border border-[#1f1f23] bg-[#0a0a0b] text-slate-400 hover:text-emerald-400 hover:border-emerald-500/40 cursor-pointer"
                title="Zoom out"
              >
                -
              </button>
              <span className="text-slate-500">{zoomFactor.toFixed(1)}x ZOOM</span>
              <button
                type="button"
                onClick={() => zoomBy(1.4)}
                className="px-1.5 h-5 rounded border border-[#1f1f23] bg-[#0a0a0b] text-slate-400 hover:text-emerald-400 hover:border-emerald-500/40 cursor-pointer"
                title="Zoom in"
              >
                +
              </button>
              <button
                type="button"
                onClick={reset}
                className="px-1.5 h-5 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 cursor-pointer"
              >
                RESET
              </button>
            </>
          ) : (
            <span className="text-slate-600">Scroll to zoom · drag to pan · double-click to reset</span>
          )}
        </div>

        <span className="shrink-0">
          {lastVisible ? `AS OF ${candleCloseUtc(lastVisible.time, barMs)} UTC` : "LATEST"}
        </span>
      </div>
    </div>
  );
}