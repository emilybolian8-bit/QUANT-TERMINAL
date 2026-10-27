/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

const MS_PER_DAY = 86400000;

/**
 * Today's calendar date in UTC, as YYYY-MM-DD.
 * Used for <input type="date"> values, which are timezone-naive.
 */
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The UTC calendar date `days` before today, as YYYY-MM-DD.
 * Computed against the live clock so defaults never go stale.
 */
export function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Start of the given YYYY-MM-DD UTC day, in epoch milliseconds.
 */
export function startOfUTCDay(iso: string): number {
  return new Date(iso + "T00:00:00Z").getTime();
}

/**
 * Inclusive end of the given YYYY-MM-DD UTC day, in epoch milliseconds.
 */
export function endOfUTCDay(iso: string): number {
  return new Date(iso + "T23:59:59Z").getTime();
}

/**
 * Epoch ms to "YYYY-MM-DD HH:MM" in UTC.
 *
 * Every timestamp in this app is a Binance candle boundary, so it is only
 * meaningful in UTC. `toLocaleString()` would silently shift every stamp by the
 * viewer's offset, which made the charts disagree with the header's DATA AS OF.
 */
export function formatUtcStamp(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 16).replace("T", " ");
}

/**
 * Close time of a candle whose `time` is its open time.
 *
 * The feed excludes the still-forming bar, so the newest bar in a series is
 * already settled: its data is only known at the *next* boundary. Labelling the
 * right edge with the open time would make a series that is fully current look
 * one bar stale.
 */
export function candleCloseUtc(openTimeMs: number, intervalMs: number): string {
  return formatUtcStamp(openTimeMs + intervalMs);
}