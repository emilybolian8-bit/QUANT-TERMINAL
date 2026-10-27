import {
  prepareProbabilityDataset,
  buildProbabilityResponse,
  buildProbabilityBrief,
  PROBABILITY_DEFAULTS,
} from "./src/utils/probability_engine";
import { Kline } from "./src/types";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSeries(seed: number, n: number, start = 1700000000000): Kline[] {
  const rng = mulberry32(seed);
  const bars: Kline[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    // random walk with occasional trend bursts
    const drift = rng() < 0.02 ? (rng() - 0.35) * 0.03 : (rng() - 0.5) * 0.012;
    const open = price;
    const close = price * (1 + drift);
    const high = Math.max(open, close) * (1 + rng() * 0.006);
    const low = Math.min(open, close) * (1 - rng() * 0.006);
    const volume = 1000 + rng() * 500;
    const takerBuy = volume * (0.4 + rng() * 0.2 + drift * 4);
    bars.push({ time: start + i * 3600000, open, high, low, close, volume, takerBuy });
    price = close;
  }
  return bars;
}

const t0 = Date.now();
const klines = new Map<string, Kline[]>();
const rng = mulberry32(7);
const universe = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "AVAXUSDT", "LINKUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT"];
for (const [i, sym] of universe.entries()) {
  klines.set(sym, makeSeries(1000 + i * 13, 3000 + Math.floor(rng() * 500)));
}
const btc = klines.get("BTCUSDT") as Kline[];

const params = { ...PROBABILITY_DEFAULTS, interval: "1h" as const, lookbackDays: 180, universeSize: 8 };
const prep = prepareProbabilityDataset(klines, ["TROUBLEUSDT"], btc, params);
const elapsed = Date.now() - t0;

console.log("prepare ms:", elapsed);
console.log("accounting:", JSON.stringify(prep.accounting, null, 1));
console.log("stageA:", prep.stageA.map((s) => `${s.key}=${s.p.toFixed(3)} [${s.count}]`).join(" "));
console.log("base:", JSON.stringify({
  collapse: prep.base.collapse.p.toFixed(3),
  extension: prep.base.extension.p.toFixed(3),
  consolidation: prep.base.consolidation.p.toFixed(3),
}));
console.log("stageB nEff:", prep.stageBNEff.toFixed(1), "blocks:", prep.blockCount);
console.log("timing:", JSON.stringify(prep.timing));
console.log("downside reach:", JSON.stringify(prep.downside.reachBeforeCollapse), "amb:", prep.downside.ambiguousShare.toFixed(2), "advP95:", prep.downside.adverseExcursionPct.p95.toFixed(1));
console.log("regime:", prep.regime.map((r) => `${r.label} p=${r.collapse.toFixed(2)} n=${r.n}`).join(" | "));
console.log("health:", JSON.stringify({
  bss: prep.health.bss,
  ci: prep.health.bssCi80,
  slope: prep.health.calibrationSlope,
  oof: prep.health.oofEvents,
  verdict: prep.health.sensitivityVerdict,
  range: prep.health.sensitivityRange,
  cells: prep.health.sensitivity.length,
}));
console.log("warnings:", prep.warnings);

const resp = buildProbabilityResponse(prep, "SOLUSDT");
console.log("state gate:", resp.stageB.gate, "nEff:", resp.stageB.nEff.toFixed(1), "flags:", resp.stageB.flags);
console.log("state cond:", JSON.stringify({
  collapse: resp.stageB.conditional.collapse.p.toFixed(3),
  extension: resp.stageB.conditional.extension.p.toFixed(3),
  consolidation: resp.stageB.conditional.consolidation.p.toFixed(3),
}));
console.log("episode:", JSON.stringify(resp.stageB.episode));
console.log("episodes series:", resp.history.episodes.map((e) => `${e.symbol} pts=${e.points.length} active=${e.active} label=${e.resolvedLabel}`));
if (resp.history.episodes[0]) {
  for (const p of resp.history.episodes[0].points)
    console.log(`  φ=${p.phase} c=${p.collapse.toFixed(2)} e=${p.extension.toFixed(2)} x=${p.consolidation.toFixed(2)} nEff=${p.nEff.toFixed(1)} gated=${p.gated} rho=${p.rho.toFixed(2)}`);
}
const brief = buildProbabilityBrief(prep, "BTCUSDT");
console.log("brief gate:", brief.state.gate, "desc:", brief.state.description[0]);

// second run deterministic?
const t1 = Date.now();
const prep2 = prepareProbabilityDataset(klines, ["TROUBLEUSDT"], btc, params);
const resp2 = buildProbabilityResponse(prep2, "SOLUSDT");
console.log("deterministic:", JSON.stringify(resp.stageB.conditional) === JSON.stringify(resp2.stageB.conditional), "second ms:", Date.now() - t1);
