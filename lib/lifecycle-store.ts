import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getServerSupabase, hasServerSupabase } from "@/lib/supabase/server";

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
    | "failure_alert";
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

export type StoreSnapshot = {
  generated_at: string;
  equipment: Equipment[];
  slots: Slot[];
  lifecycles: Lifecycle[];
  events: MaintenanceEvent[];
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

export interface LifecycleStore {
  readonly backend: "supabase" | "local-json";
  snapshot(): Promise<StoreSnapshot>;
  replacePart(input: ReplacePartInput): Promise<ReplacePartResult>;
  logMaintenance(input: LogMaintenanceInput): Promise<MaintenanceEvent>;
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
