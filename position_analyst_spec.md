# Position Analyst: Agent Build Spec

**Purpose.** For any symbol and timestamp, produce a data-grounded verdict on an open or planned position. The verdict is probabilities with intervals and sample sizes, not a signal. Downside is the priority: when evidence is thin, the correct output is "insufficient evidence / no trade".

**Stack assumption.** Python 3.11 backend (pandas, numpy, scipy, httpx/aiohttp, websockets), SQLite or Parquet for storage, a single-page HTML front end served by the same process. Change freely, but keep the module boundaries below.

**Defaults (editable in `config.yaml`).**

| Key | Default |
|---|---|
| base (lowest) timeframe | 15m; no sub-15m bars are used for analysis |
| holding horizon | **12 hours**, defined in time, not bars (`horizon_hours: 12`) |
| H in bars | derived: `H = horizon_hours * 60 / base_tf_minutes` (= 48 at 15m); never hard-coded |
| lookback for volatility | 7 days of base bars (672 at 15m), excluding the move being analyzed |
| level lookback N | 48 h of base bars (192 at 15m), decay half-life 6 h |
| min analogs for any probability | 30 |
| interval method | Wilson (frequency) or Beta posterior (shrunk) |
| fee + slippage assumption | fee taker 5 bps per side, slippage from book walk |
| OI refresh | 60 s auto + manual button |

**Horizon and timeframe rules.**
- The base timeframe is 15m. Finer data (5m OI history, raw trades, liquidations, book snapshots) is only aggregated up into 15m bars; no layer reasons on sub-15m bars.
- The holding horizon is 12 hours. A position that has neither hit TP nor SL after 12 hours is a `TIMEOUT`, in the live tab and in every analog replay.
- Higher timeframes (1h, 4h) may be added as read-only context for levels, never as the base.
- A 12h window crosses at least one funding settlement and shifts through trading sessions, so time-of-day seasonality and funding events are explicit inputs (see Layer 1, Layer 2 and the Funding card).

---

## 0. Architecture

```
fetchers/        binance.py bybit.py okx.py hyperliquid.py mcap.py
normalize/       symbols.py  units.py  oi_sum.py
store/           snapshots (orderbook, OI, funding) + klines + liquidations
manual/          overrides.py   (manual inputs, locks, TTL)
layers/          l1_move_anomaly.py  l2_reachability.py  l3_levels.py  l4_market_relative.py
analogs/         features.py  knn.py  outcomes.py
verdict/         combine.py  ev.py  sizing.py
api/             REST/WebSocket for UI
ui/              position management tab (cards in section 7)
```

Rules:
- Each fetcher returns a typed record with `value, unit, source, fetched_at, status` (`ok | stale | failed`).
- No layer calls an exchange directly; layers read from `store/` and `manual/` only.
- Every number shown in the UI carries its source tag (`auto`, `manual`, `stale`) and age.

---

## 1. Data acquisition

Verify every endpoint against the current official docs before coding; fields and limits change.

### 1.1 Open interest and 24h volume (all four venues, summed per coin)

| Venue | OI | 24h volume | Notes |
|---|---|---|---|
| Binance USD-M | `GET /fapi/v1/openInterest` (base-asset quantity); history `GET /futures/data/openInterestHist` (min 5m, limited retention) | `GET /fapi/v1/ticker/24hr` → `quoteVolume` | mark price from `/fapi/v1/premiumIndex` |
| Bybit linear | `GET /v5/market/tickers?category=linear` → `openInterest` (base), `openInterestValue` (USD if provided); history `GET /v5/market/open-interest` | same tickers call → `turnover24h` | |
| OKX swap | `GET /api/v5/public/open-interest?instType=SWAP` → `oi` (contracts), `oiCcy` (coins), `oiUsd` if present | `GET /api/v5/market/tickers?instType=SWAP` → `volCcy24h`, `vol24h` | contract size `ctVal` from `/api/v5/public/instruments`; never treat `oi` contracts as coins without `ctVal` |
| Hyperliquid | `POST /info {"type":"metaAndAssetCtxs"}` → per-asset `openInterest` (base units) | `dayNtlVlm` (USD) | no OI history: **start storing your own snapshots now**; mark price `markPx` |

### 1.2 Unit normalization (critical, most common bug)

Everything is converted to **USD notional** using that venue's mark price at fetch time:

