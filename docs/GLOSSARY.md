# C55 Tracker — Glossary, Calculations & Assumptions

This document is the canonical human-readable reference for every term, label,
parameter, formula, and threshold used in the C55 predictive-maintenance
dashboard. All values come directly from the source files cited; when a value
changes in the code, this document should be updated to match.

---

## Table of Contents

1. [Core Logic Constants](#1-core-logic-constants)
2. [Sample Status Classification](#2-sample-status-classification)
3. [Pass Detection](#3-pass-detection)
4. [Production Run Validation](#4-production-run-validation)
5. [Lifecycle Metrics (Per Part)](#5-lifecycle-metrics-per-part)
6. [Health Badge Classification](#6-health-badge-classification)
7. [Seal Wear Fraction](#7-seal-wear-fraction)
8. [Composite Risk Score](#8-composite-risk-score)
9. [ML Model Blend](#9-ml-model-blend)
10. [Part Catalog — All Thresholds](#10-part-catalog--all-thresholds)
11. [Maintenance Event Types](#11-maintenance-event-types)
12. [Sensor Signals](#12-sensor-signals)
13. [Installation ID Naming Convention](#13-installation-id-naming-convention)
14. [Failure Modes](#14-failure-modes)

---

## 1. Core Logic Constants

**Source files:** `lib/analytics.ts` (lines 5–11), `data_pipeline.py` (lines 57–61)

These five constants define the operating envelope for the C55 homogenizer.
Every sample classification, runtime counter, and stress integral is derived
from them. They are the single source of truth — changing them recalculates
everything downstream.

| Constant | Current Value | Unit | What it means |
|---|---|---|---|
| `ACTIVE_BAND_LOW_KPSI` | **19.0** | kpsi | Lower pressure bound of the active operating band. Samples below this are considered idle / ramping. |
| `ACTIVE_BAND_HIGH_KPSI` | **26.0** | kpsi | Upper pressure bound. Samples above this are flagged `out_of_band` — atypical over-pressure. |
| `PULSATION_STDEV_KPSI` | **2.0** | kpsi | Rolling standard-deviation threshold. When σ(P01) exceeds this within the active band, the sample is tagged `high_stress` (pulsation-driven fatigue). |
| `ROLLING_WINDOW_MIN` | **10** | minutes | Width of the trailing time window used to compute the rolling stdev. |
| `GAP_OFF_MIN` | **5** | minutes | Minimum gap between consecutive sensor samples to be interpreted as a Machine Off / Maintenance window. |

> **Assumption:** P01 is measured in kpsi (kilopounds per square inch). VantagePoint
> sometimes exports raw psi; the pipeline auto-detects this by checking whether
> the median value exceeds 1,000 and divides by 1,000 if so.

---

## 2. Sample Status Classification

**Source files:** `lib/analytics.ts` `classifySample()` (lines 87–96),
`data_pipeline.py` `tag_samples()` (lines 267–305),
`lib/trends-ingest.ts` `tagSamples()` (lines 353–385)

Every sensor reading is assigned exactly one of four statuses based on P01
pressure and the rolling stdev of P01 over the preceding 10 minutes.

### Decision tree

```
P01 > 26.0 kpsi
    → status = "out_of_band"

P01 < 19.0 kpsi
    → status = "below_active"

19.0 ≤ P01 ≤ 26.0  AND  rolling_stdev(P01, 10 min) > 2.0 kpsi
    → status = "high_stress"

19.0 ≤ P01 ≤ 26.0  AND  rolling_stdev(P01, 10 min) ≤ 2.0 kpsi
    → status = "active"
```

### Status labels

| Status | Meaning |
|---|---|
| `active` | Machine running within the normal operating envelope. Time in this state accumulates toward `active_runtime_minutes`. |
| `high_stress` | Machine running but pressure is fluctuating unusually hard (pulsation). Time here accumulates toward both `active_runtime_minutes` AND `high_stress_minutes`. |
| `out_of_band` | Pressure exceeded the active band ceiling — abnormal over-pressure condition. Tracked separately as `out_of_band_minutes`. Does **not** accumulate toward part active runtime. |
| `below_active` | Machine is off, ramping up, or in a cleaning/maintenance phase. Does not accumulate runtime. |

### Rolling stdev calculation

The stdev is computed over a trailing 10-minute window using **Bessel correction**
(ddof = 1, matching pandas default). Minimum of 2 samples required; returns 0 if
only 1 sample is in the window.

```
For each sample at time T:
  window = all samples with timestamp in [T − 10 min, T]
  mean   = average(P01 in window)
  stdev  = sqrt( sum((P01_i − mean)²) / (n − 1) )   for n ≥ 2
         = 0                                           for n < 2
```

---

## 3. Pass Detection

**Source file:** `lib/pass-detect.ts`, `DEFAULT_PASS_CONFIG` (lines 43–49)

A **pass** is a single continuous production cycle — a contiguous segment of
sensor data where P01 remains within the active band for approximately 34 to 40
minutes. Passes are the atomic unit of production scheduling.

### Parameters

| Parameter | Current Value | Unit | Description |
|---|---|---|---|
| `active_band_low_kpsi` | **19.0** | kpsi | Inherited from LOGIC constants |
| `active_band_high_kpsi` | **26.0** | kpsi | Inherited from LOGIC constants |
| `min_duration_min` | **34** | minutes | Shortest excursion that qualifies as a `valid` pass |
| `max_duration_min` | **40** | minutes | Longest excursion that still qualifies as `valid`; beyond this it is tagged `long` |
| `intra_pass_gap_min` | **2** | minutes | Maximum in-band gap tolerated before the pass is considered ended (handles brief VantagePoint sample-rate dropouts) |

### Pass status values

| Status | Condition |
|---|---|
| `valid` | 34 ≤ duration ≤ 40 minutes |
| `short` | duration < 34 minutes |
| `long` | duration > 40 minutes |

### Fields recorded per pass

| Field | Description |
|---|---|
| `pass_index` | 1-based sequential index, oldest to newest |
| `started_at` | ISO timestamp of first in-band sample |
| `ended_at` | ISO timestamp of last in-band sample |
| `duration_min` | `(ended_at − started_at)` in minutes, rounded to 2 decimal places |
| `peak_p01_kpsi` | Maximum P01 reading observed during the pass |
| `avg_p01_kpsi` | Mean P01 across all samples in the pass |
| `sample_count` | Number of sensor samples within the pass window |
| `status` | `valid` / `short` / `long` — see above |

### Cumulative pass runtime

The dashboard exposes two active-runtime numbers:

- **Sample-count runtime** (`active_runtime_minutes` in lifecycle metrics): counts
  every sample tagged `active` or `high_stress`, multiplied by the median
  sample interval. Can over-count short band excursions that don't represent real
  production passes.
- **Pass runtime** (`pass_runtime_minutes_total` in the summary): sum of
  `duration_min` across all detected passes. Only counts completed 34–40 minute
  production cycles. More conservative and used as the recommended reference for
  scheduling.

---

## 4. Production Run Validation

**Source file:** `lib/run-validate.ts`, `DEFAULT_RUN_CONFIG` (lines 43–49)

Passes are grouped into **production runs** and validated against the committed
operating cadence.

### Run grouping parameters

| Parameter | Current Value | Unit | Description |
|---|---|---|---|
| `inter_run_gap_min` | **240** | minutes (4 hours) | Gap between consecutive passes that signals a new production run has started |
| `long_pass_count` | **10** | passes | Standard (full) run length |
| `short_pass_count` | **6** | passes | Abbreviated run (biweekly maintenance flush) |
| `expected_runs_per_period` | **7** | runs | Total runs expected per 14-day rolling window |
| `expected_short_runs_per_period` | **1** | runs | Short runs expected per 14-day rolling window |

### Run status values

| Status | Meaning |
|---|---|
| `conforming` | Actual pass count matches the expected count (10 or 6) exactly |
| `short` | Fewer passes than expected for the assigned schedule type |
| `long` | More passes than expected |
| `unknown_schedule` | Could not unambiguously assign the run to either schedule type (equidistant from both 10 and 6) |

### Schedule labeling logic

Each run's `expected_pass_count` is assigned by snapping `actual_pass_count` to
the nearest of 10 or 6. If equidistant, the run is marked `unknown_schedule`.

```
distLong  = |actual − 10|
distShort = |actual − 6|

if distLong < distShort  → expected = 10
if distShort < distLong  → expected = 6
if equal                 → expected = null, status = "unknown_schedule"
```

### Window-level cadence anomaly

In addition to per-run status, a window-level check fires when the entire
observable window of runs deviates from the 1:6 short-to-long ratio by ≥ 1 run.
This catches a scenario where every individual run is `conforming` but the
overall schedule mix has drifted.

---

## 5. Lifecycle Metrics (Per Part)

**Source files:** `lib/trends-ingest.ts` `computeTrendsMetrics()` (lines 604–633),
`data_pipeline.py` `compute_part_metrics()` (lines 377–439)

When a sensor trends file is uploaded, the pipeline computes four usage metrics
for every **active lifecycle window** (installation date → removal date, or now
if still installed):

### active_runtime_minutes

```
active_runtime_minutes =
    count_of_samples_with_status("active" OR "high_stress")
    that fall within the lifecycle window
  × median_sample_interval_minutes
```

> **Assumption:** Sample interval is estimated as the median of all consecutive
> timestamp differences in the file. Deduplication removes exact-timestamp
> duplicates before the median is computed.

### high_stress_minutes

```
high_stress_minutes =
    count_of_samples_with_status("high_stress")
    that fall within the lifecycle window
  × median_sample_interval_minutes
```

A part that spends a high fraction of its runtime in `high_stress` state has
elevated fatigue risk — this feeds directly into Factor 3 of the risk score.

### cumulative_pressure_stress

```
cumulative_pressure_stress =
    Σ max(P01_i − 19.0, 0)  ×  sample_interval_minutes
    for every sample i where status is "active" OR "high_stress"
    and the sample falls within the lifecycle window

Unit: kpsi-minutes (pressure excess above the active floor, integrated over time)
```

This is a fatigue proxy: a part running at 25 kpsi accumulates (25 − 19) = 6
kpsi-min per minute, whereas one running at 20 kpsi only accumulates 1 kpsi-min
per minute.

### inferred_failures

```
inferred_failures =
    count of off-gaps (inter-sample gap > 5 min)
    whose time range overlaps the lifecycle window
```

Each off-gap represents an unscheduled machine-off event (maintenance, fault,
or operator stop) that occurred while a given part was installed. These are
"inferred" because the system has no direct failure log for them — they are
opportunistic signals. High counts increase risk score Factor 5.

---

## 6. Health Badge Classification

**Source files:** `data_pipeline.py` `classify_health()` (lines 342–359),
referenced in `lib/analytics.ts` `PartRecord` type (line 46)

Every active part lifecycle is assigned a health badge. The classifier applies
explicit threshold checks first; if no thresholds are defined for the part, it
falls back to MTBF percentage rules.

### Decision tree

```
Step 1 — explicit failure threshold:
  if active_runtime_minutes ≥ failure_threshold_min
      → health = "critical",  alert = "failure"

Step 2 — explicit inspection threshold:
  elif active_runtime_minutes ≥ inspection_threshold_min
      → health = "watch",  alert = "inspection"

Step 3 — MTBF percentage fallback (when no explicit thresholds exist):
  elif active_runtime_minutes / expected_mtbf_minutes ≥ 0.85
      → health = "critical",  alert = "failure"

  elif active_runtime_minutes / expected_mtbf_minutes ≥ 0.60
      → health = "watch",  alert = "inspection"

Step 4 — default:
  → health = "nominal",  alert = null
```

### Health badge values

| Badge | Color convention | Meaning |
|---|---|---|
| `nominal` | Green | Part is within its expected service life. No action required. |
| `watch` | Amber | Part has reached the inspection threshold, or has consumed ≥ 60 % of MTBF. Schedule an inspection on the next available window. |
| `critical` | Red | Part has reached or exceeded the failure threshold, or has consumed ≥ 85 % of MTBF. Service or replace immediately. |

### Alert values

| Alert | Trigger |
|---|---|
| `"inspection"` | `watch`-level condition met |
| `"failure"` | `critical`-level condition met |
| `null` | No alert — `nominal` health |

---

## 7. Seal Wear Fraction

**Source file:** `lib/analytics.ts` `sealWearFraction()` (lines 122–131)

Applies to **consumable** parts only: ICVBS, OCVBS, CVBALL, BUS, CVBSPB,
SPRING. These are non-serialized seals and balls replaced on a time-based
schedule rather than inspected individually.

### Formula

```
Given:
  activeMinutes   = accumulated active runtime of the lifecycle
  lifeLow  = 800  (sealLifeLowMin, minutes)
  lifeHigh = 1200 (sealLifeHighMin, minutes)

if activeMinutes ≤ 0:
    wearFraction = 0.0

elif activeMinutes ≤ 800:
    wearFraction = activeMinutes / 800
    (linear 0 → 1.0 from new to the low-end life)

elif activeMinutes ≥ 1200:
    wearFraction = 1.0  (fully worn, past expected life)

else:  (800 < activeMinutes < 1200)
    wearFraction = 0.5 + 0.5 × (activeMinutes − 800) / 400
    (linear 0.5 → 1.0 over the 800–1200 minute uncertainty band)
```

### Interpretation

| wearFraction | Condition |
|---|---|
| 0.0 – 0.5 | Within normal service life (< 800 min runtime) |
| 0.5 – 1.0 | In the expected-end-of-life window (800–1200 min) — monitor closely |
| ≥ 1.0 | Past expected life — replace at next opportunity |

> **Assumption:** The 800–1,200 minute envelope reflects the range of observed
> seal lifespans under normal operating conditions. A seal that spent significant
> time in `high_stress` may degrade faster than this envelope suggests.

---

## 8. Composite Risk Score

**Source file:** `lib/predict.ts` `predictForPart()` (lines 59–186)

The risk score is a 0–100 integer that ranks parts by predicted proximity to
failure. It is designed to be **explainable**: every contributing factor is
retained separately so the UI can display which signal is driving the score.

### Factor definitions

Each factor produces a weight in the range [0, 1].

**Factor 1 — Runtime vs. failure threshold** *(highest priority)*

```
if failure_threshold_min is defined:
    weight = clamp(active_runtime_minutes / failure_threshold_min, 0, 1)
    label  = "Runtime / failure threshold"

else if expected_mtbf_minutes is defined:
    weight = clamp(active_runtime_minutes / expected_mtbf_minutes, 0, 1)
    label  = "Runtime / expected MTBF"
```

Represents the most defensible single signal: how far through its expected
total life has this part run?

**Factor 2 — Inspection threshold proximity** *(early warning)*

```
if inspection_threshold_min is defined:
    weight = clamp(active_runtime_minutes / inspection_threshold_min, 0, 1) × 0.6
    label  = "Approaching inspection threshold"
```

Multiplied by 0.6 so it contributes as an early-warning signal rather than
competing with the failure threshold on equal footing.

**Factor 3 — High-stress exposure**

```
if active_runtime_minutes > 0:
    weight = clamp(high_stress_minutes / active_runtime_minutes, 0, 1)
    label  = "High-stress exposure"
```

The fraction of the part's total active life spent in `high_stress` state.
A part that is almost always in high-stress should score higher than one
with the same total runtime but little pulsation.

**Factor 4 — Cumulative pressure intensity**

```
if active_runtime_minutes > 0:
    perMin = cumulative_pressure_stress / active_runtime_minutes
    weight = clamp(perMin / 4.0, 0, 1) × 0.7
    label  = "Cumulative pressure intensity"
```

Normalizes the average kpsi-above-floor per minute against **4.0 kpsi-min/min**,
which represents the upper end of a typical mid-pressure cycle operating near
the ceiling of the active band (~23 kpsi average → 4 kpsi above the 19 floor).
The 0.7 multiplier caps its contribution to 70 % weight.

**Factor 5 — Inferred off-window failures**

```
if inferred_failures > 0:
    weight = clamp(inferred_failures / 5, 0, 1) × 0.5
    label  = "Inferred off-maintenance windows"
```

Normalizes against **5 gaps** as a "concerning but not conclusive" count. The
0.5 multiplier limits this signal to 50 % weight, since off-gaps are inferred
rather than directly observed failures.

### Composite score formula

```
factorWeights = [f.weight for f in factors]
maxFactor     = max(factorWeights)
meanFactor    = sum(factorWeights) / len(factorWeights)

composite = clamp(0.6 × maxFactor + 0.4 × meanFactor, 0, 1)

score = min(100, round(composite × 100 + (runtimeRatio > 1.0 ? 8 : 0)))
```

The **0.6 / 0.4 blend** means: "a part that is critically bad at any one
thing scores high even if its other indicators look fine." The +8 point boost
when `runtimeRatio > 1.0` (i.e., the part has already exceeded its rated life)
ensures such parts always appear emphatically red on the dashboard.

### Risk band thresholds

| Band | Score range | Meaning |
|---|---|---|
| `low` | 0 – 34 | No immediate concern |
| `moderate` | 35 – 59 | Elevated — monitor at next scheduled inspection |
| `high` | 60 – 79 | Action recommended before next production run |
| `critical` | 80 – 100 | Service or replace immediately |

### ETA-to-failure

```
ceiling = failure_threshold_min ?? expected_mtbf_minutes ?? null

if ceiling is defined and ceiling > active_runtime_minutes:
    eta_minutes = ceiling − active_runtime_minutes

elif ceiling is defined and ceiling ≤ active_runtime_minutes:
    eta_minutes = 0   ("service immediately")

else:
    eta_minutes = null  (cannot project — no reference ceiling available)
```

---

## 9. ML Model Blend

**Source file:** `lib/predict-model.ts` (lines 211–262)

When a trained model file is present at `models/failure_predictor.json`
(produced by `scripts/train_failure_model.py`), the dashboard blends ML
predictions with the heuristic score.

### Model components

| Component | Type | Output |
|---|---|---|
| Regressor | Gradient Boosted Regressor (GBR) | Predicted time-to-failure in minutes (`model_ttf_minutes`) |
| Classifier | Gradient Boosted Classifier (GBC) | Predicted failure mode + confidence probability |

### Blend rule

```
if regressor is present:
    modelRatio    = 1 − max(0, model_ttf_minutes) / ceiling
    lifted        = round(modelRatio × 100)
    blendedScore  = max(heuristicScore, min(100, lifted))
```

The blend **can only raise** the heuristic score, never lower it. This is a
deliberate conservative choice: if the model thinks failure is imminent, the
score increases; the model cannot suppress a high heuristic score.

### Feature defaults (when live sensor data is unavailable)

When the ML model is present but a fresh trends window has not been ingested,
the following feature defaults are used:

| Feature | Default |
|---|---|
| `p01_mean` | 22.0 kpsi |
| `p01_std` | 2.5 kpsi (if high_stress > 0) / 1.2 kpsi |
| `p01_max` | 24.0 kpsi |
| `p01_p95` | 23.5 kpsi |
| `p02_mean` | 0.5 |
| `t01–t03_mean` | 20.0 °C |
| `t04_mean` | 22.0 °C |
| `t05_mean` | 24.0 °C |

---

## 10. Part Catalog — All Thresholds

**Source file:** `lib/parts-catalog.ts` (lines 41–195)

All runtime thresholds are in **minutes of active runtime** (not calendar time).
`sealLifeLow` / `sealLifeHigh` apply only to consumable parts.
`inspectionThresholdMin` / `failureThresholdMin` apply only to structural parts.
`expectedMtbfMinutes` is the fallback for all non-consumable parts without explicit thresholds.

### Cluster parts

| Part Code | Display Name | Category | Consumable | MTBF (min) | Inspection (min) | Failure (min) | Seal Low (min) | Seal High (min) |
|---|---|---|---|---|---|---|---|---|
| `ICVB` | Inlet Check Valve Body | cluster | No | 10,000 | — | — | — | — |
| `HPT` | High Pressure Tee | cluster | No | 9,000 | **2,000** | **2,400** | — | — |
| `OCVB` | Outlet Check Valve Body | cluster | No | 11,000 | — | — | — | — |
| `ICVBS` | Inlet Check Valve Ball Seat | cluster | **Yes** | — | — | — | 800 | 1,200 |
| `OCVBS` | Outlet Check Valve Ball Seat | cluster | **Yes** | — | — | — | 800 | 1,200 |
| `CVBALL` | Check Valve Ball | cluster | **Yes** | — | — | — | 800 | 1,200 |
| `SPRING` | Check Valve Spring | cluster | **Yes** | — | — | — | 800 | 1,200 |

### Pump parts

| Part Code | Display Name | Category | Consumable | MTBF (min) | Inspection (min) | Failure (min) | Seal Low (min) | Seal High (min) |
|---|---|---|---|---|---|---|---|---|
| `PLG` | Plunger | pump | No | 8,000 | — | — | — | — |
| `BUS` | Backup Support Seal (BUS) | pump | **Yes** | — | — | — | 800 | 1,200 |
| `PB` | Pump Body | pump | No | 15,000 | **12,000** | **14,500** | — | — |
| `CVBSPB` | Check Valve Ball Seat (Pump Body) | pump | **Yes** | — | — | — | 800 | 1,200 |

### Homogenizer parts

| Part Code | Display Name | Category | Consumable | MTBF (min) | Inspection (min) | Failure (min) |
|---|---|---|---|---|---|---|
| `HVB` | Homogenizing Valve Body | homogenizer | No | 12,000 | — | — |
| `CSEAT` | Ceramic Seat | homogenizer | No | 6,000 | — | — |
| `IR` | Impact Ring | homogenizer | No | 6,000 | — | — |
| `CSTEM` | Ceramic Stem | homogenizer | No | 6,000 | — | — |

### Manifold & Instrument parts

| Part Code | Display Name | Category | Consumable | MTBF (min) | Inspection (min) | Failure (min) |
|---|---|---|---|---|---|---|
| `OM` | Outlet Manifold | manifold | No | 18,000 | **14,000** | **17,000** |
| `TR` | Transducer | instrument | No | 20,000 | — | — |

> **Note on the default MTBF fallback:** When a lifecycle has no MTBF defined
> in either the tracker import or the part catalog, `data_pipeline.py` defaults
> to **12,000 minutes**. `dashboard-data.ts` uses the same 12,000 default for
> seed part statuses.

---

## 11. Maintenance Event Types

**Source file:** `lib/lifecycle-store.ts` (lines 55–75)

Every change to the machine or its data is logged as a `MaintenanceEvent`.

| `event_type` | Who creates it | Meaning |
|---|---|---|
| `replace` | Operator (manual) | A part was removed and a new one installed. Archives the prior lifecycle. |
| `inspect` | Operator (manual) | Part was inspected but not replaced. |
| `clean` | Operator (manual) | Cleaning event — no part change. |
| `reset` | Operator (manual) | First-ever installation into a slot that had no prior lifecycle. |
| `off_maintenance` | Trends ingest (automatic) | An inter-sample gap > 5 min was detected — machine was likely off or being maintained. |
| `high_stress_window` | Trends ingest (automatic) | A contiguous window where σ(P01) > 2.0 kpsi was recorded. |
| `inspection_alert` | System (automatic) | Part reached its inspection threshold. |
| `failure_alert` | System (automatic) | Part reached its failure threshold. |
| `failure_observation` | Operator (manual) | Operator recorded a directly observed failure. |
| `data_integrity_alert` | Trends ingest (automatic) | Production run cadence anomaly detected (e.g., wrong number of passes in a run). |
| `pass_detected` | Trends ingest (automatic) | A valid 34–40 minute production pass was logged. |

---

## 12. Sensor Signals

**Source files:** `lib/trends-ingest.ts` `SIGNAL_ALIASES` (lines 38–70),
`data_pipeline.py` `SIGNAL_ALIASES` (lines 72–80)

The pipeline auto-detects signal columns in uploaded CSV files using fuzzy
header matching (case-insensitive, strips unit suffixes like `(kpsi)` or
`(DEG C)`).

| Signal | Description | Required? | Unit |
|---|---|---|---|
| `P01` | Homogenizing pressure — transducer at outlet manifold | **Yes** | kpsi |
| `P02` | Applied gas pressure at homogenizing body valve | No | PSI |
| `T01` | Seal-flush temperature, left cluster | No | °C or °F |
| `T02` | Seal-flush temperature, middle cluster | No | °C or °F |
| `T03` | Seal-flush temperature, right cluster | No | °C or °F |
| `T04` | Product loop temperature, pre-heat-exchanger | No | °C or °F |
| `T05` | Product loop temperature, post-heat-exchanger | No | °C or °F |
| `FLOW` | Volumetric flow rate | No | LPM or GPM |
| `RPM` | Motor/drive speed | No | RPM |
| `VIB` | Vibration | No | g-RMS or IPS |

Only `P01` is required. All other signals are merged when present and stored in
the fatigue series, but the core analytics (runtime, stress, health) rely solely
on P01.

### P01 unit auto-detection

```
if median(P01 column) > 1000:
    P01 = P01 / 1000   (convert raw psi → kpsi)
```

---

## 13. Installation ID Naming Convention

**Source file:** `lib/parts-catalog.ts` (lines 4–13, 251–323)

Installation IDs follow the pattern `{equipment_id}_{slot_code}`.

| Slot code pattern | Zone | Orientation |
|---|---|---|
| `LC1`–`LC5` | cluster | left |
| `MC1`–`MC5` | cluster | middle |
| `RC1`–`RC5` | cluster | right |
| `LP1`–`LP4` | pump | left |
| `MP1`–`MP4` | pump | middle |
| `RP1`–`RP4` | pump | right |
| `H1`–`H4` | homogenizer | center |
| `O` | manifold | center |
| `T` | instrument | center |

**Example:** `0091_RC2` = equipment 0091, right cluster, slot 2 (which maps to
`HPT` — the High Pressure Tee in the right cluster).

### Slot-to-part-code mappings

**Cluster slots (LC/MC/RC + slot index):**

| Slot index | Part code |
|---|---|
| 1 | ICVB |
| 2 | HPT |
| 3 | OCVB |
| 4 | ICVBS |
| 5 | OCVBS |

**Pump slots (LP/MP/RP + slot index):**

| Slot index | Part code |
|---|---|
| 1 | PLG |
| 2 | BUS |
| 3 | PB |
| 4 | CVBSPB |

**Homogenizer head slots (H + slot index):**

| Slot index | Part code |
|---|---|
| 1 | HVB |
| 2 | CSEAT |
| 3 | IR |
| 4 | CSTEM |

---

## 14. Failure Modes

**Source file:** `lib/parts-catalog.ts` (lines 325–337), `lib/lifecycle-store.ts` (lines 77–89)

When a part is replaced, the operator selects a failure mode that is recorded
against the archived lifecycle.

| Failure Mode | Description |
|---|---|
| `normal wear` | Expected end-of-life degradation with no abnormal cause |
| `scratches` | Surface damage from abrasive media or particulates |
| `binding (threads)` | Thread seizure — fastener could not be removed without damage |
| `fracture (port)` | Crack or break at a fluid port |
| `fracture (body)` | Crack or break in the main body material |
| `weephole leak` | Fluid escaping through the weephole — indicative of seal failure |
| `thread fracture` | Threaded connection fractured under load |
| `internal erosion` | Wear from fluid flow inside passages |
| `thermal drift` | Sensor calibration drift due to temperature |
| `other` | Failure does not fit any listed category |
| `unknown` | Failure cause not determined at time of removal |

> **Note:** `weephole leak` is the dominant failure mode associated with
> `high_stress` conditions (pulsation σ > 2 kpsi) per the Logic Doc. Parts
> with elevated `high_stress_minutes` should be inspected for weephole leaks.

---

## Appendix — Key Assumptions Summary

| # | Assumption | Effect if wrong |
|---|---|---|
| A1 | P01 is the only signal required for all core analytics | If P01 is absent or mislabeled, the entire ingest fails |
| A2 | VantagePoint exports are UTC wall-clock (no timezone offset) | Off-window detection and lifecycle overlap could be wrong by a full timezone offset |
| A3 | Median inter-sample interval is representative of all samples | Sparse gaps inflate `active_runtime_minutes` and `high_stress_minutes` |
| A4 | Off-gaps > 5 min represent machine-off events, not sensor dropouts | Sensor dropout would be counted as an inferred failure |
| A5 | The active band 19–26 kpsi captures the full production operating range | Samples outside the band during normal operation would not accumulate toward runtime |
| A6 | 34–40 min defines a valid production pass | Passes shorter or longer than this range are flagged but still recorded |
| A7 | 4 kpsi-min/min is a representative mid-pressure intensity ceiling for Factor 4 normalization | If average operating pressure shifts, this normalization will over- or under-weight the pressure intensity factor |
| A8 | 5 off-gaps is the "concerning" normalizer for Factor 5 | Parts with > 5 inferred failures are capped at the same weight as 5 |
| A9 | ML model features default to `p01_mean=22.0` when no live trends are available | Feature defaults may not match actual operating conditions, reducing model accuracy |
| A10 | MTBF fallback of 12,000 min applies to unlisted or unmapped parts | Parts with significantly shorter real MTBF will appear healthier than they are |
