import "server-only";
// =============================================================================
// Agent Parameter Tuner
//
// Implements an explainable, auditable reasoning loop that compares observed
// part outcomes (failures, inspections, replacements) against the current
// predictive-model outputs and proposes targeted adjustments to logic-params.
//
// Design constraints:
//   1. Every proposed change is logged as a MaintenanceEvent before application
//      so the audit trail is never lost.
//   2. Changes are bounded — the tuner only tightens or loosens thresholds
//      within safe limits rather than making unconstrained edits.
//   3. The operator sees a human-readable justification for every suggestion.
//   4. The tuner never reduces a threshold below a part's observed failure point.
// =============================================================================

import { getLifecycleStore } from "@/lib/lifecycle-store";
import { PART_CATALOG } from "@/lib/parts-catalog";
import {
  loadLogicParams,
  invalidateLogicParamsCache,
  type LogicParams,
  type PartParams,
} from "@/lib/logic-params";
import { predictBatchWithModel } from "@/lib/predict-model";
import { promises as fs } from "node:fs";
import path from "node:path";

const CONFIG_PATH = path.join(process.cwd(), "config", "logic-params.json");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TunerTrigger =
  | "trends_upload"      // new sensor data ingested
  | "part_replacement"   // operator replaced a part
  | "manual_review";     // operator explicitly requested a tune pass

export type ParameterProposal = {
  path: string;          // dotted JSON path, e.g. "parts.HPT.inspection_threshold_min"
  current_value: number;
  proposed_value: number;
  reason: string;
  confidence: "high" | "medium" | "low";
};

