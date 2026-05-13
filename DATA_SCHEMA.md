# DATA_SCHEMA.md

Canonical field names for the C55 Tracker. **Use these exact spellings** — do not invent variants. All TS types are exported from [`lib/lifecycle-store.ts`](lib/lifecycle-store.ts) (kept in sync with [`supabase/schema.sql`](supabase/schema.sql)).

## Core TypeScript types

### `Equipment`
```ts
{ equipment_id: string; display_name: string; }
```
Known equipment_ids: `"0091"`, `"0938"`, `"0198"`.

### `Slot`
```ts
{
  installation_id: string;       // e.g. "0091_LC2"
  equipment_id: string;
  part_code: string;             // key into PART_CATALOG
  zone: "cluster" | "pump" | "homogenizer" | "manifold" | "instrument";
  orientation: "left" | "middle" | "right" | "center";
  slot_index: number | null;
  sequence_order: number;        // physical fluid-flow position
}
```

### `Lifecycle`
```ts
{
  id?: string;                          // uuid; auto-assigned in local store
  installation_id: string;
  serial_number: string;
  is_refurb: boolean;
  installation_date: string;            // ISO
  removal_date: string | null;
  failure_mode: FailureMode | null;
  failure_notes: string | null;
  active_runtime_minutes: number;
  high_stress_minutes: number;
  cumulative_pressure_stress: number;   // kpsi-min above active floor
  inferred_failures: number;
  archived_at: string | null;           // ISO; null = active
  archive_reason: string | null;        // "replace_part" | "auto_closed_on_replace" | "imported_closed"
}
```
Unique key: `(installation_id, installation_date)` — matches `lifecycle_window_unique` in `supabase/schema.sql`.

### `MaintenanceEvent`
```ts
{
  id?: string;
  equipment_id: string | null;
  installation_id: string | null;
  lifecycle_id: string | null;
  event_type:
    | "replace" | "inspect" | "clean" | "reset" | "off_maintenance"
    | "high_stress_window" | "inspection_alert" | "failure_alert"
    | "failure_observation" | "data_integrity_alert" | "pass_detected";
  failure_mode: FailureMode | null;
  detected_at: string;                  // ISO
  ended_at: string | null;
  duration_minutes: number | null;
  source: string | null;                // "manual" | "trends-upload" | "stream:..."
  notes: string | null;
  created_at?: string;
}
```

### `FailureMode` (union)
```
"normal wear" | "scratches" | "binding (threads)" | "fracture (port)"
| "fracture (body)" | "weephole leak" | "thread fracture" | "internal erosion"
| "thermal drift" | "other" | "unknown"
```
Exported as `FAILURE_MODES` const tuple from both `lifecycle-store.ts` and `parts-catalog.ts`.

### `ProductionRunRow`
```ts
{
  id?: string;
  equipment_id: string;
  started_at: string; ended_at: string;
  expected_pass_count: number | null;
  actual_pass_count: number;
  status: "conforming" | "short" | "long" | "unknown_schedule";
  notes: string | null;
  created_at?: string;
}
```
Unique key: `(equipment_id, started_at)`.

### `PassEventRow`
```ts
{
  id?: string;
  run_id: string | null;
  equipment_id: string;
  pass_index: number;
  started_at: string; ended_at: string;
  duration_min: number;                 // 34–40 = valid
  peak_p01_kpsi: number; avg_p01_kpsi: number;
  status: "valid" | "short" | "long";
  created_at?: string;
}
```
Unique key: `(equipment_id, started_at)`.

### `StoreSnapshot` (response of `GET /api/lifecycles`)
```ts
{
  generated_at: string;
  equipment: Equipment[];
  slots: Slot[];
  lifecycles: Lifecycle[];
  events: MaintenanceEvent[];
  production_runs?: ProductionRunRow[];  // optional in older snapshots
  pass_events?: PassEventRow[];
}
```

## `PipelinePayload` — shape of `public/pipeline.json`

Defined in [`lib/analytics.ts`](lib/analytics.ts):