```
oi_usd_venue = oi_base_qty * mark_price           # Binance, Bybit, Hyperliquid
oi_usd_venue = oi_contracts * ctVal * mark_price  # OKX (or use oiUsd/oiCcy if supplied)
```

Also keep `oi_base_qty` so that OI change can be separated from price change (`ΔOI_base` is the real positioning change; `ΔOI_usd` mixes in price).

### 1.3 Symbol mapping

- Build `symbols.py` with a canonical coin ID and one row per venue: `{coin, binance_symbol, bybit_symbol, okx_instId, hl_name, multiplier}`.
- Handle multipliers: `1000PEPE` (Binance/Bybit) vs `kPEPE` (Hyperliquid) vs `PEPE` elsewhere. Normalize to per-single-coin quantity before summing.
- Universe: all symbols listed on Bybit and Binance. For each coin, sum across every venue where it exists. If only on Bybit, sum Bybit only. A coin missing on a venue is `not_listed`, not `failed`.
- Flag unmapped or ambiguous symbols for manual alias entry (section 6).

### 1.4 Aggregation

```
oi_total_usd   = Σ venues oi_usd
vol24_total_usd= Σ venues 24h perp notional volume
oi_share[v]    = oi_usd_v / oi_total_usd         # shown in UI
```

- Aggregate ΔOI over the analysis timeframe by summing per-venue OI base-quantity changes. If a venue lacks history at that resolution, use stored snapshots; if none, mark that venue `no_history` and **say so on the card** (do not silently drop it).
- Store the `last_data_timestamp` per venue and per coin. The UI shows it. Manual refresh must not create duplicate rows (idempotent upsert on `(coin, venue, ts_bucket)`).

### 1.5 Market cap

- Sources (try in order): CoinGecko `/coins/markets` (`market_cap`, `circulating_supply`, `fully_diluted_valuation`), then a second provider (CoinPaprika or CMC), then **manual**.
- Mapping ticker to provider ID is ambiguous for small caps. Store the chosen provider ID per coin; flag duplicates.
- Fallback computation: `mcap = circulating_supply * price` if only supply is available.
- Keep `fdv` too; a large `fdv / mcap` gap is a risk flag (unlock overhang).

### 1.6 Order book, trades, liquidations, klines

- Order book: top 100-500 levels per venue where possible; **snapshot at analysis time and keep it**. Also poll every N seconds while a position is open, so wall persistence can be measured.
- Aggressor trades: for taker delta/CVD and the big-trades threshold feature.
- Liquidations: use the existing unified feed (Binance, Bybit, OKX).
- Klines: from Binance Data Vision or the REST API at the analysis timeframe. Storage is required for the analog engine.

---

## 2. Layer 1: Move anomaly (fluke vs explained)

**Question:** Is the move that produced |z| ≥ 2 within normal range, and what made it?

### 2.1 Honest z-score

```
σ_pre  = EWMA or MAD-scaled stdev of bar returns over lookback, EXCLUDING the move bars
σ_pre  *= time_of_day_factor(hour)        # intraday seasonality
z_raw  = r_move / (σ_pre * sqrt(bars_in_move))
r_res  = r_coin - β * r_BTC               # β from rolling regression (e.g. 7d)
z_res  = r_res / (σ_res * sqrt(bars_in_move))
pct    = empirical percentile of |r_move| in the coin's own history (same timeframe)
```

- Report `z_raw`, `z_res`, `pct`. Crypto is fat-tailed, so the percentile is the primary measure and z is the reference.
- If `|z_res| < 1`, the move is **market beta**, not coin-specific.

### 2.2 Attribution

Compute driver z-scores over the move window against the coin's own baseline:

- `vol_z`: volume
- `oi_z`: ΔOI (base quantity)
- `liq_long_z`, `liq_short_z`: liquidation notional by side
- `delta_z`: taker delta (CVD)
- `bigtrade_z`: big-trade count/notional
- `impact = |return| / volume`, then its z (thin-book signal)
- `depth_z`: current depth at ±10 bps vs baseline (low = thin)
- `breadth`: share of venues that show the same direction and magnitude
- `funding_shift`

**Quadrant (price × OI):**

| Price | OI | Class | Durability |
|---|---|---|---|
| ↑ | ↑ | FRESH_LONGS | trend-supportive |
| ↑ | ↓ | SHORT_SQUEEZE / COVERING | fragile |
| ↓ | ↑ | FRESH_SHORTS | trend-supportive |
| ↓ | ↓ | LONG_LIQUIDATION / CAPITULATION | often exhausts |

