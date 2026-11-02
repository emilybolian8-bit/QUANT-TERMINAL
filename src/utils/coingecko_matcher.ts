/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Exchange symbol -> CoinGecko id matching.
 *
 * A ticker is not a unique key off-exchange: many CoinGecko ids share a symbol
 * (bridged tokens, scam clones, renames), so a symbol equality is never proof.
 * A match is only trusted when an independent signal agrees — a venue price
 * within tolerance of the CoinGecko price once the contract multiplier is
 * applied. Anything ambiguous is routed to `review` instead of being guessed,
 * because a wrong market cap is worse than no market cap.
 *
 * Pure and dependency-free so it can be unit-tested without a network.
 */

export type GeckoMatchStatus = "matched" | "review" | "unmatched" | "locked";

/** A CoinGecko coin, as this module needs to see it. */
export interface GeckoCandidate {
  geckoId: string;
  /** Lowercase, exactly as CoinGecko returns it. */
  symbol: string;
  name: string;
  marketCapRank: number | null;
  marketCapUsd: number | null;
  priceUsd: number | null;
  totalVolumeUsd: number | null;
}

/** A venue instrument after symbol normalization, ready to match. */
export interface NormalizedVenueInput {
  venue: string;
  venueSymbol: string;
  baseAsset: string;
  multiplier: number;
  price: number | null;
  vol24Usd: number | null;
}

export interface MatchResult {
  venue: string;
  venueSymbol: string;
  baseAsset: string;
  multiplier: number;
  geckoId: string | null;
  confidence: number | null;
  /** auto_unique | auto_scored | manual | review */
  method: string | null;
  status: GeckoMatchStatus;
  runnerUpId: string | null;
  runnerUpScore: number | null;
  reasons: string[];
}

export interface GeckoMatchConfig {
  /** Price agreement tolerance (fraction). Full score inside, zero by 3x. */
  priceMatchTolerance: number;
  /** Minimum best score to auto-accept when several candidates exist. */
  autoAcceptConfidence: number;
  /** Minimum lead over the runner-up to auto-accept. */
  autoAcceptMargin: number;
  /** Scores at or above this are worth showing a human in the review queue. */
  reviewConfidenceFloor: number;
}

export const DEFAULT_MATCH_CONFIG: GeckoMatchConfig = {
  priceMatchTolerance: 0.03,
  autoAcceptConfidence: 0.85,
  autoAcceptMargin: 0.15,
  reviewConfidenceFloor: 0.5,
};

/** Quote currencies stripped from a concatenated market symbol (BTCUSDT). */
const QUOTE_SUFFIXES = ["USDT", "USDC", "BUSD", "FDUSD", "TUSD", "DAI", "USD"];

/** Multiplier prefixes, longest first so 1000000 wins over 1000. */
const MULTIPLIER_PREFIXES: [string, number][] = [
  ["1000000", 1_000_000],
  ["100000", 100_000],
  ["10000", 10_000],
  ["1000", 1000],
];

