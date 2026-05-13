import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getServerSupabase, hasServerSupabase } from "@/lib/supabase/server";
import { PART_CATALOG } from "@/lib/parts-catalog";
import type {
  ParsedEquipment,
  ParsedLifecycle,
  ParsedSlot,
  TrackerImportReport,
} from "@/lib/tracker-import";
import type { LifecycleMetrics, TrendsIngestResult } from "@/lib/trends-ingest";

// =============================================================================
// Types — must stay in sync with supabase/schema.sql.
// =============================================================================

export type Equipment = {
  equipment_id: string;
  display_name: string;
};

export type Slot = {
  installation_id: string;
  equipment_id: string;
  part_code: string;
  zone: "cluster" | "pump" | "homogenizer" | "manifold" | "instrument";
  orientation: "left" | "middle" | "right" | "center";
  slot_index: number | null;
  sequence_order: number;
};

export type Lifecycle = {
  id?: string;
  installation_id: string;
  serial_number: string;
  is_refurb: boolean;
  installation_date: string;        // ISO
  removal_date: string | null;      // ISO or null
  failure_mode: FailureMode | null;
  failure_notes: string | null;
  active_runtime_minutes: number;
  high_stress_minutes: number;
  cumulative_pressure_stress: number;
  inferred_failures: number;
  archived_at: string | null;
  archive_reason: string | null;
};

export type MaintenanceEvent = {
  id?: string;
  equipment_id: string | null;
  installation_id: string | null;
  lifecycle_id: string | null;
  event_type:
    | "replace"
    | "inspect"
    | "clean"
    | "reset"
    | "off_maintenance"
    | "high_stress_window"
    | "inspection_alert"
    | "failure_alert"
    | "failure_observation"
    | "data_integrity_alert"
    | "pass_detected";
  failure_mode: FailureMode | null;
  detected_at: string;        // ISO
  ended_at: string | null;
  duration_minutes: number | null;
  source: string | null;
  notes: string | null;
  created_at?: string;
};

export const FAILURE_MODES = [
  "normal wear",
  "scratches",
  "binding (threads)",
  "fracture (port)",
  "fracture (body)",
  "weephole leak",
  "thread fracture",
  "internal erosion",
  "thermal drift",
  "other",
  "unknown",
] as const;
export type FailureMode = (typeof FAILURE_MODES)[number];

export type ProductionRunRow = {
  id?: string;
  equipment_id: string;
  started_at: string;
  ended_at: string;
  expected_pass_count: number | null;
  actual_pass_count: number;
  status: "conforming" | "short" | "long" | "unknown_schedule";
  notes: string | null;
  created_at?: string;
};

export type PassEventRow = {
  id?: string;
  run_id: string | null;
  equipment_id: string;
  pass_index: number;
  started_at: string;
  ended_at: string;
  duration_min: number;
  peak_p01_kpsi: number;
  avg_p01_kpsi: number;
  status: "valid" | "short" | "long";
  created_at?: string;
};

export type StoreSnapshot = {
  generated_at: string;
  equipment: Equipment[];
  slots: Slot[];
  lifecycles: Lifecycle[];
  events: MaintenanceEvent[];
  // Optional in local-json (older snapshots predate these fields).
  production_runs?: ProductionRunRow[];
  pass_events?: PassEventRow[];
};

// =============================================================================
// Local-JSON backend  (data/lifecycles.json)
// =============================================================================

const LOCAL_PATH = path.join(process.cwd(), "data", "lifecycles.json");
const PUBLIC_PATH = path.join(process.cwd(), "public", "lifecycles.json");

