// Client-side analytics matching data_pipeline.py exactly.
// Used to recompute Logic Doc tags when the operator tweaks thresholds in the UI
// without forcing a full pipeline re-run.
//
// LOGIC is populated at startup from config/logic-params.json (server) or from
// the hard-coded defaults (browser). Use loadLogicParams() when you need the
// full params object; use LOGIC when you only need the five core constants.

import { loadLogicParams } from "@/lib/logic-params";

const _p = loadLogicParams();

export const LOGIC = {
  ACTIVE_BAND_LOW_KPSI: _p.active_band_low_kpsi,
  ACTIVE_BAND_HIGH_KPSI: _p.active_band_high_kpsi,
  PULSATION_STDEV_KPSI: _p.pulsation_stdev_kpsi,
  ROLLING_WINDOW_MIN: _p.rolling_window_min,
  GAP_OFF_MIN: _p.gap_off_min,
} as const;

export type SampleStatus =
  | "off"
  | "below_active"
  | "active"
  | "high_stress"
  | "out_of_band";

export type FatigueSample = {
  ts: string;        // ISO timestamp
  p01: number;       // pressure in kpsi
  stdev: number;     // rolling 10-min stdev (kpsi)
  status: SampleStatus;
};

export type WindowSpan = {
  start: string;
  end: string;
  duration_min: number;
};

export type BoundarySource =
  | "gap"              // snapped to a detected sensor off-gap
  | "tracker_fallback" // no gap within tolerance; tracker date used as-is
  | "open";            // still installed (no removal date)

export type PartRecord = {
  installation_id: string;
  part_name: string;
  serial_number: string;
  installation_date: string;
  removal_date: string | null;
  /** Effective install date after gap-snapping (may differ from installation_date). */
  effective_installation_date?: string;
  /** Effective removal date after gap-snapping (may differ from removal_date). */
  effective_removal_date?: string | null;
  /** How each boundary was determined. */
  boundary_source?: {
    install: Exclude<BoundarySource, "open">;
    removal: BoundarySource;
  };
  active_runtime_minutes: number;
  high_stress_minutes: number;
  cumulative_pressure_stress: number;
  inferred_failures: number;
  expected_mtbf_minutes: number | null;
  inspection_threshold_min: number | null;
  failure_threshold_min: number | null;
  health: "nominal" | "watch" | "critical";
  alert: "inspection" | "failure" | null;
};

export type RunRecord = {
  run_index: number;
  started_at: string;
  ended_at: string;
  actual_pass_count: number;
  status: string;
};

export type PipelinePayload = {
  generated_at: string;
  sensor_file: string;
  sensor_sha256: string;
  rows_ingested: number;
  summary: {
    active_minutes_total: number;
    high_stress_minutes_total: number;
    off_minutes_total: number;
    out_of_band_minutes: number;
    signals_detected: string[];
    active_band_low_kpsi: number;
    active_band_high_kpsi: number;
    pulsation_threshold_kpsi: number;
    rolling_window: string;
    gap_off_minutes: number;
    sample_minutes: number;
  };
  parts: PartRecord[];
  fatigue_series: FatigueSample[];
  off_windows: WindowSpan[];
  high_stress_windows: WindowSpan[];
  /** Production runs detected by the pass-detection engine. Present when the
   *  trends file was ingested via the TypeScript pipeline (browser upload). */
  runs?: RunRecord[];
};

// Re-tag a sample with the active rule set; lets the UI overlay
// "what would happen if we tightened the band to 20 kpsi?"
export function classifySample(
  p01: number,
  stdev: number,
  cfg = LOGIC,
): SampleStatus {
  if (p01 > cfg.ACTIVE_BAND_HIGH_KPSI) return "out_of_band";
  if (p01 < cfg.ACTIVE_BAND_LOW_KPSI) return "below_active";
  if (stdev > cfg.PULSATION_STDEV_KPSI) return "high_stress";
  return "active";
}

