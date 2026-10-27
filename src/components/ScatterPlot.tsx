/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlignedDataPoint } from "../types";
import { candleCloseUtc } from "../utils/dates";

interface ScatterPlotProps {
  id: string;
  data: AlignedDataPoint[];
  beta: number;
  alpha: number;
  coinName: string;
  /** Bar size of the aligned series, used to stamp the hover read-out. */
  barMs?: number;
}

const PADDING = 48;
const ZOOM_STEP = 1.25;
const MAX_ZOOM = 40;
/** Pointer travel under this many px counts as a tap, not a drag. */
const TAP_SLOP_PX = 3;
const DOUBLE_TAP_MS = 320;

interface View {
  /** Value sitting at the centre of the plot, in return units. */
  cx: number;
  cy: number;
  /** 1 shows the full bound; higher is closer. Applied to both axes. */
  zoom: number;
}

export default function ScatterPlot({ id, data, beta, alpha, coinName, barMs = 3600000 }: ScatterPlotProps) {
  const [size, setSize] = useState(0);
  const [hoveredPoint, setHoveredPoint] = useState<AlignedDataPoint | null>(null);
  const [view, setView] = useState<View>({ cx: 0, cy: 0, zoom: 1 });

  const frameRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const panStart = useRef<{ x: number; y: number; v: View } | null>(null);
  const pinchStart = useRef<{ dist: number } | null>(null);
  const lastTapAt = useRef(0);
  const dragged = useRef(false);

  // Full-extent bound, fitted to the data with a floor so an unusually quiet
  // window does not produce a degenerate axis.
  const maxBound = useMemo(() => {
    if (data.length === 0) return 0.02;
    let maxVal = 0.015;
    for (const d of data) {
      const absBtc = Math.abs(d.btcReturn);
      const absCoin = Math.abs(d.coinReturn);
      if (absBtc > maxVal && absBtc < 0.15) maxVal = absBtc;
      if (absCoin > maxVal && absCoin < 0.15) maxVal = absCoin;
    }
    return maxVal * 1.1;
  }, [data]);

  const half = maxBound / view.zoom;
  const inner = size - 2 * PADDING;

  const mapX = (val: number) => {
    if (inner <= 0) return PADDING;
    return PADDING + ((val - (view.cx - half)) / (2 * half)) * inner;
  };

  const mapY = (val: number) => {
    if (inner <= 0) return size - PADDING;
    return size - PADDING - ((val - (view.cy - half)) / (2 * half)) * inner;
  };

  const unmapX = (px: number) => {
    if (inner <= 0) return 0;
    return view.cx - half + ((px - PADDING) / inner) * 2 * half;
  };

  const unmapY = (py: number) => {
    if (inner <= 0) return 0;
    return view.cy - half + ((size - PADDING - py) / inner) * 2 * half;
  };

  /** Keeps the window inside the data's full extent so it cannot pan to blank. */
  const clampView = useCallback(
    (next: View): View => {
      const nextHalf = maxBound / next.zoom;
      const limit = Math.max(0, maxBound - nextHalf);
      return {
        zoom: next.zoom,
        cx: Math.min(limit, Math.max(-limit, next.cx)),
        cy: Math.min(limit, Math.max(-limit, next.cy)),
      };
    },
    [maxBound]
  );

  const resetView = useCallback(() => setView({ cx: 0, cy: 0, zoom: 1 }), []);

  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => setSize(el.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A new symbol means a new cloud; a zoomed window from the previous pair
  // would be pointing at nothing.
  useEffect(() => {
    resetView();
  }, [data, resetView]);

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const anchorX = unmapX(px);
      const anchorY = unmapY(py);
      const zoom = Math.min(MAX_ZOOM, Math.max(1, view.zoom * (e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP)));
      const nextHalf = maxBound / zoom;
      const fx = (px - PADDING) / inner;
      const fy = (size - PADDING - py) / inner;
      setView(
        clampView({
          zoom,
          // Re-centre so the value under the cursor stays under the cursor.
          cx: anchorX + nextHalf - 2 * nextHalf * fx,
          cy: anchorY + nextHalf - 2 * nextHalf * fy,
        })
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [clampView, inner, maxBound, size, view]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Capture is an optimisation, not a requirement.
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragged.current = false;

    if (pointers.current.size === 1) {
      panStart.current = { x: e.clientX, y: e.clientY, v: view };
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchStart.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
      panStart.current = null;
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    const previous = pointers.current.get(e.pointerId);
    if (previous) {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (Math.hypot(e.clientX - previous.x, e.clientY - previous.y) > TAP_SLOP_PX) {
        dragged.current = true;
      }
    }

    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchStart.current && dist > 12 && pinchStart.current.dist > 12) {
        const zoom = Math.min(
          MAX_ZOOM,
          Math.max(1, view.zoom * (pinchStart.current.dist / dist))
        );
        setView((v) => clampView({ ...v, zoom }));
        dragged.current = true;
      }
      return;
    }

    if (previous && panStart.current && inner > 0) {
      const start = panStart.current;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.hypot(dx, dy) > TAP_SLOP_PX) {
        const startHalf = maxBound / start.v.zoom;
        setView(
          clampView({
            ...start.v,
            cx: start.v.cx - (dx / inner) * 2 * startHalf,
            cy: start.v.cy + (dy / inner) * 2 * startHalf,
          })
        );
        dragged.current = true;
      }
    }

    // Nearest-point read-out, computed in value space so it is unaffected by
    // the current zoom.
    if (size <= 0) return;
    const curX = unmapX(px);
    const curY = unmapY(py);
    let closest: AlignedDataPoint | null = null;
    let closestDist = Infinity;
    for (const d of data) {
      const dxp = d.btcReturn - curX;
      const dyp = d.coinReturn - curY;
      const dist = Math.hypot(dxp, dyp);
      if (dist < closestDist) {
        closestDist = dist;
        closest = d;
      }
    }
    setHoveredPoint(closest && closestDist < maxBound * 0.09 ? closest : null);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Already released.
    }
    if (pointers.current.size < 2) pinchStart.current = null;
    if (pointers.current.size > 0) return;

    panStart.current = null;
    if (dragged.current) return;

    const now = performance.now();
    if (now - lastTapAt.current < DOUBLE_TAP_MS) {
      lastTapAt.current = 0;
      resetView();
    } else {
      lastTapAt.current = now;
    }
  };

  const regressionPoints = useMemo(
    () => ({
      x1: mapX(-maxBound),
      y1: mapY(alpha + beta * -maxBound),
      x2: mapX(maxBound),
      y2: mapY(alpha + beta * maxBound),
    }),
    [alpha, beta, maxBound, view]
  );

  const formatPercent = (val: number) => `${val >= 0 ? "+" : ""}${(val * 100).toFixed(2)}%`;
  const boundPct = (half * 100).toFixed(2);
  const isZoomed = view.zoom > 1.01;

  return (
    <div
      id={id}
      className="bg-[#0e0e10] border border-[#1f1f23] rounded-xl p-5 flex flex-col md:flex-row items-center md:items-start space-y-6 md:space-y-0 md:space-x-6 hover:border-slate-700/60 transition-all"
    >
      {/* Chart Section */}
      <div className="relative w-full md:w-[380px] md:shrink-0">
        <div
          ref={frameRef}
          className="w-full select-none touch-none cursor-grab active:cursor-grabbing"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={() => setHoveredPoint(null)}
          onDoubleClick={resetView}
        >
          {size > 0 && (
            <svg width="100%" height={size} viewBox={`0 0 ${size} ${size}`}>
              {/* Main Grid Lines (Axes in the center 0,0) */}
              <line
                x1={PADDING}
                y1={mapY(0)}
                x2={size - PADDING}
                y2={mapY(0)}
                className="stroke-[#1f1f23] stroke-1"
              />
              <line
                x1={mapX(0)}
                y1={PADDING}
                x2={mapX(0)}
                y2={size - PADDING}
                className="stroke-[#1f1f23] stroke-1"
              />

              <rect
                x={PADDING}
                y={PADDING}
                width={size - 2 * PADDING}
                height={size - 2 * PADDING}
                className="stroke-[#1f1f23] fill-none stroke-1"
              />

              {/* Core Quadrant Labels */}
              <text
                x={size - PADDING - 65}
                y={PADDING + 18}
                className="fill-slate-500 text-[9px] font-mono select-none font-bold"
              >
                I. BTC ▲ / {coinName} ▲
              </text>
              <text
                x={PADDING + 8}
                y={PADDING + 18}
                className="fill-slate-500 text-[9px] font-mono select-none font-bold"
              >
                II. BTC ▼ / {coinName} ▲
              </text>
              <text
                x={PADDING + 8}
                y={size - PADDING - 10}
                className="fill-slate-500 text-[9px] font-mono select-none font-bold"
              >
                III. BTC ▼ / {coinName} ▼
              </text>
              <text
                x={size - PADDING - 65}
                y={size - PADDING - 10}
                className="fill-slate-500 text-[9px] font-mono select-none font-bold"
              >
                IV. BTC ▲ / {coinName} ▼
              </text>

              {/* Axis titles and bounds */}
              <text
                x={size / 2}
                y={size - 12}
                textAnchor="middle"
                className="fill-slate-400 text-[11px] font-mono font-medium"
              >
                BTC Return
              </text>
              <text
                x={PADDING + 2}
                y={size - PADDING - 14}
                textAnchor="start"
                className="fill-slate-500 text-[9px] font-mono"
              >
                -{boundPct}%
              </text>
              <text
                x={size - PADDING - 2}
                y={size - PADDING - 14}
                textAnchor="end"
                className="fill-slate-500 text-[9px] font-mono"
              >
                +{boundPct}%
              </text>

              {/* Rotation is applied as an SVG attribute: the previous CSS
                  `rotate(-90px)` was invalid, so this label rendered flat and
                  sat on top of the tick values. */}
              <text
                x={14}
                y={size / 2}
                textAnchor="middle"
                transform={`rotate(-90 14 ${size / 2})`}
                className="fill-slate-400 text-[11px] font-mono font-medium"
              >
                {coinName} Return
              </text>
              <text
                x={PADDING - 6}
                y={PADDING + 4}
                textAnchor="end"
                className="fill-slate-500 text-[9px] font-mono"
              >
                +{boundPct}%
              </text>
              <text
                x={PADDING - 6}
                y={size - PADDING + 4}
                textAnchor="end"
                className="fill-slate-500 text-[9px] font-mono"
              >
                -{boundPct}%
              </text>

              {/* Scatter Points */}
              {data.map((pt, i) => {
                const cx = mapX(pt.btcReturn);
                const cy = mapY(pt.coinReturn);

                if (cx < PADDING || cx > size - PADDING || cy < PADDING || cy > size - PADDING) {
                  return null;
                }

                const isSystemicSystem = pt.btcReturn * pt.coinReturn >= 0;
                const ptColor = isSystemicSystem
                  ? "fill-emerald-500/30 hover:fill-emerald-400"
                  : "fill-rose-500/20 hover:fill-rose-400";

                const isHovered = hoveredPoint && hoveredPoint.time === pt.time;

                return (
                  <circle
                    key={i}
                    cx={cx}
                    cy={cy}
                    r={isHovered ? 6 : 2.5}
                    className={`${ptColor} transition-all duration-100 ease-out`}
                    stroke={isHovered ? "#10b981" : "none"}
                    strokeWidth={isHovered ? 2 : 0}
                  />
                );
              })}

              {/* Regression Trend Line */}
              <line
                x1={regressionPoints.x1}
                y1={regressionPoints.y1}
                x2={regressionPoints.x2}
                y2={regressionPoints.y2}
                className="stroke-emerald-400 stroke-[2px] transition-all"
                strokeDasharray="4 2"
              />

              {hoveredPoint && (
                <>
                  <line
                    x1={PADDING}
                    y1={mapY(hoveredPoint.coinReturn)}
                    x2={size - PADDING}
                    y2={mapY(hoveredPoint.coinReturn)}
                    className="stroke-slate-500/30 stroke-1"
                    strokeDasharray="2 2"
                  />
                  <line
                    x1={mapX(hoveredPoint.btcReturn)}
                    y1={PADDING}
                    x2={mapX(hoveredPoint.btcReturn)}
                    y2={size - PADDING}
                    className="stroke-slate-500/30 stroke-1"
                    strokeDasharray="2 2"
                  />
                </>
              )}
            </svg>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 mt-1 text-[9px] font-mono text-slate-500">
          <span className="truncate">
            {isZoomed
              ? `${view.zoom.toFixed(1)}x · ±${boundPct}%`
              : "Scroll to zoom · drag to pan · double-click to reset"}
          </span>
          {isZoomed && (
            <button
              type="button"
              onClick={resetView}
              className="shrink-0 px-1.5 h-5 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 cursor-pointer"
            >
              RESET
            </button>
          )}
        </div>
      </div>

      {/* Analytics Explanation on Right */}
      <div className="flex-1 flex flex-col justify-between self-stretch py-2 w-full min-w-0">
        <div>
          <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest block font-bold">
            REGRESSION EQUATION
          </span>
          <h4 className="text-xl font-mono text-emerald-400 font-bold mt-1 break-all">
            Y = {alpha >= 0 ? "+" : ""}
            {alpha.toExponential(3)} + {beta.toFixed(3)} * X
          </h4>
          <p className="text-xs text-slate-400 mt-3 leading-relaxed">
            This scatter plot maps dynamic joint return distributions. The dotted line is the OLS (Ordinary Least
            Squares) linear regression profile.
          </p>

          <div className="grid grid-cols-2 gap-3 mt-5">
            <div className="p-2.5 bg-[#0a0a0b] rounded border border-[#1f1f23]">
              <span className="text-[10px] font-mono text-emerald-400 block mb-0.5 font-bold uppercase">
                SYSTEMATIC RUN (I & III)
              </span>
              <p className="text-[10px] text-slate-500 leading-normal">
                Common co-movement. Assets track directionally same. Higher beta magnifies Quadrant I.
              </p>
            </div>
            <div className="p-2.5 bg-[#0a0a0b] rounded border border-[#1f1f23]">
              <span className="text-[10px] font-mono text-rose-400 block mb-0.5 font-bold uppercase">
                DIVERGENT DISPERSION (II & IV)
              </span>
              <p className="text-[10px] text-slate-500 leading-normal">
                Idiosyncratic shifts. Great source of alpha for spread trading and market hedges.
              </p>
            </div>
          </div>
        </div>

        <div className="mt-5 p-4 bg-[#0a0a0b] rounded-lg border border-[#1f1f23] min-h-[75px] flex flex-col justify-center">
          {hoveredPoint ? (
            <div>
              <div className="flex justify-between items-center text-[10px] font-mono text-slate-500 border-b border-[#1f1f23] pb-1 mb-2 gap-2">
                <span className="truncate">BAR CLOSE: {candleCloseUtc(hoveredPoint.time, barMs)} UTC</span>
                <span className="text-emerald-400 font-bold shrink-0">CLOSE COORDINATES</span>
              </div>
              <div className="flex justify-between font-mono gap-2">
                <div>
                  <span className="text-[10px] text-slate-500 block">BTC return</span>
                  <span className="text-sm font-semibold text-white">{formatPercent(hoveredPoint.btcReturn)}</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-500 block">{coinName} return</span>
                  <span
                    className={`text-sm font-semibold ${
                      hoveredPoint.coinReturn >= 0 ? "text-emerald-400" : "text-rose-400"
                    }`}
                  >
                    {formatPercent(hoveredPoint.coinReturn)}
                  </span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-500 block">Spread Ratio</span>
                  <span className="text-sm font-semibold text-white">{hoveredPoint.ratio.toFixed(5)}</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center">
              <span className="text-xs font-mono text-slate-500 block italic">
                Hover over scatter data points to analyze local historical returns coordinates
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}