export interface NormalizedSymbol {
  baseAsset: string;
  multiplier: number;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * Cleans an exchange symbol to a base asset plus contract multiplier.
 *
 * Handles the shapes the four venues actually publish: Binance `1000PEPEUSDT`
 * (baseAsset supplied), Bybit `PEPEUSDT`, OKX `PEPE-USDT-SWAP`, and Hyperliquid
 * `kPEPE` (lowercase-k = 1000x). The multiplier matters because the venue price
 * is quoted per contract, i.e. 1000 units of the base asset.
 */
export function normalizeVenueSymbol(
  venue: string,
  venueSymbol: string,
  baseAsset?: string | null
): NormalizedSymbol {
  let token = (baseAsset && baseAsset.trim()) || venueSymbol || "";
  token = token.trim();

  // OKX joins base-quote-settle with dashes: keep the leading base leg.
  if (token.includes("-")) {
    token = token.split("-").filter(Boolean)[0] ?? token;
  }

  let multiplier = 1;

  // Hyperliquid encodes the 1000x multiplier as a lowercase "k" prefix (kPEPE).
  if (venue === "hyperliquid" && /^k[A-Z0-9]/.test(token)) {
    multiplier = 1000;
    token = token.slice(1);
  }

  let upper = token.toUpperCase();

  // Strip a trailing quote currency when only a full market symbol was given.
  if (!baseAsset) {
    for (const quote of QUOTE_SUFFIXES) {
      if (upper.length > quote.length && upper.endsWith(quote)) {
        upper = upper.slice(0, -quote.length);
        break;
      }
    }
  }

  if (multiplier === 1) {
    if (/^1M(?=[A-Z])/.test(upper)) {
      // 1MBABYDOGE = 1,000,000 BABYDOGE
      multiplier = 1_000_000;
      upper = upper.slice(2);
    } else {
      for (const [prefix, m] of MULTIPLIER_PREFIXES) {
        // Require a real base asset after the digits (never strip "1INCH").
        if (
          upper.length > prefix.length &&
          upper.startsWith(prefix) &&
          /[A-Z]/.test(upper[prefix.length])
        ) {
          multiplier = m;
          upper = upper.slice(prefix.length);
          break;
        }
      }
    }
  }

  return { baseAsset: upper || token.toUpperCase(), multiplier };
}

/** Convenience wrapper producing a ready-to-match instrument. */
export function normalizeInstrument(
  venue: string,
  venueSymbol: string,
  baseAsset: string | null | undefined,
  price: number | null,
  vol24Usd: number | null
): NormalizedVenueInput {
  const { baseAsset: base, multiplier } = normalizeVenueSymbol(venue, venueSymbol, baseAsset);
  return { venue, venueSymbol, baseAsset: base, multiplier, price, vol24Usd };
}

export interface CandidateScore {
  candidate: GeckoCandidate;
  score: number;
  priceScore: number | null;
  reasons: string[];
}

/** Normalized token overlap between a venue base asset and a CoinGecko name. */
function nameSimilarity(baseAsset: string, name: string): number {
  const base = baseAsset.toLowerCase();
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.includes(base)) return 1;
  if (tokens.some((t) => t.length >= 3 && (t.startsWith(base) || base.startsWith(t)))) {
    return 0.6;
  }
  return 0;
}

/**
 * Scores one candidate against the venue instrument. Returns null when the
 * candidate is hard-rejected (price off by more than 3x tolerance, or a
 * placeholder coin with neither a market cap nor any volume).
 */
export function scoreCandidate(
  input: NormalizedVenueInput,
  candidate: GeckoCandidate,
  cfg: GeckoMatchConfig = DEFAULT_MATCH_CONFIG
): CandidateScore | null {
  // Dead/placeholder id: no market cap and no turnover is never the right coin.
  if (
    (candidate.marketCapUsd == null || candidate.marketCapUsd === 0) &&
    (candidate.totalVolumeUsd == null || candidate.totalVolumeUsd === 0)
  ) {
    return null;
  }

  const reasons: string[] = [];
  const tol = cfg.priceMatchTolerance;
  let priceScore: number | null = null;

  if (input.price != null && candidate.priceUsd != null && candidate.priceUsd > 0) {
    const venueBase = input.price / input.multiplier;
    const deviation = Math.abs(venueBase / candidate.priceUsd - 1);
    if (deviation <= tol) {
      priceScore = 1;
      reasons.push(`price within ${(deviation * 100).toFixed(2)}%`);
    } else if (deviation >= 3 * tol) {
      // Wrong coin by a wide margin: drop it before it can win on rank alone.
      return null;
    } else {
      priceScore = clamp01(1 - (deviation - tol) / (3 * tol - tol));
      reasons.push(`price off by ${(deviation * 100).toFixed(1)}%`);
    }
  }

  const symbolScore = candidate.symbol.toLowerCase() === input.baseAsset.toLowerCase() ? 1 : 0;

  const rankScore =
    candidate.marketCapRank && candidate.marketCapRank > 0
      ? clamp01(1 - Math.log10(candidate.marketCapRank) / Math.log10(20000))
      : 0.1;

  let volumeScore = 0.5;
  const geckoVol = candidate.totalVolumeUsd;
  if (input.vol24Usd != null && geckoVol != null) {
    if (geckoVol <= 0) {
      // Zero CoinGecko volume with real venue turnover is a bad match.
      volumeScore = input.vol24Usd > 0 ? 0 : 0.5;
    } else {
      const ratio = input.vol24Usd / geckoVol;
      volumeScore =
        ratio <= 0 ? 0 : ratio <= 3 ? 1 : clamp01(1 - (ratio - 3) / 7);
    }
  }

  const nameScore = nameSimilarity(input.baseAsset, candidate.name);

  const score =
    0.4 * (priceScore ?? 0.5) +
    0.15 * symbolScore +
    0.2 * rankScore +
    0.15 * volumeScore +
    0.1 * nameScore;

  return { candidate, score, priceScore, reasons };
}

