/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { CoinOption } from "../types";

/**
 * Quote suffix the terminal analyses against. Typed tickers are normalized to
 * it so "ldo", "LDO" and "LDOUSDT" all resolve to the same instrument.
 */
export const QUOTE_ASSET = "USDT";

/**
 * Quote suffixes recognized in already-qualified tickers. Anything else the
 * user types is treated as a base asset and gets USDT appended.
 */
const KNOWN_QUOTE_SUFFIXES = ["USDT", "USDC", "BUSD", "FDUSD", "TUSD", "BTC", "ETH", "BNB"];

/**
 * Normalizes free-form ticker input into a canonical uppercase pair symbol.
 *
 * Accepts what a trader actually types: "sol", "SOL", "solusdt", "  sol/usdt ",
 * "SOL-USDT". Returns "" for input that cannot become a symbol.
 *
 * Some futures-only listings use non-Latin characters, so the character filter
 * keeps Unicode letters and digits rather than stripping them to nothing.
 */
export function normalizeTickerInput(raw: string): string {
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/[\s/_-]+/gu, "")
    .replace(/[^\p{L}\p{N}]/gu, "");

  if (!cleaned) return "";

  const upperQuote = KNOWN_QUOTE_SUFFIXES.find((q) => cleaned.endsWith(q) && cleaned.length > q.length);
  if (upperQuote) {
    // Collapse any non-USDT quote to the USDT pair the terminal actually serves
    return `${cleaned.slice(0, -upperQuote.length)}${QUOTE_ASSET}`;
  }

  return `${cleaned}${QUOTE_ASSET}`;
}

/**
 * How a candidate matched the query, best first. Used so typing "SOL" surfaces
 * SOLUSDT above the dozens of pairs that merely contain the substring.
 */
type MatchTier = 0 | 1 | 2 | 3 | 4;

function scoreCandidate(candidate: CoinOption, normalizedTerm: string, term: string): MatchTier {
  const symbol = candidate.symbol;
  const base = candidate.baseAsset.toUpperCase();

  if (base === term || symbol === normalizedTerm) return 0; // exact ticker
  if (base.startsWith(term) || symbol.startsWith(normalizedTerm)) return 1; // ticker prefix
  // "1000PEPE" should not outrank "PEPE" for the query "PEPE"
  if (base.replace(/^1000/, "").startsWith(term)) return 2;
  if (symbol.includes(normalizedTerm) || base.includes(term)) return 3; // loose substring
  return 4;
}

export interface RankOptions {
  /** Symbols already in the workspace; excluded unless `includeExisting`. */
  exclude?: string[];
  /** Keep already-added symbols in the list, flagged instead of hidden. */
  includeExisting?: boolean;
  limit?: number;
}

export interface RankedMatch {
  coin: CoinOption;
  /** True when the ticker is already in the workspace. */
  existing: boolean;
}

/**
 * Ranks catalog entries against a query, best match first.
 *
 * An empty query returns nothing rather than dumping 500 symbols: the picker is
 * a search box, and an unfiltered list is unusable at this catalog size.
 */
export function rankCatalogMatches(
  catalog: CoinOption[],
  query: string,
  options: RankOptions = {}
): RankedMatch[] {
  const { exclude = [], includeExisting = false, limit = 8 } = options;

  const term = query.trim().toUpperCase().replace(/[\s/_-]+/gu, "");
  if (!term) return [];

  const normalizedTerm = normalizeTickerInput(term);
  const excluded = new Set(exclude.map((s) => s.toUpperCase()));
  const scored: { match: RankedMatch; tier: MatchTier; length: number }[] = [];

  for (const coin of catalog) {
    const tier = scoreCandidate(coin, normalizedTerm, term);
    if (tier === 4) continue;

    const existing = excluded.has(coin.symbol.toUpperCase());
    if (existing && !includeExisting) continue;

    scored.push({ match: { coin, existing }, tier, length: coin.baseAsset.length });
  }

  // Tier first, then shortest ticker (SOL before SOLANA), then alphabetical for
  // a stable order across renders.
  scored.sort(
    (a, b) => a.tier - b.tier || a.length - b.length || a.match.coin.symbol.localeCompare(b.match.coin.symbol)
  );

  return scored.slice(0, limit).map((s) => s.match);
}

/**
 * Resolves typed input against the live catalog, and — when the catalog has not
 * caught up with a fresh listing — falls back to a server-side lookup that
 * probes the tape directly.
 *
 * Returns a discriminated result so the UI can distinguish "added" from
 * "no such symbol" from "backend unreachable" and say which.
 */
export type ResolveResult =
  | { status: "ok"; coin: CoinOption }
  | { status: "not-found"; symbol: string }
  | { status: "error"; message: string };

export async function resolveTicker(
  rawInput: string,
  catalog: CoinOption[]
): Promise<ResolveResult> {
  const symbol = normalizeTickerInput(rawInput);
  if (!symbol) {
    return { status: "error", message: "Enter a ticker such as LDO, INJ or TONUSDT." };
  }

  const local = catalog.find((c) => c.symbol === symbol);
  if (local) {
    return { status: "ok", coin: local };
  }

  // Not in the client's catalog. Ask the server, which force-refreshes and can
  // accept a brand-new listing the cached catalog never saw.
  try {
    const res = await fetch(`/api/symbol-lookup?symbol=${encodeURIComponent(symbol)}`);
    const data = await res.json();

    if (!res.ok) {
      return { status: "error", message: data?.error || "Symbol lookup failed." };
    }
    if (data?.found) {
      const coin: CoinOption = {
        symbol: data.symbol,
        baseAsset: data.baseAsset,
        name: data.name,
        category: data.category,
        description: data.description,
        market: data.market,
        contractType: data.contractType,
        provisional: Boolean(data.provisional),
        firstBarTime: data.firstBarTime ?? null,
      };
      return { status: "ok", coin };
    }
    return { status: "not-found", symbol };
  } catch {
    return {
      status: "error",
      message: "Cannot reach the exchange catalog. Check the backend connection.",
    };
  }
}

/** "3d", "2mo", "5h" — used to describe how much history an asset has. */
export function formatHistoryAge(firstBarTime: number | null | undefined): string | null {
  if (!firstBarTime) return null;

  const hours = (Date.now() - firstBarTime) / 3600000;
  if (hours < 1) return "<1h";
  if (hours < 48) return `${Math.floor(hours)}h`;
  if (hours < 24 * 60) return `${Math.floor(hours / 24)}d`;
  if (hours < 24 * 365) return `${Math.floor(hours / 720)}mo`;
  return `${Math.floor(hours / 8760)}y`;
}
