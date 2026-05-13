import { NextResponse } from "next/server";
import { getLifecycleStore } from "@/lib/lifecycle-store";
import { PART_CATALOG } from "@/lib/parts-catalog";
import { predictBatchWithModel } from "@/lib/predict-model";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET() {
  const store = getLifecycleStore();
  try {
    const snap = await store.snapshot();
    const slots = new Map(snap.slots.map((s) => [s.installation_id, s]));

    // Legacy data sometimes has more than one "active" lifecycle per slot.
    // Collapse to the most recent installation per installation_id so the
    // dashboard predicts on the row the operator actually cares about.
    const latestByInstall = new Map<string, typeof snap.lifecycles[number]>();
    for (const lc of snap.lifecycles) {
      if (lc.archived_at !== null) continue;
      const prev = latestByInstall.get(lc.installation_id);
      if (
        !prev ||
        new Date(lc.installation_date).getTime() >
          new Date(prev.installation_date).getTime()
      ) {
        latestByInstall.set(lc.installation_id, lc);
      }
    }

    const inputs = Array.from(latestByInstall.values()).map((lc) => {
      const slot = slots.get(lc.installation_id);
      const code = slot?.part_code ?? "";
      const catalog = PART_CATALOG[code];
      return {
        installation_id: lc.installation_id,
        part_code: code,
        part_name: catalog?.displayName ?? code,
        active_runtime_minutes: lc.active_runtime_minutes,
        high_stress_minutes: lc.high_stress_minutes,
        cumulative_pressure_stress: lc.cumulative_pressure_stress,
        inferred_failures: lc.inferred_failures,
        expected_mtbf_minutes: catalog?.expectedMtbfMinutes ?? null,
        inspection_threshold_min: catalog?.inspectionThresholdMin ?? null,
        failure_threshold_min: catalog?.failureThresholdMin ?? null,
        installation_date: lc.installation_date,
      };
    });
    // predictBatchWithModel transparently falls back to the heuristic
    // predictor when models/failure_predictor.json is absent — so the
    // dashboard works pre-training.
    const predictions = await predictBatchWithModel(inputs);
    const source = predictions[0]?.source ?? "heuristic";
    return NextResponse.json({
      backend: store.backend,
      generated_at: new Date().toISOString(),
      source,
      count: predictions.length,
      predictions,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
