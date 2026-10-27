# Event-Level Empirical & Bayesian Framework for Post-Surge Price Dynamics (v2, revised)

**Purpose:** an analyst tool that reports, from historical precedent, the conditional probability that a coin which has undergone an extreme expansion subsequently *collapses*, *extends to a second leg*, or *consolidates*, together with timing and downside-risk profiles and honest uncertainty.

**Status:** analytical and non-predictive. Nothing here is a trading signal. **No number in this document is an empirical result**; every figure in examples is a placeholder (`XX.X%`).

---

## 0. What Changed From the Prior Draft

| # | Problem in prior draft | Correction in this version |
| :-- | :--- | :--- |
| 1 | **Milestone leaked into the label.** A break defined as loss of a VWAP anchored at surge start sits near mid-range, so the "≥ 50% retrace" label was partly satisfied by construction. | `t_break` is a fixed, shallow pullback fraction of the surge range. Labels are measured **incrementally from the price at `t_break`**. Structure signals (lower high, VWAP loss) become *features*, not triggers (§2, §3). |
| 2 | **Conditioning on a breakdown occurring** silently excluded straight-line continuations, inflating the collapse base rate. | Explicit two-stage structure. Stage A: P(breakdown occurs). Stage B: outcomes given breakdown. Every probability is labelled with its conditioning (§2, §6). |
| 3 | **Surge origin misdefined.** `t_0` was the bar where the z-score *breached*, so the range `R_surge` excluded the move that triggered the event and retrace percentages were mis-scaled. | `t_0` is the swing-low **origin** of the run, found by looking back from the trigger bar (§2). |
| 4 | **Independence assumed.** Beta-Binomial treated events as exchangeable, but pumps cluster by date, repeat on one coin, and share BTC regime. | De-duplication with a cooldown, date-block clustering, hierarchical effects, effective-N accounting, cluster bootstrap (§6). |
| 5 | **Bucket selection bias and hard bins.** Reporting the most extreme bucket is a winner's curse; bins reintroduce discretization and sparse-cell variance. | Primary engine is a **Bayesian multinomial regression on continuous features** with shrinkage priors. Buckets are a presentation layer only (§6). |
| 6 | **Three separate Beta-Binomials** are not jointly coherent. | **Dirichlet-multinomial** for the base layer; priors set by empirical Bayes (§6). |
| 7 | **Kaplan-Meier treated a second leg as censoring** (informative censoring), and the hazard ratio was read as a speed ratio. | **Competing-risks** cumulative incidence (Aalen-Johansen); covariate effects via Fine-Gray or cause-specific Cox, with correct interpretation (§7). |
| 8 | **Adverse-excursion profile used collapse events only**, hiding the squeeze tail that hurts shorts. | Excursion statistics computed over **all** events, plus probability of reaching `peak + x·R` before collapse (§8). |
| 9 | **CVD divergence** via cumulative series is spurious (both trend). **Displacement efficiency** depends on bar size. | Per-bar definitions and a sampling-sensitivity check (§4). |
| 10 | **BSS gate computed in-sample**, with a hard `≤ 0` cut that flips randomly at small N. | Out-of-fold skill with block-bootstrap intervals; gate on the interval, not the point estimate (§9). |
| 11 | **Horizon `h`, `k_surge`, baseline, cooldown undefined or tied to fixed calendar durations.** | All parameters defined on the scale-free convention below (§1). |

---

## 1. Parameter Convention (Scale-Free)

No parameter in this framework is a fixed calendar duration. Every window or split is one of:

- a **count of bars** on the analysis timeframe,
- a **fraction of the available bars or events**, or
- a **multiple of the event's own duration** `D = (bars from t_0 to t_peak)`.

This makes the framework timeframe-agnostic and robust to however much history is available.

