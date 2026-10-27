/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Flame } from "lucide-react";
import type { LiqHeatmapCandle, LiqHeatmapEvent, LiqHeatmapResponse, LiqWindow } from "../types";
import { formatUtcStamp } from "../utils/dates";

const REFRESH_MS = 20_000;

/** Price bin width as a percentage of the window's mid price. */
const BIN_OPTIONS = [0.04, 0.08, 0.15] as const;
const DEFAULT_BIN = 0.08;

/** Visible-bar presets; the wheel edits the value freely between presets. */
const BAR_OPTIONS = [30, 60, 100, 160] as const;
const DEFAULT_BARS = 100;

/**
 * Chart-local candle intervals. Each maps to a server-side lookback span, so
 * the timeframe can be coarsened or refined without touching the page window.
 */
const TIMEFRAME_OPTIONS = ["1m", "5m", "15m", "1h"] as const;
const DEFAULT_INTERVAL_BY_WINDOW: Record<LiqWindow, string> = {
  "1h": "1m",
  "4h": "5m",
  "24h": "15m",
};

const DEFAULT_GAIN = 1.4;
const DEFAULT_HIDE_BELOW = 8;
const DEFAULT_PAD = 45;

/** Gutter geometry, mirrored from the reference build. */
const L = 8;
const RA = 62;
const PW = 84;
const B = 22;
const TOP = 8;

const ZOOM_STEP = 1.25;
const MIN_BARS = 10;
const MIN_Y_ZOOM = 0.2;
const MAX_Y_ZOOM = 20;
/** Pointer travel under this many px is a click, not a drag. */
const DRAG_SLOP_PX = 3;

const COL = {
  up: "#2bb5a4",
  down: "#f0524f",
  price: "#ffd24a",
  below: "#ff9f43",
  above: "#4dd0e1",
  grid: "#161d29",
  axis: "#8089a0",
} as const;

/** Heatmap ramp: deep indigo -> violet -> teal -> green -> yellow. */
const GRADIENT_STOPS: Array<[number, [number, number, number]]> = [
  [0, [27, 15, 61]],
  [0.25, [84, 32, 150]],
  [0.5, [31, 155, 176]],
  [0.78, [123, 224, 122]],
  [1, [255, 243, 107]],
];

