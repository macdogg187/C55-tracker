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

/** Build a stream at 1-Hz with arbitrary pressure segments. */
function buildStream(
  ...segments: { durationMin: number; p01Kpsi: number }[]
): { times: number[]; p01: number[] } {
  const times: number[] = [];
  const p01: number[] = [];
  let t = EPOCH;
  for (const seg of segments) {
    const n = Math.floor(seg.durationMin * 60);
    for (let i = 0; i <= n; i++) {
      times.push(t);
      p01.push(seg.p01Kpsi);
      t += 1000;
    }
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

test("detectPasses: 45-min pass with no stoppage stays long", () => {
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
  // 20 min at 22 kpsi -> 5s overshoot to 31 kpsi (above ceiling) -> 18 more min at 22 kpsi.
  // This should split into TWO passes (both short) because the band ceiling
  // is exclusive.
  const a = constantPass(EPOCH, 20, 22);
  const overshoot = constantPass(EPOCH + 20 * 60 * 1000 + 1000, 0.1, 31);
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

// ---------------------------------------------------------------------------
// Stoppage sub-division: long passes are split at hidden stoppages
// ---------------------------------------------------------------------------

test("subdivide: long pass with below-band stoppage splits into two valid passes", () => {
  // 20 min at 22 kpsi -> 5 min at 5 kpsi -> 20 min at 22 kpsi
  // The 5 kpsi dip is below active_band_low (15), so the initial detector
  // splits naturally into two 20-min passes. Both are short (< 34 min).
  const a = constantPass(EPOCH, 20, 22);
  const dip = constantPass(EPOCH + 20 * 60 * 1000 + 1000, 5, 5);
  const b = constantPass(EPOCH + 25 * 60 * 1000 + 2000, 20, 22);
  const seq = concat([a, dip, b]);
  const passes = detectPasses(seq.times, seq.p01);
  assert.equal(passes.length, 2);
  assert.ok(passes.every((p) => p.status === "short"));
});

test("subdivide: long pass with wide-band stoppage splits via dip_ratio_floor", () => {
  // With active band [10, 30], avg_p01 ≈ 21.1, dip_ratio_floor = 0.6:
  // floor = 21.1 * 0.6 ≈ 12.66 kpsi. A 4-min dip to 12 kpsi is in-band
  // (12 >= 10) but below 12.66 → triggers sub-division.
  const stream = buildStream(
    { durationMin: 20, p01Kpsi: 22 },
    { durationMin: 4, p01Kpsi: 12 },  // in-band but below dip floor
    { durationMin: 20, p01Kpsi: 22 },
  );
  const passes = detectPasses(stream.times, stream.p01, {
    ...DEFAULT_PASS_CONFIG,
    active_band_low_kpsi: 10,
    max_duration_min: 40,
    stoppage_detection: {
      min_dip_duration_min: 3,
      dip_ratio_floor: 0.6,  // floor ≈ 21.1 * 0.6 ≈ 12.66; 12 < 12.66 → split
    },
  });
  assert.equal(passes.length, 2);
  // Sub-passes are 20 and ~24 min — both short (< 34 min).
  assert.ok(passes.every((p) => p.status === "short"));
});

test("subdivide: dip above dip_ratio_floor does not split", () => {
  // Same band [10, 30], avg ≈ 22, floor = 13.2. A 4-min dip to 14 kpsi
  // is above 13.2 → no split. The pass stays long.
  const stream = buildStream(
    { durationMin: 20, p01Kpsi: 22 },
    { durationMin: 4, p01Kpsi: 14 },  // above dip floor 13.2
    { durationMin: 20, p01Kpsi: 22 },
  );
  const passes = detectPasses(stream.times, stream.p01, {
    ...DEFAULT_PASS_CONFIG,
    active_band_low_kpsi: 10,
    max_duration_min: 40,
    stoppage_detection: {
      min_dip_duration_min: 3,
      dip_ratio_floor: 0.6,
    },
  });
  assert.equal(passes.length, 1);
  assert.equal(passes[0].status, "long");
});

test("subdivide: in-band sag above dip floor does not split", () => {
  // 42 min all in [15, 30] with a 2-min sag to 16 kpsi.
  // dip_ratio_floor = 0.6, floor = 15 * 0.6 = 9. Since 16 > 9, no split.
  const stream = buildStream(
    { durationMin: 20, p01Kpsi: 22 },
    { durationMin: 2, p01Kpsi: 16 },
    { durationMin: 20, p01Kpsi: 22 },
  );
  const passes = detectPasses(stream.times, stream.p01);
  assert.equal(passes.length, 1);
  assert.equal(passes[0].status, "long");
});

test("subdivide: multiple stoppages split into multiple passes", () => {
  // 15 min at 22 -> 3 min at 5 -> 15 min at 22 -> 3 min at 5 -> 15 min at 22
  // Initial detector sees below-band (5 < 15) and splits into 3 passes.
  const a = constantPass(EPOCH, 15, 22);
  const dip1 = constantPass(EPOCH + 15 * 60 * 1000 + 1000, 3, 5);
  const b = constantPass(EPOCH + 18 * 60 * 1000 + 2000, 15, 22);
  const dip2 = constantPass(EPOCH + 33 * 60 * 1000 + 3000, 3, 5);
  const c = constantPass(EPOCH + 36 * 60 * 1000 + 4000, 15, 22);
  const seq = concat([a, dip1, b, dip2, c]);
  const passes = detectPasses(seq.times, seq.p01);
  assert.equal(passes.length, 3);
  assert.ok(passes.every((p) => p.status === "short"));
});

test("subdivide: dip shorter than min_dip_duration does not split", () => {
  // 20 min at 22 -> 2 min at 2 kpsi (with wide band) -> 20 min at 22 kpsi
  // The 2-min dip is below min_dip_duration_min=3, so even though it's
  // below the dip floor, it's too brief to be a stoppage.
  const stream = buildStream(
    { durationMin: 20, p01Kpsi: 22 },
    { durationMin: 2, p01Kpsi: 2 },
    { durationMin: 20, p01Kpsi: 22 },
  );
  const passes = detectPasses(stream.times, stream.p01, {
    ...DEFAULT_PASS_CONFIG,
    active_band_low_kpsi: 0,
    max_duration_min: 40,
    stoppage_detection: {
      min_dip_duration_min: 3,
      dip_ratio_floor: 0.6,
    },
  });
  assert.equal(passes.length, 1);
  assert.equal(passes[0].status, "long");
});

test("subdivide: pass indices are renumbered after splitting", () => {
  // Two passes: one valid, one long (that gets split).
  // The valid pass comes first, then a gap, then a long pass with a stoppage.
  // After sub-division, pass indices should be 1, 2, 3 (sequential).
  const stream = buildStream(
    { durationMin: 38, p01Kpsi: 22 },  // valid pass
    { durationMin: 12, p01Kpsi: 0.1 }, // gap (below band)
    { durationMin: 20, p01Kpsi: 22 },  // start of long pass
    { durationMin: 4, p01Kpsi: 5 },    // stoppage (below band → splits naturally)
    { durationMin: 20, p01Kpsi: 22 },  // end of long pass
  );
  const passes = detectPasses(stream.times, stream.p01);
  assert.ok(passes.length >= 3);
  for (let i = 0; i < passes.length; i++) {
    assert.equal(passes[i].pass_index, i + 1);
  }
});
