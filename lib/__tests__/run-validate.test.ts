import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RUN_CONFIG,
  detectScheduleAnomalies,
  groupPassesIntoRuns,
  labelRunSchedules,
  validateRuns,
} from "../run-validate";
import type { Pass } from "../pass-detect";

const EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);

// Build a synthetic Pass array. Each run is a sequence of 38-min passes
// separated by 10 min, and runs are separated by an 8-hour gap so they
// cluster correctly under DEFAULT_RUN_CONFIG.inter_run_gap_min (240 min).
function buildRun(
  startMs: number,
  passCount: number,
  passIndexBase: number,
): Pass[] {
  const passes: Pass[] = [];
  for (let i = 0; i < passCount; i++) {
    const start = startMs + i * (38 + 10) * 60 * 1000;
    const end = start + 38 * 60 * 1000;
    passes.push({
      pass_index: passIndexBase + i,
      started_at_ms: start,
      ended_at_ms: end,
      duration_min: 38,
      peak_p01_kpsi: 23,
      avg_p01_kpsi: 22,
      sample_count: 38 * 60,
      status: "valid",
    });
  }
  return passes;
}

const HOUR_MS = 60 * 60 * 1000;

test("groupPassesIntoRuns: clusters passes by 4h gap", () => {
  const passes = [
    ...buildRun(EPOCH, 10, 1),
    ...buildRun(EPOCH + 24 * HOUR_MS, 10, 11),
  ];
  const runs = groupPassesIntoRuns(passes);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].actual_pass_count, 10);
  assert.equal(runs[1].actual_pass_count, 10);
});

test("labelRunSchedules: 10-pass run is conforming", () => {
  const passes = buildRun(EPOCH, 10, 1);
  const grouped = groupPassesIntoRuns(passes);
  const labelled = labelRunSchedules(grouped);
  assert.equal(labelled[0].expected_pass_count, 10);
  assert.equal(labelled[0].status, "conforming");
});

test("labelRunSchedules: 6-pass run is conforming", () => {
  const passes = buildRun(EPOCH, 6, 1);
  const grouped = groupPassesIntoRuns(passes);
  const labelled = labelRunSchedules(grouped);
  assert.equal(labelled[0].expected_pass_count, 6);
  assert.equal(labelled[0].status, "conforming");
});

test("labelRunSchedules: 9-pass run snaps to 10 with 'short' status", () => {
  const passes = buildRun(EPOCH, 9, 1);
  const grouped = groupPassesIntoRuns(passes);
  const labelled = labelRunSchedules(grouped);
  assert.equal(labelled[0].expected_pass_count, 10);
  assert.equal(labelled[0].status, "short");
});

test("labelRunSchedules: 7-pass equidistant goes unknown", () => {
  // 7 is closer to 6 (delta=1) than to 10 (delta=3) so snaps to 6 'long'.
  // Use 8 which is equidistant (delta=2 each way).
  const passes = buildRun(EPOCH, 8, 1);
  const grouped = groupPassesIntoRuns(passes);
  const labelled = labelRunSchedules(grouped);
  assert.equal(labelled[0].expected_pass_count, null);
  assert.equal(labelled[0].status, "unknown_schedule");
});

test("validateRuns: 6 of 7 conforming runs (10,10,10,10,10,10,6) -> 0 anomalies", () => {
  const passes: Pass[] = [];
  let passIdx = 1;
  for (let i = 0; i < 6; i++) {
    passes.push(...buildRun(EPOCH + i * 24 * HOUR_MS, 10, passIdx));
    passIdx += 10;
  }
  passes.push(...buildRun(EPOCH + 6 * 24 * HOUR_MS, 6, passIdx));
  const { runs, anomalies } = validateRuns(passes);
  assert.equal(runs.length, 7);
  assert.ok(runs.every((r) => r.status === "conforming"));
  // 7 long, 0 short would not match the 1:6 cadence; this fixture has 6 long
  // + 1 short which matches the rule, so anomalies should be empty.
  assert.equal(anomalies.length, 0);
});

test("validateRuns: all-long week triggers a cadence anomaly", () => {
  const passes: Pass[] = [];
  let passIdx = 1;
  for (let i = 0; i < 7; i++) {
    passes.push(...buildRun(EPOCH + i * 24 * HOUR_MS, 10, passIdx));
    passIdx += 10;
  }
  const { runs, anomalies } = validateRuns(passes);
  assert.equal(runs.length, 7);
  assert.ok(runs.every((r) => r.status === "conforming"));
  // 7 long, 0 short -> off-cadence. At least one anomaly with run_index = -1
  // (the window-level alert) should be emitted.
  assert.ok(anomalies.length >= 1);
  assert.ok(anomalies.some((a) => a.run_index === -1));
});

test("detectScheduleAnomalies: short runs are individually reported", () => {
  const passes = [
    ...buildRun(EPOCH, 8, 1),
    ...buildRun(EPOCH + 24 * HOUR_MS, 10, 9),
  ];
  const { runs } = validateRuns(passes);
  // The 8-pass run is equidistant -> unknown_schedule; the 10-pass is OK.
  const anomalies = detectScheduleAnomalies(runs, DEFAULT_RUN_CONFIG);
  assert.ok(anomalies.some((a) => a.detail.includes("8 pass")));
});
