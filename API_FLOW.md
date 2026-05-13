# API_FLOW.md

Business logic and data flow for every C55 Tracker API route. Field names are in [`DATA_SCHEMA.md`](DATA_SCHEMA.md).

## Backend selection

Every route routes writes through `getLifecycleStore()` in [`lib/lifecycle-store.ts`](lib/lifecycle-store.ts):

- `SUPABASE_SERVICE_ROLE_KEY` set → `SupabaseStore` (Postgres tables).
- Otherwise → `LocalJsonStore` (mutates `data/lifecycles.json`, bootstrapped from `public/lifecycles.json` on first read).

The store interface is identical between backends, so route code never branches on the backend. The response payload includes a `backend: "supabase" | "local-json"` field so the dashboard knows which mode it's in.

## Route map

| Method | Path | Body / params | Effect |
|--------|------|---------------|--------|
| GET | `/api/lifecycles` | — | Returns full `StoreSnapshot` + `backend`. |
| GET | `/api/history` | — | Returns flattened lifecycle history rows (active + archived), joined to slot/catalog metadata where available. |
| POST | `/api/lifecycle/replace` | `{ installation_id, new_serial, failure_mode, notes?, timestamp? }` | Archives current lifecycle on that slot, inserts fresh lifecycle with reset odometers, logs `replace` (or `reset` if no prior) event. |
| POST | `/api/maintenance` | `{ event_type, installation_id?, equipment_id?, lifecycle_id?, failure_mode?, detected_at?, ended_at?, duration_minutes?, notes?, source? }` | Inserts one `MaintenanceEvent`. Validates `event_type` against the union and `failure_mode` against `FAILURE_MODES`. |
| POST | `/api/failure/log` | `{ installation_id, failure_mode, notes?, timestamp? }` | Inserts a `failure_observation` event **without** archiving the lifecycle. Used as a positive label for the predictor. |
| POST | `/api/ingest/tracker` | multipart `file: .xlsx`, optional `sheet` (default `"Tracker"`) | Parses workbook → upserts equipment + slots + lifecycles. Max **25 MB**. |
| POST | `/api/ingest/trends` | multipart `file: .csv\|.txt` | Parses (UTF-16 LE BOM + tab/comma auto-detect), computes metrics, detects passes/runs/anomalies, applies to store, rewrites `public/pipeline.json`. Max **80 MB**. |
| GET | `/api/predictions` | — | Returns ranked predictions for every active lifecycle (latest per slot). |
| GET | `/api/predictions/live` | — | Server-Sent Events stream from in-process bus in `stream_worker.ts`. Replays ring buffer on connect. |
| GET | `/api/logic-params` | — | Returns active logic/tuning parameters from `loadLogicParams()`. |
| PUT | `/api/logic-params` | partial `LogicParams` object | Validates, merges, and persists `config/logic-params.json`; invalidates params cache and returns updated params. |
| POST | `/api/recalculate` | optional `{ equipment_id? }` | Recomputes predictions + health summary from current params without mutating lifecycle rows. |
| POST | `/api/agent/tune` | optional `{ trigger?, dry_run?, equipment_id? }` | Runs proposal loop in `agent-param-tuner`; can apply medium/high-confidence updates and log a maintenance audit event. |
| GET | `/api/components` | `?parent_lifecycle_id=...` **or** `?installation_id=...` | Handler scaffolding exists (parent resolution + validation), but route is currently blocked by missing component store/catalog exports in `lib/`. |
| POST | `/api/components` | `{ parent_lifecycle_id\|installation_id, subpart_code, sub_index, serial_number?, installation_date? }` | Handler scaffolding exists, but route is currently blocked by missing component store/catalog exports in `lib/`. |
| GET | `/api/components/missing` | `?equipment_id=0091` | Handler exists, but route is currently blocked by missing `missingComponentFlags` implementation on the store. |
| POST | `/api/components/archive` | `{ component_id, failure_mode, failure_notes?, timestamp? }` | Handler exists, but route is currently blocked by missing `archiveComponent` implementation on the store. |