Use a deadband: if `|ΔOI|` is below a noise threshold (e.g. `|oi_z| < 0.5`), set quadrant = `NEUTRAL`.

### 2.3 Verdict classes

| Class | Condition (tune on your data) |
|---|---|
| EXPLAINED_INFORMED | quadrant fresh-side AND `vol_z > 1.5` AND `breadth ≥ 0.75` AND depth not collapsed |
| EXPLAINED_FORCED | liquidation z > 2 on the relevant side AND ΔOI negative |
| LIQUIDITY_VACUUM | `impact` z > 2 AND `depth_z < -1` AND `vol_z < 1` |
| BETA | `|z_res| < 1` |
| UNEXPLAINED | no driver above 1.5σ |

Output also the **explained fraction**: regress `|r_move|` on the drivers (rolling, per coin or pooled) and report R² contribution per driver. Show it as a horizontal bar in the card.

Historical backing: show the empirical forward-return distribution (next 12 h, i.e. H bars) for the same class, same coin if N ≥ 30, otherwise pooled.

---

## 3. Layer 2: TP/SL reachability

**Question:** Given OI, OI change and the book at analysis time, can TP and SL realistically be reached within the horizon?

### 3.1 Statistical reach

```
d_tp = |TP - entry| / entry,   d_sl = |SL - entry| / entry
σ_H  = σ_pre * sqrt(H)                              # horizon vol
k_tp = d_tp / σ_H,   k_sl = d_sl / σ_H              # distances in σ-units
P_touch(d, H) ≈ 2 * (1 - Φ(d / σ_H))                # driftless touch probability
P_tp_first_driftless = d_sl / (d_tp + d_sl)         # gambler's ruin
```

Flag `TP_UNLIKELY` if `k_tp > 1.5` and `UNREACHABLE` if `k_tp > 2.5`. Report the empirical version from analogs alongside the analytic one; trust the empirical one once N ≥ 30.

Over 48 bars the `sqrt(H)` scaling is weaker, because volatility clusters and varies by session. So also compute `σ_H_emp` directly: the distribution of realized 12h high-low range (and of 12h close-to-close return) from the coin's own history, matched to the same time-of-day window if data allows. Use `σ_H_emp` when it differs from `σ_pre * sqrt(H)` by more than 25%, and show both. Reflect any funding settlement inside the window as a flag on the card.

### 3.2 Book cost

```
cost_tp = Σ cumulative opposing-side depth (USD) between entry and TP   # buyer needs to eat asks (long)
cost_sl = Σ cumulative depth between entry and SL
flow_bar = median aggressive taker volume per base bar (same side, last 96 bars = 24 h at 15m)
sweep_ratio_tp = cost_tp / (flow_bar * H)
sweep_ratio_sl = cost_sl / (flow_bar * H)
```

- Ratio > 1 means the horizon cannot supply enough flow to get there under typical conditions.
- Also report `depth_imbalance = bid_depth_band / ask_depth_band` for bands = SL distance and TP distance.
- Wall persistence: a wall counts only if present in ≥ 70% of snapshots in the last M minutes. Show `wall_age`.
- Venue breadth: compute depth per venue and combined.

### 3.3 OI fuel and liquidation clusters

- **OI-by-price profile:** for each bar, add `ΔOI_base` (signed by aggressor direction or by the quadrant) into the price bucket of that bar. This approximates where positions were opened.
- **Estimated liquidation levels** for assumed leverage tiers `L ∈ {5, 10, 25, 50}`:
  `liq_long = entry_bucket * (1 - 1/L + mmr)`, `liq_short = entry_bucket * (1 + 1/L - mmr)`.
  Weight by tier assumptions (config). These are estimates, not observed data. **Label them as such.**
- Outputs:
  - `TP_in_cluster` (magnet): TP within ±0.25 ATR of a heavy cluster.
  - `SL_exposed`: SL within ±0.25 ATR beyond a heavy cluster on the stop side.
  - `fuel_score`: OI added in the last window that sits on the far side of price (what can be forced out).

### 3.4 Reachability output

