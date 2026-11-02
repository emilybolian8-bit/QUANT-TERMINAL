/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CoinGecko id-helper regression checks (coingecko_id_helper_spec.md §7-8).
 * Pure/offline: no CoinGecko or exchange requests are made. Run with
 * `npx.cmd tsx smoke_coingecko.ts`.
 */

import os from "os";
import path from "path";

// Point the store at a throwaway file and never start the background build.
process.env.COINGECKO_DISABLE = "1";
process.env.COINGECKO_DATA_FILE = path.join(os.tmpdir(), `gecko-test-${process.pid}.json`);

const { normalizeVenueSymbol, scoreCandidate, matchCoin } = await import(
  "./src/utils/coingecko_matcher"
);
const idmap = await import("./src/utils/coingecko_id_map");

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

interface Cand {
  geckoId: string;
  symbol: string;
  name: string;
  marketCapRank: number | null;
  marketCapUsd: number | null;
  priceUsd: number | null;
  totalVolumeUsd: number | null;
}
const cand = (over: Partial<Cand> & { geckoId: string }): Cand => ({
  symbol: "pepe",
  name: "Pepe",
  marketCapRank: 50,
  marketCapUsd: 4e9,
  priceUsd: 0.00001,
  totalVolumeUsd: 1e9,
  ...over,
});

/* 1. Symbol normalization. */
{
  const cases: [string, string, string | null, number, string][] = [
    ["binance", "1000PEPEUSDT", "1000PEPE", 1000, "PEPE"],
    ["binance", "1000SHIBUSDT", "1000SHIB", 1000, "SHIB"],
    ["binance", "1MBABYDOGEUSDT", "1MBABYDOGE", 1_000_000, "BABYDOGE"],
    ["binance", "BTCUSDT", null, 1, "BTC"],
    ["binance", "1INCHUSDT", null, 1, "1INCH"],
    ["hyperliquid", "kPEPE", null, 1000, "PEPE"],
    ["okx", "PEPE-USDT-SWAP", "PEPE", 1, "PEPE"],
    ["bybit", "PEPEUSDT", "PEPE", 1, "PEPE"],
  ];
  const detail: string[] = [];
  let ok = true;
  for (const [venue, sym, base, mult, wantBase] of cases) {
    const r = normalizeVenueSymbol(venue, sym, base);
    if (!(r.multiplier === mult && r.baseAsset === wantBase)) ok = false;
    // eslint-disable-next-line no-console
    console.log(`    ${sym} -> ${r.baseAsset} x${r.multiplier}`);
  }
  check("1. symbol normalization (quote/multiplier/hyperliquid-k)", ok);
}

/* 2. Multiplier-aware price agreement accepts the correct coin. */
{
  const input = {
    venue: "binance",
    venueSymbol: "1000PEPEUSDT",
    baseAsset: "PEPE",
    multiplier: 1000,
    price: 0.01,
    vol24Usd: 1_000_000,
  };
  const scored = scoreCandidate(input, cand({ geckoId: "pepe" }));
  check(
    "2. 1000PEPE @0.01 matches PEPE @0.00001 (multiplier applied)",
    scored != null && scored.priceScore === 1
  );
}

/* 3a. Collision: the wrong-price candidate is hard-rejected. */
{
  const input = {
    venue: "binance",
    venueSymbol: "PEPEUSDT",
    baseAsset: "PEPE",
    multiplier: 1,
    price: 0.00001,
    vol24Usd: 1_000_000,
  };
  const result = matchCoin(input, [
    cand({ geckoId: "pepe" }),
    cand({ geckoId: "pepe-fake", name: "Pepe Clone", priceUsd: 0.5 }),
  ]);
  check(
    "3a. collision keeps the price-confirmed candidate",
    result.geckoId === "pepe" && result.status === "matched",
    `id=${result.geckoId} status=${result.status}`
  );
}

/* 3b. Two candidates both passing within the margin -> review. */
{
  const input = {
    venue: "binance",
    venueSymbol: "PEPEUSDT",
    baseAsset: "PEPE",
    multiplier: 1,
    price: 0.00001,
    vol24Usd: 1e9,
  };
  const result = matchCoin(
    input,
    [cand({ geckoId: "pepe-a" }), cand({ geckoId: "pepe-b" })]
  );
  check(
    "3b. ambiguous same-symbol pair routed to review, not guessed",
    result.status === "review" && result.runnerUpId != null
  );
}

/* 4. A locked override wins over any score. */
{
  idmap.setGeckoOverride("binance:TESTUSDT", "the-right-id", "unit test");
  const resolved = idmap.resolveGeckoId({ venue: "binance", venueSymbol: "TESTUSDT" });
  const status = idmap.coinGeckoStatus();
  check(
    "4. locked override resolves and is counted",
    resolved.geckoId === "the-right-id" && resolved.status === "locked" && status.overrides >= 1,
    `id=${resolved.geckoId} status=${resolved.status} overrides=${status.overrides}`
  );
}

/* 5. Unmapped coin -> unavailable, never a guessed market cap. */
{
  const resolved = idmap.resolveGeckoId({ venue: "binance", venueSymbol: "NOTMAPPEDUSDT" });
  const mcap = await idmap.resolveGeckoMcap({
    baseAsset: "NOTMAPPED",
    venue: "binance",
    venueSymbol: "NOTMAPPEDUSDT",
  });
  check(
    "5. unmapped coin returns unavailable (no guessed mcap)",
    resolved.geckoId == null && mcap.status === "unavailable" && mcap.marketCapUsd == null,
    `status=${mcap.status}`
  );
}

console.log(
  failures === 0
    ? "\nALL COINGECKO ID-HELPER CHECKS PASSED"
    : `\n${failures} COINGECKO ID-HELPER CHECK(S) FAILED`
);