```ts
{
  generated_at: string;
  sensor_file: string;
  sensor_sha256: string;
  rows_ingested: number;
  summary: {
    active_minutes_total: number;
    high_stress_minutes_total: number;
    off_minutes_total: number;
    out_of_band_minutes: number;
    signals_detected: string[];          // e.g. ["P01","P02","T01"]
    active_band_low_kpsi: number;        // 19.0
    active_band_high_kpsi: number;       // 26.0
    pulsation_threshold_kpsi: number;    // 2.0
    rolling_window: string;              // "10min"
    gap_off_minutes: number;             // 5
    sample_minutes: number;
    // From trends-ingest summary (when present):
    passes_total?: number;
    valid_passes_total?: number;
    pass_runtime_minutes_total?: number;
    runs_total?: number;
    conforming_runs_total?: number;
    schedule_anomalies_total?: number;
  };
  parts: PartRecord[];
  fatigue_series: FatigueSample[];       // [{ ts, p01, stdev, status }]
  off_windows: WindowSpan[];             // [{ start, end, duration_min }]
  high_stress_windows: WindowSpan[];
  runs?: {
    run_index: number;
    started_at: string;
    ended_at: string;
    actual_pass_count: number;
    status: string;
  }[];
}
```

`SampleStatus` = `"off" | "below_active" | "active" | "high_stress" | "out_of_band"`.

`PartRecord` (in the pipeline payload only; UI overlay = `PartStatus` in `lib/dashboard-data.ts`):
```ts
{
  installation_id: string;
  part_name: string;
  serial_number: string;
  installation_date: string;
  removal_date: string | null;
  active_runtime_minutes: number;
  high_stress_minutes: number;
  cumulative_pressure_stress: number;
  inferred_failures: number;
  expected_mtbf_minutes: number;
  inspection_threshold_min: number | null;
  failure_threshold_min: number | null;
  health: "nominal" | "watch" | "critical";
  alert: "inspection" | "failure" | null;
}
```

## Part catalog (`lib/parts-catalog.ts`)

17 part codes across 5 zones. **Use the `partCode` string as the foreign key everywhere.**

| Code | Display name | Zone | Consumable | Structural | Serialized | MTBF (min) | Inspect (min) | Failure (min) | Seal life (min) |
|------|--------------|------|------------|------------|------------|------------|---------------|---------------|-----------------|
| `ICVB` | Inlet Check Valve Body | cluster | no | no | yes | 10,000 | — | — | — |
| `HPT` | High Pressure Tee | cluster | no | yes | yes | 9,000 | 2,000 | 2,400 | — |
| `OCVB` | Outlet Check Valve Body | cluster | no | no | yes | 11,000 | — | — | — |
| `ICVBS` | Inlet Check Valve Ball Seat | cluster | yes | no | — | — | — | — | 800–1,200 |
| `OCVBS` | Outlet Check Valve Ball Seat | cluster | yes | no | — | — | — | — | 800–1,200 |
| `CVBALL` | Check Valve Ball | cluster | yes | no | — | — | — | — | 800–1,200 |
| `SPRING` | Check Valve Spring | cluster | yes | no | — | — | — | — | 800–1,200 |
| `PLG` | Plunger | pump | no | no | — | 8,000 | — | — | — |
| `BUS` | Backup Support Seal (BUS) | pump | yes | no | — | — | — | — | 800–1,200 |
| `PB` | Pump Body | pump | no | yes | yes | 15,000 | 12,000 | 14,500 | — |
| `CVBSPB` | CV Ball Seat (Pump Body) | pump | yes | no | — | — | — | — | 800–1,200 |
| `HVB` | Homogenizing Valve Body | homogenizer | no | no | yes | 12,000 | — | — | — |
| `CSEAT` | Ceramic Seat | homogenizer | no | no | — | 6,000 | — | — | — |
| `IR` | Impact Ring | homogenizer | no | no | — | 6,000 | — | — | — |
| `CSTEM` | Ceramic Stem | homogenizer | no | no | — | 6,000 | — | — | — |
| `OM` | Outlet Manifold | manifold | no | yes | — | 18,000 | 14,000 | 17,000 | — |
| `TR` | Transducer | instrument | no | no | — | 20,000 | — | — | — |

