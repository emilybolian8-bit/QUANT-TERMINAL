/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Durable JSONL log behind the liquidation tape.
 *
 * The collectors are meant to run 24/7 on a server nobody is watching, so a
 * restart (deploy, OOM-kill, host reboot) must not reset the 24h+ baseline
 * that the gainers/losers comparison is measured against. Every accepted
 * event is appended to an hourly per-venue file —
 *
 *   <dir>/binance/binance_liq_2026-10-07_14.jsonl   (UTC buckets)
 *
 * matching the Python collector's layout, and boot replays the retention
 * window back into the store before the venue sockets open. Cloud Run
 * instances with ephemeral disks simply skip the replay and behave like the
 * memory-only original; a persistent disk (Compute Engine, or a mounted
 * volume) keeps the tape continuous across restarts.
 *
 * Writes are buffered by the OS with a flush on every write boundary the
 * store can afford: an explicit fsync happens at most once per interval and
 * on close, because cascades emit thousands of events per minute and a
 * per-event fsync would throttle the feed exactly when the data matters.
 * Persistence is never allowed to take collection down — repeated write
 * failures disable the writer while the sockets keep running.
 */

import fs from "fs";
import os from "os";
import path from "path";
import type { LiqEvent, LiqPersistenceInfo } from "../types";

/** Minimal store surface this module needs; keeps the import graph acyclic. */
export interface LiquidationStoreLike {
  hydrate(events: LiqEvent[]): number;
  attachWriter(writer: LiquidationWriter | null): void;
}

export interface LiquidationWriter {
  write(event: LiqEvent): void;
}

/** Consecutive failures before the writer gives up for the process lifetime. */
const FAILURE_LIMIT = 25;

/** Minimum gap between fsync calls; every write still reaches the OS. */
const FSYNC_INTERVAL_MS = 10_000;

/** Directory used when LIQ_DATA_DIR is unset: ./data/liq under the CWD. */
export function defaultLiquidationDataDir(): string {
  return process.env.LIQ_DATA_DIR || path.join(process.cwd(), "data", "liq");
}

/** True when `dir` can be created and written to right now. */
function isWritableDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Picks where the tape is written. The configured LIQ_DATA_DIR wins — the
 * Docker image points it at the persistent /data/liq, which on Cloud Run is a
 * GCS-backed volume. If that path is missing or read-only (e.g. a mount the
 * runtime service account cannot write) fall back to a temp dir so collection
 * keeps running instead of the writer stalling after repeated failures.
 */
export function resolveLiquidationDataDir(): string {
  const preferred = defaultLiquidationDataDir();
  if (isWritableDir(preferred)) return preferred;
  for (const dir of [path.join(os.tmpdir(), "liq"), path.join(process.cwd(), "data", "liq")]) {
    if (dir !== preferred && isWritableDir(dir)) {
      console.error(`Liquidation persistence: ${preferred} is not writable; using ${dir} (ephemeral).`);
      return dir;
    }
  }
  return preferred;
}