| Parameter | Meaning | Default (tune only inside training folds) |
| :--- | :--- | :--- |
| `L_surge` | Trigger lookback in bars (the bar span matching the surge criterion in use) | user-defined |
| `k_surge` | Trigger threshold on baseline-scaled return z-score (optional absolute return floor for a fixed-size case study) | grid; report sensitivity |
| `β` | Pullback depth defining `t_break`, as a fraction of `R` | 0.10 (grid 0.05-0.20) |
| `δ_c` | Collapse distance below `P_break`, as a fraction of `R` | 0.25 |
| `δ_e` | Extension distance above `P_peak`, as a fraction of `R` | 0.25 |
| `m` | Horizon multiplier: `h = m · D` (with `h_min` and `h_max` bar bounds) | 2 (grid 1, 2, 3) |
| `m_b` | Breakdown window multiplier: no-breakdown if no `t_break` within `m_b · D_trig` bars after the trigger | 2 |
| `ε` | Fraction of pre-surge history excluded just before `t_0` from the baseline | 0.15-0.20 |
| `B_max` | Cap on baseline bars (keeps the baseline recent) | longest window with ≥ 80% data coverage |
| `c` | Per-coin cooldown after an event, as a multiple of `h` | ≥ 2 |
| Dev / holdout | Chronological split by event onset order | earliest ≈ 80% development, latest ≈ 20% sealed holdout |
| `K` | Number of equal-bar time blocks for blocked CV | 5-10 |
| Coverage | Minimum non-missing bar share over baseline + event window | ≥ 80% (else exclude, and log it) |
| `n_eff` floor | Minimum effective analog count to report a conditional state | max(≈ 30 events, ≈ 5% of development events) |
| Credible level | Reported intervals | 80% and 95% |

---

## 2. Event Definition, Universe, and Milestones

### 2.1 Universe (point-in-time)

- Include delisted, halted, and sunset pairs; use listing/delisting records as of each date, not the current list.
- State scope explicitly: requiring perp OI/funding history restricts the universe to coins that received perps, which skews toward larger or more hyped names. Report results *for that universe*.
- Exclude events failing the data-coverage rule; log the excluded share and check that exclusion is not correlated with outcome.

### 2.2 Surge trigger and origin

1. **Trigger bar `t_trig`:** first bar where the return over the last `L_surge` bars, scaled by the coin's baseline volatility, satisfies `Z_return ≥ k_surge` (and any absolute-return floor in use).
2. **Origin `t_0`:** the bar of the lowest low within the `L_surge` bars before `t_trig`. This is known at `t_trig` and anchors the run. (Using the breach bar itself would understate the surge range.)
3. **Cooldown:** after an event, ignore new triggers on the same coin for `c · h` bars, so repeat triggers inside one episode do not become separate observations.

### 2.3 Peak and breakdown (objective, shallow, leakage-controlled)

Work in log prices, `p_τ = ln P_τ`, so large surges do not distort proportions.

- **Surge range:** `R = p_peak − p_{t_0}`.
- **Breakdown `t_break`:** the first bar close after `t_trig` with

$$ p^{\text{close}}_\tau \le \max_{s \in [t_0, \tau]} p^{\text{high}}_s - \beta R $$

- **Peak:** `t_peak = argmax` of highs on `[t_0, t_break]`; `P_peak` is that high. `D = t_peak − t_0` in bars.
- **No-breakdown events:** if no `t_break` occurs within `m_b · D_trig` bars of `t_trig`, the event is classified *no-breakdown* and kept in the dataset (see §3, Stage A). It is never discarded.

### 2.4 Structure signals are features, not triggers

Lower high, loss of the VWAP anchored at `t_0`, upper-wick fraction of the peak bar, and pullback speed are measured **at `t_break`** and enter the model as covariates (§4). This removes the circularity of prior label design.

### 2.5 Leakage diagnostic (required before any modelling)

Compute the pullback depth at breakdown for every event:

$$ \rho_{\text{break}} = \frac{p_{\text{peak}} - p_{\text{break}}}{R} $$

Require the distribution of `ρ_break` to be tightly concentrated near `β` and far below the cumulative-retrace levels used in any label. If a meaningful share of events already satisfy a label at `t_break`, flag them as *pre-resolved* and exclude them from that label's denominator.

