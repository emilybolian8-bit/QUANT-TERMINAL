/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from "react";
import { AlignedDataPoint } from "../types";
import { useChartViewport } from "../utils/useChartViewport";
import { candleCloseUtc } from "../utils/dates";

interface PairsSpreadChartProps {
  id: string;
  data: AlignedDataPoint[];
  coinBase: string;
  compareAsset?: string;
  /** Bar size of the aligned series. Defaults to 1h, the only feed it is fed from. */
  barMs?: number;
}

const HEIGHT = 180;
const PADDING_X = 40;
const PADDING_Y = 20;
/** Nominal viewBox width for the single frame before measurement lands. */
const FALLBACK_WIDTH = 640;

export default function PairsSpreadChart({
  id,
  data,
  coinBase,
  compareAsset = "BTC",
  barMs = 3600000,
}: PairsSpreadChartProps) {
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

  const span = viewport.end - viewport.start;

  // The svg must stay mounted for the ResizeObserver to measure it, so geometry
  // falls back to a nominal width until the first measurement lands.
  const plotWidth = width || FALLBACK_WIDTH;

  const mapX = (index: number) => {
    if (span <= 0) return PADDING_X;
    return PADDING_X + ((index - viewport.start) / span) * (plotWidth - PADDING_X);
  };

  const mapY = (zVal: number) => {
    return PADDING_Y + ((3.0 - zVal) / 6.0) * (HEIGHT - 2 * PADDING_Y);
  };

  // Emit only the visible slice so the path stays cheap and the out-of-bound
  // markers stay dense where the reader is actually looking.
  const visible = useMemo(() => {
    const from = Math.max(0, Math.floor(viewport.start));
    const to = Math.min(data.length - 1, Math.ceil(viewport.end));
    return data.slice(from, to + 1).map((d, i) => ({ ...d, index: from + i }));
  }, [data, viewport]);

  const linePath = useMemo(
    () =>
      visible
        .map((d, i) => `${i === 0 ? "M" : "L"} ${mapX(d.index)} ${mapY(d.zscore)}`)
        .join(" "),
    [visible, viewport.start, span, plotWidth]
  );

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (data.length === 0) return;
    const index = Math.round(viewport.start + fractionFromClientX(e.clientX) * span);
    if (index >= 0 && index < data.length) setHoverIndex(index);
  };

  const hoverPoint = hoverIndex !== null ? data[hoverIndex] : null;
  const firstVisible = data[Math.ceil(viewport.start)];
  const lastVisible = data[Math.floor(viewport.end)];

  const zUpperY = mapY(2.0);
  const zLowerY = mapY(-2.0);

  return (
    <div
      id={id}
      className="bg-[#0e0e10] border border-[#1f1f23] rounded-xl p-5 hover:border-slate-700/60 transition-all flex flex-col"
    >
      <div className="flex justify-between items-center mb-4 gap-3">
        <div>
          <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest block">
            SPREAD REVERSION ARBITRAGE DESK
          </span>
          <h3 className="text-sm font-mono text-white font-semibold mt-0.5">
            Spread Ratio Z-Score Timeline ({coinBase}/{compareAsset})
          </h3>
        </div>
        <div className="text-right min-h-[36px] flex flex-col justify-center shrink-0">
          {hoverPoint ? (
            <div className="font-mono text-xs">
              <span className="text-[10px] text-slate-500 block">
                Z-Score: {hoverPoint.zscore.toFixed(4)} (Ratio: {hoverPoint.ratio.toFixed(6)})
              </span>
              <span className="text-[9px] text-slate-600 block">
                BAR CLOSE: {candleCloseUtc(hoverPoint.time, barMs)} UTC
              </span>
              <span
                className={`font-semibold px-1.5 py-0.5 rounded text-[10px] uppercase ${
                  hoverPoint.zscore > 1.8
                    ? "bg-rose-950/80 text-rose-400 border border-rose-800/40"
                    : hoverPoint.zscore < -1.8
                    ? "bg-emerald-950/80 text-emerald-400 border border-emerald-800/40"
                    : "bg-[#141417] text-slate-400 border border-[#1f1f23]"
                }`}
              >
                {hoverPoint.zscore > 1.8
                  ? `SELL COIN, HEDGE ${compareAsset}`
                  : hoverPoint.zscore < -1.8
                  ? `BUY COIN, HEDGE ${compareAsset}`
                  : "SPREAD EQUILIBRIUM"}
              </span>
            </div>
          ) : (
            <span className="text-[10px] font-mono text-slate-500 italic block">
              Hover timeline to monitor statistical deviation buy/sell bounds
            </span>
          )}
        </div>
      </div>

      <div className="relative flex-1 self-stretch">
        {data.length > 0 ? (
          <svg
            ref={svgRef}
            width="100%"
            height={HEIGHT}
            viewBox={`0 0 ${plotWidth} ${HEIGHT}`}
            className="select-none cursor-grab active:cursor-grabbing touch-none"
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setHoverIndex(null)}
            {...svgProps}
          >
            {/* Shaded Top Overvaluation zone (Z > +2) */}
            <rect
              x={PADDING_X}
              y={PADDING_Y}
              width={plotWidth - PADDING_X}
              height={Math.max(0, zUpperY - PADDING_Y)}
              className="fill-rose-500/5"
            />

            {/* Shaded Bottom Undervaluation zone (Z < -2) */}
            <rect
              x={PADDING_X}
              y={zLowerY}
              width={plotWidth - PADDING_X}
              height={Math.max(0, HEIGHT - PADDING_Y - zLowerY)}
              className="fill-emerald-500/5"
            />

            <line
              x1={PADDING_X}
              y1={zUpperY}
              x2={plotWidth - PADDING_X}
              y2={zUpperY}
              className="stroke-rose-800/40 stroke-1"
              strokeDasharray="2 2"
            />
            {/* Right-edge labels sit inside the plot so they cannot spill past the card. */}
            <text
              x={plotWidth - PADDING_X - 6}
              y={zUpperY - 4}
              textAnchor="end"
              className="fill-rose-400/80 text-[8px] font-mono"
            >
              +2.0σ Sell Ratio
            </text>

            {[1.0, -1.0].map((v) => (
              <g key={v}>
                <line
                  x1={PADDING_X}
                  y1={mapY(v)}
                  x2={plotWidth - PADDING_X}
                  y2={mapY(v)}
                  className="stroke-[#1f1f23] stroke-1"
                  strokeDasharray="4 4"
                />
                <text
                  x={PADDING_X - 10}
                  y={mapY(v) + 3}
                  textAnchor="end"
                  className="fill-slate-500 text-[9px] font-mono"
                >
                  {v > 0 ? "+1.0" : "-1.0"}
                </text>
              </g>
            ))}

            {/* Mean Origin (Equilibrium Ratio) */}
            <line
              x1={PADDING_X}
              y1={mapY(0)}
              x2={plotWidth - PADDING_X}
              y2={mapY(0)}
              className="stroke-slate-700/40 stroke-[1.25px]"
            />
            <text
              x={PADDING_X - 10}
              y={mapY(0) + 3}
              textAnchor="end"
              className="fill-slate-400 text-[10px] font-mono font-bold"
            >
              Mean
            </text>

            <line
              x1={PADDING_X}
              y1={zLowerY}
              x2={plotWidth - PADDING_X}
              y2={zLowerY}
              className="stroke-emerald-800/40 stroke-1"
              strokeDasharray="2 2"
            />
            <text
              x={plotWidth - PADDING_X - 6}
              y={zLowerY + 11}
              textAnchor="end"
              className="fill-emerald-500/80 text-[8px] font-mono"
            >
              -2.0σ Buy Ratio
            </text>

            <path
              d={linePath}
              className="stroke-emerald-400 stroke-[1.5px] fill-none transition-all duration-300"
              vectorEffect="non-scaling-stroke"
            />

            {visible.map((pt) => {
              if (Math.abs(pt.zscore) <= 2.0) return null;
              return (
                <circle
                  key={pt.index}
                  cx={mapX(pt.index)}
                  cy={mapY(pt.zscore)}
                  r={3}
                  className={pt.zscore > 2 ? "fill-rose-400" : "fill-emerald-400"}
                />
              );
            })}

            {hoverIndex !== null &&
              hoverPoint &&
              hoverIndex >= viewport.start &&
              hoverIndex <= viewport.end && (
                <>
                  <line
                    x1={mapX(hoverIndex)}
                    y1={PADDING_Y}
                    x2={mapX(hoverIndex)}
                    y2={HEIGHT - PADDING_Y}
                    className="stroke-emerald-500/20 stroke-1"
                    strokeDasharray="2 2"
                  />
                  <circle
                    cx={mapX(hoverIndex)}
                    cy={mapY(hoverPoint.zscore)}
                    r={4.5}
                    className={`${
                      hoverPoint.zscore > 1.8
                        ? "fill-rose-500"
                        : hoverPoint.zscore < -1.8
                        ? "fill-emerald-500"
                        : "fill-emerald-400"
                    } stroke-[#0e0e10] stroke-2`}
                  />
                </>
              )}
          </svg>
        ) : (
          <div className="flex h-[150px] items-center justify-center border border-[#1f1f23] border-dashed rounded bg-[#0a0a0b]/25">
            <span className="text-xs text-slate-500 font-mono text-center px-4 leading-relaxed">
              No aligned spread history for this pair in the requested window.
            </span>
          </div>
        )}
      </div>

      <div className="flex justify-between items-center text-[10px] font-mono text-slate-500 mt-2 px-1 border-t border-[#1f1f23] pt-2 font-semibold gap-3">
        <span className="shrink-0 font-normal">
          {firstVisible ? `${candleCloseUtc(firstVisible.time, barMs)} UTC` : "START"}
        </span>

        <div className="flex items-center gap-2 justify-center flex-wrap font-normal">
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
              <span>{zoomFactor.toFixed(1)}x ZOOM</span>
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

        <span className="shrink-0 font-normal">
          {lastVisible ? `AS OF ${candleCloseUtc(lastVisible.time, barMs)} UTC` : "LATEST"}
        </span>
      </div>
    </div>
  );
}