const LUT: string[] = Array.from({ length: 256 }, (_, i) => {
  const s = i / 255;
  let j = 1;
  while (j < GRADIENT_STOPS.length - 1 && s > GRADIENT_STOPS[j][0]) j += 1;
  const [a0, c0] = GRADIENT_STOPS[j - 1];
  const [a1, c1] = GRADIENT_STOPS[j];
  const f = a1 === a0 ? 0 : (s - a0) / (a1 - a0);
  const c = c0.map((v, m) => Math.round(v + (c1[m] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
});

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clampZoom = (z: number) => clamp(z, MIN_Y_ZOOM, MAX_Y_ZOOM);

/** "MM-DD HH:MM" in UTC. */
const fmtT = (t: number) => formatUtcStamp(t).slice(5, 16);
/** "HH:MM" in UTC. */
const fmtClock = (t: number) => formatUtcStamp(t).slice(11, 16);

const fmtP = (p: number) => {
  if (!Number.isFinite(p)) return "—";
  return p >= 1000 ? p.toFixed(1) : p >= 1 ? p.toFixed(3) : p.toPrecision(4);
};

const fmtV = (v: number) => {
  if (!Number.isFinite(v) || v <= 0) return "0";
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return v.toFixed(0);
};

/** Bin grid over the window: standing vs originally-created notional per bar. */
interface HeatGrid {
  n: number;
  nb: number;
  gmin: number;
  bs: number;
  vmax: number;
  /** grid[k * n + t] = notional still standing in bin k at bar t. */
  grid: Float32Array;
  /** orig[k * n + t] = notional created in bin k at or before bar t. */
  orig: Float32Array;
}

/** Index of the bar containing `t` (last bar whose open time is <= t). */
function barIndexFor(candles: LiqHeatmapCandle[], t: number): number {
  if (t <= candles[0].time) return 0;
  let lo = 0;
  let hi = candles.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Bin every liquidation print, then let price sweep each bin.
 *
 * Each print seeds its bin with the full notional from its bar onward. From
 * the next bar on, the share of the bin that price has traded into is cleared
 * and never returns: a wick through the whole bin removes it, a wick into
 * half of it removes half. Long prints sit below price and are consumed by
 * descending lows; short prints sit above and are consumed by ascending
 * highs - the same geometry the reference model assigns by leverage tier.
 */
function buildGrid(events: LiqHeatmapEvent[], candles: LiqHeatmapCandle[], binBps: number): HeatGrid | null {
  const n = candles.length;
  if (n === 0) return null;

  let hi = -Infinity;
  let lo = Infinity;
  for (const candle of candles) {
    if (candle.high > hi) hi = candle.high;
    if (candle.low < lo) lo = candle.low;
  }
  if (!(hi > lo)) {
    hi = lo * 1.001 + 1e-12;
    lo = lo * 0.999 - 1e-12;
  }

  const mid = (hi + lo) / 2;
  const bs = (mid * binBps) / 100;
  const gmin = lo * 0.8;
  const nb = Math.max(1, Math.ceil((hi * 1.2 - gmin) / bs));
  const grid = new Float32Array(nb * n);
  const orig = new Float32Array(nb * n);

  interface Seed {
    i: number;
    a: number;
    below: boolean;
  }
  const seeds: Seed[][] = Array.from({ length: nb }, () => []);

  for (const event of events) {
    const price = event.price;
    if (!Number.isFinite(price) || price <= 0) continue;
    const a = Number.isFinite(event.notional) ? event.notional : 0;
    if (a <= 0) continue;
    const k = Math.floor((price - gmin) / bs);
    if (k < 0 || k >= nb) continue;
    const i = barIndexFor(candles, event.et > 0 ? event.et : event.t);
    const below =
      event.position === "long" ? true : event.position === "short" ? false : price <= candles[i].close;
    seeds[k].push({ i, a, below });
  }

  for (let k = 0; k < nb; k += 1) {
    const list = seeds[k];
    if (list.length === 0) continue;
    const binLo = gmin + k * bs;
    const binHi = binLo + bs;
    for (const seed of list) {
      grid[k * n + seed.i] += seed.a;
      orig[k * n + seed.i] += seed.a;
      let pm = 0;
      for (let j = seed.i + 1; j < n; j += 1) {
        if (pm < 1) {
          const bar = candles[j];
          const pen = seed.below ? clamp01((binHi - bar.low) / bs) : clamp01((bar.high - binLo) / bs);
          if (pen > pm) pm = pen;
        }
        orig[k * n + j] += seed.a;
        if (pm < 1) grid[k * n + j] += seed.a * (1 - pm);
      }
    }
  }

  const positive: number[] = [];
  for (let i = 0; i < grid.length; i += 1) if (grid[i] > 0) positive.push(grid[i]);
  positive.sort((a, b) => a - b);
  const p97 = positive.length ? positive[Math.min(positive.length - 1, Math.floor(positive.length * 0.97))] : 0;

  return { n, nb, gmin, bs, vmax: p97 > 0 ? p97 : 1, grid, orig };
}

interface HeatStats {
  close: number;
  below: number;
  above: number;
  clearedPct: number;
  topAbove: [number, number] | null;
  topBelow: [number, number] | null;
}

/** Standing totals, cleared share and the biggest clusters at bar T. */
function computeStats(heat: HeatGrid, T: number, close: number): HeatStats {
  const { nb, gmin, bs, n, grid, orig } = heat;
  let below = 0;
  let above = 0;
  let tc = 0;
  let to = 0;
  let topAbove: [number, number] | null = null;
  let topBelow: [number, number] | null = null;

  for (let k = 0; k < nb; k += 1) {
    const cu = grid[k * n + T];
    const og = orig[k * n + T];
    const price = gmin + (k + 0.5) * bs;
    tc += cu;
    to += og;
    if (price < close) {
      below += cu;
      if (cu > 0 && (!topBelow || cu > topBelow[0])) topBelow = [cu, price];
    } else {
      above += cu;
      if (cu > 0 && (!topAbove || cu > topAbove[0])) topAbove = [cu, price];
    }
  }

  return {
    close,
    below,
    above,
    clearedPct: to > 0 ? 100 * (1 - tc / to) : 0,
    topAbove,
    topBelow,
  };
}

/** Geometry of the last drawn frame, read back by the pointer handlers. */
interface Layout {
  px0: number;
  px1: number;
  top: number;
  ph: number;
  bw: number;
  i0: number;
  i1: number;
  N: number;
  pLo: number;
  pHi: number;
  r0: number;
  aLo: number;
  aHi: number;
  gridLo: number;
  gridHi: number;
}

interface DragState {
  x: number;
  y: number;
  T: number;
  yPan: number;
  yZoom: number;
  moved: boolean;
}

const fieldCls =
  "bg-[#0a0d12] text-[#d3d9e4] border border-[#2a3448] rounded-[5px] px-2 py-1 text-[12px] focus:border-[#ffd24a] focus:outline-none";
const btnCls =
  "bg-[#0a0d12] text-[#d3d9e4] border border-[#2a3448] rounded-[5px] px-2.5 py-1 text-[12px] cursor-pointer hover:border-[#ffd24a] focus-visible:border-[#ffd24a] focus-visible:outline-none";
const sliderCls = "accent-[#ffd24a] h-4 cursor-pointer";

export default function LiquidationLadderChart({
  symbol,
  window: liqWindow,
}: {
  symbol: string;
  window: LiqWindow;
}) {
  const [data, setData] = useState<LiqHeatmapResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [timeframe, setTimeframe] = useState<string>(() => DEFAULT_INTERVAL_BY_WINDOW[liqWindow]);

  // A symbol/window swap is a new series (spinner, cleared frame); a timeframe
  // swap refetches behind the mounted frame so the tone sliders and view hold.
  const seriesKey = `${symbol}|${liqWindow}`;
  const seriesRef = useRef(seriesKey);

  // The chart owns its candle interval, but a page-window change remaps it to
  // that window's natural timeframe so the first look still matches the page.
  useEffect(() => {
    setTimeframe(DEFAULT_INTERVAL_BY_WINDOW[liqWindow]);
  }, [liqWindow]);

  useEffect(() => {
    let cancelled = false;
    if (seriesRef.current !== seriesKey) {
      seriesRef.current = seriesKey;
      setData(null);
      setError(null);
      setLoading(true);
    }

    const load = async () => {
      try {
        const response = await fetch(
          `/api/liq/heatmap?symbol=${encodeURIComponent(symbol)}&window=${liqWindow}&interval=${encodeURIComponent(timeframe)}`
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload?.error || `Heatmap lookup failed (${response.status}).`);
        }
        if (!cancelled) {
          setData(payload as LiqHeatmapResponse);
          setError(null);
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message || "Liquidation heatmap unavailable.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [symbol, liqWindow, timeframe, seriesKey]);

  const body = (() => {
    if (loading && !data) {
      return (
        <div className="flex h-[180px] items-center justify-center border border-[#1f2735] border-dashed rounded bg-[#0a0d12]/60">
          <span className="text-xs text-slate-600 font-mono animate-pulse">Reading the liquidation tape…</span>
        </div>
      );
    }
    if (error && !data) {
      return (
        <div className="flex h-[180px] items-center justify-center border border-rose-900/40 border-dashed rounded bg-rose-950/20">
          <span className="text-xs text-rose-300 font-mono px-4 text-center">{error}</span>
        </div>
      );
    }
    if (!data) return null;
    return (
      <HeatmapFrame
        data={data}
        symbol={symbol}
        window={liqWindow}
        timeframe={timeframe}
        onTimeframeChange={setTimeframe}
      />
    );
  })();

  return (
    <div className="bg-[#0a0a0b] border border-[#1f1f23] rounded-lg p-4">
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500 font-bold flex items-center">
          <Flame size={12} className="mr-1.5 text-orange-400" />
          LIQUIDATION HEATMAP — SWEEP CLEARING
        </span>
        <span className="text-[9px] font-mono text-slate-600">
          {symbol} · {liqWindow.toUpperCase()} WINDOW
        </span>
      </div>

      {body}
    </div>
  );
}

function HeatmapFrame({
  data,
  symbol,
  window: liqWindow,
  timeframe,
  onTimeframeChange,
}: {
  data: LiqHeatmapResponse;
  symbol: string;
  window: LiqWindow;
  timeframe: string;
  onTimeframeChange: (value: string) => void;
}) {
  const candles = data.candles ?? [];
  const events = data.events ?? [];
  const n = candles.length;

  const [binBps, setBinBps] = useState<number>(DEFAULT_BIN);
  const [barsSel, setBarsSel] = useState<number>(DEFAULT_BARS);
  const [T, setT] = useState<number>(() => Math.max(0, n - 1));
  const [gain, setGain] = useState(DEFAULT_GAIN);
  const [hideBelow, setHideBelow] = useState(DEFAULT_HIDE_BELOW);
  const [pad, setPad] = useState(DEFAULT_PAD);
  const [playing, setPlaying] = useState(false);
  const [yZoom, setYZoom] = useState(1);
  const [yPan, setYPan] = useState(0);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const layoutRef = useRef<Layout | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const hoverRafRef = useRef(0);
  const liveEdgeRef = useRef(false);

  const heat = useMemo(() => buildGrid(events, candles, binBps), [events, candles, binBps]);

  const t = n > 0 ? Math.min(Math.max(T, 0), n - 1) : 0;
  const N = n > 0 ? Math.max(MIN_BARS, Math.min(barsSel, n)) : MIN_BARS;

  // A new series starts with a clean view. The bar count changes with the
  // timeframe, so the jump to the live edge is deferred until the refetched
  // candles land (`liveEdgeRef`), rather than clamped against the old series.
  useEffect(() => {
    liveEdgeRef.current = true;
    setYZoom(1);
    setYPan(0);
    setPlaying(false);
    setHover(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, liqWindow, timeframe]);

  useEffect(() => {
    if (liveEdgeRef.current && n > 0) {
      liveEdgeRef.current = false;
      setT(n - 1);
    }
  }, [n]);

  // Replay stops at the live edge.
  useEffect(() => {
    if (playing && t >= n - 1) setPlaying(false);
  }, [playing, t, n]);

  useEffect(() => {
    if (!playing || n < 2) return;
    const id = setInterval(() => {
      setT((prev) => (prev >= n - 1 ? n - 1 : prev + 1));
    }, 70);
    return () => clearInterval(id);
  }, [playing, n]);

  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measureEl = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measureEl();
    const ro = new ResizeObserver(measureEl);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Redraw every frame the chart state changes.
  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  const stats = useMemo(
    () => (heat ? computeStats(heat, t, candles[t]?.close ?? 0) : null),
    [heat, t, candles]
  );

  const tooltip = useMemo(() => {
    const ly = layoutRef.current;
    if (!hover || !heat || !ly) return null;
    if (hover.x < ly.px0 || hover.x > ly.px1 || hover.y < ly.top || hover.y > ly.top + ly.ph) return null;
    const j = clamp(Math.floor((hover.x - ly.px0) / ly.bw) + ly.i0, ly.i0, ly.i1);
    const price = ly.pHi - ((hover.y - ly.top) / ly.ph) * (ly.pHi - ly.pLo);
    const k = clamp(Math.floor((price - heat.gmin) / heat.bs), 0, heat.nb - 1);
    const binLo = heat.gmin + k * heat.bs;
    return {
      bar: candles[j],
      binLo,
      binHi: binLo + heat.bs,
      cu: heat.grid[k * heat.n + j],
      og: heat.orig[k * heat.n + j],
    };
  }, [hover, heat, candles]);

  const setHoverThrottled = (x: number, y: number) => {
    if (hoverRafRef.current) return;
    hoverRafRef.current = requestAnimationFrame(() => {
      hoverRafRef.current = 0;
      setHover({ x, y });
    });
  };

  const draw = () => {
    const cv = canvasRef.current;
    if (!cv || !heat) return;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth;
    const H = cv.clientHeight;
    if (W <= 0 || H <= 0) return;
    if (cv.width !== Math.round(W * dpr)) cv.width = Math.round(W * dpr);
    if (cv.height !== Math.round(H * dpr)) cv.height = Math.round(H * dpr);
    const cx = cv.getContext("2d");
    if (!cx) return;
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.clearRect(0, 0, W, H);
    if (n === 0) return;

    const i1 = t;
    const i0 = Math.max(0, i1 - N + 1);
    const px0 = L;
    const px1 = W - RA - PW - 8;
    const ph = H - B - TOP;
    const bw = (px1 - px0) / (N + 3);

    let lo = Infinity;
    let hi = -Infinity;
    for (let i = i0; i <= i1; i += 1) {
      if (candles[i].low < lo) lo = candles[i].low;
      if (candles[i].high > hi) hi = candles[i].high;
    }
    if (!(hi > lo)) {
      hi = lo * 1.001 + 1e-12;
      lo = lo * 0.999 - 1e-12;
    }

    const gridLo = heat.gmin;
    const gridHi = heat.gmin + heat.nb * heat.bs;
    const pd = (hi - lo) * (pad / 100);
    const aLo = Math.max(gridLo, lo - pd);
    const aHi = Math.min(gridHi, hi + pd);
    const r0 = Math.max(1e-12, aHi - aLo);
    const r = r0 / yZoom;
    const base = (aLo + aHi) / 2;
    let pLo: number;
    let pHi: number;
    if (r >= gridHi - gridLo) {
      pLo = gridLo;
      pHi = gridHi;
    } else {
      let center = base + yPan * r0;
      center = clamp(center, gridLo + r / 2, gridHi - r / 2);
      pLo = center - r / 2;
      pHi = center + r / 2;
    }

    const Y = (p: number) => TOP + ((pHi - p) / (pHi - pLo)) * ph;
    const X = (i: number) => px0 + (i - i0) * bw;
    const cl = candles[i1].close;

    layoutRef.current = {
      px0,
      px1,
      top: TOP,
      ph,
      bw,
      i0,
      i1,
      N,
      pLo,
      pHi,
      r0,
      aLo,
      aHi,
      gridLo,
      gridHi,
    };

    cx.font = '11px "IBM Plex Sans", system-ui, sans-serif';
    cx.fillStyle = COL.axis;
    cx.strokeStyle = COL.grid;
    cx.lineWidth = 1;
    for (let q = 0; q <= 6; q += 1) {
      const p = pLo + ((pHi - pLo) * q) / 6;
      const y = Y(p);
      cx.beginPath();
      cx.moveTo(px0, y);
      cx.lineTo(px1, y);
      cx.stroke();
      cx.fillText(fmtP(p), px1 + PW + 14, y + 4);
    }

    const step = Math.max(1, Math.ceil(N / 7));
    for (let i = i0; i <= i1; i += step) {
      cx.fillText(fmtClock(candles[i].time), X(i), H - 6);
    }

    const kLo = clamp(Math.floor((pLo - heat.gmin) / heat.bs), 0, heat.nb - 1);
    const kHi = clamp(Math.floor((pHi - heat.gmin) / heat.bs), 0, heat.nb - 1);
    const thr = Math.floor(2.55 * hideBelow);

    cx.save();
    cx.beginPath();
    cx.rect(px0, TOP, px1 - px0, ph);
    cx.clip();

    // Heatmap: one run-length-merged rectangle per constant-colour stretch.
    for (let k = kLo; k <= kHi; k += 1) {
      const y0 = Y(heat.gmin + (k + 1) * heat.bs);
      const h = Y(heat.gmin + k * heat.bs) - y0 + 0.6;
      let rs = i0;
      let rc = -1;
      for (let tt = i0; tt <= i1 + 1; tt += 1) {
        let c = -1;
        if (tt <= i1) {
          const v = heat.grid[k * n + tt];
          if (v > 0) {
            const q = Math.floor(255 * clamp01(Math.sqrt(v / heat.vmax) * gain));
            if (q >= thr) c = q & 248;
          }
        }
        if (c !== rc) {
          if (rc >= 0) {
            cx.fillStyle = LUT[rc];
            cx.fillRect(X(rs), y0, X(tt) - X(rs), h);
          }
          rs = tt;
          rc = c;
        }
      }
    }

    // Candles.
    for (let i = i0; i <= i1; i += 1) {
      const bar = candles[i];
      const x = X(i) + bw / 2;
      const up = bar.close >= bar.open;
      cx.strokeStyle = cx.fillStyle = up ? COL.up : COL.down;
      cx.beginPath();
      cx.moveTo(x, Y(bar.high));
      cx.lineTo(x, Y(bar.low));
      cx.stroke();
      cx.fillRect(
        x - bw * 0.34,
        Y(Math.max(bar.open, bar.close)),
        bw * 0.68,
        Math.max(1, Math.abs(Y(bar.open) - Y(bar.close)))
      );
    }

    // Last price line.
    cx.strokeStyle = COL.price;
    cx.setLineDash([4, 3]);
    cx.beginPath();
    cx.moveTo(px0, Y(cl));
    cx.lineTo(px1, Y(cl));
    cx.stroke();
    cx.setLineDash([]);

    // Crosshair.
    if (hover && hover.x >= px0 && hover.x <= px1 && hover.y >= TOP && hover.y <= TOP + ph) {
      cx.strokeStyle = "rgba(255,255,255,0.33)";
      cx.setLineDash([2, 3]);
      cx.beginPath();
      cx.moveTo(hover.x, TOP);
      cx.lineTo(hover.x, TOP + ph);
      cx.moveTo(px0, hover.y);
      cx.lineTo(px1, hover.y);
      cx.stroke();
      cx.setLineDash([]);
    }
    cx.restore();

    // Last price tag, right of the profile.
    cx.fillStyle = COL.price;
    cx.fillRect(px1 + PW + 10, Y(cl) - 8, RA - 4, 16);
    cx.fillStyle = "#0a0d12";
    cx.fillText(fmtP(cl), px1 + PW + 14, Y(cl) + 4);

    // Right-hand profile: originally created (grey) vs still standing.
    let pm = 0;
    for (let k = kLo; k <= kHi; k += 1) pm = Math.max(pm, heat.orig[k * n + i1]);
    pm = pm || 1;
    const pxp = px1 + 8;
    for (let k = kLo; k <= kHi; k += 1) {
      const cu = heat.grid[k * n + i1];
      const og = heat.orig[k * n + i1];
      const price = heat.gmin + (k + 0.5) * heat.bs;
      const y0 = Y(heat.gmin + (k + 1) * heat.bs);
      const h = Math.max(1, Y(heat.gmin + k * heat.bs) - y0);
      cx.fillStyle = "#ffffff22";
      cx.fillRect(pxp, y0, (PW * og) / pm, h);
      cx.fillStyle = price < cl ? COL.below : COL.above;
      cx.fillRect(pxp, y0, (PW * cu) / pm, h);
    }
  };

  // Wheel is registered manually: React's delegated listener is passive, and
  // a passive listener cannot stop the page from scrolling under the cursor.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const ly = layoutRef.current;
      if (!ly) return;
      const rect = cv.getBoundingClientRect();

      if (e.shiftKey || e.altKey) {
        // Price zoom about the cursor.
        const f = clamp((e.clientY - rect.top - ly.top) / ly.ph, 0, 1);
        const span = ly.pHi - ly.pLo;
        const pC = ly.pHi - f * span;
        const next = clampZoom(yZoom * (e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
        const r2 = ly.r0 / next;
        const center2 = pC + (f - 0.5) * r2;
        setYZoom(next);
        setYPan((center2 - (ly.aLo + ly.aHi) / 2) / ly.r0);
        return;
      }

      // Time zoom about the cursor bar.
      const frac = clamp((e.clientX - rect.left - ly.px0) / Math.max(1, ly.px1 - ly.px0), 0, 1);
      const nextN = clamp(Math.round(ly.N * (e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP)), MIN_BARS, n);
      if (nextN === ly.N) return;
      const anchorBar = ly.i0 + frac * (ly.N - 1);
      const nextT = Math.round(anchorBar + (1 - frac) * (nextN - 1));
      setBarsSel(nextN);
      setT(clamp(nextT, 0, n - 1));
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, [yZoom, n]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current;
    if (!cv || !layoutRef.current) return;
    try {
      cv.setPointerCapture(e.pointerId);
    } catch {
      // Capture is an optimisation, not a requirement.
    }
    dragRef.current = { x: e.clientX, y: e.clientY, T: t, yPan, yZoom, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    setHoverThrottled(e.clientX - rect.left, e.clientY - rect.top);

    const drag = dragRef.current;
    const ly = layoutRef.current;
    if (!drag || !ly) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) < DRAG_SLOP_PX && Math.abs(dy) < DRAG_SLOP_PX) return;
    drag.moved = true;

    const localX = e.clientX - rect.left;
    if (localX > ly.px1 && Math.abs(dy) >= Math.abs(dx)) {
      // Dragging the price scale stretches the price axis about the centre.
      setYZoom(clampZoom(drag.yZoom / Math.exp(dy * 0.006)));
      setYPan(drag.yPan);
      return;
    }

    // Pan: horizontal moves time, vertical moves price.
    const dT = Math.round(-dx / ly.bw);
    setT(clamp(drag.T + dT, 0, n - 1));
    const base = (ly.aLo + ly.aHi) / 2;
    const panMin = (ly.gridLo - base) / ly.r0;
    const panMax = (ly.gridHi - base) / ly.r0;
    setYPan(clamp(drag.yPan + dy / ly.ph / drag.yZoom, panMin, panMax));
  };

  const endPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current;
    if (cv) {
      try {
        cv.releasePointerCapture(e.pointerId);
      } catch {
        // Already released.
      }
    }
    dragRef.current = null;
  };

  const onPointerLeave = () => {
    if (hoverRafRef.current) {
      cancelAnimationFrame(hoverRafRef.current);
      hoverRafRef.current = 0;
    }
    dragRef.current = null;
    setHover(null);
  };

  const resetView = () => {
    setYZoom(1);
    setYPan(0);
    setBarsSel(DEFAULT_BARS);
    setT(Math.max(0, n - 1));
    setPlaying(false);
  };

  const startPlay = () => {
    if (t >= n - 1) setT(Math.min(30, n - 1));
    setPlaying(true);
  };

  const barChoices = Array.from(new Set([...BAR_OPTIONS, barsSel])).sort((a, b) => a - b);

  if (n === 0 || !heat || !stats) {
    return (
      <div className="flex h-[180px] items-center justify-center border border-[#1f2735] border-dashed rounded bg-[#0a0d12]/60">
        <span className="text-xs text-slate-600 font-mono px-4 text-center">
          No candles for {symbol} in this window — the heatmap needs a price series to sweep against.
        </span>
      </div>
    );
  }

  const cluster = (top: [number, number] | null) =>
    top ? `${fmtP(top[1])} (${((top[1] / stats.close - 1) * 100).toFixed(1)}%)` : "none";

  return (
    <div>
      {/* Controls: timeframe + grid + bars */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pb-2.5 border-b border-[#1f2735]">
        <label className="flex items-center gap-2 text-[12px] text-[#8089a0]">
          Timeframe
          <select
            value={timeframe}
            onChange={(e) => onTimeframeChange(e.target.value)}
            className={fieldCls}
          >
            {TIMEFRAME_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[12px] text-[#8089a0]">
          Bin size
          <select value={binBps} onChange={(e) => setBinBps(Number(e.target.value))} className={fieldCls}>
            {BIN_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {v.toFixed(2)}%
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[12px] text-[#8089a0]">
          Bars
          <select value={barsSel} onChange={(e) => setBarsSel(Number(e.target.value))} className={fieldCls}>
            {barChoices.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <span className="ml-auto text-[12px] font-mono text-[#8089a0]">
          {symbol} · {liqWindow.toUpperCase()} · {data.interval} BARS
        </span>
      </div>

      {/* Replay + tone controls */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 py-2.5 border-b border-[#1f2735]">
        <button
          type="button"
          onClick={() => (playing ? setPlaying(false) : startPlay())}
          className={btnCls}
        >
          {playing ? "Pause" : "Play replay"}
        </button>
        <label className="flex items-center gap-2 text-[12px] text-[#8089a0]">
          Time
          <input
            type="range"
            min={0}
            max={Math.max(1, n - 1)}
            value={t}
            onChange={(e) => setT(Number(e.target.value))}
            className={`${sliderCls} w-[260px] max-w-[46vw]`}
          />
        </label>
        <label className="flex items-center gap-2 text-[12px] text-[#8089a0]">
          Gain
          <input
            type="range"
            min={0.5}
            max={3}
            step={0.1}
            value={gain}
            onChange={(e) => setGain(Number(e.target.value))}
            className={`${sliderCls} w-[110px]`}
          />
        </label>
        <label className="flex items-center gap-2 text-[12px] text-[#8089a0]">
          Hide below
          <input
            type="range"
            min={0}
            max={60}
            value={hideBelow}
            onChange={(e) => setHideBelow(Number(e.target.value))}
            className={`${sliderCls} w-[110px]`}
          />
        </label>
        <label className="flex items-center gap-2 text-[12px] text-[#8089a0]">
          Price padding
          <input
            type="range"
            min={5}
            max={150}
            value={pad}
            onChange={(e) => setPad(Number(e.target.value))}
            className={`${sliderCls} w-[110px]`}
          />
        </label>
      </div>

      {/* Stats */}
      <div
        className="flex flex-wrap gap-x-6 gap-y-1 py-2.5 text-[12px] text-[#8089a0] border-b border-[#1f2735]"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        <span>
          <b className="text-[#d3d9e4] font-semibold">{symbol}</b>
        </span>
        <span>Bar {fmtT(candles[t].time)}</span>
        <span>
          Standing below price <b className="text-[#d3d9e4] font-semibold">{fmtV(stats.below)}</b>
        </span>
        <span>
          above <b className="text-[#d3d9e4] font-semibold">{fmtV(stats.above)}</b>
        </span>
        <span>
          Cleared so far <b className="text-[#d3d9e4] font-semibold">{stats.clearedPct.toFixed(0)}%</b>
        </span>
        <span>
          Biggest cluster above{" "}
          <b className="text-[#d3d9e4] font-semibold">{cluster(stats.topAbove)}</b>
        </span>
        <span>
          below <b className="text-[#d3d9e4] font-semibold">{cluster(stats.topBelow)}</b>
        </span>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 py-2.5 text-[12px] text-[#8089a0] border-b border-[#1f2735]">
        <span>Liquidation size</span>
        <span
          className="inline-block w-[160px] h-2 rounded-sm"
          style={{ background: "linear-gradient(90deg,#1b0f3d,#542096,#1f9bb0,#7be07a,#fff36b)" }}
        />
        <span>low to high</span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: COL.below }} />
          longs (below price)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: COL.above }} />
          shorts (above price)
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block w-2.5 h-2.5 rounded-sm"
            style={{ background: "rgba(255,255,255,0.19)" }}
          />
          originally created
        </span>
      </div>

      {/* Canvas */}
      <div className="relative mt-3">
        <canvas
          ref={canvasRef}
          style={{
            width: "100%",
            height: "min(68vh, 620px)",
            minHeight: 360,
            display: "block",
            background: "#0a0d12",
            border: "1px solid #1f2735",
            borderRadius: "6px",
            cursor: "crosshair",
            touchAction: "none",
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onPointerLeave={onPointerLeave}
          onDoubleClick={resetView}
        />
        {hover && tooltip && (
          <div
            className="pointer-events-none absolute bg-[#10151df2] border border-[#2a3448] rounded-[5px] px-2.5 py-1.5 text-[12px] leading-[1.55] whitespace-nowrap text-[#d3d9e4]"
            style={{
              left: hover.x,
              top: Math.max(4, hover.y + 14),
              transform: size.w > 0 && hover.x > size.w - 260 ? "translateX(calc(-100% - 24px))" : "translateX(14px)",
              fontVariantNumeric: "tabular-nums",
              zIndex: 5,
            }}
          >
            <div>{fmtT(tooltip.bar.time)} UTC</div>
            <div>
              O {fmtP(tooltip.bar.open)} H {fmtP(tooltip.bar.high)}
            </div>
            <div>
              L {fmtP(tooltip.bar.low)} C {fmtP(tooltip.bar.close)}
            </div>
            <div>
              Level {fmtP(tooltip.binLo)} to {fmtP(tooltip.binHi)}
            </div>
            <div>
              {tooltip.og > 0 ? (
                <>
                  Standing <b>{fmtV(tooltip.cu)}</b> of {fmtV(tooltip.og)} created (
                  {(100 * (1 - tooltip.cu / tooltip.og)).toFixed(0)}% cleared)
                </>
              ) : (
                "No liquidations here yet"
              )}
            </div>
          </div>
        )}
      </div>

      <div className="text-[12px] text-[#6b7489] leading-relaxed mt-2.5 px-1 border-t border-[#1f1f25] pt-2.5 max-w-[110ch]">
        Levels are built from live liquidation prints (Binance, Bybit, OKX) snapped to{" "}
        {binBps.toFixed(2)}% price bins. Each print seeds its bin with its full notional; once price trades
        through the bin, the covered share is cleared and never returns — a wick through the whole bin removes
        it, a wick into half of it removes half. Drag the time slider or press Play to watch levels build and
        get consumed. Scroll to zoom time, shift+scroll to zoom price, drag to pan, drag the price scale to
        stretch it, double-click to reset.
      </div>
    </div>
  );
}