// Bucket a downsampled fatigue series into N evenly-spaced bins for charting.
export function binFatigueSeries(
  series: FatigueSample[],
  bins = 240,
): { ts: string; p01: number; stdev: number; status: SampleStatus }[] {
  if (series.length <= bins) return series;
  const step = Math.max(1, Math.floor(series.length / bins));
  const out: FatigueSample[] = [];
  for (let i = 0; i < series.length; i += step) {
    const slice = series.slice(i, Math.min(i + step, series.length));
    const p01 = slice.reduce((a, s) => a + s.p01, 0) / slice.length;
    const stdev = slice.reduce((a, s) => a + s.stdev, 0) / slice.length;
    // Worst status wins so high-stress is never hidden by averaging
    const rank = { off: 0, below_active: 1, active: 2, out_of_band: 3, high_stress: 4 };
    const status = slice.reduce<SampleStatus>(
      (worst, s) => (rank[s.status] > rank[worst] ? s.status : worst),
      "off",
    );
    out.push({ ts: slice[0].ts, p01, stdev, status });
  }
  return out;
}

// Lifespan progress for a consumable seal (0..1 = nominal, >1 = past life)
export function sealWearFraction(
  activeMinutes: number,
  lifeLow = 800,
  lifeHigh = 1200,
): number {
  if (activeMinutes <= 0) return 0;
  if (activeMinutes >= lifeHigh) return 1;
  if (activeMinutes <= lifeLow) return activeMinutes / lifeLow;
  return 0.5 + (0.5 * (activeMinutes - lifeLow)) / Math.max(1, lifeHigh - lifeLow);
}

export type CumulativeStressPoint = {
  ts: string;
  value: number;
  /** installation_id of the part lifecycle active at this sample, if known. */
  installation_id: string | null;
};

// Running integral of pressure stress above the active floor.
// Returns one CumulativeStressPoint per input sample.  The counter resets
// whenever the sample's timestamp crosses a part installation boundary, so
// each lifecycle starts from 0 — making the value directly comparable to
// that part's per-lifecycle inspection/failure thresholds.
//
// If parts is omitted the counter never resets (legacy behaviour).
export function computeCumulativeStress(
  series: FatigueSample[],
  activeFloor = LOGIC.ACTIVE_BAND_LOW_KPSI,
  parts?: PartRecord[],
): CumulativeStressPoint[] {
  // Build sorted lifecycle windows from parts (most recent first for fast lookup).
  type LifeWin = { installMs: number; removalMs: number; id: string; rate: number };
  const windows: LifeWin[] = [];
  if (parts && parts.length > 0) {
    for (const p of parts) {
      const installMs = new Date(
        p.effective_installation_date ?? p.installation_date,
      ).getTime();
      const removalMs = (p.effective_removal_date ?? p.removal_date)
        ? new Date((p.effective_removal_date ?? p.removal_date)!).getTime()
        : Infinity;
      // kpsi-min per active-minute: used to express threshold in same units as cumulative value.
      const rate =
        p.active_runtime_minutes > 0
          ? p.cumulative_pressure_stress / p.active_runtime_minutes
          : null;
      if (Number.isFinite(installMs)) {
        windows.push({ installMs, removalMs, id: p.installation_id, rate: rate ?? 0 });
      }
    }
    windows.sort((a, b) => a.installMs - b.installMs);
  }

  function activePartAt(tsMs: number): LifeWin | null {
    for (let i = windows.length - 1; i >= 0; i--) {
      if (tsMs >= windows[i].installMs && tsMs <= windows[i].removalMs) {
        return windows[i];
      }
    }
    return null;
  }

  let cumulative = 0;
  let lastInstallId: string | null = null;

  return series.map((s, i) => {
    const tsMs = new Date(s.ts).getTime();
    const win = activePartAt(tsMs);

    // Reset cumulative counter when we enter a new lifecycle.
    if (win && win.id !== lastInstallId) {
      cumulative = 0;
      lastInstallId = win.id;
    }

    if (i > 0) {
      const dtMs = tsMs - new Date(series[i - 1].ts).getTime();
      const dtMin = dtMs / 60_000;
      if (dtMin <= LOGIC.GAP_OFF_MIN * 6) {
        cumulative += Math.max(0, s.p01 - activeFloor) * Math.min(dtMin, LOGIC.GAP_OFF_MIN);
      }
    }

    return { ts: s.ts, value: cumulative, installation_id: win?.id ?? null };
  });
}

// Health badge for the cards
export function healthFor(p: PartRecord): "nominal" | "watch" | "critical" {
  return p.health;
}