/** "YYYY-MM-DD_HH" in UTC — the Python collector's hourly bucket key. */
function hourBucket(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}_${p(d.getUTCHours())}`;
}

interface OpenFile {
  bucket: string;
  fd: number;
}

class JsonlWriter implements LiquidationWriter {
  written = 0;
  failures = 0;
  lastError: string | null = null;

  private files = new Map<string, OpenFile>();
  private lastSyncAt = 0;
  private stalled = false;

  constructor(private dir: string) {}

  write(event: LiqEvent): void {
    if (this.stalled) return;
    try {
      const bucket = hourBucket(event.receivedAtMs);
      let handle = this.files.get(event.exchange);
      if (!handle || handle.bucket !== bucket) {
        if (handle) this.closeHandle(event.exchange, handle);
        const sub = path.join(this.dir, event.exchange);
        fs.mkdirSync(sub, { recursive: true });
        const file = path.join(sub, `${event.exchange}_liq_${bucket}.jsonl`);
        handle = { bucket, fd: fs.openSync(file, "a") };
        this.files.set(event.exchange, handle);
      }
      fs.writeSync(handle.fd, `${JSON.stringify(event)}\n`);
      this.written += 1;
      this.failures = 0;
      this.lastError = null;

      const now = Date.now();
      if (now - this.lastSyncAt >= FSYNC_INTERVAL_MS) {
        this.lastSyncAt = now;
        this.sync();
      }
    } catch (err) {
      this.failures += 1;
      this.lastError = err instanceof Error ? err.message : String(err);
      if (this.failures >= FAILURE_LIMIT) {
        this.stalled = true;
        console.error(
          `Liquidation persistence disabled after ${FAILURE_LIMIT} consecutive write failures: ${this.lastError}`
        );
      }
    }
  }

  /** Pushes buffered bytes to the disk itself (crash/power-loss safety). */
  sync(): void {
    for (const handle of this.files.values()) {
      try {
        fs.fsyncSync(handle.fd);
      } catch {
        // A failed fsync is reported by the next write; never interrupt the feed.
      }
    }
  }

  close(): void {
    this.sync();
    for (const [key, handle] of [...this.files]) this.closeHandle(key, handle);
  }

  private closeHandle(key: string, handle: OpenFile): void {
    try {
      fs.closeSync(handle.fd);
    } catch {
      // Nothing useful to do; the bytes were already handed to writeSync.
    }
    this.files.delete(key);
  }
}

/**
 * Replays every hourly file still inside the retention window. Files are
 * filtered by mtime first so a 50-hour scan never reads months of history,
 * then each line is validated: a crash can leave a torn final line, which
 * simply fails to parse and is skipped.
 */
export function loadPersistedEvents(dir: string, retentionMs: number, maxEvents: number): LiqEvent[] {
  const cutoff = Date.now() - retentionMs;
  const loaded: LiqEvent[] = [];

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return []; // No directory yet: first run.
  }

  for (const entry of entries) {
    const sub = path.join(dir, entry);
    try {
      if (!fs.statSync(sub).isDirectory()) continue;
      for (const file of fs.readdirSync(sub)) {
        if (!file.endsWith(".jsonl")) continue;
        const full = path.join(sub, file);
        try {
          if (fs.statSync(full).mtimeMs < cutoff) continue;
          replayFile(full, cutoff, loaded);
        } catch {
          // Unreadable file: the rest of the window still loads.
        }
      }
    } catch {
      // Unreadable venue directory: keep going.
    }
  }

  loaded.sort((a, b) => a.receivedAtMs - b.receivedAtMs);
  if (loaded.length > maxEvents) loaded.splice(0, loaded.length - maxEvents);
  return loaded;
}

function replayFile(file: string, cutoff: number, into: LiqEvent[]): void {
  const text = fs.readFileSync(file, "utf8");
  if (!text) return;
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    try {
      const event = JSON.parse(line) as LiqEvent;
      if (
        typeof event.receivedAtMs === "number" &&
        event.receivedAtMs >= cutoff &&
        typeof event.symbol === "string" &&
        event.symbol.length > 0 &&
        typeof event.exchange === "string"
      ) {
        into.push(event);
      }
    } catch {
      // Torn line from an unclean shutdown; every other line still parses.
    }
  }
}

let active: { writer: JsonlWriter; replayedEvents: number; dir: string } | null = null;

/**
 * Replays the on-disk window into the store and starts writing again.
 * Call before startLiquidationCollectors() so replayed events never race a
 * live push, and before the HTTP routes so /api/liq/status reports it.
 * LIQ_PERSIST=0 skips entirely (tests, offline debugging).
 */
export function startLiquidationPersistence(
  store: LiquidationStoreLike,
  opts: { retentionMs: number; maxEvents: number }
): LiqPersistenceInfo {
  const dir = resolveLiquidationDataDir();
  if (process.env.LIQ_PERSIST === "0") {
    return { enabled: false, dir, replayedEvents: 0, writtenEvents: 0, writeFailures: 0, lastError: null };
  }

  let replayedEvents = 0;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const startedAt = Date.now();
    replayedEvents = store.hydrate(loadPersistedEvents(dir, opts.retentionMs, opts.maxEvents));
    console.log(
      `Liquidation persistence: replayed ${replayedEvents} events in ${Date.now() - startedAt}ms from ${dir}`
    );
  } catch (err) {
    console.error("Liquidation persistence: boot replay failed, continuing memory-only:", err);
  }

  const writer = new JsonlWriter(dir);
  store.attachWriter(writer);
  active = { writer, replayedEvents, dir };
  return liquidationPersistenceInfo();
}

/** Flushes and closes the log. Called from the SIGTERM/SIGINT shutdown path. */
export function stopLiquidationPersistence(): void {
  if (!active) return;
  active.writer.close();
  active = null;
}

/** Snapshot merged into GET /api/liq/status. */
export function liquidationPersistenceInfo(): LiqPersistenceInfo {
  if (!active) {
    return {
      enabled: false,
      dir: defaultLiquidationDataDir(),
      replayedEvents: 0,
      writtenEvents: 0,
      writeFailures: 0,
      lastError: null,
    };
  }
  return {
    enabled: true,
    dir: active.dir,
    replayedEvents: active.replayedEvents,
    writtenEvents: active.writer.written,
    writeFailures: active.writer.failures,
    lastError: active.writer.lastError,
  };
}
