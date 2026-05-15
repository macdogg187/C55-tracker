// =============================================================================
// Logic-parameter loader — single source of truth for all tunable thresholds.
//
// The browser (client components) and server code both need access to these
// values, so this module must be importable in both contexts.  The JSON file
// is read synchronously on the server side and falls back to the hard-coded
// defaults when running in the browser (or if the file is absent).
//
// HOW TO UPDATE PARAMS:
//   PUT /api/logic-params  — writes config/logic-params.json at runtime
//   Direct file edit       — edit config/logic-params.json directly, restart dev server
// =============================================================================

export type PartParams = {
  expected_mtbf_minutes?: number;
  inspection_threshold_min?: number;
  failure_threshold_min?: number;
  seal_life_low_min?: number;
  seal_life_high_min?: number;
};

export type LogicParams = {
  active_band_low_kpsi: number;
  active_band_high_kpsi: number;
  pulsation_stdev_kpsi: number;
  rolling_window_min: number;
  gap_off_min: number;

  pass_detection: {
    min_duration_min: number;
    max_duration_min: number;
    intra_pass_gap_min: number;
  };

  stoppage_detection: {
    min_dip_duration_min: number;
    dip_ratio_floor: number;
  };

  run_validation: {
    inter_run_gap_min: number;
    long_pass_count: number;
    short_pass_count: number;
    expected_runs_per_period: number;
    expected_short_runs_per_period: number;
  };

  risk_score: {
    composite_max_factor_weight: number;
    composite_mean_factor_weight: number;
    inspection_proximity_multiplier: number;
    high_stress_exposure_multiplier: number;
    pressure_intensity_multiplier: number;
    pressure_intensity_ceiling_kpsi_per_min: number;
    inferred_failures_multiplier: number;
    inferred_failures_normalizer: number;
    overlife_boost_points: number;
  };

  risk_bands: {
    critical_min: number;
    high_min: number;
    moderate_min: number;
  };

  health_thresholds: {
    critical_mtbf_pct: number;
    watch_mtbf_pct: number;
  };

  parts: Record<string, PartParams>;

  default_mtbf_fallback_minutes: number;

  temp_slope: {
    warn_celsius_per_min: number;
    crit_celsius_per_min: number;
  };
};

export const DEFAULT_LOGIC_PARAMS: LogicParams = {
  active_band_low_kpsi: 15.0,
  active_band_high_kpsi: 30.0,
  pulsation_stdev_kpsi: 2.0,
  rolling_window_min: 10,
  gap_off_min: 5,

  pass_detection: {
    min_duration_min: 34,
    max_duration_min: 40,
    intra_pass_gap_min: 2,
  },

  stoppage_detection: {
    min_dip_duration_min: 3,
    dip_ratio_floor: 0.6,
  },

  run_validation: {
    inter_run_gap_min: 240,
    long_pass_count: 10,
    short_pass_count: 6,
    expected_runs_per_period: 7,
    expected_short_runs_per_period: 1,
  },

  risk_score: {
    composite_max_factor_weight: 0.6,
    composite_mean_factor_weight: 0.4,
    inspection_proximity_multiplier: 0.6,
    high_stress_exposure_multiplier: 1.0,
    pressure_intensity_multiplier: 0.7,
    pressure_intensity_ceiling_kpsi_per_min: 4.0,
    inferred_failures_multiplier: 0.5,
    inferred_failures_normalizer: 5,
    overlife_boost_points: 8,
  },

  risk_bands: {
    critical_min: 80,
    high_min: 60,
    moderate_min: 35,
  },

  health_thresholds: {
    critical_mtbf_pct: 0.85,
    watch_mtbf_pct: 0.60,
  },

  parts: {
    ICVB:   { expected_mtbf_minutes: 10000 },
    HPT:    { expected_mtbf_minutes: 9000,  inspection_threshold_min: 2000,  failure_threshold_min: 2400  },
    OCVB:   { expected_mtbf_minutes: 11000 },
    ICVBS:  { seal_life_low_min: 800, seal_life_high_min: 1200 },
    OCVBS:  { seal_life_low_min: 800, seal_life_high_min: 1200 },
    CVBALL: { seal_life_low_min: 800, seal_life_high_min: 1200 },
    PLG:    { expected_mtbf_minutes: 8000 },
    BUS:    { seal_life_low_min: 800, seal_life_high_min: 1200 },
    PB:     { expected_mtbf_minutes: 15000, inspection_threshold_min: 12000, failure_threshold_min: 14500 },
    BSPB: { seal_life_low_min: 800, seal_life_high_min: 1200 },
    SPRING: { seal_life_low_min: 800, seal_life_high_min: 1200 },
    HVB:    { expected_mtbf_minutes: 12000 },
    CSEAT:  { expected_mtbf_minutes: 6000 },
    IR:     { expected_mtbf_minutes: 6000 },
    CSTEM:  { expected_mtbf_minutes: 6000 },
    OM:     { expected_mtbf_minutes: 18000, inspection_threshold_min: 14000, failure_threshold_min: 17000 },
    TR:     { expected_mtbf_minutes: 20000 },
  },

  default_mtbf_fallback_minutes: 12000,

  temp_slope: {
    warn_celsius_per_min: 0.5,
    crit_celsius_per_min: 1.5,
  },
};

// ---------------------------------------------------------------------------
// Server-side file loader (Node.js only — tree-shaken out of browser bundles)
// ---------------------------------------------------------------------------

let _cached: LogicParams | null = null;

/** Load params from config/logic-params.json, falling back to defaults. */
export function loadLogicParams(): LogicParams {
  if (_cached) return _cached;

  // Guard: skip fs access in browser / edge runtimes.
  if (typeof window !== "undefined" || typeof process === "undefined") {
    return DEFAULT_LOGIC_PARAMS;
  }

  try {
    // Dynamic require keeps this import out of the browser bundle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    const filePath = path.join(process.cwd(), "config", "logic-params.json");
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<LogicParams>;
    _cached = mergeWithDefaults(parsed);
    return _cached;
  } catch {
    return DEFAULT_LOGIC_PARAMS;
  }
}

/** Reload on next call — called after PUT /api/logic-params writes a new file. */
export function invalidateLogicParamsCache(): void {
  _cached = null;
}

function mergeWithDefaults(parsed: Partial<LogicParams>): LogicParams {
  return {
    ...DEFAULT_LOGIC_PARAMS,
    ...parsed,
    pass_detection: { ...DEFAULT_LOGIC_PARAMS.pass_detection, ...parsed.pass_detection },
    stoppage_detection: { ...DEFAULT_LOGIC_PARAMS.stoppage_detection, ...parsed.stoppage_detection },
    run_validation: { ...DEFAULT_LOGIC_PARAMS.run_validation, ...parsed.run_validation },
    risk_score:     { ...DEFAULT_LOGIC_PARAMS.risk_score,     ...parsed.risk_score },
    risk_bands:     { ...DEFAULT_LOGIC_PARAMS.risk_bands,     ...parsed.risk_bands },
    health_thresholds: { ...DEFAULT_LOGIC_PARAMS.health_thresholds, ...parsed.health_thresholds },
    temp_slope: { ...DEFAULT_LOGIC_PARAMS.temp_slope, ...parsed.temp_slope },
    parts: {
      ...DEFAULT_LOGIC_PARAMS.parts,
      ...(parsed.parts ?? {}),
    },
  };
}