### Slot layout (`buildSlotsForEquipment(equipmentId)`)

Per equipment unit (3 cluster columns × 5 slots + 3 pump columns × 4 slots + 4 head slots + 1 manifold + 1 transducer = **35 slots**):

- **Cluster** (slots 1–5 each): `{EQ}_LC1..LC5`, `{EQ}_MC1..MC5`, `{EQ}_RC1..RC5` → `ICVB, HPT, OCVB, ICVBS, OCVBS`
- **Pump** (slots 1–4 each): `{EQ}_LP1..LP4`, `{EQ}_MP1..MP4`, `{EQ}_RP1..RP4` → `PLG, BUS, PB, CVBSPB`
- **Homogenizer head** (slots 1–4): `{EQ}_H1..H4` → `HVB, CSEAT, IR, CSTEM`
- **Outlet manifold**: `{EQ}_O` → `OM`
- **Transducer**: `{EQ}_T` → `TR`

Physical sequence (drives `SequentialFlowchart`): cluster L (100s) → cluster M (110s) → cluster R (120s) → pump L (200s) → pump M (210s) → pump R (220s) → outlet manifold (300) → homogenizer head (400s) → transducer (500). Slot index is added to the zone base.

## Sensor signals (canonical taxonomy)

VantagePoint exports column names like `P01_0091 (kpsi)`; the parser strips the `_equipment` suffix and `(units)` block.

| Signal | Description | Unit |
|--------|-------------|------|
| `P01` | Homogenizing pressure at outlet manifold (primary) | kpsi |
| `P02` | Applied gas pressure at homogenizing body valve | kpsi |
| `T01` | Seal-flush temperature, left (downstream of pump body) | °C |
| `T02` | Seal-flush temperature, middle | °C |
| `T03` | Seal-flush temperature, right | °C |
| `T04` | Product loop temperature, pre-heat-exchanger | °C |
| `T05` | Product loop temperature, post-heat-exchanger | °C |
| `FLOW` | Product flow rate | — |
| `RPM` | Motor / drive speed | rpm |
| `VIB` | Vibration | g-rms or ips |

**Active band**: `19 ≤ P01 ≤ 26 kpsi`. **High stress**: rolling 10-min σ(P01) > 2 kpsi.

## Supabase tables (when `SUPABASE_SERVICE_ROLE_KEY` is set)

Defined in [`supabase/schema.sql`](supabase/schema.sql), 10 tables, all RLS-enabled (anon = read-only, service-role = full writes):

1. `equipment`
2. `part_catalog`
3. `installation_slot`
4. `part_lifecycle` — unique on `(installation_id, installation_date)`
5. `sensor_sample`
6. `sensor_window_10m`
7. `maintenance_event`
8. `csv_ingest_log`
9. `production_run` — unique on `(equipment_id, started_at)`
10. `pass_event` — unique on `(equipment_id, started_at)`

`part_lifecycle` also has `last_metrics_refresh: timestamptz` (Supabase only; not on the local-JSON snapshot).

## Snapshot file paths

- `public/lifecycles.json` — committed seed; bootstraps `data/lifecycles.json` on first read.
- `data/lifecycles.json` — gitignored mutable local store. Created on first write.
- `public/pipeline.json` — committed seed; rewritten by `data_pipeline.py`, `scripts/import_tracker.py` (lifecycles only), and `applyTrendsIngest` on every trends upload.
- `config/logic-params.json` — optional runtime overrides for thresholds/weights; read by `loadLogicParams()` and mutated by `PUT /api/logic-params`.
- `models/failure_predictor.json` — gitignored sklearn artefact; optional. When absent, `predict-model.ts` falls back to the heuristic in `predict.ts`.