All routes set `dynamic = "force-dynamic"` except `/api/logic-params` (which is server-only but does not explicitly export `dynamic`). Ingest/prediction/tuning routes pin `runtime = "nodejs"` where long-running or Node APIs are required.

## Replace-part flow (`POST /api/lifecycle/replace`)

1. Read current snapshot.
2. Find ALL active lifecycles (`removal_date IS NULL AND archived_at IS NULL`) for `installation_id`.
3. If none → fresh install: insert new `Lifecycle`, log `reset` event.
4. If one or more:
   - Most recent install becomes the archived row (`removal_date = archived_at = ts`, `archive_reason = "replace_part"`, `failure_mode` set).
   - Any stale active rows auto-close with `archive_reason = "auto_closed_on_replace"` (data hygiene against the legacy Tracker).
   - Log `replace` event with `failure_mode`.
5. Insert new `Lifecycle` for the same `installation_id` with all odometers = 0.

Returns `{ archived, created, event }`.

## Tracker ingest (`POST /api/ingest/tracker`)

1. `parseTrackerWorkbook(buf, sheetName)` in [`lib/tracker-import.ts`](lib/tracker-import.ts) reads the `.xlsx` via `exceljs`. Returns `{ equipment, slots, lifecycles, report }`. Non-throwing — payload-shape problems come back as `report.fatal` (surface as 422).
2. `store.ingestTracker(parsed)`:
   - Upserts equipment by `equipment_id`.
   - Upserts referenced rows in `part_catalog` (defensive; covers fresh DBs).
   - Upserts slots by `installation_id`.
   - For each lifecycle row, upserts by `(installation_id, installation_date)`:
     - On match: merges, taking `max(active_runtime_minutes)` so re-imports don't clobber accumulated runtime.
     - On miss: inserts; `archive_reason = "imported_closed"` if `removal_date` is present.

Returns counts: `{ equipment_upserted, slots_upserted, lifecycles_upserted, lifecycles_inserted, lifecycles_updated, report }`.

## Trends ingest (`POST /api/ingest/trends`)

```
multipart .csv/.txt
        ↓
parseTrendsText (lib/trends-ingest-txt.ts)  ─── UTF-16 LE BOM + tab/comma sniff
        ↓
store.activeLifecycleWindows()  ─── (per-slot install windows)
        ↓
computeTrendsMetrics(parsed, windows, fileName)  ─── (lib/trends-ingest.ts)
        ↓                                              ├── classifies every sample
        │                                              ├── rolling 10-min σ(P01)
        │                                              ├── attributes minutes to lifecycles
        │                                              ├── pass detection (lib/pass-detect.ts)
        │                                              ├── run grouping (< 4h gaps)
        │                                              └── biweekly cadence validate (lib/run-validate.ts)
        ↓
store.applyTrendsIngest(result)
        ├── lifecycles: max(existing, computed) for runtime/stress/cumulative/inferred — idempotent
        ├── logs high_stress_window events (dedupe by event_type+detected_at+ended_at)
        ├── logs off_maintenance events (same dedupe)
        ├── upserts production_run rows (key: equipment_id+started_at)
        ├── upserts pass_event rows (key: equipment_id+started_at)
        └── logs data_integrity_alert events for cadence anomalies
        ↓
writePipelineSnapshot(result)  ─── rewrites public/pipeline.json
        ↓
Fresh predictions snapshot computed inline so the operator sees impact immediately.
```

Equipment scope for runs/passes is resolved as: `input.equipment_id` → `inferEquipmentIdFromSource(filename)` (matches `0091_*.csv` etc.) → first equipment in snapshot → `"0091"` fallback.

Response includes `rows_ingested`, `signals_detected`, `summary`, `passes_total`, `valid_passes_total`, `runs_total`, `conforming_runs_total`, `schedule_anomalies_total`, persistence counters, and `predictions: predictions.slice(0, 30)`.

## Predictions flow (`GET /api/predictions`)

