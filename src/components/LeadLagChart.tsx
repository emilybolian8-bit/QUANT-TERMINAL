/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo } from "react";
import { LagCoefficient } from "../types";
import { useChartViewport } from "../utils/useChartViewport";

interface LeadLagChartProps {
  id: string;
  lagHistory: LagCoefficient[];
  timeframe: "1h" | "15m";
  optimalLag: number;
}

const HEIGHT = 180;
const PADDING_X = 40;
const PADDING_Y = 25;
/** Nominal viewBox width for the single frame before measurement lands. */
const FALLBACK_WIDTH = 450;

export default function LeadLagChart({
  id,
  lagHistory,
  timeframe,
  optimalLag,
}: LeadLagChartProps) {
  const {
    svgRef,
    width,
    viewport,
    isZoomed,
    zoomFactor,
    reset,
    svgProps,
  } = useChartViewport(lagHistory.length, {
    leftPadPx: PADDING_X,
    // Room for the "L > 0" tick at the right edge of the plot.
    rightPadPx: 12,
  });

  const span = viewport.end - viewport.start;

  // The svg must stay mounted for the ResizeObserver to measure it, so geometry
  // falls back to a nominal width until the first measurement lands.
  const plotWidth = width || FALLBACK_WIDTH;

  const mapX = (index: number) => {
    if (span <= 0) return PADDING_X;
    const usable = plotWidth - PADDING_X - 12;
    return PADDING_X + ((index - viewport.start) / span) * usable;
  };

  const maxAbsCoeff = useMemo(() => {
    if (lagHistory.length === 0) return 1;
    return Math.max(...lagHistory.map((l) => Math.abs(l.coefficient))) || 0.5;
  }, [lagHistory]);

  const mapY = (val: number) => {
    const limit = Math.max(0.2, maxAbsCoeff * 1.15);
    return PADDING_Y + ((limit - val) / (2 * limit)) * (HEIGHT - 2 * PADDING_Y);
  };

  const zeroY = mapY(0);

  // Bars are sized from the visible window, so a zoomed view thickens them
  // instead of leaving a sparse row of thin slivers.
  const barW = span > 0 ? Math.min(22, ((plotWidth - PADDING_X - 12) / span) * 0.62) : 18;

  // With many bars on screen the per-bar coefficient labels collide, so they are
  // dropped once the bars get too thin to hold text.
  const showCoefficients = barW >= 15;

  const firstVisible = lagHistory[Math.ceil(viewport.start)];
  const lastVisible = lagHistory[Math.floor(viewport.end)];

  return (
    <div
      id={id}
      className="bg-[#0e0e10] border border-[#1f1f23] rounded-xl p-5 hover:border-slate-700/60 transition-all flex flex-col justify-between"
    >
      <div>
        <div className="flex justify-between items-start gap-3">
          <div>
            <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest block">
              CROSS-CORRELATION LAG SPECTRUM
            </span>
            <h3 className="text-sm font-mono text-white font-semibold mt-0.5">
              Lead-Lag Analysis (Pearson r by Time Offsets)
            </h3>
          </div>
          {isZoomed && (
            <button
              type="button"
              onClick={reset}
              className="shrink-0 text-[9px] font-mono px-2 h-6 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 cursor-pointer"
            >
              {zoomFactor.toFixed(1)}x · RESET
            </button>
          )}
        </div>
        <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
          {"Matches R_Coin,t against R_BTC,t-L. If the optimal lag is positive (L > 0), BTC price returns lead "}
          {timeframe === "1h" ? "by hours" : "by 15-min intervals"}
          {", serving as an active prediction variable."}
        </p>
      </div>

      <div className="relative my-4 flex-1 self-stretch">
        <svg
          ref={svgRef}
          width="100%"
          height={HEIGHT}
          viewBox={`0 0 ${plotWidth} ${HEIGHT}`}
          className="select-none cursor-grab active:cursor-grabbing touch-none"
          {...svgProps}
        >
          {/* Zero boundary axis */}
          <line
            x1={PADDING_X - 10}
            y1={zeroY}
            x2={plotWidth - 12}
            y2={zeroY}
            className="stroke-[#1f1f23] stroke-1"
          />
          <text
            x={PADDING_X - 15}
            y={zeroY + 3}
            textAnchor="end"
            className="fill-slate-500 text-[8px] font-mono"
          >
            0.0
          </text>

          {lagHistory.map((item, index) => {
            if (index < viewport.start - 0.5 || index > viewport.end + 0.5) return null;

            const cx = mapX(index);
            const cy = mapY(item.coefficient);
            const isZero = item.lag === 0;
            const isOptimal = item.lag === optimalLag;

            const yStart = Math.min(zeroY, cy);
            const barH = Math.max(1, Math.abs(cy - zeroY));

            let barColor = "fill-slate-800/60 hover:fill-slate-700";
            if (isOptimal) {
              barColor = "fill-emerald-500 hover:fill-emerald-400";
            } else if (isZero) {
              barColor = "fill-emerald-500/20 stroke-emerald-500/40 hover:fill-emerald-500/35";
            }

            return (
              <g key={index} className="group/bar">
                <rect
                  x={cx - barW / 2}
                  y={yStart}
                  width={barW}
                  height={barH}
                  rx={2}
                  className={`${barColor} transition-all duration-200 cursor-pointer`}
                />

                {showCoefficients && (
                  <text
                    x={cx}
                    y={item.coefficient >= 0 ? yStart - 5 : yStart + barH + 11}
                    textAnchor="middle"
                    className={`text-[9px] font-mono ${
                      isOptimal ? "fill-emerald-400 font-bold" : "fill-slate-500"
                    }`}
                  >
                    {item.coefficient.toFixed(3)}
                  </text>
                )}

                {/* Lag labels are the x axis, so they stay legible at any zoom. */}
                {barW >= 8 && (
                  <text
                    x={cx}
                    y={HEIGHT - 2}
                    textAnchor="middle"
                    className={`text-[10px] font-mono ${
                      isOptimal
                        ? "fill-emerald-400 font-bold"
                        : isZero
                        ? "fill-emerald-500/80"
                        : "fill-slate-600"
                    }`}
                  >
                    {item.lag > 0 ? `+${item.lag}` : item.lag}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="flex justify-between items-center text-[9px] font-mono text-slate-500 border-t border-[#1f1f23] pt-2">
        <span className="text-rose-400 font-semibold">Coin Leads BTC (L &lt; 0)</span>
        <span className="text-slate-500">
          {isZoomed
            ? `Showing ${firstVisible?.lag} to ${lastVisible?.lag} · scroll to zoom, double-click to reset`
            : "Scroll to zoom, drag to pan, double-click to reset"}
        </span>
        <span className="text-emerald-400 font-semibold">BTC Leads Coin (L &gt; 0)</span>
      </div>
    </div>
  );
}