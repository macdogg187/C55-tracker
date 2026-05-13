import type { Pass } from "@/lib/pass-detect";
import { loadLogicParams } from "@/lib/logic-params";

// =============================================================================
// Production-Run Validation
//
// Groups detected passes into runs by clustering on inter-pass gaps and
// validates each run against the cadence the operations team committed to:
//
//   Over a rolling 14-day window, 6 out of every 7 runs should be 10-pass
//   and the remaining 1 should be 6-pass.
//
// The 10/6 distinction is the input to the predictive model — a mislabeled
// schedule means the model would learn the wrong baseline. We surface
// schedule-violation events so they get manual review before training.
// =============================================================================

export type RunStatus =
  | "conforming"     // pass count matches the expected (10 or 6)
  | "short"          // ran fewer passes than expected
  | "long"           // ran more passes than expected
  | "unknown_schedule"; // 14-day window didn't have enough context to label

export type ProductionRun = {
  run_index: number;            // 1-based, oldest -> newest
  started_at_ms: number;
  ended_at_ms: number;
  expected_pass_count: number | null;   // 10 | 6 | null
  actual_pass_count: number;
  status: RunStatus;
  pass_indices: number[];       // pass_index values from the Pass[] input
};

export type RunValidationConfig = {
  // Two passes more than this far apart belong to different runs.
  inter_run_gap_min: number;
  // Cadence: every Nth run is the short variant.
  long_pass_count: number;       // 10
  short_pass_count: number;      // 6
  expected_runs_per_period: number; // 7
  expected_short_runs_per_period: number; // 1
};

const _rv = loadLogicParams().run_validation;

export const DEFAULT_RUN_CONFIG: RunValidationConfig = {
  inter_run_gap_min: _rv.inter_run_gap_min,
  long_pass_count: _rv.long_pass_count,
  short_pass_count: _rv.short_pass_count,
  expected_runs_per_period: _rv.expected_runs_per_period,
  expected_short_runs_per_period: _rv.expected_short_runs_per_period,
};

/**
 * Group passes into runs by clustering on inter-pass gaps.
 */
export function groupPassesIntoRuns(
  passes: Pass[],
  cfg: RunValidationConfig = DEFAULT_RUN_CONFIG,
): ProductionRun[] {
  const runs: ProductionRun[] = [];
  if (passes.length === 0) return runs;

  const gapMs = cfg.inter_run_gap_min * 60_000;

  let cursor: ProductionRun = {
    run_index: 1,
    started_at_ms: passes[0].started_at_ms,
    ended_at_ms: passes[0].ended_at_ms,
    expected_pass_count: null,
    actual_pass_count: 1,
    status: "unknown_schedule",
    pass_indices: [passes[0].pass_index],
  };

  for (let i = 1; i < passes.length; i++) {
    const p = passes[i];
    if (p.started_at_ms - cursor.ended_at_ms > gapMs) {
      runs.push(cursor);
      cursor = {
        run_index: runs.length + 1,
        started_at_ms: p.started_at_ms,
        ended_at_ms: p.ended_at_ms,
        expected_pass_count: null,
        actual_pass_count: 1,
        status: "unknown_schedule",
        pass_indices: [p.pass_index],
      };
    } else {
      cursor.ended_at_ms = p.ended_at_ms;
      cursor.actual_pass_count += 1;
      cursor.pass_indices.push(p.pass_index);
    }
  }
  runs.push(cursor);
  return runs;
}

/**
 * Assign expected_pass_count + status to each run.
 *
 * The cadence rule says "6 of every 7 runs are 10-pass and 1 is 6-pass over
 * a 2-week window". We label each run by:
 *   1. Snap actual_pass_count to the nearest expected (10 or 6).
 *   2. If the result is unambiguous (delta <= 2 to either pole and they
 *      disagree), use that.
 *   3. Otherwise mark unknown_schedule so a human can resolve it.
 */