1. Load `StoreSnapshot`.
2. Collapse to **latest active lifecycle per `installation_id`** (legacy Tracker sometimes has duplicate actives).
3. Build `PredictInput[]` by joining with `Slot` + `PART_CATALOG` for catalog thresholds.
4. `predictBatchWithModel(inputs)` in [`lib/predict-model.ts`](lib/predict-model.ts):
   - If `models/failure_predictor.json` exists → sklearn scorer (`source: "model"`).
   - Else → heuristic `predictBatch` in [`lib/predict.ts`](lib/predict.ts) (`source: "heuristic"`).
5. Sort descending by `risk_score`.

Response: `{ backend, generated_at, source, count, predictions }`.

### Risk scoring (`lib/predict.ts`)

Five factors → composite `0–100` (weights and cutoffs loaded from `logic-params`; defaults shown below):

| # | Factor | Weight | Detail |
|---|--------|--------|--------|
| 1 | `runtime / failure_threshold_min` (or `/ expected_mtbf_minutes` fallback) | full | Dominant signal. |
| 2 | `runtime / inspection_threshold_min` | × `inspection_proximity_multiplier` (default `0.6`) | Early warning. |
| 3 | `high_stress_minutes / active_runtime_minutes` | full | Weephole-leak driver per Logic Doc. |
| 4 | `cumulative_pressure_stress / runtime`, normalized to `pressure_intensity_ceiling_kpsi_per_min` (default `4.0`) | × `pressure_intensity_multiplier` (default `0.7`) | Fatigue proxy. |
| 5 | `inferred_failures / inferred_failures_normalizer` (default `5`) | × `inferred_failures_multiplier` (default `0.5`) | Off-maintenance gap count. |

`composite = clamp01(max_factor_weight × max_factor + mean_factor_weight × avg_factors)` with defaults `0.6` and `0.4`.
`score = round(composite × 100) + (runtime_ratio > 1 ? overlife_boost_points : 0)` (default boost `8`), capped at 100.

Bands come from `risk_bands` (defaults: `low < 35 ≤ moderate < 60 ≤ high < 80 ≤ critical`).

`eta_minutes = max(0, (failure_min ?? mtbf) - runtime)`, or `null` when no ceiling is set.

## Logic params + recalculate flow

`GET /api/logic-params` returns the active parameter set (defaults merged with `config/logic-params.json` when present).

`PUT /api/logic-params` validates partial updates, merges onto current params, persists JSON, invalidates cache, and returns `{ ok: true, params }`.

`POST /api/recalculate` then re-scores active lifecycles with the current params snapshot (optionally scoped by `equipment_id`) and returns:

- `predictions` (model-backed when available; heuristic fallback otherwise)
- `health_summary` computed from config-driven MTBF percentages and threshold cutoffs
- `params_snapshot` (key constants used for that recompute)

No lifecycle rows are mutated by recalculate.

## Agent tune flow (`POST /api/agent/tune`)

1. Load snapshot + current params.
2. Gather evidence from closed lifecycles with known failure modes.
3. Compare observed failure runtimes vs current thresholds and generate proposals (`parts.*` thresholds, MTBF, optional pulsation tuning).
4. If not `dry_run`, apply medium/high-confidence proposals to `config/logic-params.json`.
5. Best-effort log a `maintenance_event` audit record (`event_type: data_integrity_alert`, source `agent-param-tuner:*`).

Response includes proposal list, applied paths, optional event id, and summary text.

## Live telemetry SSE (`GET /api/predictions/live`)

```
VantagePoint (OPC-UA) ──> VantagePointAdapter ──> stream_worker.ts
                                                    ├── publishLiveSample() → in-process bus
                                                    │       └── /api/predictions/live SSE
                                                    └── tumbling window (default 60s)
                                                            └── store.applyTrendsIngest()
```