/**
 * Resolves one instrument to a CoinGecko id following the spec's order:
 * unique top-set symbol, then scored candidates, then the full-id pool (which
 * is never auto-accepted). Manual overrides are the caller's job (they win
 * unconditionally) so this stays pure.
 */
export function matchCoin(
  input: NormalizedVenueInput,
  topCandidates: GeckoCandidate[],
  poolCandidates: GeckoCandidate[] = [],
  cfg: GeckoMatchConfig = DEFAULT_MATCH_CONFIG
): MatchResult {
  const result: MatchResult = {
    venue: input.venue,
    venueSymbol: input.venueSymbol,
    baseAsset: input.baseAsset,
    multiplier: input.multiplier,
    geckoId: null,
    confidence: null,
    method: null,
    status: "unmatched",
    runnerUpId: null,
    runnerUpScore: null,
    reasons: [],
  };

  const scored = topCandidates
    .map((candidate) => scoreCandidate(input, candidate, cfg))
    .filter((s): s is CandidateScore => s != null)
    .sort((a, b) => b.score - a.score);

  if (scored.length > 0) {
    const best = scored[0];
    const runner = scored[1] ?? null;
    result.runnerUpId = runner?.candidate.geckoId ?? null;
    result.runnerUpScore = runner ? round3(runner.score) : null;
    result.geckoId = best.candidate.geckoId;
    result.confidence = round3(best.score);
    result.reasons = [...best.reasons];

    // Exactly one usable same-symbol coin in the top set: accept when the
    // price confirms it, otherwise leave it for a human.
    if (topCandidates.length === 1) {
      if (best.priceScore === 1) {
        result.method = "auto_unique";
        result.status = "matched";
        result.confidence = round3(Math.min(1, 0.9 + 0.09 * best.score));
        result.reasons.unshift("unique symbol in top set; price confirmed");
      } else {
        result.method = "auto_unique";
        result.status = "review";
        result.reasons.unshift(
          best.priceScore == null
            ? "unique symbol; venue price unavailable to confirm"
            : "unique symbol but price is off tolerance"
        );
      }
      return result;
    }

    const margin = best.score - (runner?.score ?? 0);
    if (best.score >= cfg.autoAcceptConfidence && margin >= cfg.autoAcceptMargin) {
      result.method = "auto_scored";
      result.status = "matched";
      result.reasons.unshift(
        `best ${round3(best.score)} leads runner-up by ${round3(margin)}`
      );
    } else {
      result.method = "review";
      result.status = "review";
      result.reasons.unshift(
        `ambiguous: ${scored.length} same-symbol candidates, margin ${round3(margin)}`
      );
    }
    return result;
  }

  // Nothing usable in the top set: fall back to the full id list, but never
  // auto-accept from it (many ids share a symbol outside the top ranks).
  const poolScored = poolCandidates
    .map((candidate) => scoreCandidate(input, candidate, cfg))
    .filter((s): s is CandidateScore => s != null)
    .sort((a, b) => b.score - a.score);

  if (poolScored.length > 0) {
    const best = poolScored[0];
    const runner = poolScored[1] ?? null;
    result.geckoId = best.candidate.geckoId;
    result.method = "review";
    result.status = "review";
    result.confidence = round3(best.score);
    result.runnerUpId = runner?.candidate.geckoId ?? null;
    result.runnerUpScore = runner ? round3(runner.score) : null;
    result.reasons = [
      "outside the top set — suggested from the full id list, needs review",
      ...best.reasons,
    ];
    return result;
  }

  result.reasons = ["no same-symbol candidate"];
  return result;
}