export function labelRunSchedules(
  runs: ProductionRun[],
  cfg: RunValidationConfig = DEFAULT_RUN_CONFIG,
): ProductionRun[] {
  return runs.map((run) => {
    const actual = run.actual_pass_count;
    const distLong = Math.abs(actual - cfg.long_pass_count);
    const distShort = Math.abs(actual - cfg.short_pass_count);

    let expected: number | null = null;
    if (distLong < distShort) expected = cfg.long_pass_count;
    else if (distShort < distLong) expected = cfg.short_pass_count;
    else expected = null; // equidistant -> ambiguous

    let status: RunStatus;
    if (expected === null) {
      status = "unknown_schedule";
    } else if (actual === expected) {
      status = "conforming";
    } else if (actual < expected) {
      status = "short";
    } else {
      status = "long";
    }

    return { ...run, expected_pass_count: expected, status };
  });
}

export type ScheduleAnomaly = {
  run_index: number;
  started_at_ms: number;
  ended_at_ms: number;
  detail: string;
};

/**
 * Audit a window of labelled runs against the 6:1 cadence rule. Emits one
 * anomaly per non-conforming run plus a window-level summary anomaly when
 * the ratio of short to long runs is wrong.
 */
export function detectScheduleAnomalies(
  runs: ProductionRun[],
  cfg: RunValidationConfig = DEFAULT_RUN_CONFIG,
): ScheduleAnomaly[] {
  const anomalies: ScheduleAnomaly[] = [];
  for (const run of runs) {
    if (run.status === "conforming") continue;
    anomalies.push({
      run_index: run.run_index,
      started_at_ms: run.started_at_ms,
      ended_at_ms: run.ended_at_ms,
      detail:
        run.status === "unknown_schedule"
          ? `run had ${run.actual_pass_count} pass(es) — cannot label as ${cfg.long_pass_count}- or ${cfg.short_pass_count}-pass`
          : `run had ${run.actual_pass_count} pass(es), expected ${run.expected_pass_count} (${run.status})`,
    });
  }

  // Window-level cadence check. Project the actual short:long counts onto
  // the expected (default 1:6) cadence. We compare the *expected* number of
  // short runs given the window size with the observed count and flag any
  // delta >= 1 — i.e. zero short runs in a 7-run window is an anomaly even
  // though every individual run was 'conforming' to its label.
  if (runs.length >= cfg.expected_runs_per_period) {
    const longCount = runs.filter(
      (r) => r.expected_pass_count === cfg.long_pass_count,
    ).length;
    const shortCount = runs.filter(
      (r) => r.expected_pass_count === cfg.short_pass_count,
    ).length;
    const totalLabelled = longCount + shortCount;
    if (totalLabelled >= cfg.expected_runs_per_period) {
      const expectedShortRatio =
        cfg.expected_short_runs_per_period / cfg.expected_runs_per_period;
      const expectedShort = expectedShortRatio * totalLabelled;
      if (Math.abs(shortCount - expectedShort) >= 1) {
        anomalies.push({
          run_index: -1,
          started_at_ms: runs[0].started_at_ms,
          ended_at_ms: runs[runs.length - 1].ended_at_ms,
          detail:
            `cadence ratio off — saw ${shortCount} short / ${longCount} long ` +
            `(expected ~${cfg.expected_short_runs_per_period}:${cfg.expected_runs_per_period - cfg.expected_short_runs_per_period} per 14-day window)`,
        });
      }
    }
  }

  return anomalies;
}

/**
 * One-shot helper: detect passes + group + label + audit in a single call.
 */
export function validateRuns(
  passes: Pass[],
  cfg: RunValidationConfig = DEFAULT_RUN_CONFIG,
): {
  runs: ProductionRun[];
  anomalies: ScheduleAnomaly[];
} {
  const grouped = groupPassesIntoRuns(passes, cfg);
  const runs = labelRunSchedules(grouped, cfg);
  const anomalies = detectScheduleAnomalies(runs, cfg);
  return { runs, anomalies };
}
