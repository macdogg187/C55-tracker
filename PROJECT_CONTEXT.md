# PROJECT_CONTEXT.md

High-level source of truth for the C55 Tracker. Read first in any new Agent session.

## Core goals

- Predictive-maintenance dashboard for the C55 homogenizer line (three units: `0091`, `0938`, `0198`).
- Replace the legacy Excel + SAP workflow with one local-first web app.
- Surface part-level failure risk **before** weephole leaks, thread fractures, or seat erosion occur.
- Tag every active lifecycle as `nominal` / `watch` / `critical` from runtime + sensor-derived stress.

## Tech stack

- **Frontend**: Next.js 16 (App Router only, no `pages/`) + React 19 + Tailwind 4 + TypeScript 5.
- **Tests**: `node --import tsx --test` against `lib/__tests__/*.test.ts`.
- **Storage**: Dual backend — `LocalJsonStore` (default, writes `data/lifecycles.json`) or `SupabaseStore` (Postgres + RLS) when `SUPABASE_SERVICE_ROLE_KEY` is set.
- **Sensor ingest**: TS path = `POST /api/ingest/trends` (CSV/TXT via `lib/trends-ingest-txt.ts` → `lib/trends-ingest.ts`). Python path = `data_pipeline.py` one-shot or `scripts/watch_csv.py` folder watcher — both write `public/pipeline.json`.
- **Live telemetry**: `scripts/stream_worker.ts` + `lib/vantagepoint-adapter.ts` (MockAdapter today, OpcUaAdapter stub) → SSE at `/api/predictions/live`.
- **Model**: Optional `models/failure_predictor.json` (sklearn GBM, trained by `scripts/train_failure_model.py`); `lib/predict-model.ts` falls back to the heuristic in `lib/predict.ts` when absent.
- **Tunable logic params**: `config/logic-params.json` via `GET/PUT /api/logic-params`, on-demand rescoring at `POST /api/recalculate`, and agentic proposals at `POST /api/agent/tune`.

## Architecture

```
VantagePoint CSV/TXT ──┐                        ┌── public/pipeline.json (committed seed)
                       ├── computeTrendsMetrics ┤
Live OPC-UA (stub)  ───┘   (lib/trends-ingest)  └── store.applyTrendsIngest → lifecycle metrics
                                                                                ↓
MTBF Tracker .xlsx ──── parseTrackerWorkbook ────── store.ingestTracker ──→ Lifecycle store
                                                                                ↓
                                              ┌────────────────────────────────┘
                                              ↓
Dashboard (app/page.tsx) ←── /api/lifecycles, /api/predictions, /api/predictions/live (SSE),
                             /api/history, /api/logic-params, /api/recalculate
```

- **Default mode (no env var)**: API routes read seed from `public/lifecycles.json`, mutate `data/lifecycles.json`, regenerate `public/pipeline.json` on trends upload.
- **Supabase mode** (`SUPABASE_SERVICE_ROLE_KEY` set): same API surface routes writes to Postgres tables via `lib/supabase/server.ts`.
- **Backend selection**: `getLifecycleStore()` in [`lib/lifecycle-store.ts`](lib/lifecycle-store.ts) caches one instance per process.

## Health tiers (per active lifecycle)

- `nominal` — under inspection threshold AND < 60% of MTBF.
- `watch` — past inspection threshold OR ≥ 60% of MTBF.
- `critical` — past failure threshold OR ≥ 85% of MTBF.
- Alert field is set to `inspection` or `failure` when the corresponding threshold trips.

## Risk score (`lib/predict.ts`)

Five explainable factors, composite `0–100` = `60% × max_factor + 40% × avg_factors`, +8 if past failure threshold:

1. Runtime / failure threshold (or MTBF fallback) — dominant signal.
2. Approaching inspection threshold (× 0.6 weight).
3. High-stress exposure ratio = `high_stress_minutes ÷ active_runtime_minutes`.
4. Cumulative pressure intensity = `cumulative_pressure_stress ÷ runtime`, normalized to 4.0 kpsi-min/min (× 0.7).
5. Inferred off-maintenance windows (× 0.5).

Bands: `low < 35 ≤ moderate < 60 ≤ high < 80 ≤ critical`.

## Logic Doc constants (must stay in sync across TS and Python)

| Rule | Value |
|------|-------|
| Active runtime band | 19 ≤ P01 ≤ 26 kpsi |
| Pulsation (high stress) | rolling 10-min σ(P01) > 2 kpsi |
| Off / maintenance | inter-sample gap > 5 min |
| Out-of-band | P01 > 26 kpsi |
| Valid pass | contiguous P01 in band, 34–40 min |
| Production run | ≥ 1 pass with < 4 h gaps |
| Biweekly cadence (14d) | 6 of 7 runs = 10-pass, 1 of 7 = 6-pass |

## Constraints

- **No Supabase required for local dev.** `LocalJsonStore` covers every API route + the dashboard + tests.
- **`data/` is gitignored**; auto-created on first mutation. Bootstrapped from `public/lifecycles.json`.
- **`public/pipeline.json` and `public/lifecycles.json` are committed** — sample seed.
- **Python deps install to user site** (`pip install --user` is implicit on this box); not required for dashboard dev.
- **ESLint 9 flat config** (`eslint.config.mjs`). One known pre-existing warning: `_opts` unused in `vantagepoint-adapter.ts`.
- **Multipart limits**: tracker = 25 MB, trends = 80 MB.
- **`app/api/components/*` routes are not wired end-to-end yet** — route handlers exist, but they still reference `SUBCOMPONENT_CATALOG`/component store methods that are not exported from `lib/`. Don't rely on them.

## Current progress

_(Update at end of every session. Replace this block — don't append.)_

- Lifecycle store dual-backend complete; local mode persists lifecycle/events/runs/passes and Supabase mode upserts the same core entities.
- Trends ingest detects passes + runs + cadence anomalies, applies metrics idempotently, and rewrites `public/pipeline.json` (including `runs`).
- Prediction stack is config-driven via `logic-params` defaults/overrides, with model fallback to heuristic when `models/failure_predictor.json` is absent.
- Runtime tuning endpoints are live: `GET/PUT /api/logic-params`, `POST /api/recalculate`, and `POST /api/agent/tune`.
- History read model is live at `GET /api/history` for active + archived lifecycle rows.

## Next steps

_(Update at end of every session.)_

- Implement/export `SUBCOMPONENT_CATALOG` and component store methods (`listComponents`, `upsertComponent`, `archiveComponent`, `missingComponentFlags`) so `app/api/components/*` compiles and works.
- Wire `OpcUaAdapter` against the plant OPC-UA endpoint when NodeIds are confirmed.
- Add dedupe safeguards for Supabase trend-derived event inserts (local JSON path already dedupes by `(event_type, detected_at, ended_at)`).
- Improve trainer label quality — current TTF labels are coarse.

## Reference index

- Types + dual-backend store: [`lib/lifecycle-store.ts`](lib/lifecycle-store.ts)
- Part catalog + slot builder: [`lib/parts-catalog.ts`](lib/parts-catalog.ts)
- Logic Doc constants: [`lib/analytics.ts`](lib/analytics.ts)
- Logic/tuning config: [`lib/logic-params.ts`](lib/logic-params.ts)
- Heuristic scorer: [`lib/predict.ts`](lib/predict.ts)
- Agent tuner loop: [`lib/agent-param-tuner.ts`](lib/agent-param-tuner.ts)
- See [`DATA_SCHEMA.md`](DATA_SCHEMA.md) for every field name.
- See [`API_FLOW.md`](API_FLOW.md) for every route + the ingest pipeline.
