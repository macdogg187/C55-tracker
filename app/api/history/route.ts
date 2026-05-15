import { NextResponse } from "next/server";
import { getLifecycleStore } from "@/lib/lifecycle-store";
import { PART_CATALOG } from "@/lib/parts-catalog";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export type HistoryRow = {
  id: string;
  installation_id: string;
  equipment_id: string;
  part_code: string;
  part_name: string;
  serial_number: string;
  is_refurb: boolean;
  installation_date: string;
  removal_date: string | null;
  active_runtime_minutes: number;
  high_stress_minutes: number;
  failure_mode: string | null;
  notes: string | null;
  status: "active" | "archived";
};

export async function GET() {
  const store = getLifecycleStore();
  try {
    const snap = await store.snapshot();

    // Build a slot map so we can look up part info by installation_id
    const slotMap = new Map(snap.slots.map((s) => [s.installation_id, s]));

    const rows: HistoryRow[] = snap.lifecycles.map((lc) => {
      const slot = slotMap.get(lc.installation_id);
      const partCode = slot?.part_code ?? derivePartCode(lc.installation_id);
      const catalog = partCode ? PART_CATALOG[partCode] : null;

      const equipmentId =
        slot?.equipment_id ?? lc.installation_id.match(/^(\d{3,5})_/)?.[1] ?? "";

      return {
        id: lc.id ?? lc.installation_id,
        installation_id: lc.installation_id,
        equipment_id: equipmentId,
        part_code: partCode ?? "",
        part_name: catalog?.displayName ?? partCode ?? lc.installation_id,
        serial_number: lc.serial_number,
        is_refurb: lc.is_refurb,
        installation_date: lc.installation_date,
        removal_date: lc.removal_date,
        active_runtime_minutes: lc.active_runtime_minutes,
        high_stress_minutes: lc.high_stress_minutes,
        failure_mode: lc.failure_mode,
        notes: lc.failure_notes,
        status: lc.removal_date || lc.archived_at ? "archived" : "active",
      };
    });

    // Sort: active first (by installation_date desc), then archived (by removal_date desc)
    rows.sort((a, b) => {
      if (a.status !== b.status) return a.status === "active" ? -1 : 1;
      const dateA = a.status === "archived" ? (a.removal_date ?? a.installation_date) : a.installation_date;
      const dateB = b.status === "archived" ? (b.removal_date ?? b.installation_date) : b.installation_date;
      return new Date(dateB).getTime() - new Date(dateA).getTime();
    });

    return NextResponse.json({ rows, total: rows.length });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

/**
 * Derive a part code from the installation_id slot suffix when no slot record exists.
 * e.g. "0091_LC2" → cluster slot 2 → "HPT"
 */
function derivePartCode(installationId: string): string | null {
  const slot = installationId.replace(/^\d{3,5}_/, "");
  const cluster = /^([LMR])C([1-5])$/.exec(slot);
  if (cluster) {
    const codes: Record<string, string> = { "1": "ICVB", "2": "HPT", "3": "OCVB", "4": "ICVBS", "5": "OCVBS" };
    return codes[cluster[2]] ?? null;
  }
  const pump = /^([LMR])P([1-4])$/.exec(slot);
  if (pump) {
    const codes: Record<string, string> = { "1": "PLG", "2": "BUS", "3": "PB", "4": "BSPB" };
    return codes[pump[2]] ?? null;
  }
  const head = /^H([1-4])$/.exec(slot);
  if (head) {
    const codes: Record<string, string> = { "1": "HVB", "2": "CSEAT", "3": "IR", "4": "CSTEM" };
    return codes[head[1]] ?? null;
  }
  if (slot === "O") return "OM";
  if (slot === "T") return "TR";
  return null;
}