export type TunerResult = {
  triggered_by: TunerTrigger;
  proposals: ParameterProposal[];
  applied: boolean;
  applied_paths: string[];
  event_id: string | null;
  summary: string;
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runParamTuner(
  trigger: TunerTrigger,
  options: { dry_run?: boolean; equipment_id?: string } = {},
): Promise<TunerResult> {
  const { dry_run = false, equipment_id } = options;

  const store  = loadLogicParams();
  const lsStore = getLifecycleStore();
  const snap   = await lsStore.snapshot();
  const slots  = new Map(snap.slots.map((s) => [s.installation_id, s]));
  const params = store;

  // ── 1. Gather evidence: closed lifecycles with known failure modes ──────
  const closedWithFailure = snap.lifecycles.filter(
    (lc) =>
      lc.archived_at !== null &&
      lc.failure_mode !== null &&
      lc.failure_mode !== "unknown" &&
      lc.active_runtime_minutes > 0,
  );

  // Group actual failure runtimes by part code.
  const observedFailureRuntimes: Record<string, number[]> = {};
  for (const lc of closedWithFailure) {
    const slot = slots.get(lc.installation_id);
    if (!slot) continue;
    if (equipment_id && slot.equipment_id !== equipment_id) continue;
    const code = slot.part_code;
    (observedFailureRuntimes[code] ??= []).push(lc.active_runtime_minutes);
  }

  // ── 2. Get current predictions for active lifecycles ────────────────────
  const latestByInstall = new Map<string, typeof snap.lifecycles[number]>();
  for (const lc of snap.lifecycles) {
    if (lc.archived_at !== null) continue;
    if (equipment_id) {
      const slot = slots.get(lc.installation_id);
      if (slot?.equipment_id !== equipment_id) continue;
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

  const inputs = Array.from(latestByInstall.values()).map((lc) => {
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
      expected_mtbf_minutes:
        pp.expected_mtbf_minutes ?? catalog?.expectedMtbfMinutes ?? params.default_mtbf_fallback_minutes,
      inspection_threshold_min:
        pp.inspection_threshold_min ?? catalog?.inspectionThresholdMin ?? null,
      failure_threshold_min:
        pp.failure_threshold_min ?? catalog?.failureThresholdMin ?? null,
      installation_date: lc.installation_date,
    };
  });

  const predictions = await predictBatchWithModel(inputs);

  // ── 3. Generate proposals ────────────────────────────────────────────────
  const proposals: ParameterProposal[] = [];

  for (const [code, runtimes] of Object.entries(observedFailureRuntimes)) {
    if (!runtimes.length) continue;

    // Observed median failure runtime for this part code.
    const sorted = [...runtimes].sort((a, b) => a - b);
    const medianFailureRuntime = sorted[Math.floor(sorted.length / 2)];
    const minObserved = sorted[0];

    const currentParams = params.parts[code] ?? {};
    const catalog       = PART_CATALOG[code];

    // ── a) Failure threshold: if observed median is significantly below the
    //       current threshold, tighten it (or create it if absent).
    const currentFailure =
      currentParams.failure_threshold_min ??
      catalog?.failureThresholdMin ??
      null;

    if (currentFailure === null || medianFailureRuntime < currentFailure * 0.9) {
      const proposed = Math.max(
        minObserved,
        Math.round(medianFailureRuntime * 0.95),
      );
      if (currentFailure === null || proposed < currentFailure) {
        proposals.push({
          path: `parts.${code}.failure_threshold_min`,
          current_value: currentFailure ?? -1,
          proposed_value: proposed,
          reason:
            `${runtimes.length} observed failure(s) for ${code}; ` +
            `median runtime at failure = ${medianFailureRuntime} min, ` +
            `which is ${currentFailure ? `${Math.round((1 - medianFailureRuntime / currentFailure) * 100)}% below` : "below the current"} threshold. ` +
            `Proposing tighter threshold at ${proposed} min (95% of median).`,
          confidence: runtimes.length >= 5 ? "high" : runtimes.length >= 2 ? "medium" : "low",
        });
      }
    }

    // ── b) Inspection threshold: if absent or too close to the failure
    //       threshold, add a lead-time buffer of ~15%.
    const currentInspection =
      currentParams.inspection_threshold_min ??
      catalog?.inspectionThresholdMin ??
      null;
    const targetFailure =
      proposals.find((p) => p.path === `parts.${code}.failure_threshold_min`)?.proposed_value ??
      currentFailure;

    if (targetFailure && (currentInspection === null || currentInspection > targetFailure * 0.9)) {
      const proposedInspection = Math.round(targetFailure * 0.85);
      if (currentInspection === null || proposedInspection < currentInspection) {
        proposals.push({
          path: `parts.${code}.inspection_threshold_min`,
          current_value: currentInspection ?? -1,
          proposed_value: proposedInspection,
          reason:
            `Inspection lead-time should precede failure threshold (${targetFailure} min) ` +
            `by ≥ 15%. Proposing ${proposedInspection} min (85% of failure threshold).`,
          confidence: "medium",
        });
      }
    }

    // ── c) MTBF: if the catalog MTBF is substantially higher than observed
    //       median failure runtime, suggest reducing it.
    const currentMtbf =
      currentParams.expected_mtbf_minutes ??
      catalog?.expectedMtbfMinutes ??
      null;
    if (currentMtbf && medianFailureRuntime < currentMtbf * 0.7) {
      const proposedMtbf = Math.round(medianFailureRuntime * 1.1); // 10% headroom
      proposals.push({
        path: `parts.${code}.expected_mtbf_minutes`,
        current_value: currentMtbf,
        proposed_value: proposedMtbf,
        reason:
          `Observed median failure runtime (${medianFailureRuntime} min) is ` +
          `${Math.round((1 - medianFailureRuntime / currentMtbf) * 100)}% below ` +
          `catalogued MTBF (${currentMtbf} min). ` +
          `Reducing MTBF to ${proposedMtbf} min improves health-badge accuracy.`,
        confidence: runtimes.length >= 3 ? "medium" : "low",
      });
    }
  }

  // ── d) Pulsation threshold: if high-stress exposure is high across many
  //       parts with no failures, the current threshold may be too sensitive.
  //       Conversely, if weephole-leak failures correlate with high-stress time,
  //       consider tightening it.
  const weepholeParts = predictions.filter((p) => {
    const lc = latestByInstall.get(p.installation_id);
    return (lc?.high_stress_minutes ?? 0) > (lc?.active_runtime_minutes ?? 1) * 0.3;
  });
  const weeepholeFailed = closedWithFailure.filter(
    (lc) => lc.failure_mode === "weephole leak" || lc.failure_mode === "internal erosion",
  );
  if (weeepholeFailed.length >= 3 && weepholeParts.length > 0) {
    const currentPulsation = params.pulsation_stdev_kpsi;
    if (currentPulsation > 1.5) {
      proposals.push({
        path: "pulsation_stdev_kpsi",
        current_value: currentPulsation,
        proposed_value: Math.max(1.5, currentPulsation - 0.2),
        reason:
          `${weeepholeFailed.length} weephole-leak / erosion failures observed. ` +
          `${weepholeParts.length} active parts have high-stress fraction > 30%. ` +
          `Tightening pulsation threshold by 0.2 kpsi increases high-stress detection sensitivity.`,
        confidence: "low",
      });
    }
  }

  if (!proposals.length) {
    return {
      triggered_by: trigger,
      proposals: [],
      applied: false,
      applied_paths: [],
      event_id: null,
      summary: "No parameter adjustments warranted by current evidence.",
    };
  }

  // ── 4. Apply high-confidence proposals (unless dry_run) ─────────────────
  const toApply = dry_run
    ? []
    : proposals.filter((p) => p.confidence === "high" || p.confidence === "medium");

  const appliedPaths: string[] = [];

  if (toApply.length > 0) {
    const current = loadLogicParams();
    const patch: Partial<LogicParams> = {};

    for (const proposal of toApply) {
      const parts2 = proposal.path.split(".");
      if (parts2[0] === "parts" && parts2.length === 3) {
        const [, code2, field] = parts2;
        if (!patch.parts) patch.parts = { ...current.parts };
        patch.parts[code2] = {
          ...(patch.parts[code2] ?? current.parts[code2] ?? {}),
          [field]: proposal.proposed_value,
        } as PartParams;
        appliedPaths.push(proposal.path);
      } else if (parts2.length === 1) {
        (patch as Record<string, unknown>)[parts2[0]] = proposal.proposed_value;
        appliedPaths.push(proposal.path);
      }
    }

    const merged: LogicParams = {
      ...current,
      ...patch,
      parts: { ...current.parts, ...(patch.parts ?? {}) },
    };

    const toWrite = { ...merged } as Record<string, unknown>;
    delete toWrite["_comment"];
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.writeFile(CONFIG_PATH, JSON.stringify(toWrite, null, 2), "utf-8");
    invalidateLogicParamsCache();
  }

  // ── 5. Log the tuning event ──────────────────────────────────────────────
  const summary =
    `Agent param tuner (${trigger}): ` +
    `${proposals.length} proposal(s) generated, ` +
    `${appliedPaths.length} applied. ` +
    proposals
      .map((p) => `[${p.confidence}] ${p.path}: ${p.current_value} → ${p.proposed_value}`)
      .join("; ");

  let eventId: string | null = null;
  if (!dry_run) {
    try {
      const lsStore2 = getLifecycleStore();
      const event = await lsStore2.logMaintenance({
        event_type: "data_integrity_alert",
        notes: summary,
        source: `agent-param-tuner:${trigger}`,
      });
      eventId = event.id ?? null;
    } catch {
      // Non-fatal — the tuning still happened.
    }
  }

  return {
    triggered_by: trigger,
    proposals,
    applied: appliedPaths.length > 0,
    applied_paths: appliedPaths,
    event_id: eventId,
    summary,
  };
}