`{k_tp, k_sl, P_touch_tp, P_touch_sl, sweep_ratio_tp, sweep_ratio_sl, TP_in_cluster, SL_exposed, depth_imbalance, label}` where label ∈ `REACHABLE | STRETCHED | UNLIKELY | UNREACHABLE`.

---

## 4. Layer 3: Opposing levels (bull vs bear candle groups)

**Question:** Which levels are most likely to work against the position, and what is the likely outcome?

### 4.1 Candle groups

Take the last N bars on the analysis timeframe, split into `BULL` (close > open) and `BEAR` (close < open). Weight each bar by `w = exp(-age / half_life)`.

For each group build a **price-bucketed profile** (bucket = 0.25 × ATR):
- volume profile (`Σ w * volume` allocated across the bar's range, weighted toward the body)
- taker-delta profile
- count of touches/rejections

Candle quality: `body_ratio = |close-open| / (high-low)`. Weight rejection levels (long wicks) separately.

### 4.2 Level types

For a **long**:
- **Overhead resistance:** BEAR volume above entry (sellers active; longs who bought there are trapped and sell at breakeven). Include the opens of large bearish candles and the last bearish candle before an impulsive drop.
- **Support:** BULL volume below entry.
- **Air pockets:** buckets with near-zero volume from both groups. If the SL sits in one, expect slippage through it.
For a **short**, mirror everything.

### 4.3 OI quadrant tagging per candle

Tag each candle: bull+OI↑ (fresh longs), bull+OI↓ (short cover), bear+OI↑ (fresh shorts), bear+OI↓ (long exit/liquidation). Then:
- Above entry: bear+OI↑ clusters are fresh shorts and resist first; if broken, their stops become squeeze fuel (record as `breakout_fuel`).
- Above entry: bull+OI↑ clusters are trapped longs (supply at breakeven).
- Below entry: bull+OI↑ clusters are longs defending support; bear+OI↓ clusters mean capitulation already done (weaker support signal).

### 4.4 Level strength score

```
strength = Σ_bars (w * volume_in_bucket * body_ratio) * (1 + 0.25*touches) * tag_multiplier
```
Rank levels, then output:
- `nearest_opposing_level`, distance in ATR, strength percentile vs other levels in the window
- `levels_between_entry_and_tp` (count and total strength)
- `levels_between_entry_and_sl` (supporting your stop vs air pocket)

### 4.5 Outcome distribution (analog engine)

Feature vector per setup: `z_res, quadrant, liq_z, delta_z, depth_z, k_tp, k_sl, sweep_ratio, dist_to_opposing_level_ATR, strength, market_relative_score (layer 4), time_of_day`.

- Standardize features, find K nearest historical setups (K = 100, minimum 30 above a distance threshold) from the stored dataset. Restrict to same timeframe and, if enough data, same coin tier.
- For each analog replay TP/SL on the forward path (bar-by-bar, assume SL fills first if both are touched in the same bar). Record MFE, MAE, outcome ∈ `TP | SL | TIMEOUT`.
- Output `P_tp, P_sl, P_timeout` with Wilson intervals, `N`, mean `bars_to_exit`, MFE/MAE medians, and the analog dates range (so look-ahead leakage is auditable).
- **Decision rule:**
  `EV = P_tp * R_tp - P_sl * R_sl - costs`. Use the **lower bound** of the interval for `P_tp` and the upper bound for `P_sl`. If `EV_lower ≤ 0` → verdict `NO_EDGE / AVOID`.
- Sizing suggestion: capped fractional Kelly, `f = min(cap, 0.25 * f_kelly(P_tp_lower))`, fixed-risk per trade from config. Present it as a suggestion only.

---

## 5. Layer 4: Market-relative plausibility (mcap, OI, volume)

**Question:** Relative to the overall market and the coin's size, is the move (or the target) plausible?

### 5.1 Core ratios

```
vol_mcap  = vol24_total_usd / mcap          # turnover
oi_mcap   = oi_total_usd / mcap             # leverage footprint
oi_vol    = oi_total_usd / vol24_total_usd  # how many days of volume are sitting in OI
fdv_mcap  = fdv / mcap
```

Worked example from the brief: vol $2M, mcap $500M, OI $10M gives `vol_mcap = 0.4%`, `oi_mcap = 2%`, `oi_vol = 5×`. A very thin flow relative to size.

### 5.2 Cross-sectional context

Maintain the same ratios for the whole universe (all Bybit and Binance symbols, refreshed with the aggregator). Report each ratio as a **percentile** vs the universe and vs mcap-tier peers (micro < $100M, small < $500M, mid < $2B, large). Report also vs BTC and ETH as benchmarks.

### 5.3 Required flow vs available flow

Square-root impact law: `move ≈ Y * σ_day * sqrt(Q / V_day)` with `Y ≈ 1` (calibrate on your own data per tier).

```
Q_required = V_day * (target_move / (Y * σ_day))²
```
- For the 12h horizon, also compute the horizon version: `V_H` = median rolling 12h volume and `σ_H` = the 12h vol from Layer 2, so `Q_required_H = V_H * (target_move / (Y * σ_H))²`. Show both the daily and the 12h figures; the 12h one is the one that judges this position.
- `Q_required` = net aggressive flow needed to produce the move.
- Compare against: `V_day` (daily volume), and the **forced-flow ceiling** `F_max = OI_total_usd * liq_fraction` (liquidations cannot exceed the positions that exist; `liq_fraction` is observed from past spikes, default 0.1-0.3).
- Example: σ_day = 5%, move = 10%, V_day = $2M gives `Q_required = 2M * (10/5)² = $8M`, which is 4× daily volume and close to the entire $10M OI. Plausible only with new capital, news, or a venue outage.

### 5.4 Plausibility score and labels

```
plaus_flow   = clip(1 - Q_required / (V_day + F_max), 0, 1)   # 0 = implausible
crowding     = percentile(oi_mcap)                              # high = squeeze fuel / fragile
thin_flag    = vol_mcap percentile < 10
```
Labels: `PLAUSIBLE | STRETCHED | IMPLAUSIBLE`. Also report `empirical_move_percentile`: how often coins with similar (`vol_mcap`, `oi_mcap`) buckets moved ≥ target within H bars (from your dataset).

Special flags: `OI_MCAP_HIGH` (> 90th percentile: fragile, liquidation cascades more likely), `FDV_OVERHANG`, `MCAP_MANUAL` (confidence reduced).

When the mcap is missing and no manual value is given, **Layer 4 returns `unavailable`** and the verdict states that the market-relative check was skipped. It must never silently assume a value.

---

## 6. Manual inputs and overrides

Anything that fails to fetch can be entered by hand, and anything can be overridden.

| Field | Where used |
|---|---|
| `mcap`, `circulating_supply`, `fdv` | Layer 4 |
| `oi_usd` per venue (and `oi_base`) | aggregator, L1/L2/L4 |
| `vol24_usd` per venue | L4 |
| `mark_price` per venue | normalization |
| `symbol_alias` / `multiplier` per venue | mapping |
| `listed_venues` (force include/exclude) | aggregation |
| `leverage_tiers` weights | L2 liquidation estimate |
| `liq_fraction`, `Y` impact constant | L4 |
| `sigma_day` | L4 (if klines unavailable) |

Behavior:
- Each manual record: `{coin, field, value, unit, entered_at, ttl, lock}`.
- Precedence: `lock=true` manual wins always; otherwise manual is used only when auto is `failed` or `stale`; a fresh auto value replaces an unlocked manual value and the UI notes the swap.
- Default TTL: 24h for mcap/supply, 15 min for OI/volume/price. An expired manual value shows `STALE (manual)` and counts as missing for confidence.
- Every card shows a badge per field: `AUTO • 12s`, `MANUAL • 3h`, `STALE`, `MISSING`.
- A **Data Health** card (section 7) lists every field with its status and an input box next to each failed one.
- Verdict confidence is reduced when key inputs are manual, stale, or missing. State which inputs were degraded.

---

## 7. Position management tab: cards

Layout: header strip, then a responsive grid of cards. Every card has a title, source badge(s), last-updated time, and a collapsed "why" drawer showing the underlying numbers. Colors encode risk (green = favorable, amber = caution, red = adverse), never alone: add icons/text.

1. **Position Header** — symbol, side, entry, mark, uPnL ($ and R-multiple), size, leverage, TP, SL, time in trade against the 12h horizon (elapsed / remaining, with a countdown to timeout), distance to TP/SL in % and σ-units.
2. **Verdict & Risk** — combined verdict (`FAVORABLE | NEUTRAL | ADVERSE | NO_EDGE`), `EV_lower`, suggested size (capped), list of the 3 strongest reasons for and against, invalidation conditions (e.g. "OI quadrant flips to long-liquidation", "wall at X pulled"), data-confidence meter.
3. **Move Anomaly (L1)** — `z_raw`, `z_res`, percentile, class label, quadrant, attribution bars (volume, OI, liquidations, delta, thin book), breadth across venues, historical forward-return distribution for the class.
4. **TP/SL Reachability (L2)** — `k_tp`, `k_sl`, `P_touch` and empirical hit rates, sweep ratios, `TP_in_cluster`, `SL_exposed`, label.
5. **Order Book** — snapshot timestamp (and age), depth in ±10/25/50 bps bands per side and per venue, imbalance, persistent walls with age, cumulative depth curve with entry/TP/SL markers.
6. **OI Composition** — total OI (USD) with per-venue split (Binance/Bybit/OKX/Hyperliquid) and `not_listed`/`no_history` tags, ΔOI over 5m/15m/1h/4h, quadrant, OI vs 24h volume, last data timestamp per venue.
7. **Levels Ladder (L3)** — vertical price ladder: opposing levels, supports, air pockets, estimated liquidation clusters (labeled "estimated"), entry/TP/SL markers, strength, distance in ATR.
8. **Outcome Distribution** — `P_tp / P_sl / P_timeout` with intervals as a stacked bar, `N` analogs, date range, median bars-to-exit, MFE/MAE, expected value after costs, "no edge" banner when `EV_lower ≤ 0` or `N < 30`.
9. **Market-Relative (L4)** — mcap, FDV, `vol_mcap`, `oi_mcap`, `oi_vol` with universe and tier percentiles, required vs available flow bar (`Q_required` vs `V_day` vs `F_max`), plausibility label, flags.
10. **Liquidation & Flow Pulse** — rolling liquidation notional by side, taker delta/CVD, big-trade clusters for the last 1h with the current position's relevant side highlighted.
11. **Funding & Positioning** — funding rate per venue, shifts, OI-weighted funding, crowding percentile, and the time to the next funding settlement(s) inside the 12h window.
12. **Data Health & Manual Inputs** — table of all fields: value, source, age, status; input box and `lock` toggle for each failed or overridden field; global refresh button showing the last refresh time; warnings for stale venues.

Interactions: auto-refresh every 60 s (configurable) plus a manual refresh button. The button triggers an idempotent refresh and must not duplicate rows. A pulse indicator shows when a layer recomputed.

---

## 8. Storage and logging

- Persist every snapshot used in an analysis (OI per venue, book, funding, mcap used with its source) with an `analysis_id`, so any verdict can be reproduced.
- Log each verdict and, once the position closes (or the horizon expires), the realized outcome. This feeds calibration.
- **Start the orderbook and OI snapshot logger immediately.** Hyperliquid OI has no history, and book depth cannot be backtested without stored snapshots.

## 9. Validation (required before trusting any output)

- Walk-forward evaluation only; no look-ahead in features or analog selection (analogs must precede the analysis time).
- Calibration: reliability curve and Brier score for `P_tp`; report by class and by mcap tier.
- Compare against baselines: driftless gambler's-ruin probability, and a plain ATR-only reachability.
- Report layer ablations: how much each layer improves Brier/EV when added.
- Ignore results for any bucket with fewer than 30 analogs; show `insufficient evidence`.

## 10. Edge cases and acceptance criteria

- Coin on only one venue → sum that venue only, others `not_listed`.
- Venue API fails → `failed`, use last good value if inside TTL, else manual prompt, else exclude with a visible warning.
- Multiplier mismatches (1000×, k-prefix) have unit tests; the OI sum for a sample coin must match each exchange's UI within 1%.
- OKX contracts converted with `ctVal` (unit test).
- All timestamps UTC; all candle timestamps aligned to bar close.
- Both TP and SL touched within one bar → count as SL.
- Missing mcap → L4 `unavailable`, not defaulted.
- Acceptance: for a chosen symbol and timestamp, the agent produces the complete card set, every number traceable to a stored snapshot or a manual input, and the verdict is reproducible from `analysis_id`.

## 11. Open parameters to confirm with the owner

- Confirmed by the owner: 12-hour holding horizon, 15m base timeframe, no other bar count assumed.
- Leverage tier weights for liquidation estimates.
- Fee and slippage model per venue.
- Mcap provider preference.
