import "server-only";
import { NextResponse } from "next/server";
import { getLifecycleStore } from "@/lib/lifecycle-store";
import { PART_CATALOG } from "@/lib/parts-catalog";
import { loadLogicParams } from "@/lib/logic-params";
import { predictBatchWithModel } from "@/lib/predict-model";
import type { PredictInput } from "@/lib/predict";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// =============================================================================
// POST /api/recalculate
//
// Re-scores every active lifecycle using the current logic-params (read fresh
// from config/logic-params.json) and returns the updated predictions.
//
// This endpoint does NOT mutate the stored lifecycle records — it is a
// pure compute pass that reflects the *current* parameter set.  To persist
// parameter changes, call PUT /api/logic-params first; then POST this endpoint
// to see the downstream effect without modifying underlying runtime/stress data.
//
// Optional JSON body:
//   {
//     "equipment_id": "0091"   // scope to one machine; omit for all
//   }
// =============================================================================

export async function POST(req: Request) {
  let scope: { equipment_id?: string } = {};
  try {
    const text = await req.text();
    if (text.trim()) scope = JSON.parse(text) as typeof scope;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const params = loadLogicParams();
  const store  = getLifecycleStore();

  let snap;
  try {
    snap = await store.snapshot();
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  const slots = new Map(snap.slots.map((s) => [s.installation_id, s]));

  // Collapse to the most recent active lifecycle per slot.
  const latestByInstall = new Map<string, typeof snap.lifecycles[number]>();
  for (const lc of snap.lifecycles) {
    if (lc.archived_at !== null) continue;
    // Scope filter
    if (scope.equipment_id) {
      const slot = slots.get(lc.installation_id);
      if (slot?.equipment_id !== scope.equipment_id) continue;
    }
    const prev = latestByInstall.get(lc.installation_id);
    if (
      !prev ||
      new Date(lc.installation_date).getTime() >
        new Date(prev.installation_date).getTime()
    ) {
      latestByInstall.set(lc.installation_id, lc);
    }
  }

  // Build predict inputs, preferring config-driven thresholds over catalog
  // hard-codes so a PUT /api/logic-params change is immediately reflected.
  const inputs: PredictInput[] = Array.from(latestByInstall.values()).map((lc) => {
    const slot    = slots.get(lc.installation_id);
    const code    = slot?.part_code ?? "";
    const catalog = PART_CATALOG[code];
    const pp      = params.parts[code] ?? {};

    return {
      installation_id: lc.installation_id,
      part_code: code,
      part_name: catalog?.displayName ?? code,
      active_runtime_minutes: lc.active_runtime_minutes,
      high_stress_minutes: lc.high_stress_minutes,
      cumulative_pressure_stress: lc.cumulative_pressure_stress,
      inferred_failures: lc.inferred_failures,
      // Config-driven thresholds take precedence over catalog defaults.
      expected_mtbf_minutes:
        pp.expected_mtbf_minutes ??
        catalog?.expectedMtbfMinutes ??
        params.default_mtbf_fallback_minutes,
      inspection_threshold_min:
        pp.inspection_threshold_min ?? catalog?.inspectionThresholdMin ?? null,
      failure_threshold_min:
        pp.failure_threshold_min ?? catalog?.failureThresholdMin ?? null,
      installation_date: lc.installation_date,
    };
  });

  let predictions;
  try {
    predictions = await predictBatchWithModel(inputs);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  // Build a lookup from installation_id → PredictInput so we can access
  // inspection_threshold_min (not present on the Prediction return type).
  const inputByInstall = new Map(inputs.map((i) => [i.installation_id, i]));

  // Compute health + alert for each lifecycle using the config MTBF percentages,
  // mirroring the classify_health() logic from data_pipeline.py.
  const healthSummary = predictions.map((p) => {
    const lc     = latestByInstall.get(p.installation_id);
    const input  = inputByInstall.get(p.installation_id);
    const runtime = lc?.active_runtime_minutes ?? 0;
    const mtbf    = p.expected_mtbf_minutes;
    const failMin = p.failure_threshold_min;
    const inspMin = input?.inspection_threshold_min ?? null;
    const ht      = params.health_thresholds;

    let health: "nominal" | "watch" | "critical" = "nominal";
    let alert: "inspection" | "failure" | null = null;

    if (failMin !== null && failMin !== undefined && runtime >= failMin) {
      health = "critical"; alert = "failure";
    } else if (inspMin !== null && inspMin !== undefined && runtime >= inspMin) {
      health = "watch"; alert = "inspection";
    } else if (mtbf !== null && mtbf !== undefined && mtbf > 0) {
      const pct = runtime / mtbf;
      if (pct >= ht.critical_mtbf_pct) {
        health = "critical"; alert = "failure";
      } else if (pct >= ht.watch_mtbf_pct) {
        health = "watch"; alert = "inspection";
      }
    }

    return { installation_id: p.installation_id, health, alert };
  });

  return NextResponse.json({
    ok: true,
    backend: store.backend,
    generated_at: new Date().toISOString(),
    params_snapshot: {
      active_band_low_kpsi:  params.active_band_low_kpsi,
      active_band_high_kpsi: params.active_band_high_kpsi,
      pulsation_stdev_kpsi:  params.pulsation_stdev_kpsi,
      health_thresholds:     params.health_thresholds,
      risk_bands:            params.risk_bands,
    },
    count: predictions.length,
    predictions,
    health_summary: healthSummary,
  });
}
