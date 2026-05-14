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

export type StoppageDetectionConfig = {
  // Minimum duration a pressure dip must last to be considered a stoppage
  // within a long pass (shorter dips are treated as sensor noise). This is
  // intentionally longer than intra_pass_gap_min because a genuine stoppage
  // involves the process ramping down and back up, which takes several minutes.
  min_dip_duration_min: number;
  // Fractional pressure drop threshold relative to the pass average: if P01
  // drops below avg_p01_kpsi * dip_ratio_floor during a long pass, the dip is
  // classified as a stoppage. For example, with a pass averaging 22 kpsi and
  // ratio 0.6, any dip below 13.2 kpsi that lasts >= min_dip_duration_min
  // triggers a split. This catches "soft landings" where pressure bleeds off
  // but never fully drops below the active band floor.
  dip_ratio_floor: number;
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
  // When a pass exceeds max_duration_min, subdivide it by looking for hidden
  // stoppages. No real pass exceeds 40 min — a "long" pass always means the
  // detector merged two passes across an undetected pause.
  stoppage_detection: StoppageDetectionConfig;
};

const _pd = loadLogicParams().pass_detection;
const _sd = loadLogicParams().stoppage_detection;

export const DEFAULT_PASS_CONFIG: PassDetectionConfig = {
  active_band_low_kpsi: LOGIC.ACTIVE_BAND_LOW_KPSI,
  active_band_high_kpsi: LOGIC.ACTIVE_BAND_HIGH_KPSI,
  min_duration_min: _pd.min_duration_min,
  max_duration_min: _pd.max_duration_min,
  intra_pass_gap_min: _pd.intra_pass_gap_min,
  stoppage_detection: {
    min_dip_duration_min: _sd.min_dip_duration_min,
    dip_ratio_floor: _sd.dip_ratio_floor,
  },
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

  // No real pass exceeds max_duration_min — a "long" pass always means two
  // passes were merged across an undetected stoppage. Re-examine the raw
  // samples of every long pass and split at the deepest dip.
  return subdivideLongPasses(passes, times, p01, cfg);
}

/**
 * Scan long passes for hidden stoppages and split them into shorter passes.
 *
 * A stoppage is identified by a contiguous run of samples where P01 drops
 * below `avg_p01 * dip_ratio_floor` — i.e. the pressure sags to less than a
 * configured fraction of the pass average. For example, with a pass averaging
 * 22 kpsi and ratio 0.6, any dip below 13.2 kpsi lasting >= min_dip_duration_min
 * is a stoppage. This catches both hard drops below the active band floor and
 * "soft landings" where pressure bled off but stayed within the band.
 *
 * The dip must last at least `min_dip_duration_min` to count; shorter dips
 * are treated as sensor noise (already handled by intra_pass_gap_min).
 */
function subdivideLongPasses(
  passes: Pass[],
  times: number[],
  p01: number[],
  cfg: PassDetectionConfig,
): Pass[] {
  const longPasses = passes.filter((p) => p.status === "long");
  if (longPasses.length === 0) return passes;

  const sd = cfg.stoppage_detection;
  const minDipMs = sd.min_dip_duration_min * 60_000;

  const result: Pass[] = [];

  for (const pass of passes) {
    if (pass.status !== "long") {
      result.push(pass);
      continue;
    }

    // The dip floor is relative to this pass's average pressure.
    const dipFloor = pass.avg_p01_kpsi * sd.dip_ratio_floor;

    // Collect the raw sample indices that belong to this pass.
    const startMs = pass.started_at_ms;
    const endMs = pass.ended_at_ms;

    // Find the sample range — binary-search-like scan (the arrays can be
    // large, but we only do this for long passes which are rare).
    let lo = 0;
    while (lo < times.length && times[lo] < startMs) lo++;
    let hi = times.length - 1;
    while (hi > lo && times[hi] > endMs) hi--;

    // Within this pass, find contiguous dips below the stoppage floor.
    const splitPoints: number[] = []; // sample indices where splits should occur
    let j = lo;

    while (j <= hi) {
      if (p01[j] < dipFloor) {
        const dipStart = j;
        let dipEnd = j;
        while (dipEnd <= hi && p01[dipEnd] < dipFloor) dipEnd++;
        dipEnd--; // last below-floor sample

        const dipDurMs = times[dipEnd] - times[dipStart];
        if (dipDurMs >= minDipMs) {
          // Split at the midpoint of the dip: the last above-floor sample
          // before the dip ends the first sub-pass; the first above-floor
          // sample after the dip starts the second.
          splitPoints.push(dipStart);
        }
        j = dipEnd + 1;
      } else {
        j++;
      }
    }

    if (splitPoints.length === 0) {
      // No stoppage found — keep the long tag as-is (rare edge case).
      result.push(pass);
      continue;
    }

    // Re-slice the pass at each stoppage. We walk the sample indices
    // between splitPoints, creating new sub-passes from contiguous
    // in-band runs.
    const boundaries = [lo, ...splitPoints, hi + 1];
    let subIdx = 0;

    for (let b = 0; b < boundaries.length - 1; b++) {
      let segLo = boundaries[b];
      const segHi = boundaries[b + 1];

      // Skip below-floor samples at the start of each segment.
      while (segLo < segHi && p01[segLo] < cfg.active_band_low_kpsi) segLo++;
      // Skip below-floor samples at the end.
      let segEnd = segHi - 1;
      while (segEnd > segLo && p01[segEnd] < cfg.active_band_low_kpsi) segEnd--;

      if (segLo > segEnd) continue;

      // Compute sub-pass from in-band samples in [segLo, segEnd].
      let sum = 0;
      let peak = -Infinity;
      let count = 0;
      let firstInBand = -1;
      let lastInBand = -1;

      for (let k = segLo; k <= segEnd; k++) {
        const v = p01[k];
        if (v >= cfg.active_band_low_kpsi && v <= cfg.active_band_high_kpsi) {
          if (firstInBand === -1) firstInBand = k;
          lastInBand = k;
          sum += v;
          if (v > peak) peak = v;
          count++;
        }
      }

      if (count === 0 || firstInBand === -1) continue;

      const durMin = (times[lastInBand] - times[firstInBand]) / 60_000;
      const status: PassStatus =
        durMin < cfg.min_duration_min
          ? "short"
          : durMin > cfg.max_duration_min
            ? "long"
            : "valid";

      subIdx++;
      result.push({
        pass_index: 0, // renumbered below
        started_at_ms: times[firstInBand],
        ended_at_ms: times[lastInBand],
        duration_min: Math.round(durMin * 100) / 100,
        peak_p01_kpsi: Math.round(peak * 100) / 100,
        avg_p01_kpsi: count > 0 ? Math.round((sum / count) * 100) / 100 : 0,
        sample_count: count,
        status,
      });
    }
  }

  // Renumber pass_index sequentially.
  result.sort((a, b) => a.started_at_ms - b.started_at_ms);
  for (let k = 0; k < result.length; k++) {
    result[k].pass_index = k + 1;
  }

  return result;
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
