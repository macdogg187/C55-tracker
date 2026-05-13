// Client-side analytics matching data_pipeline.py exactly.
// Used to recompute Logic Doc tags when the operator tweaks thresholds in the UI
// without forcing a full pipeline re-run.

export const LOGIC = {
  ACTIVE_BAND_LOW_KPSI: 19.0,
  ACTIVE_BAND_HIGH_KPSI: 26.0,
  PULSATION_STDEV_KPSI: 2.0,
  ROLLING_WINDOW_MIN: 10,
  GAP_OFF_MIN: 5,
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

export type PartRecord = {
  installation_id: string;
  part_name: string;
  serial_number: string;
  installation_date: string;
  removal_date: string | null;
  active_runtime_minutes: number;
  high_stress_minutes: number;
  cumulative_pressure_stress: number;
  inferred_failures: number;
  expected_mtbf_minutes: number;
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

// Health badge for the cards
export function healthFor(p: PartRecord): "nominal" | "watch" | "critical" {
  return p.health;
}
