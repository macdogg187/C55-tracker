import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PASS_CONFIG,
  cumulativeRuntimeMinutes,
  detectPasses,
} from "../pass-detect";

// Helpers: generate 1-Hz P01 streams for synthetic scenarios. We use a fixed
// epoch so all assertions stay stable.
const EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01T00:00:00Z

function constantPass(
  startMs: number,
  durationMin: number,
  p01Kpsi: number,
  stepSec = 1,
): { times: number[]; p01: number[] } {
  const times: number[] = [];
  const p01: number[] = [];
  const samples = Math.floor((durationMin * 60) / stepSec);
  for (let i = 0; i <= samples; i++) {
    times.push(startMs + i * stepSec * 1000);
    p01.push(p01Kpsi);
  }
  return { times, p01 };
}

function offPeriod(
  startMs: number,
  durationMin: number,
  stepSec = 1,
): { times: number[]; p01: number[] } {
  return constantPass(startMs, durationMin, 0.1, stepSec);
}

function concat(
  segments: { times: number[]; p01: number[] }[],
): { times: number[]; p01: number[] } {
  const times: number[] = [];
  const p01: number[] = [];
  for (const seg of segments) {
    times.push(...seg.times);
    p01.push(...seg.p01);
  }
  return { times, p01 };
}

test("detectPasses: single 38-min pass at 22 kpsi is valid", () => {
  const { times, p01 } = constantPass(EPOCH, 38, 22);
  const passes = detectPasses(times, p01);
  assert.equal(passes.length, 1);
  assert.equal(passes[0].status, "valid");
  assert.equal(passes[0].peak_p01_kpsi, 22);
  assert.equal(passes[0].avg_p01_kpsi, 22);
  // 38 min, +/- 1s of rounding
  assert.ok(Math.abs(passes[0].duration_min - 38) < 0.05);
});

test("detectPasses: 25-min pass is tagged 'short'", () => {
  const { times, p01 } = constantPass(EPOCH, 25, 22);
  const passes = detectPasses(times, p01);
  assert.equal(passes.length, 1);
  assert.equal(passes[0].status, "short");
});

test("detectPasses: 45-min pass is tagged 'long'", () => {
  const { times, p01 } = constantPass(EPOCH, 45, 22);
  const passes = detectPasses(times, p01);
  assert.equal(passes.length, 1);
  assert.equal(passes[0].status, "long");
});

test("detectPasses: below-band samples don't start a pass", () => {
  // 10 min idle, then a 38-min pass, then 10 min idle again.
  const seq = concat([
    offPeriod(EPOCH, 10),
    constantPass(EPOCH + 10 * 60 * 1000 + 1000, 38, 22),
    offPeriod(EPOCH + 49 * 60 * 1000 + 1000, 10),
  ]);
  const passes = detectPasses(seq.times, seq.p01);
  assert.equal(passes.length, 1);
  assert.equal(passes[0].status, "valid");
});

test("detectPasses: out-of-band ceiling breaks a pass", () => {
  // 20 min at 22 kpsi -> 5s overshoot to 28 kpsi -> 18 more min at 22 kpsi.
  // This should split into TWO passes (both short) because the band ceiling
  // is exclusive.
  const a = constantPass(EPOCH, 20, 22);
  const overshoot = constantPass(EPOCH + 20 * 60 * 1000 + 1000, 0.1, 28);
  const b = constantPass(EPOCH + 20 * 60 * 1000 + 8000, 18, 22);
  const seq = concat([a, overshoot, b]);
  const passes = detectPasses(seq.times, seq.p01);
  assert.equal(passes.length, 2);
  assert.ok(passes.every((p) => p.status === "short"));
});

test("detectPasses: 9 valid + 1 short in a sequence", () => {
  const segments = [];
  for (let i = 0; i < 9; i++) {
    const t0 = EPOCH + i * 50 * 60 * 1000;
    segments.push(constantPass(t0, 38, 22));
    segments.push(offPeriod(t0 + 38 * 60 * 1000 + 1000, 12));
  }
  // Tenth pass is short (only 20 min).
  segments.push(constantPass(EPOCH + 9 * 50 * 60 * 1000, 20, 22));
  const seq = concat(segments);
  const passes = detectPasses(seq.times, seq.p01);
  assert.equal(passes.length, 10);
  assert.equal(passes.filter((p) => p.status === "valid").length, 9);
  assert.equal(passes.filter((p) => p.status === "short").length, 1);
});

test("cumulativeRuntimeMinutes sums durations only", () => {
  const { times, p01 } = constantPass(EPOCH, 38, 22);
  const passes = detectPasses(times, p01);
  const total = cumulativeRuntimeMinutes(passes);
  assert.ok(Math.abs(total - 38) < 0.1);
});

test("detectPasses: empty input returns []", () => {
  assert.deepEqual(detectPasses([], []), []);
});

test("detectPasses: mismatched array lengths throws", () => {
  assert.throws(() => detectPasses([1, 2, 3], [1, 2]));
});

test("detectPasses: respects config tolerances", () => {
  const { times, p01 } = constantPass(EPOCH, 25, 22);
  const passes = detectPasses(times, p01, {
    ...DEFAULT_PASS_CONFIG,
    min_duration_min: 20,
    max_duration_min: 30,
  });
  assert.equal(passes[0].status, "valid");
});
