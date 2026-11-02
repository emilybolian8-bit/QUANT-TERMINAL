/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Inclusive index window currently on screen, in fractional index units. */
export interface ChartViewport {
  start: number;
  end: number;
}

/** Normalized (0..1) rectangle of a drag-selection over the plot area. */
export interface BoxSelection {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface ChartViewportOptions {
  /** Narrowest slice the wheel may zoom into, in points. */
  minSpan?: number;
  /** Left gutter in px (y-axis labels). Excluded from pan, zoom and hover. */
  leftPadPx?: number;
  /** Right gutter in px. */
  rightPadPx?: number;
  /**
   * Turns a plain left-drag into a rectangle zoom. With `yRange` set the
   * rectangle zooms both axes; hold Shift to pan instead. Off by default so
   * charts that already pan on drag keep their behaviour.
   */
  boxZoom?: boolean;
  /** Full y data range as [min, max]. Enables vertical rectangle zoom. */
  yRange?: [number, number];
  /** Vertical gutters in px, excluded from zoom/hover mapping. */
  topPadPx?: number;
  bottomPadPx?: number;
}

const ZOOM_STEP = 1.25;
/** Two taps closer together than this count as a double tap. */
const DOUBLE_TAP_MS = 320;
/** Pointer travel under this many px is a tap, not a drag. */
const TAP_SLOP_PX = 3;
/** A rectangle thinner than this fraction of the plot is treated as a tap. */
const MIN_BOX_FRACTION = 0.02;

/**
 * Measured width + zoom/pan window for a hand-rolled SVG chart.
 *
 * Two problems this solves at once:
 *
 * 1. Containment. These charts used `preserveAspectRatio="none"`, which
 *    stretches the viewBox horizontally and smears every SVG `<text>` label.
 *    Measuring the element and setting the viewBox to the same pixel width
 *    makes the mapping 1:1, so the drawing is undistorted and always lands
 *    inside the card.
 * 2. Interaction. Wheel and pinch zoom about the cursor, drag pans, and a
 *    double click or double tap restores the full series.
 *
 * With `boxZoom` enabled a plain drag instead draws a rectangle that becomes
 * the new window, `selection` carries that rectangle (normalized) so the chart
 * can render it, and `yDomain` exposes the current vertical window.
 */
export function useChartViewport(count: number, options: ChartViewportOptions = {}) {
  const {
    minSpan = 6,
    leftPadPx = 0,
    rightPadPx = 0,
    boxZoom = false,
    yRange,
    topPadPx = 0,
    bottomPadPx = 0,
  } = options;

  const yLo = yRange ? yRange[0] : undefined;
  const yHi = yRange ? yRange[1] : undefined;
  const boxY = yRange !== undefined;

  const [width, setWidth] = useState(0);
  const [viewport, setViewport] = useState<ChartViewport>({ start: 0, end: 1 });
  const [yDomain, setYDomain] = useState<{ min: number; max: number } | null>(
    yLo !== undefined && yHi !== undefined ? { min: yLo, max: yHi } : null
  );
  const [selection, setSelection] = useState<BoxSelection | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const pointers = useRef(new Map<number, number>());
  const panStart = useRef<{ x: number; v: ChartViewport } | null>(null);
  const pinchStart = useRef<{ dist: number } | null>(null);
  const boxStart = useRef<{ fx: number; fy: number; cx: number; cy: number } | null>(null);
  const lastTapAt = useRef(0);
  const dragged = useRef(false);

  // Guards against a stale closure in the pointer handlers, which fire outside
  // the render that created them.
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const yDomainRef = useRef(yDomain);
  yDomainRef.current = yDomain;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const full = Math.max(1, count - 1);
  const floorSpan = Math.max(1, Math.min(minSpan, full));

  const clamp = useCallback(
    (start: number, end: number): ChartViewport => {
      let s = start;
      let e = end;
      let span = e - s;

      if (span > full) {
        const c = (s + e) / 2;
        s = c - full / 2;
        e = c + full / 2;
        span = full;
      }
      if (span < floorSpan) {
        const c = (s + e) / 2;
        s = c - floorSpan / 2;
        e = c + floorSpan / 2;
        span = floorSpan;
      }
      if (s < 0) {
        s = 0;
        e = span;
      }
      if (e > full) {
        e = full;
        s = full - span;
      }
      return { start: s, end: e };
    },
    [floorSpan, full]
  );

  const reset = useCallback(() => {
    setViewport({ start: 0, end: full });
    if (yLo !== undefined && yHi !== undefined) setYDomain({ min: yLo, max: yHi });
    else setYDomain(null);
    setSelection(null);
    boxStart.current = null;
  }, [full, yLo, yHi]);

  // A new series starts full-frame. Carrying a zoomed slice across a symbol or
  // timeframe change would show a window of an unrelated series.
  useEffect(() => {
    setViewport({ start: 0, end: full });
    setSelection(null);
    boxStart.current = null;
  }, [full]);

  // Re-fit the vertical window when the underlying data range changes.
  useEffect(() => {
    if (yLo === undefined || yHi === undefined) {
      setYDomain(null);
      return;
    }
    setYDomain({ min: yLo, max: yHi });
  }, [yLo, yHi]);

  const zoomAt = useCallback(
    (fraction: number, factor: number) => {
      setViewport((v) => {
        const span = v.end - v.start;
        const anchor = v.start + fraction * span;
        const nextSpan = Math.min(full, Math.max(floorSpan, span * factor));
        return clamp(anchor - fraction * nextSpan, anchor + (1 - fraction) * nextSpan);
      });
    },
    [clamp, floorSpan, full]
  );

  const zoomBy = useCallback((factor: number) => zoomAt(0.5, factor), [zoomAt]);

  /** Fraction of the plot area, gutters excluded, under a client x position. */
  const fractionFromClientX = useCallback(
    (clientX: number) => {
      const el = svgRef.current;
      if (!el) return 0.5;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return 0.5;
      const usable = Math.max(24, rect.width - leftPadPx - rightPadPx);
      return Math.min(1, Math.max(0, (clientX - rect.left - leftPadPx) / usable));
    },
    [leftPadPx, rightPadPx]
  );

  /** Fraction of the plot area, gutters excluded, under a client y position. */
  const fractionFromClientY = useCallback(
    (clientY: number) => {
      const el = svgRef.current;
      if (!el) return 0.5;
      const rect = el.getBoundingClientRect();
      if (rect.height <= 0) return 0.5;
      const usable = Math.max(24, rect.height - topPadPx - bottomPadPx);
      return Math.min(1, Math.max(0, (clientY - rect.top - topPadPx) / usable));
    },
    [topPadPx, bottomPadPx]
  );

  // Wheel is registered manually because React's delegated listener is passive,
  // and a passive listener cannot stop the page from scrolling under the cursor.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      zoomAt(fractionFromClientX(e.clientX), factor);
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [fractionFromClientX, zoomAt, width]);

  useLayoutEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const measure = () => setWidth(el.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (count <= 1) return;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Capture is an optimisation, not a requirement.
      }
      pointers.current.set(e.pointerId, e.clientX);
      dragged.current = false;

      if (pointers.current.size === 2) {
        const xs = [...pointers.current.values()];
        pinchStart.current = { dist: Math.abs(xs[0] - xs[1]) };
        panStart.current = null;
        boxStart.current = null;
        setSelection(null);
        return;
      }

      if (pointers.current.size === 1) {
        // Plain drag box-zooms; Shift+drag pans. Charts without boxZoom keep pan.
        if (boxZoom && !e.shiftKey) {
          const fx = fractionFromClientX(e.clientX);
          const fy = fractionFromClientY(e.clientY);
          boxStart.current = { fx, fy, cx: e.clientX, cy: e.clientY };
          setSelection({ x0: fx, y0: fy, x1: fx, y1: fy });
          panStart.current = null;
        } else {
          panStart.current = { x: e.clientX, v: viewportRef.current };
          boxStart.current = null;
        }
      }
    },
    [count, boxZoom, fractionFromClientX, fractionFromClientY]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const previousX = pointers.current.get(e.pointerId);
      if (previousX === undefined) return;
      pointers.current.set(e.pointerId, e.clientX);
      if (Math.abs(e.clientX - previousX) > TAP_SLOP_PX) dragged.current = true;

      if (pointers.current.size >= 2) {
        const xs = [...pointers.current.values()];
        const dist = Math.abs(xs[0] - xs[1]);
        if (pinchStart.current && dist > 12 && pinchStart.current.dist > 12) {
          zoomAt(0.5, pinchStart.current.dist / dist);
          dragged.current = true;
        }
        return;
      }

      const bs = boxStart.current;
      if (pointers.current.size === 1 && bs) {
        if (Math.abs(e.clientX - bs.cx) > TAP_SLOP_PX || Math.abs(e.clientY - bs.cy) > TAP_SLOP_PX) {
          dragged.current = true;
        }
        const fx = fractionFromClientX(e.clientX);
        const fy = fractionFromClientY(e.clientY);
        setSelection({
          x0: Math.min(bs.fx, fx),
          y0: Math.min(bs.fy, fy),
          x1: Math.max(bs.fx, fx),
          y1: Math.max(bs.fy, fy),
        });
        return;
      }

      if (pointers.current.size === 1 && panStart.current) {
        const start = panStart.current;
        if (Math.abs(e.clientX - start.x) <= TAP_SLOP_PX) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const usable = Math.max(24, rect.width - leftPadPx - rightPadPx);
        const span = start.v.end - start.v.start;
        // Dragging right pulls earlier data into view.
        const shift = -((e.clientX - start.x) / usable) * span;
        setViewport(clamp(start.v.start + shift, start.v.end + shift));
        dragged.current = true;
      }
    },
    [clamp, leftPadPx, rightPadPx, zoomAt, fractionFromClientX, fractionFromClientY]
  );

  const endPointer = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      pointers.current.delete(e.pointerId);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Already released.
      }

      if (pointers.current.size < 2) pinchStart.current = null;
      if (pointers.current.size > 0) return;

      const bs = boxStart.current;
      boxStart.current = null;
      panStart.current = null;

      // A committed rectangle becomes the new window on both axes.
      if (bs && dragged.current) {
        const sel = selectionRef.current;
        if (sel) {
          const v = viewportRef.current;
          const xspan = v.end - v.start;
          if (sel.x1 - sel.x0 >= MIN_BOX_FRACTION) {
            setViewport(clamp(v.start + sel.x0 * xspan, v.start + sel.x1 * xspan));
          }
          const yd = yDomainRef.current;
          if (boxY && yd && sel.y1 - sel.y0 >= MIN_BOX_FRACTION) {
            const yspan = yd.max - yd.min;
            const top = Math.max(yd.max, yd.min) - sel.y0 * yspan;
            const bot = Math.max(yd.max, yd.min) - sel.y1 * yspan;
            setYDomain({ min: Math.min(bot, top), max: Math.max(bot, top) });
          }
        }
        setSelection(null);
        lastTapAt.current = 0;
        return;
      }

      setSelection(null);
      if (dragged.current) return;

      const now = performance.now();
      if (now - lastTapAt.current < DOUBLE_TAP_MS) {
        lastTapAt.current = 0;
        reset();
      } else {
        lastTapAt.current = now;
      }
    },
    [clamp, reset, boxY]
  );

  const onDoubleClick = useCallback(() => reset(), [reset]);

  const span = viewport.end - viewport.start;
  const yZoomed =
    boxY &&
    !!yDomain &&
    (Math.abs(yDomain.min - (yLo ?? 0)) > 1e-9 || Math.abs(yDomain.max - (yHi ?? 0)) > 1e-9);

  return {
    svgRef,
    width,
    viewport,
    span,
    yDomain,
    selection,
    isZoomed: viewport.start > 0.001 || viewport.end < full - 0.001 || yZoomed,
    zoomFactor: span > 0 ? full / span : 1,
    reset,
    zoomBy,
    fractionFromClientX,
    fractionFromClientY,
    svgProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endPointer,
      onPointerCancel: endPointer,
      onDoubleClick,
    },
  };
}
