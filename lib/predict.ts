import { PART_CATALOG } from "@/lib/parts-catalog";

// =============================================================================
// Failure-risk scoring — combines the lifecycle odometer with trend-derived
// stress signals so the dashboard can rank parts by predicted-time-to-failure
// rather than just by raw runtime.
//
// The score is intentionally explainable: every contributing factor is kept
// as a separate sub-score so the UI can show *why* a part is flagged.
// =============================================================================

export type RiskBand = "low" | "moderate" | "high" | "critical";

export type PredictInput = {
  installation_id: string;
  part_code: string;
  part_name: string;
  active_runtime_minutes: number;
  high_stress_minutes: number;
  cumulative_pressure_stress: number;
  inferred_failures: number;
  expected_mtbf_minutes: number | null;
  inspection_threshold_min: number | null;
  failure_threshold_min: number | null;
  installation_date: string | null;
};

export type Factor = {
  label: string;
  weight: number;          // 0..1 contribution to the composite score
  detail: string;
};

export type Prediction = {
  installation_id: string;
  part_code: string;
  part_name: string;
  risk_score: number;       // 0..100
  band: RiskBand;
  eta_minutes: number | null;   // null if we cannot project
  factors: Factor[];
  active_runtime_minutes: number;
  failure_threshold_min: number | null;
  expected_mtbf_minutes: number | null;
};

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

function band(score: number): RiskBand {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 35) return "moderate";
  return "low";
}

export function predictForPart(input: PredictInput): Prediction {
  const runtime = Math.max(0, input.active_runtime_minutes);
  const stressMin = Math.max(0, input.high_stress_minutes);
  const cumStress = Math.max(0, input.cumulative_pressure_stress);
  const mtbf = input.expected_mtbf_minutes ?? PART_CATALOG[input.part_code]?.expectedMtbfMinutes ?? null;
  const failureMin =
    input.failure_threshold_min ??
    PART_CATALOG[input.part_code]?.failureThresholdMin ??
    null;
  const inspectionMin =
    input.inspection_threshold_min ??
    PART_CATALOG[input.part_code]?.inspectionThresholdMin ??
    null;

  const factors: Factor[] = [];

  // (1) Runtime vs failure threshold — the most defensible single signal.
  let runtimeRatio = 0;
  if (failureMin && failureMin > 0) {
    runtimeRatio = runtime / failureMin;
    factors.push({
      label: "Runtime / failure threshold",
      weight: clamp01(runtimeRatio),
      detail: `${Math.round(runtime).toLocaleString()} min / ${failureMin.toLocaleString()} min (${(runtimeRatio * 100).toFixed(0)}%)`,
    });
  } else if (mtbf && mtbf > 0) {
    runtimeRatio = runtime / mtbf;
    factors.push({
      label: "Runtime / expected MTBF",
      weight: clamp01(runtimeRatio),
      detail: `${Math.round(runtime).toLocaleString()} min / ${mtbf.toLocaleString()} min (${(runtimeRatio * 100).toFixed(0)}%)`,
    });
  }

  // (2) Inspection-threshold proximity — early warning even before MTBF.
  if (inspectionMin && inspectionMin > 0) {
    const ratio = clamp01(runtime / inspectionMin);
    factors.push({
      label: "Approaching inspection threshold",
      weight: ratio * 0.6,
      detail: `${Math.round(runtime).toLocaleString()} min / ${inspectionMin.toLocaleString()} min`,
    });
  }

  // (3) High-stress exposure ratio — pulsation σ > 2 kpsi is the dominant
  // weephole-leak driver per the Logic Doc.
  if (runtime > 0) {
    const stressRatio = clamp01(stressMin / runtime);
    factors.push({
      label: "High-stress exposure",
      weight: stressRatio,
      detail: `${stressMin.toLocaleString()} of ${Math.round(runtime).toLocaleString()} min (${(stressRatio * 100).toFixed(0)}%)`,
    });
  }

  // (4) Cumulative pressure-stress per minute of life (proxy for fatigue).
  if (runtime > 0) {
    const perMin = cumStress / runtime;
    // 4.0 (kpsi-min per min, i.e. average kpsi above the active floor) is
    // the upper end of a typical mid-pressure cycle. Normalize against that.
    const ratio = clamp01(perMin / 4);
    factors.push({
      label: "Cumulative pressure intensity",
      weight: ratio * 0.7,
      detail: `${perMin.toFixed(2)} kpsi-min/min avg above floor`,
    });
  }

  // (5) Inferred off-window failures — every gap inside this lifecycle is
  // suggestive of an unscheduled maintenance event.
  if (input.inferred_failures > 0) {
    const ratio = clamp01(input.inferred_failures / 5);
    factors.push({
      label: "Inferred off-maintenance windows",
      weight: ratio * 0.5,
      detail: `${input.inferred_failures} gap(s) > 5 min`,
    });
  }

  // Composite score: weighted average of the contributing factors, capped at
  // 100. Runtime ratio dominates because it's the most reliable signal.
  if (!factors.length) {
    return {
      installation_id: input.installation_id,
      part_code: input.part_code,
      part_name: input.part_name,
      risk_score: 0,
      band: "low",
      eta_minutes: null,
      factors,
      active_runtime_minutes: runtime,
      failure_threshold_min: failureMin,
      expected_mtbf_minutes: mtbf,
    };
  }

  const factorWeights = factors.reduce((a, f) => a + f.weight, 0);
  const maxFactor = Math.max(...factors.map((f) => f.weight));
  // 60% of the score = strongest single factor (we want to flag a part that's
  // bad at any one thing), 40% = average of the rest.
  const composite = clamp01(0.6 * maxFactor + 0.4 * (factorWeights / factors.length));
  // Boost by 8 pts whenever runtime ratio exceeds 1.0 to make critical truly
  // pop on the dashboard.
  const score = Math.min(100, Math.round(composite * 100 + (runtimeRatio > 1 ? 8 : 0)));

  // ETA-to-failure (minutes): based on the failure threshold or MTBF. Subtract
  // accumulated runtime; if already past it, null = "service immediately".
  let eta: number | null = null;
  const ceiling = failureMin ?? mtbf ?? null;
  if (ceiling && ceiling > runtime) {
    eta = Math.round(ceiling - runtime);
  } else if (ceiling) {
    eta = 0;
  }

  return {
    installation_id: input.installation_id,
    part_code: input.part_code,
    part_name: input.part_name,
    risk_score: score,
    band: band(score),
    eta_minutes: eta,
    factors: factors.sort((a, b) => b.weight - a.weight),
    active_runtime_minutes: runtime,
    failure_threshold_min: failureMin,
    expected_mtbf_minutes: mtbf,
  };
}

export function predictBatch(inputs: PredictInput[]): Prediction[] {
  return inputs
    .map((i) => predictForPart(i))
    .sort((a, b) => b.risk_score - a.risk_score);
}