---

## 3. Two-Stage Structure and Labels

### Stage A: does a breakdown occur?

For every triggered event, record whether `t_break` occurred within the breakdown window, and if not, whether the run extended (new highs beyond the trigger-time peak by a margin of `δ_e · R`). This gives P(breakdown) and P(second leg before any breakdown). **All Stage B probabilities are conditional on a breakdown occurring and must be labelled that way.**

### Stage B: outcome after breakdown (incremental labels)

Horizon `h = m · D` bars from `t_break`. For `τ ∈ [t_break, t_break + h]`:

$$
Y_E =
\begin{cases}
-1 & \text{if } \exists\,\tau:\; \dfrac{p_{\text{break}} - p_\tau}{R} \ge \delta_c \quad (\text{Collapse}) \\[2mm]
+1 & \text{if } \exists\,\tau:\; \dfrac{p_\tau - p_{\text{peak}}}{R} \ge \delta_e \quad (\text{Second-Leg Extension}) \\[2mm]
0 & \text{if neither level is touched within } h \quad (\text{Consolidation})
\end{cases}
$$

- **First-touch rule:** the earlier touch decides. If both levels fall inside one bar, resolve with finer-timeframe data when available; otherwise tag the event *ambiguous*, report the ambiguous share, and show results with ambiguous events excluded, assigned to each class, and split.
- **Secondary descriptive measure:** cumulative retrace from peak, `(p_peak − p_τ)/R`, reported alongside (e.g., share reaching 0.50). Its pre-resolved share is shown.
- **Sensitivity is mandatory:** repeat headline results over a grid of `β`, `δ_c`, `δ_e`, and `m`. A conclusion that flips across reasonable choices is reported as fragile.

---

## 4. Feature Matrix (measured at `t_break`, point-in-time)

### 4.1 Normalization

- **Primary reference:** the coin's own pre-surge baseline: the pre-`t_0` history excluding the last `ε` fraction, capped at `B_max` most recent bars. Use robust scaling (median / MAD).
- **Fallback** when the coin has too few baseline bars: a peer-cohort reference distribution (similar market-cap tier) built from other coins.
- **Cutpoints, percentiles, and scalers are fit on training folds only.**

### 4.2 Group A: leverage and positioning

| Feature | Definition | Notes |
| :--- | :--- | :--- |
| Normalized OI expansion | `(OI_{t_peak} − OI_{t_0}) / MarketCap_{t_0}`; also OI/market-cap level vs peer cohort | Use point-in-time circulating supply snapshots (supply data is revised). |
| Funding excess | latest settled funding at `t_break` minus baseline median, in baseline MADs | Funding is a step function; use settled rate, optionally the predicted rate. |
| Perp-spot basis | `(P_perp − P_spot)/P_spot` at `t_break` vs baseline | Pair with spot/perp **volume share**. |
| Short-liquidation share (run-up) | `Σ_{[t_0,t_peak]} ShortLiqVol / Σ Volume` | **Lower-bound proxy:** some venue streams are throttled and under-report. Keep venue coverage constant across the sample. |
| Long-liquidation share (since peak) | long liquidation volume on `[t_peak, t_break]` / volume | Indicates whether the long flush has already begun. |

**Composite:** `LeverageScore` = first principal component (fit on training folds) or mean of rank-normalized OI expansion, funding excess, and basis. Use it instead of three correlated axes.

### 4.3 Group B: order-flow exhaustion

| Feature | Definition | Notes |
| :--- | :--- | :--- |
| CVD divergence | per-bar correlation `corr(r_τ, Δ_τ)` over `[t_0, t_peak]`, where `Δ_τ` is signed taker volume normalized by bar volume; plus the slope of CVD residual over the last third of the run | Cumulative-series correlation is spurious (both trend); do not use it. |
| Displacement efficiency | `\|p_peak − p_{t_0}\| / Σ_τ \|p_τ − p_{τ-1}\|` | Computed at the analysis bar size **and** at a coarser resampling to test noise sensitivity; use the more stable one. |
| Volume decay | median volume over `[t_peak, t_break]` / median volume over `[t_0, t_peak]` (log ratio), with a minimum-bar guard | Pullback span is short, so use the median to limit noise. |