- `lib/vantagepoint-adapter.ts` defines `VantagePointAdapter` interface + `MockAdapter` (CSV replay) + `OpcUaAdapter` (stub).
- `scripts/stream_worker.ts` (run via `npm run stream:mock`) buffers samples and flushes through the same store path as the upload route.
- The SSE endpoint replays its in-memory ring buffer on connect so a fresh tab gets immediate signal.
- `FailurePredictionPanel` shows "Live stream" with a green dot when SSE is up; falls back to 12 s polling of `/api/predictions` otherwise.

## Python pipeline (offline path)

These are optional and parallel to the TS ingest route — they write the same `public/pipeline.json` shape but **do not** touch `data/lifecycles.json`.

### `data_pipeline.py` — one-shot

```bash
python data_pipeline.py    # reads MTBF Tracker_cursor.xlsx + vantagepoint_sensor.csv
                           # writes public/pipeline.json
```

Performs the same classification + pass-detection as `lib/trends-ingest.ts`. Useful when no dashboard is running. Constants in the file must stay synced with `lib/analytics.ts`.

### `scripts/watch_csv.py` — folder watcher

```bash
python scripts/watch_csv.py    # polls inbox/ for new *.csv
```

1. Dedupes by sha256 (state in `.csv_watch_state.json`).
2. Re-runs `data_pipeline.py` to regenerate `public/pipeline.json`.
3. Moves source CSV to `archive/` on success.
4. Survives restarts.

### `scripts/import_tracker.py` — historical backfill

```bash
python scripts/import_tracker.py
```

Reads `MTBF Tracker_cursor.xlsx → "Tracker"` and emits:

- `supabase/seed.sql` — idempotent `INSERT ... ON CONFLICT DO UPDATE` for equipment / part_catalog / installation_slot / part_lifecycle, plus a prelude that upserts the canonical catalog.
- `public/lifecycles.json` — read-only snapshot that bootstraps `data/lifecycles.json` on first API write in local-JSON mode.

### `scripts/train_failure_model.py` — model trainer

```bash
python scripts/train_failure_model.py \
  --trends-dir archive --mtbf-xlsx 'MTBF Tracker_cursor.xlsx' --out-dir models
```

1. Loads all `.csv/.txt` in `archive/` (UTF-16 LE BOM aware).
2. Engineers features per `models/feature_spec.json` (rolling σ on P01/P02, OLS slope of T04/T05, cumulative stress).
3. Fits `GradientBoostingRegressor` (TTF) + `GradientBoostingClassifier` (failure mode).
4. Writes `models/failure_predictor.joblib` (Python) **and** `models/failure_predictor.json` (portable, read by `lib/predict-model.ts`).

## Event-type semantics

Set on `MaintenanceEvent.event_type`:

| Type | Source | Meaning |
|------|--------|---------|
| `replace` | replace route | Lifecycle archived, new one started. |
| `reset` | replace route | Fresh install on an empty slot. |
| `inspect` / `clean` | maintenance route | Operator-logged routine maintenance. |
| `off_maintenance` | trends ingest | Detected inter-sample gap > 5 min. |
| `high_stress_window` | trends ingest | Rolling σ(P01) > 2 kpsi window. |
| `pass_detected` | trends ingest | 34–40 min valid pass observed. |
| `inspection_alert` | scheduler (TBD) | Lifecycle crossed inspection threshold. |
| `failure_alert` | scheduler (TBD) | Lifecycle crossed failure threshold. |
| `failure_observation` | `/api/failure/log` | Operator reported failure without replacing. |
| `data_integrity_alert` | trends ingest | Biweekly cadence anomaly detected by `lib/run-validate.ts`. |

## Idempotency notes

- **Trends re-uploads are safe.** Lifecycle metric updates use `Math.max(existing, computed)` rather than incrementing. Run/pass upserts dedupe on `(equipment_id, started_at)`. Event inserts dedupe on `(event_type, detected_at, ended_at)`.
- **Tracker re-imports are safe.** Lifecycle upsert key is `(installation_id, installation_date)`; `active_runtime_minutes` is preserved via `max(existing, row)`.
- **Replace-part is non-idempotent** by design (each click is a real event); the operator must not double-click.