async function readLocal(): Promise<StoreSnapshot> {
  // Prefer the writeable copy under /data; bootstrap from /public on first read
  // so the importer's snapshot becomes the initial state.
  try {
    const raw = await fs.readFile(LOCAL_PATH, "utf-8");
    return JSON.parse(raw) as StoreSnapshot;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  let bootstrap: Partial<StoreSnapshot> = {};
  try {
    const raw = await fs.readFile(PUBLIC_PATH, "utf-8");
    bootstrap = JSON.parse(raw) as Partial<StoreSnapshot>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const snapshot: StoreSnapshot = {
    generated_at: new Date().toISOString(),
    equipment: bootstrap.equipment ?? [],
    slots: bootstrap.slots ?? [],
    lifecycles: (bootstrap.lifecycles ?? []).map((lc) => normaliseLifecycle(lc)),
    events: bootstrap.events ?? [],
    production_runs: bootstrap.production_runs ?? [],
    pass_events: bootstrap.pass_events ?? [],
  };
  await writeLocal(snapshot);
  return snapshot;
}

async function writeLocal(snapshot: StoreSnapshot): Promise<void> {
  await fs.mkdir(path.dirname(LOCAL_PATH), { recursive: true });
  await fs.writeFile(
    LOCAL_PATH,
    JSON.stringify({ ...snapshot, generated_at: new Date().toISOString() }, null, 2),
    "utf-8",
  );
}

function normaliseLifecycle(raw: Partial<Lifecycle>): Lifecycle {
  return {
    id: raw.id ?? randomUUID(),
    installation_id: raw.installation_id ?? "",
    serial_number: raw.serial_number ?? "",
    is_refurb: raw.is_refurb ?? false,
    installation_date: raw.installation_date ?? new Date().toISOString(),
    removal_date: raw.removal_date ?? null,
    failure_mode: raw.failure_mode ?? null,
    failure_notes: raw.failure_notes ?? null,
    active_runtime_minutes: raw.active_runtime_minutes ?? 0,
    high_stress_minutes: raw.high_stress_minutes ?? 0,
    cumulative_pressure_stress: raw.cumulative_pressure_stress ?? 0,
    inferred_failures: raw.inferred_failures ?? 0,
    archived_at: raw.archived_at ?? null,
    archive_reason: raw.archive_reason ?? null,
  };
}

// =============================================================================
// Public API — backend-agnostic
// =============================================================================

export type ReplacePartInput = {
  installation_id: string;
  new_serial: string;
  failure_mode: FailureMode;
  notes?: string;
  timestamp?: string;        // override "now" for backfills
};

export type ReplacePartResult = {
  archived: Lifecycle;
  created: Lifecycle;
  event: MaintenanceEvent;
};

export type LogMaintenanceInput = {
  installation_id?: string | null;
  lifecycle_id?: string | null;
  equipment_id?: string | null;
  event_type: MaintenanceEvent["event_type"];
  failure_mode?: FailureMode | null;
  detected_at?: string;
  ended_at?: string | null;
  duration_minutes?: number | null;
  notes?: string | null;
  source?: string | null;
};

export type TrackerIngestInput = {
  equipment: ParsedEquipment[];
  slots: ParsedSlot[];
  lifecycles: ParsedLifecycle[];
  report: TrackerImportReport;
  source?: string;
};

export type TrackerIngestResult = {
  equipment_upserted: number;
  slots_upserted: number;
  lifecycles_upserted: number;
  lifecycles_inserted: number;
  lifecycles_updated: number;
  report: TrackerImportReport;
};

export type TrendsIngestInput = {
  result: TrendsIngestResult;
  source?: string;
  // Optional scope for run / pass persistence. When omitted we try to infer
  // from the source filename ("0091_*.csv") and fall back to the first known
  // equipment in the snapshot.
  equipment_id?: string;
};

export type TrendsApplyResult = {
  lifecycles_updated: number;
  events_logged: number;
  passes_persisted: number;
  runs_persisted: number;
  schedule_anomalies_logged: number;
  result: TrendsIngestResult;
};

export interface LifecycleStore {
  readonly backend: "supabase" | "local-json";
  snapshot(): Promise<StoreSnapshot>;
  replacePart(input: ReplacePartInput): Promise<ReplacePartResult>;
  logMaintenance(input: LogMaintenanceInput): Promise<MaintenanceEvent>;
  ingestTracker(input: TrackerIngestInput): Promise<TrackerIngestResult>;
  applyTrendsIngest(input: TrendsIngestInput): Promise<TrendsApplyResult>;
  // Returns just the active lifecycle windows the trends pipeline needs to
  // compute its analytics — keeps the trends route lightweight.
  activeLifecycleWindows(): Promise<{
    installation_id: string;
    installation_date: string;
    removal_date: string | null;
  }[]>;
}

// Best-effort: pull "0091" out of a path like "0091_12APR26to12MAY26.csv" or
// "trends:0091_2026-05.csv". Returns null when no equipment prefix is found.
export function inferEquipmentIdFromSource(source: string | null | undefined): string | null {
  if (!source) return null;
  const m = source.match(/(?:^|[\s/:_-])(\d{3,5})(?:[_.\s-]|$)/);
  return m ? m[1] : null;
}

const PUBLIC_PIPELINE_PATH = path.join(process.cwd(), "public", "pipeline.json");

async function writePipelineSnapshot(result: TrendsIngestResult): Promise<void> {
  const payload = {
    generated_at: result.generated_at,
    sensor_file: result.sensor_file,
    sensor_sha256: "",
    rows_ingested: result.rows_ingested,
    summary: result.summary,
    parts: [],
    fatigue_series: result.fatigue_series,
    off_windows: result.off_windows,
    high_stress_windows: result.high_stress_windows,
  };
  try {
    await fs.mkdir(path.dirname(PUBLIC_PIPELINE_PATH), { recursive: true });
    await fs.writeFile(PUBLIC_PIPELINE_PATH, JSON.stringify(payload, null, 2), "utf-8");
  } catch {
    // Non-fatal — the dashboard still works from the lifecycle snapshot.
  }
}

// -----------------------------------------------------------------------------
// Local-JSON implementation
// -----------------------------------------------------------------------------

class LocalJsonStore implements LifecycleStore {
  readonly backend = "local-json" as const;

  async snapshot(): Promise<StoreSnapshot> {
    return readLocal();
  }

  async replacePart(input: ReplacePartInput): Promise<ReplacePartResult> {
    const ts = input.timestamp ?? new Date().toISOString();
    const snap = await readLocal();

    // Find ALL active lifecycles for this slot (the legacy Tracker has cases
    // where older rows were never properly closed). Most-recent install wins
    // as the primary archive; any stragglers get auto-closed for hygiene.
    const activeIdxs = snap.lifecycles
      .map((lc, i) => ({ lc, i }))
      .filter(
        ({ lc }) =>
          lc.installation_id === input.installation_id
          && lc.removal_date === null
          && lc.archived_at === null,
      )
      .sort(
        (a, b) =>
          new Date(b.lc.installation_date).getTime() -
          new Date(a.lc.installation_date).getTime(),
      );

    if (activeIdxs.length === 0) {
      throw new Error(
        `No active lifecycle for installation_id ${input.installation_id}`,
      );
    }

    const primaryIdx = activeIdxs[0].i;
    const previous = snap.lifecycles[primaryIdx];
    const archived: Lifecycle = {
      ...previous,
      removal_date: ts,
      archived_at: ts,
      archive_reason: "replace_part",
      failure_mode: input.failure_mode,
      failure_notes: input.notes ?? previous.failure_notes,
    };

    // Auto-close stale active rows (data hygiene).
    for (let k = 1; k < activeIdxs.length; k++) {
      const { i } = activeIdxs[k];
      snap.lifecycles[i] = {
        ...snap.lifecycles[i],
        removal_date: ts,
        archived_at: ts,
        archive_reason: "auto_closed_on_replace",
      };
    }

    const created: Lifecycle = normaliseLifecycle({
      installation_id: input.installation_id,
      serial_number: input.new_serial,
      is_refurb: false,
      installation_date: ts,
      removal_date: null,
      failure_mode: null,
      failure_notes: null,
      active_runtime_minutes: 0,
      high_stress_minutes: 0,
      cumulative_pressure_stress: 0,
      inferred_failures: 0,
      archived_at: null,
      archive_reason: null,
    });

    const event: MaintenanceEvent = {
      id: randomUUID(),
      equipment_id: snap.slots.find(
        (s) => s.installation_id === input.installation_id,
      )?.equipment_id ?? null,
      installation_id: input.installation_id,
      lifecycle_id: archived.id ?? null,
      event_type: "replace",
      failure_mode: input.failure_mode,
      detected_at: ts,
      ended_at: ts,
      duration_minutes: null,
      source: "manual",
      notes: input.notes ?? null,
      created_at: ts,
    };

    snap.lifecycles[primaryIdx] = archived;
    snap.lifecycles.push(created);
    snap.events.push(event);
    await writeLocal(snap);
    return { archived, created, event };
  }

  async logMaintenance(input: LogMaintenanceInput): Promise<MaintenanceEvent> {
    const ts = input.detected_at ?? new Date().toISOString();
    const snap = await readLocal();
    const slot = input.installation_id
      ? snap.slots.find((s) => s.installation_id === input.installation_id) ?? null
      : null;
    const event: MaintenanceEvent = {
      id: randomUUID(),
      equipment_id: input.equipment_id ?? slot?.equipment_id ?? null,
      installation_id: input.installation_id ?? null,
      lifecycle_id: input.lifecycle_id ?? null,
      event_type: input.event_type,
      failure_mode: input.failure_mode ?? null,
      detected_at: ts,
      ended_at: input.ended_at ?? null,
      duration_minutes: input.duration_minutes ?? null,
      source: input.source ?? "manual",
      notes: input.notes ?? null,
      created_at: ts,
    };
    snap.events.push(event);
    await writeLocal(snap);
    return event;
  }

  async ingestTracker(input: TrackerIngestInput): Promise<TrackerIngestResult> {
    const snap = await readLocal();

    const eqById = new Map(snap.equipment.map((e) => [e.equipment_id, e]));
    for (const eq of input.equipment) {
      eqById.set(eq.equipment_id, { ...(eqById.get(eq.equipment_id) ?? {}), ...eq });
    }

    const slotById = new Map(snap.slots.map((s) => [s.installation_id, s]));
    for (const slot of input.slots) {
      slotById.set(slot.installation_id, slot as Slot);
    }

    // Lifecycle UPSERT key: (installation_id, installation_date) — matches the
    // schema's lifecycle_window_unique constraint.
    const lcByKey = new Map<string, { idx: number; lc: Lifecycle }>();
    snap.lifecycles.forEach((lc, idx) => {
      lcByKey.set(`${lc.installation_id}|${lc.installation_date}`, { idx, lc });
    });

    let inserted = 0;
    let updated = 0;
    for (const row of input.lifecycles) {
      const key = `${row.installation_id}|${row.installation_date}`;
      const existing = lcByKey.get(key);
      if (existing) {
        const merged: Lifecycle = {
          ...existing.lc,
          serial_number: row.serial_number || existing.lc.serial_number,
          is_refurb: row.is_refurb,
          removal_date: row.removal_date,
          failure_mode: row.failure_mode ?? existing.lc.failure_mode,
          failure_notes: row.failure_notes ?? existing.lc.failure_notes,
          active_runtime_minutes: Math.max(
            existing.lc.active_runtime_minutes,
            row.active_runtime_minutes,
          ),
          archived_at: row.removal_date ? existing.lc.archived_at ?? row.removal_date : existing.lc.archived_at,
        };
        snap.lifecycles[existing.idx] = merged;
        updated += 1;
      } else {
        const fresh: Lifecycle = normaliseLifecycle({
          installation_id: row.installation_id,
          serial_number: row.serial_number,
          is_refurb: row.is_refurb,
          installation_date: row.installation_date,
          removal_date: row.removal_date,
          failure_mode: row.failure_mode,
          failure_notes: row.failure_notes,
          active_runtime_minutes: row.active_runtime_minutes,
          archived_at: row.removal_date,
          archive_reason: row.removal_date ? "imported_closed" : null,
        });
        snap.lifecycles.push(fresh);
        lcByKey.set(key, { idx: snap.lifecycles.length - 1, lc: fresh });
        inserted += 1;
      }
    }

    snap.equipment = Array.from(eqById.values());
    snap.slots = Array.from(slotById.values());
    await writeLocal(snap);

    return {
      equipment_upserted: input.equipment.length,
      slots_upserted: input.slots.length,
      lifecycles_upserted: input.lifecycles.length,
      lifecycles_inserted: inserted,
      lifecycles_updated: updated,
      report: input.report,
    };
  }

  async activeLifecycleWindows(): Promise<{
    installation_id: string;
    installation_date: string;
    removal_date: string | null;
  }[]> {
    const snap = await readLocal();
    return snap.lifecycles
      .filter((lc) => lc.archived_at === null)
      .map((lc) => ({
        installation_id: lc.installation_id,
        installation_date: lc.installation_date,
        removal_date: lc.removal_date,
      }));
  }

  async applyTrendsIngest(input: TrendsIngestInput): Promise<TrendsApplyResult> {
    const snap = await readLocal();
    const ts = input.result.generated_at;
    const metricsById = new Map<string, LifecycleMetrics>();
    for (const m of input.result.lifecycle_metrics) metricsById.set(m.installation_id, m);

    let updated = 0;
    for (let i = 0; i < snap.lifecycles.length; i++) {
      const lc = snap.lifecycles[i];
      if (lc.archived_at) continue;
      const m = metricsById.get(lc.installation_id);
      if (!m) continue;
      // Trends are the source of truth for usage — replace, not increment, so
      // re-uploading the same window is idempotent.
      snap.lifecycles[i] = {
        ...lc,
        active_runtime_minutes: Math.max(lc.active_runtime_minutes, m.active_runtime_minutes),
        high_stress_minutes: Math.max(lc.high_stress_minutes, m.high_stress_minutes),
        cumulative_pressure_stress: Math.max(
          lc.cumulative_pressure_stress,
          m.cumulative_pressure_stress,
        ),
        inferred_failures: Math.max(lc.inferred_failures, m.inferred_failures),
      };
      updated += 1;
    }

    // Log new derived events per window so the operator can see them in the
    // maintenance feed. Dedupe by (event_type, detected_at, ended_at).
    const eventKey = (e: { event_type: string; detected_at: string; ended_at: string | null }) =>
      `${e.event_type}|${e.detected_at}|${e.ended_at ?? ""}`;
    const seenKeys = new Set(snap.events.map(eventKey));

    let eventsLogged = 0;
    for (const w of input.result.high_stress_windows) {
      const key = `high_stress_window|${w.start}|${w.end}`;
      if (seenKeys.has(key)) continue;
      snap.events.push({
        id: randomUUID(),
        equipment_id: null,
        installation_id: null,
        lifecycle_id: null,
        event_type: "high_stress_window",
        failure_mode: null,
        detected_at: w.start,
        ended_at: w.end,
        duration_minutes: w.duration_min,
        source: input.source ?? "trends-upload",
        notes: `σ(P01) > ${input.result.summary.pulsation_threshold_kpsi} kpsi`,
        created_at: ts,
      });
      seenKeys.add(key);
      eventsLogged += 1;
    }
    for (const w of input.result.off_windows) {
      const key = `off_maintenance|${w.start}|${w.end}`;
      if (seenKeys.has(key)) continue;
      snap.events.push({
        id: randomUUID(),
        equipment_id: null,
        installation_id: null,
        lifecycle_id: null,
        event_type: "off_maintenance",
        failure_mode: null,
        detected_at: w.start,
        ended_at: w.end,
        duration_minutes: w.duration_min,
        source: input.source ?? "trends-upload",
        notes: `inter-sample gap > ${input.result.summary.gap_off_minutes} min`,
        created_at: ts,
      });
      seenKeys.add(key);
      eventsLogged += 1;
    }

    // Persist detected passes + runs + schedule anomalies. We dedupe by
    // (equipment_id, started_at) so re-ingesting the same source file is a
    // no-op. The equipment scope is operator-selectable but we infer from
    // the file name as a sensible default.
    const equipmentId =
      input.equipment_id
      ?? inferEquipmentIdFromSource(input.source)
      ?? snap.equipment[0]?.equipment_id
      ?? "0091";

    snap.production_runs ??= [];
    snap.pass_events ??= [];

    const existingRunKeys = new Set(
      snap.production_runs.map((r) => `${r.equipment_id}|${r.started_at}`),
    );
    const existingPassKeys = new Set(
      snap.pass_events.map((p) => `${p.equipment_id}|${p.started_at}`),
    );

    let runsPersisted = 0;
    let passesPersisted = 0;
    let anomaliesLogged = 0;

    const runIdByIndex = new Map<number, string>();
    for (const run of input.result.runs) {
      const key = `${equipmentId}|${run.started_at}`;
      if (existingRunKeys.has(key)) {
        // Reuse the existing run id so passes link to the right row.
        const prev = snap.production_runs.find(
          (r) => r.equipment_id === equipmentId && r.started_at === run.started_at,
        );
        if (prev?.id) runIdByIndex.set(run.run_index, prev.id);
        continue;
      }
      const id = randomUUID();
      runIdByIndex.set(run.run_index, id);
      snap.production_runs.push({
        id,
        equipment_id: equipmentId,
        started_at: run.started_at,
        ended_at: run.ended_at,
        expected_pass_count: run.expected_pass_count,
        actual_pass_count: run.actual_pass_count,
        status: run.status,
        notes: null,
        created_at: ts,
      });
      runsPersisted += 1;
    }

    const runIdxOf = new Map<number, number>();
    input.result.runs.forEach((r) => {
      for (const passIndex of r.pass_indices) runIdxOf.set(passIndex, r.run_index);
    });

    for (const p of input.result.passes) {
      const key = `${equipmentId}|${p.started_at}`;
      if (existingPassKeys.has(key)) continue;
      const runIdx = runIdxOf.get(p.pass_index);
      const runId = runIdx !== undefined ? runIdByIndex.get(runIdx) ?? null : null;
      snap.pass_events.push({
        id: randomUUID(),
        run_id: runId,
        equipment_id: equipmentId,
        pass_index: p.pass_index,
        started_at: p.started_at,
        ended_at: p.ended_at,
        duration_min: p.duration_min,
        peak_p01_kpsi: p.peak_p01_kpsi,
        avg_p01_kpsi: p.avg_p01_kpsi,
        status: p.status,
      });
      passesPersisted += 1;
    }

    // Schedule anomalies → maintenance events tagged "data_integrity_alert".
    // Dedupe by (event_type, detected_at, ended_at) like the off/high-stress
    // windows above so re-uploads stay idempotent.
    for (const a of input.result.schedule_anomalies) {
      const key = `data_integrity_alert|${a.started_at}|${a.ended_at}`;
      if (seenKeys.has(key)) continue;
      snap.events.push({
        id: randomUUID(),
        equipment_id: equipmentId,
        installation_id: null,
        lifecycle_id: null,
        event_type: "data_integrity_alert",
        failure_mode: null,
        detected_at: a.started_at,
        ended_at: a.ended_at,
        duration_minutes: null,
        source: input.source ?? "trends-upload",
        notes: a.detail,
        created_at: ts,
      });
      seenKeys.add(key);
      anomaliesLogged += 1;
    }

    await writeLocal(snap);
    await writePipelineSnapshot(input.result);

    return {
      lifecycles_updated: updated,
      events_logged: eventsLogged,
      passes_persisted: passesPersisted,
      runs_persisted: runsPersisted,
      schedule_anomalies_logged: anomaliesLogged,
      result: input.result,
    };
  }
}

// -----------------------------------------------------------------------------
// Supabase implementation
// -----------------------------------------------------------------------------

class SupabaseStore implements LifecycleStore {
  readonly backend = "supabase" as const;

  async snapshot(): Promise<StoreSnapshot> {
    const sb = getServerSupabase();
    if (!sb) throw new Error("Supabase not configured");
    const [equipment, slots, lifecycles, events] = await Promise.all([
      sb.from("equipment").select("*"),
      sb.from("installation_slot").select("*"),
      sb.from("part_lifecycle").select("*"),
      sb
        .from("maintenance_event")
        .select("*")
        .order("detected_at", { ascending: false })
        .limit(500),
    ]);
    for (const r of [equipment, slots, lifecycles, events]) {
      if (r.error) throw new Error(r.error.message);
    }
    return {
      generated_at: new Date().toISOString(),
      equipment: equipment.data ?? [],
      slots: slots.data ?? [],
      lifecycles: (lifecycles.data ?? []).map((lc) =>
        normaliseLifecycle(lc as Partial<Lifecycle>),
      ),
      events: (events.data ?? []) as MaintenanceEvent[],
    };
  }

  async replacePart(input: ReplacePartInput): Promise<ReplacePartResult> {
    const sb = getServerSupabase();
    if (!sb) throw new Error("Supabase not configured");
    const ts = input.timestamp ?? new Date().toISOString();

    const { data: prev, error: prevErr } = await sb
      .from("part_lifecycle")
      .select("*")
      .eq("installation_id", input.installation_id)
      .is("removal_date", null)
      .is("archived_at", null)
      .order("installation_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (prevErr) throw new Error(prevErr.message);
    if (!prev) {
      throw new Error(
        `No active lifecycle for installation_id ${input.installation_id}`,
      );
    }

    const { data: archived, error: archErr } = await sb
      .from("part_lifecycle")
      .update({
        removal_date: ts,
        archived_at: ts,
        archive_reason: "replace_part",
        failure_mode: input.failure_mode,
        failure_notes: input.notes ?? prev.failure_notes,
      })
      .eq("id", prev.id)
      .select()
      .single();
    if (archErr) throw new Error(archErr.message);

    const { data: created, error: insErr } = await sb
      .from("part_lifecycle")
      .insert({
        installation_id: input.installation_id,
        serial_number: input.new_serial,
        is_refurb: false,
        installation_date: ts,
      })
      .select()
      .single();
    if (insErr) throw new Error(insErr.message);

    const { data: event, error: evtErr } = await sb
      .from("maintenance_event")
      .insert({
        installation_id: input.installation_id,
        lifecycle_id: archived.id,
        event_type: "replace",
        failure_mode: input.failure_mode,
        detected_at: ts,
        ended_at: ts,
        source: "manual",
        notes: input.notes ?? null,
      })
      .select()
      .single();
    if (evtErr) throw new Error(evtErr.message);

    return {
      archived: normaliseLifecycle(archived as Partial<Lifecycle>),
      created: normaliseLifecycle(created as Partial<Lifecycle>),
      event: event as MaintenanceEvent,
    };
  }

  async logMaintenance(input: LogMaintenanceInput): Promise<MaintenanceEvent> {
    const sb = getServerSupabase();
    if (!sb) throw new Error("Supabase not configured");
    const { data, error } = await sb
      .from("maintenance_event")
      .insert({
        equipment_id: input.equipment_id ?? null,
        installation_id: input.installation_id ?? null,
        lifecycle_id: input.lifecycle_id ?? null,
        event_type: input.event_type,
        failure_mode: input.failure_mode ?? null,
        detected_at: input.detected_at ?? new Date().toISOString(),
        ended_at: input.ended_at ?? null,
        duration_minutes: input.duration_minutes ?? null,
        source: input.source ?? "manual",
        notes: input.notes ?? null,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data as MaintenanceEvent;
  }

  async ingestTracker(input: TrackerIngestInput): Promise<TrackerIngestResult> {
    const sb = getServerSupabase();
    if (!sb) throw new Error("Supabase not configured");

    if (input.equipment.length) {
      const { error } = await sb
        .from("equipment")
        .upsert(input.equipment, { onConflict: "equipment_id" });
      if (error) throw new Error(error.message);
    }

    // Upsert any part_catalog rows referenced by the slots (in case they
    // aren't seeded yet — defensive against fresh-databases).
    const referenced = new Set(input.slots.map((s) => s.part_code));
    const catalogRows = Array.from(referenced)
      .map((code) => {
        const c = PART_CATALOG[code];
        if (!c) return null;
        return {
          part_code: c.partCode,
          display_name: c.displayName,
          category: c.category,
          is_consumable: c.isConsumable,
          is_structural: c.isStructural,
          expected_mtbf_minutes: c.expectedMtbfMinutes ?? null,
          inspection_threshold_min: c.inspectionThresholdMin ?? null,
          failure_threshold_min: c.failureThresholdMin ?? null,
          seal_life_low_min: c.sealLifeLowMin ?? null,
          seal_life_high_min: c.sealLifeHighMin ?? null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (catalogRows.length) {
      const { error } = await sb
        .from("part_catalog")
        .upsert(catalogRows, { onConflict: "part_code" });
      if (error) throw new Error(error.message);
    }

    if (input.slots.length) {
      const { error } = await sb
        .from("installation_slot")
        .upsert(input.slots, { onConflict: "installation_id" });
      if (error) throw new Error(error.message);
    }

    let inserted = 0;
    let updated = 0;
    for (const row of input.lifecycles) {
      const { data: existing, error: selErr } = await sb
        .from("part_lifecycle")
        .select("id, active_runtime_minutes")
        .eq("installation_id", row.installation_id)
        .eq("installation_date", row.installation_date)
        .maybeSingle();
      if (selErr) throw new Error(selErr.message);

      if (existing) {
        const { error } = await sb
          .from("part_lifecycle")
          .update({
            serial_number: row.serial_number,
            is_refurb: row.is_refurb,
            removal_date: row.removal_date,
            failure_mode: row.failure_mode,
            failure_notes: row.failure_notes,
            active_runtime_minutes: Math.max(
              existing.active_runtime_minutes ?? 0,
              row.active_runtime_minutes,
            ),
            archived_at: row.removal_date,
          })
          .eq("id", existing.id);
        if (error) throw new Error(error.message);
        updated += 1;
      } else {
        const { error } = await sb.from("part_lifecycle").insert({
          installation_id: row.installation_id,
          serial_number: row.serial_number,
          is_refurb: row.is_refurb,
          installation_date: row.installation_date,
          removal_date: row.removal_date,
          failure_mode: row.failure_mode,
          failure_notes: row.failure_notes,
          active_runtime_minutes: row.active_runtime_minutes,
          archived_at: row.removal_date,
          archive_reason: row.removal_date ? "imported_closed" : null,
        });
        if (error) throw new Error(error.message);
        inserted += 1;
      }
    }

    return {
      equipment_upserted: input.equipment.length,
      slots_upserted: input.slots.length,
      lifecycles_upserted: input.lifecycles.length,
      lifecycles_inserted: inserted,
      lifecycles_updated: updated,
      report: input.report,
    };
  }

  async activeLifecycleWindows(): Promise<{
    installation_id: string;
    installation_date: string;
    removal_date: string | null;
  }[]> {
    const sb = getServerSupabase();
    if (!sb) throw new Error("Supabase not configured");
    const { data, error } = await sb
      .from("part_lifecycle")
      .select("installation_id, installation_date, removal_date")
      .is("archived_at", null);
    if (error) throw new Error(error.message);
    return (data ?? []) as {
      installation_id: string;
      installation_date: string;
      removal_date: string | null;
    }[];
  }

  async applyTrendsIngest(input: TrendsIngestInput): Promise<TrendsApplyResult> {
    const sb = getServerSupabase();
    if (!sb) throw new Error("Supabase not configured");

    const { data: actives, error: actErr } = await sb
      .from("part_lifecycle")
      .select("id, installation_id, active_runtime_minutes, high_stress_minutes, cumulative_pressure_stress, inferred_failures")
      .is("archived_at", null);
    if (actErr) throw new Error(actErr.message);

    const byInstall = new Map(
      (actives ?? []).map((row) => [row.installation_id as string, row]),
    );

    let updated = 0;
    for (const m of input.result.lifecycle_metrics) {
      const lc = byInstall.get(m.installation_id);
      if (!lc) continue;
      const { error } = await sb
        .from("part_lifecycle")
        .update({
          active_runtime_minutes: Math.max(
            lc.active_runtime_minutes ?? 0,
            m.active_runtime_minutes,
          ),
          high_stress_minutes: Math.max(
            lc.high_stress_minutes ?? 0,
            m.high_stress_minutes,
          ),
          cumulative_pressure_stress: Math.max(
            Number(lc.cumulative_pressure_stress ?? 0),
            m.cumulative_pressure_stress,
          ),
          inferred_failures: Math.max(
            lc.inferred_failures ?? 0,
            m.inferred_failures,
          ),
          last_metrics_refresh: input.result.generated_at,
        })
        .eq("id", lc.id);
      if (error) throw new Error(error.message);
      updated += 1;
    }

    const eventsToInsert = [
      ...input.result.high_stress_windows.map((w) => ({
        event_type: "high_stress_window" as const,
        detected_at: w.start,
        ended_at: w.end,
        duration_minutes: w.duration_min,
        source: input.source ?? "trends-upload",
        notes: `σ(P01) > ${input.result.summary.pulsation_threshold_kpsi} kpsi`,
      })),
      ...input.result.off_windows.map((w) => ({
        event_type: "off_maintenance" as const,
        detected_at: w.start,
        ended_at: w.end,
        duration_minutes: w.duration_min,
        source: input.source ?? "trends-upload",
        notes: `inter-sample gap > ${input.result.summary.gap_off_minutes} min`,
      })),
    ];

    let logged = 0;
    if (eventsToInsert.length) {
      const { error } = await sb.from("maintenance_event").insert(eventsToInsert);
      if (!error) logged = eventsToInsert.length;
    }

    // Persist runs + passes + schedule anomalies. Uniqueness is guarded by
    // (equipment_id, started_at) via the unique constraints in schema.sql.
    const equipmentId =
      input.equipment_id
      ?? inferEquipmentIdFromSource(input.source)
      ?? "0091";

    let runsPersisted = 0;
    const runIdByIndex = new Map<number, string>();

    if (input.result.runs.length) {
      const runRows = input.result.runs.map((r) => ({
        equipment_id: equipmentId,
        started_at: r.started_at,
        ended_at: r.ended_at,
        expected_pass_count: r.expected_pass_count,
        actual_pass_count: r.actual_pass_count,
        status: r.status,
      }));
      const { data: upserted, error: runErr } = await sb
        .from("production_run")
        .upsert(runRows, { onConflict: "equipment_id,started_at" })
        .select("id, started_at");
      if (!runErr && upserted) {
        const byStarted = new Map(
          (upserted as { id: string; started_at: string }[]).map((row) => [
            row.started_at,
            row.id,
          ]),
        );
        for (const r of input.result.runs) {
          const id = byStarted.get(r.started_at);
          if (id) runIdByIndex.set(r.run_index, id);
        }
        runsPersisted = upserted.length;
      }
    }

    let passesPersisted = 0;
    if (input.result.passes.length) {
      const runIdxByPass = new Map<number, number>();
      input.result.runs.forEach((r) => {
        for (const idx of r.pass_indices) runIdxByPass.set(idx, r.run_index);
      });
      const passRows = input.result.passes.map((p) => {
        const runIdx = runIdxByPass.get(p.pass_index);
        return {
          run_id: runIdx !== undefined ? runIdByIndex.get(runIdx) ?? null : null,
          equipment_id: equipmentId,
          pass_index: p.pass_index,
          started_at: p.started_at,
          ended_at: p.ended_at,
          duration_min: p.duration_min,
          peak_p01_kpsi: p.peak_p01_kpsi,
          avg_p01_kpsi: p.avg_p01_kpsi,
          status: p.status,
        };
      });
      const { error: passErr, count } = await sb
        .from("pass_event")
        .upsert(passRows, { onConflict: "equipment_id,started_at", count: "exact" });
      if (!passErr) passesPersisted = count ?? passRows.length;
    }

    let anomaliesLogged = 0;
    if (input.result.schedule_anomalies.length) {
      const anomalyRows = input.result.schedule_anomalies.map((a) => ({
        equipment_id: equipmentId,
        event_type: "data_integrity_alert" as const,
        detected_at: a.started_at,
        ended_at: a.ended_at,
        source: input.source ?? "trends-upload",
        notes: a.detail,
      }));
      const { error } = await sb.from("maintenance_event").insert(anomalyRows);
      if (!error) anomaliesLogged = anomalyRows.length;
    }

    await writePipelineSnapshot(input.result);
    return {
      lifecycles_updated: updated,
      events_logged: logged,
      passes_persisted: passesPersisted,
      runs_persisted: runsPersisted,
      schedule_anomalies_logged: anomaliesLogged,
      result: input.result,
    };
  }
}

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

let cached: LifecycleStore | null = null;

export function getLifecycleStore(): LifecycleStore {
  if (cached) return cached;
  cached = hasServerSupabase() ? new SupabaseStore() : new LocalJsonStore();
  return cached;
}