### 4.4 Group C: structure at breakdown

Lower-high flag; distance of close from the VWAP anchored at `t_0`, in units of `R`; upper-wick fraction of the peak bar; pullback speed `ρ_break / (bars from peak to break)`.

### 4.5 Group D: context

Float ratio (circulating/FDV) point-in-time; listing age in bars or age percentile; catalyst class (exchange listing, news, none/unknown); BTC regime (BTC return and volatility percentile over the same span); count of other simultaneous surges (crowding); spot-vs-perp volume share; cyclical time-of-day and weekday.

### 4.6 Feature budget

Cap the number of features at roughly one per 15-20 effective events in the smallest outcome class. Add features one at a time by out-of-fold log-score improvement; drop any that do not help.

---

## 5. Data Integrity Checklist

- Every feature and label must be reproducible using only information available at `t_break` (features) or after it (labels).
- Percentile cutoffs, priors, PCA loadings, and hyperparameters are estimated within training folds.
- Point-in-time market cap, listings, and delistings; no survivorship.
- Funding and OI aligned to their true publication times (not forward-filled backwards).
- Log and report: events excluded for coverage, ambiguous labels, pre-resolved events, de-duplicated repeats.

---

## 6. Probability Engine

### 6.1 Dependence handling (applies to everything below)

- De-duplicate repeats per coin via the cooldown.
- Assign each event to a **date block** (equal-bar time block); events in the same block share regime and are not independent.
- Compute **effective sample size** `n_eff` from clustering (design effect) and use it in place of raw `N` for all intervals.
- Hierarchical effects: coin tier and date block as random intercepts.
- Use cluster (block) bootstrap for intervals wherever a closed form is not available.

### 6.2 Base layer: Dirichlet-multinomial

For a state (or the whole sample) with class counts `n = (n_c, n_0, n_e)`:

$$ \mathbf{p} \mid \mathbf{n} \sim \text{Dirichlet}\big(\boldsymbol{\alpha}_0 + \mathbf{n}_{\text{eff}}\big), \qquad \boldsymbol{\alpha}_0 = m_0 \cdot \hat{\mathbf{p}}_{\text{base}} $$

- `p̂_base` comes from training data; `m_0` (prior strength) is set by empirical Bayes (marginal likelihood across states) or CV, not by hand.
- `n_eff` replaces raw counts via `n_eff = n · (effective N / raw N)` so clustering widens the posterior.
- Report the posterior mean and the 80% / 95% credible intervals for each class **jointly**, so the three probabilities always sum to one.

### 6.3 Primary model: Bayesian multinomial regression on continuous features

$$
\log \frac{P(Y=j \mid \mathbf{x})}{P(Y=0 \mid \mathbf{x})} = a_j + \mathbf{x}^\top \boldsymbol{\beta}_j + u_{\text{block}} + u_{\text{tier}}, \quad j \in \{-1, +1\}
$$

- Standardized features; shrinkage priors on `β_j` (hierarchical scale, or regularized horseshoe) so weak effects collapse toward zero.
- Outputs are **posterior predictive** class probabilities with credible intervals from posterior draws.
- If a full Bayesian fit is impractical, use a penalized multinomial logit with a block bootstrap for intervals.
- Fewer than a few hundred events: restrict to a handful of features and the composite scores; do not add trees.

### 6.4 State buckets as a presentation layer only

Buckets (e.g., "High leverage + negative CVD divergence + VWAP lost") are shown for readability. Their displayed probabilities come from the continuous model or from **kernel-weighted analogs** (similarity-weighted history with effective N), shrunk toward the parent in the order *state → regime → coin tier → pooled base rate*. Raw bucket frequencies are never the headline number.

### 6.5 Insufficient-data rule

