import { LOGIC } from "@/lib/analytics";
import { loadLogicParams } from "@/lib/logic-params";

// =============================================================================
// C55 Pass Detection Engine
//
// A "pass" is a contiguous P01 excursion into the active band (19..26 kpsi)
// that lasts approximately 34..40 minutes. The Logic Doc constants are
// re-used here so a band tweak stays in one place.
//
// Why two-pass detection lives outside trends-ingest:
//   - it is also the input to the biweekly schedule validator (run-validate.ts)
//   - it is small enough to unit-test cleanly with synthetic streams
//   - swapping the heuristic for a real change-point detector later only
//     touches this file
// =============================================================================

export type PassStatus = "valid" | "short" | "long";

export type Pass = {
  pass_index: number;          // 1-based, assigned by detectPasses
  started_at_ms: number;
  ended_at_ms: number;
  duration_min: number;
  peak_p01_kpsi: number;
  avg_p01_kpsi: number;
  sample_count: number;
  status: PassStatus;
};

export type PassDetectionConfig = {
  active_band_low_kpsi: number;
  active_band_high_kpsi: number;
  // Tolerances for what counts as a "valid" pass. Outside these the pass is
  // emitted but tagged as 'short' or 'long' so the validator can distinguish
  // a missing pass from a malformed one.
  min_duration_min: number;
  max_duration_min: number;
  // Maximum gap inside a pass before we consider the pass ended — handles
  // tiny VantagePoint sample-rate hiccups without splitting one pass into two.
  intra_pass_gap_min: number;
};

const _pd = loadLogicParams().pass_detection;

export const DEFAULT_PASS_CONFIG: PassDetectionConfig = {
  active_band_low_kpsi: LOGIC.ACTIVE_BAND_LOW_KPSI,
  active_band_high_kpsi: LOGIC.ACTIVE_BAND_HIGH_KPSI,
  min_duration_min: _pd.min_duration_min,
  max_duration_min: _pd.max_duration_min,
  intra_pass_gap_min: _pd.intra_pass_gap_min,
};

/**
 * Detect 34–40 minute "passes" in a P01 stream.
 *
 * @param times unix-ms timestamps, assumed monotonically non-decreasing
 * @param p01   P01 readings in kpsi, parallel array to `times`
 * @param cfg   optional override for the active band / duration tolerances
 */
export function detectPasses(
  times: number[],
  p01: number[],
  cfg: PassDetectionConfig = DEFAULT_PASS_CONFIG,
): Pass[] {
  if (times.length !== p01.length) {
    throw new Error(
      `detectPasses: times.length=${times.length} != p01.length=${p01.length}`,
    );
  }

  const passes: Pass[] = [];
  const n = times.length;
  if (n === 0) return passes;

  const gapMs = cfg.intra_pass_gap_min * 60_000;
  let i = 0;
  let passIdx = 0;

  while (i < n) {
    // Skip samples that are not in the active band.
    if (
      p01[i] < cfg.active_band_low_kpsi ||
      p01[i] > cfg.active_band_high_kpsi
    ) {
      i++;
      continue;
    }

    // Begin a candidate pass. Extend through contiguous in-band samples,
    // tolerating intra-pass gaps below `intra_pass_gap_min`.
    const startIdx = i;
    let endIdx = i;
    let sum = 0;
    let peak = -Infinity;
    let count = 0;

    while (endIdx < n) {
      const v = p01[endIdx];
      if (v < cfg.active_band_low_kpsi || v > cfg.active_band_high_kpsi) break;
      // Break on any large gap to the next sample — keeps two distinct passes
      // that happen to bracket a quiet period from being merged.
      if (
        endIdx > startIdx &&
        times[endIdx] - times[endIdx - 1] > gapMs
      ) {
        break;
      }
      sum += v;
      if (v > peak) peak = v;
      count++;
      endIdx++;
    }

    const lastIdx = endIdx - 1;
    const durMin = (times[lastIdx] - times[startIdx]) / 60_000;
    const status: PassStatus =
      durMin < cfg.min_duration_min
        ? "short"
        : durMin > cfg.max_duration_min
          ? "long"
          : "valid";

    passIdx++;
    passes.push({
      pass_index: passIdx,
      started_at_ms: times[startIdx],
      ended_at_ms: times[lastIdx],
      duration_min: Math.round(durMin * 100) / 100,
      peak_p01_kpsi: Math.round(peak * 100) / 100,
      avg_p01_kpsi: count > 0 ? Math.round((sum / count) * 100) / 100 : 0,
      sample_count: count,
      status,
    });

    i = endIdx;
  }

  return passes;
}

/**
 * Sum of all pass durations — used as the canonical "active runtime" when
 * pass-detection is in play. The trends-ingest active-runtime metric is
 * sample-count-based, which can over-count brief band excursions; this one
 * tracks completed passes only.
 */
export function cumulativeRuntimeMinutes(passes: Pass[]): number {
  return Math.round(
    passes.reduce((acc, p) => acc + p.duration_min, 0) * 100,
  ) / 100;
}
