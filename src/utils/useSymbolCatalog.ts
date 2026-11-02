/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CoinOption, SymbolCatalog } from "../types";

/**
 * Client-side freshness window. Deliberately shorter than the server TTL so a
 * picker that has sat open still re-pulls without the user pressing refresh.
 */
const CLIENT_TTL_MS = 5 * 60 * 1000;

const STORAGE_KEY = "quant_symbol_catalog_v1";

interface CachedCatalog {
  fetchedAt: number;
  symbols: CoinOption[];
}

function readCache(): CachedCatalog | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.fetchedAt !== "number" || !Array.isArray(parsed.symbols)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(symbols: CoinOption[], fetchedAt: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ symbols, fetchedAt }));
  } catch {
    // Private-mode or quota failures are non-fatal: the in-memory copy still works
  }
}

/**
 * Single source of truth for the tradable symbol list, shared by every ticker
 * input in the app.
 *
 * - Loads on first focus rather than on mount, so a 500-symbol catalog is not
 *   pulled before the user asks for it.
 * - Hydrates instantly from localStorage, then revalidates in the background,
 *   so the dropdown is never blank and never permanently stale.
 * - `refresh()` bypasses both caches, which is how a freshly listed pair gets
 *   picked up the moment someone clicks refresh.
 */
export function useSymbolCatalog() {
  const [symbols, setSymbols] = useState<CoinOption[]>([]);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  // Guards against a slow response overwriting a newer one after a forced refresh
  const requestSeq = useRef(0);

  const load = useCallback(async (force: boolean) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/binance-symbols${force ? "?force=1" : ""}`);
      const data = (await res.json()) as SymbolCatalog & { error?: string };

      if (seq !== requestSeq.current) return; // superseded by a newer request

      if (!res.ok) {
        setError(data?.error || "Failed to load the Binance symbol catalog.");
        return;
      }
      if (!Array.isArray(data.symbols)) {
        setError("Exchange catalog came back in an unexpected shape.");
        return;
      }

      setSymbols(data.symbols);
      setFetchedAt(data.fetchedAt);
      setStale(Boolean(data.stale));
      setWarning(data.warning ?? null);
      writeCache(data.symbols, data.fetchedAt);
    } catch (err: any) {
      if (seq !== requestSeq.current) return;
      // Offline: fall back to whatever the last session cached
      setError(err?.message || "Cannot reach the symbol catalog service.");
      const cached = readCache();
      if (cached) {
        setSymbols(cached.symbols);
        setFetchedAt(cached.fetchedAt);
        setStale(true);
      }
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  /**
   * Called on input focus. Serves the cached catalog immediately and only hits
   * the network when the copy on hand is actually past its TTL.
   */
  const ensureLoaded = useCallback(() => {
    if (symbols.length === 0) {
      const cached = readCache();
      if (cached) {
        setSymbols(cached.symbols);
        setFetchedAt(cached.fetchedAt);
        setStale(Date.now() - cached.fetchedAt >= CLIENT_TTL_MS);
      }
    }

    if (Date.now() - fetchedAt >= CLIENT_TTL_MS) {
      void load(false);
    }
  }, [symbols.length, fetchedAt, load]);

  const refresh = useCallback(() => {
    void load(true);
  }, [load]);

  return { symbols, fetchedAt, loading, error, stale, warning, ensureLoaded, refresh };
}