If `n_eff` for the current state is below the floor, or the current feature vector is out-of-distribution relative to training events, the report shows the **base rate only** and states "insufficient comparable history."

---

## 7. Timing: Competing-Risks Analysis

Collapse and extension are **competing events**; reaching the horizon is the only censoring.

- **Cumulative incidence (Aalen-Johansen):**

$$ \hat F_j(t) = \sum_{t_i \le t} \hat S(t_{i-1}) \frac{d_{j,i}}{n_i}, \qquad \hat S(t) = \prod_{t_i \le t}\left(1 - \frac{d_{1,i} + d_{2,i}}{n_i}\right) $$

  where `j` indexes collapse or extension. Report `F̂_collapse` and `F̂_extension` at `0.25h, 0.5h, 0.75h, h` (times in bars and as fractions of `h`).
- **Median time to collapse** is only reported if the collapse cumulative incidence actually reaches 50% within `h`; otherwise report "not reached."
- **Covariate effects:** Fine-Gray (subdistribution) or cause-specific Cox. A hazard ratio is a ratio of instantaneous rates, **not** "X times faster"; describe it as such, or use accelerated-failure-time output if a speed interpretation is wanted.
- Apply the same dependence handling as §6.1 (cluster-robust variance).

---

## 8. Downside and Adverse-Excursion Profile (all events)

Computed over **all** events with a breakdown (never collapse-only), measured from `P_break`:

- **Adverse excursion** for a short-side view: `AE = max_{τ ∈ [t_break, t_break+h]} (p_τ − p_break) / R`, and the same in percent terms.
- **Stop-style probabilities:** `P(price reaches P_peak + x·R before the collapse level, within h)` for a grid of `x`, overall and conditional on collapse.
- **Tail summary:** 50th / 90th / 95th / 99th percentiles and expected shortfall of `AE`; also maximum favorable excursion.
- Report these **with intervals** and the sample size. Tail quantiles from few events are unreliable; state this beside each number and use a bootstrap.

The point of this section is that the squeeze tail, not the average outcome, is what determines whether a collapse thesis is survivable.

---

## 9. Validation and Audit Protocol

1. **Chronological split:** develop and tune on the earliest ≈ 80% of events; keep the latest ≈ 20% as a **sealed holdout**, evaluated once at the end.
2. **Blocked CV on the development set:** split the timeline into `K` equal-bar blocks; leave one block out at a time. Purge `h` bars on each side of the held-out block, and purge across **all coins** at overlapping timestamps (crypto events are cross-sectionally dependent).
3. **Everything learned from data is fit inside training folds:** priors, cutpoints, scalers, PCA loadings, hyperparameters, feature selection.
4. **Metrics (out-of-fold):**
   - Multiclass log-score and **Brier skill score** against climatology computed from the *training-fold* base rates:

$$ \text{BSS} = 1 - \frac{\text{BS}_{\text{model}}}{\text{BS}_{\text{clim}}}, \qquad \text{BS} = \frac1N \sum_i \sum_{j} (p_{ij} - y_{ij})^2 $$

   - Calibration slope and intercept (preferred over binned reliability plots at small N; if bins are shown, pool them and show intervals).
   - Credible-interval coverage: do nominal 80% / 95% intervals contain outcomes at about those rates out of fold?
5. **Block-bootstrap intervals on every skill metric.** With few events these metrics are noisy; report the interval.
6. **Reporting gate:** a conditional view is shown only if the **lower bound** of its out-of-fold skill interval exceeds zero. Otherwise the report falls back to the base rate. This replaces the earlier point-estimate `BSS ≤ 0` cut.
7. **Benchmarks the model must beat out of fold:** climatology; a one-feature logistic (`ρ_break` or `LeverageScore`); a logistic with two to three hand-chosen features. If the full model does not beat them, report the simpler one.
8. **Multiple-comparison control:** count and report how many states, features, and parameter settings were examined. Rely on hierarchical shrinkage rather than selecting the best-looking cell.
9. **Stability checks:** skill in the first half vs second half of the development period; by coin tier; by BTC regime; across the `β, δ_c, δ_e, m` grid; with and without ambiguous and pre-resolved events.
10. **Holdout and monitoring:** open the sealed holdout once. After deployment, track rolling out-of-sample calibration and re-estimate on an expanding window; flag drift.

---

## 10. Output Schema

The report is descriptive. **Every number below is a placeholder.**

```
================================================================================
EVENT STATE ANALYSIS (historical precedent, not a forecast)
State:  <plain-language description of the current feature vector>
Conditioning: GIVEN a breakdown (pullback of β·R) has occurred
Analogs: N = XX events | n_eff = XX | share of analog weight from latest 20% of events = XX%
Gate: PASSED / FALLBACK TO BASE RATE   |   Flags: [OOD] [ambiguous XX%] [pre-resolved XX%]
================================================================================

0. STAGE A (all triggered events)
   P(breakdown occurs) = XX%  [CI]    P(second leg before breakdown) = XX%  [CI]

1. OUTCOME PROBABILITIES (Stage B, given breakdown)
   Outcome                     Base rate   Conditional (post. mean)   80% CI        95% CI
   Collapse        (−1)         XX.X%       XX.X%                      [XX, XX]      [XX, XX]
   Extension       (+1)         XX.X%       XX.X%                      [XX, XX]      [XX, XX]
   Consolidation    (0)         XX.X%       XX.X%                      [XX, XX]      [XX, XX]
   (probabilities sum to 100%; intervals widened for clustering)

2. TIMING (competing risks, h = m·D)
   Cumulative incidence at 0.25h / 0.5h / 0.75h / h:
     Collapse:   XX% / XX% / XX% / XX%
     Extension:  XX% / XX% / XX% / XX%
   Median time to collapse: <value in bars> or "not reached within h"

3. DOWNSIDE PROFILE (all events with breakdown, from P_break)
   P(reach peak + x·R before collapse): x = 0.0 / 0.1 / 0.25 / 0.5  →  XX% / XX% / XX% / XX%
   Adverse excursion (in R and %): p50 / p90 / p95 / p99 / ES95  →  XX / XX / XX / XX / XX
   Note: tail quantiles rest on few events; see interval and n.

4. MODEL HEALTH (out-of-fold)
   Brier skill vs climatology: XX  [block-bootstrap CI]   Log-score skill: XX  [CI]
   Calibration slope/intercept: XX / XX   Interval coverage (80%/95%): XX% / XX%
   Sensitivity across β, δ, m: STABLE / FRAGILE
================================================================================
```

---

## 11. Implementation Order

1. **Event table and diagnostics.** Build the point-in-time universe, triggers, origins, milestones, and cooldown de-duplication. Report counts, excluded share, no-breakdown share, ambiguous share, and the `ρ_break` leakage diagnostic.
2. **Base rates.** Stage A and Stage B base rates with Dirichlet intervals and dependence-adjusted `n_eff`. Run the parameter-sensitivity grid.
3. **Univariate effects.** One feature at a time, shrunk, out-of-fold. Keep only features that improve log-score.
4. **Multivariate Bayesian model** with the feature budget; compare against the simple benchmarks.
5. **Competing risks and downside profile** (§7, §8).
6. **Report generator and monitoring** with the gating and insufficient-data rules.

---

## 12. Known Limitations

- **Small effective sample.** Extreme surges are rare and clustered; effective N is far smaller than the event count suggests. Wide intervals are the correct output.
- **Regime drift.** Market structure, listing practices, and leverage norms change; conditional frequencies describe past regimes, so recency weighting and rolling checks are required.
- **Proxy data.** Liquidation streams, circulating supply, and funding timing are imperfect; the framework treats them as noisy proxies.
- **Scope.** Results apply to coins in the point-in-time universe with the required derivatives data, not to all coins.
- **Descriptive, not causal.** Conditional frequencies show association with historical outcomes; they do not establish that a feature causes a reversal.
