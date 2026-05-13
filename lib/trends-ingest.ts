import "server-only";
import Papa from "papaparse";
import { LOGIC, type WindowSpan } from "@/lib/analytics";
import {
  resolveLifecycleBoundaries,
  type OffGap,
} from "@/lib/lifecycle-boundaries";
import {
  DEFAULT_PASS_CONFIG,
  detectPasses,
  cumulativeRuntimeMinutes,
  type Pass,
} from "@/lib/pass-detect";
import {
  validateRuns,
  type ProductionRun,
  type ScheduleAnomaly,
} from "@/lib/run-validate";

// =============================================================================
// VantagePoint trends CSV ingestor — TS twin of `data_pipeline.py` so an
// operator can drop a CSV through the browser and have it merged into the
// LifecycleStore on the spot (no Python required).
//
// Outputs metrics per active lifecycle window (active runtime, high-stress
// minutes, cumulative pressure-stress, inferred off-window failures) AND
// global trend artefacts (off windows, high-stress windows, fatigue series)
// so the dashboard can render them immediately.
// =============================================================================

// Canonical alias map for the supported telemetry trends. Each alias is the
// header text after lower-casing + replacing whitespace with underscores. The
// taxonomy mirrors the schema's sensor_sample.signal check constraint.
//
//   P01   Homogenizing pressure (transducer at outlet manifold), kpsi
//   P02   Applied gas pressure at homogenizing body valve
//   T01   Seal-flush temperature, left
//   T02   Seal-flush temperature, middle
//   T03   Seal-flush temperature, right
//   T04   Product loop temperature, pre-heat-exchanger
//   T05   Product loop temperature, post-heat-exchanger
const SIGNAL_ALIASES: Record<string, string[]> = {
  P01: [
    "p01", "pressure_01", "pressure", "psi", "homogenizing_pressure",
    "outlet_pressure", "outlet_manifold_pressure",
  ],
  P02: [
    "p02", "pressure_02", "back_pressure", "applied_gas_pressure",
    "homogenizing_valve_pressure", "hvb_pressure",
  ],
  T01: [
    "t01", "temp_01", "temperature_01", "seal_flush_left",
    "seal_flush_temp_left", "left_seal_temp", "inlet_temp",
  ],
  T02: [
    "t02", "temp_02", "temperature_02", "seal_flush_middle",
    "seal_flush_temp_middle", "middle_seal_temp", "outlet_temp",
  ],
  T03: [
    "t03", "temp_03", "temperature_03", "seal_flush_right",
    "seal_flush_temp_right", "right_seal_temp",
  ],
  T04: [
    "t04", "temp_04", "temperature_04", "pre_hx_temp", "pre_heat_exchanger_temp",
    "product_loop_pre_hx", "preheat_temp",
  ],
  T05: [
    "t05", "temp_05", "temperature_05", "post_hx_temp", "post_heat_exchanger_temp",
    "product_loop_post_hx", "postheat_temp",
  ],
  FLOW: ["flow", "flow_rate", "lpm", "gpm"],
  RPM: ["rpm", "speed", "motor_speed"],
  VIB: ["vib", "vibration", "g_rms", "ips"],
};

export type SensorSample = {
  ts: number;        // unix ms
  P01: number;       // kpsi
  P02?: number;
  T01?: number;
  T02?: number;
  T03?: number;
  T04?: number;
  T05?: number;
  FLOW?: number;
  RPM?: number;
  VIB?: number;
  rolling_stdev: number;
  status: "below_active" | "active" | "high_stress" | "out_of_band";
};

export type TaggedSeries = {
  samples: SensorSample[];
  signalsDetected: string[];
  sampleMinutes: number;
};

export type LifecycleWindow = {
  installation_id: string;
  installation_date: string;   // ISO — tracker-entered date
  removal_date: string | null; // ISO — tracker-entered date (null = still installed)
};

export type LifecycleMetrics = {
  installation_id: string;
  active_runtime_minutes: number;
  high_stress_minutes: number;
  out_of_band_minutes: number;
  cumulative_pressure_stress: number;
  inferred_failures: number;
  effective_installation_date: string;
  effective_removal_date: string | null;
  boundary_source: {
    install: "gap" | "tracker_fallback";
    removal: "gap" | "tracker_fallback" | "open";
  };
};

export type PassSummary = {
  started_at: string;
  ended_at: string;
  duration_min: number;
  peak_p01_kpsi: number;
  avg_p01_kpsi: number;
  status: "valid" | "short" | "long";
  pass_index: number;
};

export type RunSummary = {
  run_index: number;
  started_at: string;
  ended_at: string;
  expected_pass_count: number | null;
  actual_pass_count: number;
  status: "conforming" | "short" | "long" | "unknown_schedule";
  pass_indices: number[];
};

export type ScheduleAnomalySummary = {
  run_index: number;
  started_at: string;
  ended_at: string;
  detail: string;
};

export type TrendsIngestResult = {
  generated_at: string;
  sensor_file: string;
  rows_ingested: number;
  signals: string[];
  sample_minutes: number;
  summary: {
    active_minutes_total: number;
    high_stress_minutes_total: number;
    off_minutes_total: number;
    out_of_band_minutes: number;
    active_band_low_kpsi: number;
    active_band_high_kpsi: number;
    pulsation_threshold_kpsi: number;
    rolling_window: string;
    gap_off_minutes: number;
    sample_minutes: number;
    signals_detected: string[];
    passes_total: number;
    valid_passes_total: number;
    pass_runtime_minutes_total: number;
    runs_total: number;
    conforming_runs_total: number;
    schedule_anomalies_total: number;
  };
  off_windows: WindowSpan[];
  high_stress_windows: WindowSpan[];
  fatigue_series: { ts: string; p01: number; stdev: number; status: string; t01: number | null; t02: number | null; t03: number | null }[];
  lifecycle_metrics: LifecycleMetrics[];
  passes: PassSummary[];
  runs: RunSummary[];
  schedule_anomalies: ScheduleAnomalySummary[];
};

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

type RawRow = Record<string, string>;

// Strip the "(kpsi)" / "(DEG C)" / "(PSI)" units block off the end of a
// header and lower-case + underscore-collapse the rest so we can match it
// against SIGNAL_ALIASES.
function normaliseHeader(header: string): string {
  return header
    .replace(/\([^)]*\)/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function detectSignalColumns(headers: string[]): Record<string, string> {
  // Two-pass match. The pass 1 exact-match catches simple headers like
  // "P01" / "pressure". Pass 2 is a permissive prefix match that handles
  // VantagePoint exports where the header is "P01_0091 (kpsi)" — we strip
  // the units, then ask "does the lowercase header start with any known
  // alias?". This is intentionally greedy because the equipment suffix
  // (_0091) is variable per machine.
  const norm: { orig: string; norm: string }[] = headers.map((h) => ({
    orig: h,
    norm: normaliseHeader(h),
  }));

  const found: Record<string, string> = {};

  for (const [canon, aliases] of Object.entries(SIGNAL_ALIASES)) {
    const all = [canon.toLowerCase(), ...aliases];
    // Pass 1: exact match.
    for (const { orig, norm: n } of norm) {
      if (all.includes(n)) {
        found[canon] = orig;
        break;
      }
    }
    if (found[canon]) continue;
    // Pass 2: prefix match (handles "p01_0091" -> "p01").
    for (const { orig, norm: n } of norm) {
      for (const alias of all) {
        if (n === alias || n.startsWith(`${alias}_`) || n.startsWith(`${alias}-`)) {
          found[canon] = orig;
          break;
        }
      }
      if (found[canon]) break;
    }
  }
  return found;
}

function detectTimestampColumn(headers: string[]): string | null {
  for (const h of headers) {
    const low = normaliseHeader(h);
    if (low === "timestamp" || low === "time" || low === "datetime" || low === "date_time") {
      return h;
    }
  }
  return null;
}

function parseNumber(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
}

// US-locale `M/D/YYYY h:mm:ss[.fff] AM|PM`. JS's built-in Date parser is
// inconsistent across runtimes for this format, so we parse manually.
function parseUsLocaleDate(raw: string): number {
  const m = raw.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,4}))?\s*(AM|PM)?$/i,
  );
  if (!m) return Number.NaN;
  const month = Number(m[1]);
  const day = Number(m[2]);
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  let hour = Number(m[4]);
  const min = Number(m[5]);
  const sec = Number(m[6]);
  const ms = m[7] ? Number((m[7] + "000").slice(0, 3)) : 0;
  const meridiem = m[8]?.toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  // Use UTC to avoid host-timezone-driven offsets — the VantagePoint
  // export omits a zone, so the UI must show the operator the same wall
  // clock that the file holds.
  return Date.UTC(year, month - 1, day, hour, min, sec, ms);
}

function parseTimestamp(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return Number.NaN;
  // Prefer the US-locale parser when the string starts with `M/D/YYYY`.
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(trimmed)) {
    const t = parseUsLocaleDate(trimmed);
    if (Number.isFinite(t)) return t;
  }
  // Otherwise fall back to ISO / generic parsing.
  const d = new Date(trimmed);
  return d.getTime();
}

// VantagePoint emits its files as UTF-16 LE with a BOM. The legacy
// fixture lives as plain UTF-8. Sniff the BOM, decode accordingly.
export function decodeTrendsBuffer(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  // Strip UTF-8 BOM if present.
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  return new TextDecoder("utf-8").decode(bytes);
}

// ---------------------------------------------------------------------------
// Logic Doc analytics
// ---------------------------------------------------------------------------

function rollingStdev(values: number[], times: number[], windowMs: number): number[] {
  // Trailing window: include all samples whose ts in [now-windowMs, now].
  const out = new Array<number>(values.length).fill(0);
  let left = 0;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    sumSq += values[i] * values[i];
    count += 1;
    while (left < i && times[i] - times[left] > windowMs) {
      sum -= values[left];
      sumSq -= values[left] * values[left];
      count -= 1;
      left += 1;
    }
    if (count < 2) {
      out[i] = 0;
      continue;
    }
    const mean = sum / count;
    const variance = Math.max(0, sumSq / count - mean * mean);
    // Bessel-corrected sample stdev to match pandas default ddof=1.
    out[i] = Math.sqrt(variance * (count / Math.max(1, count - 1)));
  }
  return out;
}

function estimateSampleMinutes(times: number[]): number {
  if (times.length < 2) return 1;
  const diffs: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const d = (times[i] - times[i - 1]) / 60_000;
    if (d > 0) diffs.push(d);
  }
  if (!diffs.length) return 1;
  diffs.sort((a, b) => a - b);
  const mid = diffs[Math.floor(diffs.length / 2)];
  return mid > 0 ? mid : 1;
}

function detectOffWindows(times: number[], gapMin: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 1; i < times.length; i++) {
    const minutes = (times[i] - times[i - 1]) / 60_000;
    if (minutes > gapMin) out.push([times[i - 1], times[i]]);
  }
  return out;
}

function tagSamples(times: number[], p01: number[]): {
  status: SensorSample["status"][];
  stdev: number[];
  isActive: Uint8Array;
  isHighStress: Uint8Array;
  isOutOfBand: Uint8Array;
} {
  const windowMs = LOGIC.ROLLING_WINDOW_MIN * 60_000;
  const stdev = rollingStdev(p01, times, windowMs);
  const status: SensorSample["status"][] = new Array(p01.length);
  const isActive = new Uint8Array(p01.length);
  const isHighStress = new Uint8Array(p01.length);
  const isOutOfBand = new Uint8Array(p01.length);

  for (let i = 0; i < p01.length; i++) {
    const v = p01[i];
    if (v > LOGIC.ACTIVE_BAND_HIGH_KPSI) {
      status[i] = "out_of_band";
      isOutOfBand[i] = 1;
    } else if (v >= LOGIC.ACTIVE_BAND_LOW_KPSI && v <= LOGIC.ACTIVE_BAND_HIGH_KPSI) {
      if (stdev[i] > LOGIC.PULSATION_STDEV_KPSI) {
        status[i] = "high_stress";
        isHighStress[i] = 1;
      } else {
        status[i] = "active";
        isActive[i] = 1;
      }
    } else {
      status[i] = "below_active";
    }
  }
  return { status, stdev, isActive, isHighStress, isOutOfBand };
}

function collapseStatusWindows(
  times: number[],
  status: SensorSample["status"][],
  target: SensorSample["status"],
): [number, number][] {
  const out: [number, number][] = [];
  const n = times.length;
  let i = 0;
  while (i < n) {
    if (status[i] !== target) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && status[j + 1] === target) j++;
    out.push([times[i], times[j]]);
    i = j + 1;
  }
  return out;
}

function toWindowSpan(pair: [number, number]): WindowSpan {
  const [s, e] = pair;
  return {
    start: new Date(s).toISOString(),
    end: new Date(e).toISOString(),
    duration_min: Math.round((e - s) / 60_000),
  };
}

/**
 * Prefer-active thinning: keep a dense sample of active/high_stress/out_of_band
 * points (where every measurement counts for fatigue analysis) and fill the
 * remaining quota with uniformly-strided below_active points for context.
 *
 * maxPoints raised to 3000 from the old 1500 so the fatigue chart renders
 * ~15× more detail during run time on the next upload/pipeline run.
 */
type ThinRow = {
  ts: string;
  p01: number;
  stdev: number;
  status: string;
  t01: number | null;
  t02: number | null;
  t03: number | null;
};

function thinSeries(
  times: number[],
  p01: number[],
  stdev: number[],
  status: SensorSample["status"][],
  temps: { T01?: number[]; T02?: number[]; T03?: number[] },
  maxPoints = 3000,
): ThinRow[] {
  function makeRow(i: number): ThinRow {
    return {
      ts: new Date(times[i]).toISOString(),
      p01: p01[i],
      stdev: stdev[i],
      status: status[i],
      t01: temps.T01 ? (temps.T01[i] ?? null) : null,
      t02: temps.T02 ? (temps.T02[i] ?? null) : null,
      t03: temps.T03 ? (temps.T03[i] ?? null) : null,
    };
  }

  if (times.length <= maxPoints) {
    return times.map((_, i) => makeRow(i));
  }

  // Partition indices into active vs. inactive.
  const activeIdx: number[] = [];
  const inactiveIdx: number[] = [];
  for (let i = 0; i < times.length; i++) {
    if (status[i] === "below_active") {
      inactiveIdx.push(i);
    } else {
      activeIdx.push(i);
    }
  }

  // Budget: reserve up to 80% of maxPoints for active samples; fill the rest
  // with inactive context so the chart can still show the band boundaries.
  const activeQuota = Math.min(activeIdx.length, Math.floor(maxPoints * 0.8));
  const inactiveQuota = maxPoints - activeQuota;

  // Thin each bucket uniformly.
  function strideSelect(indices: number[], quota: number): number[] {
    if (indices.length <= quota) return indices;
    const step = indices.length / quota;
    const out: number[] = [];
    for (let k = 0; k < quota; k++) {
      out.push(indices[Math.floor(k * step)]);
    }
    return out;
  }

  const keptActive = strideSelect(activeIdx, activeQuota);
  const keptInactive = strideSelect(inactiveIdx, inactiveQuota);

  // Merge back in chronological order.
  const kept = [...keptActive, ...keptInactive].sort((a, b) => a - b);

  return kept.map((i) => makeRow(i));
}

function overlapMinutes(a0: number, a1: number, b0: number, b1: number): number {
  const start = Math.max(a0, b0);
  const end = Math.min(a1, b1);
  return Math.max(0, (end - start) / 60_000);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseTrendsCsv(text: string): {
  times: number[];
  signals: Record<string, number[]>;
  signalsDetected: string[];
} {
  const result = Papa.parse<RawRow>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  // Don't bail on parse errors — Papa records "delimiter mismatch" warnings
  // on otherwise-recoverable rows; only treat an empty data array as fatal.
  const rows = result.data;
  if (!rows.length) throw new Error("trends file is empty");

  const headers = result.meta.fields ?? [];
  const tsCol = detectTimestampColumn(headers);
  if (!tsCol) {
    throw new Error(
      `trends file must include a timestamp column (got ${JSON.stringify(headers)})`,
    );
  }
  const signalCols = detectSignalColumns(headers);
  if (!signalCols.P01) {
    throw new Error(
      `trends file must include a P01 (pressure) column (got ${JSON.stringify(headers)})`,
    );
  }

  const times: number[] = [];
  const cols: Record<string, number[]> = {};
  for (const sig of Object.keys(signalCols)) cols[sig] = [];

  for (const row of rows) {
    const rawTs = row[tsCol];
    if (!rawTs) continue;
    const t = parseTimestamp(rawTs);
    if (!Number.isFinite(t)) continue;
    const sample: Record<string, number> = {};
    let bad = false;
    for (const [sig, col] of Object.entries(signalCols)) {
      const raw = row[col];
      const n = raw === undefined ? Number.NaN : parseNumber(raw);
      if (sig === "P01" && !Number.isFinite(n)) {
        bad = true;
        break;
      }
      sample[sig] = n;
    }
    if (bad) continue;
    times.push(t);
    for (const sig of Object.keys(signalCols)) {
      cols[sig].push(sample[sig]);
    }
  }

  if (!times.length) throw new Error("trends file had no parseable rows with P01");

  // Sort by timestamp + dedupe (last value wins) like pandas drop_duplicates.
  const order = times.map((t, i) => [t, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const seen = new Map<number, number>();
  for (const [t, i] of order) seen.set(t, i);  // last writer wins
  const sortedIdx = [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, i]) => i);

  const outTimes: number[] = [];
  const outCols: Record<string, number[]> = {};
  for (const sig of Object.keys(cols)) outCols[sig] = [];
  for (const i of sortedIdx) {
    outTimes.push(times[i]);
    for (const sig of Object.keys(cols)) outCols[sig].push(cols[sig][i]);
  }

  // Per-signal unit normalisation. VantagePoint exports P01 sometimes as
  // raw psi, sometimes as kpsi — we infer from the median. P02 is "applied
  // gas pressure" and stays in its native units (typically PSI but small
  // enough not to need conversion).
  const p01sorted = outCols.P01.slice().sort((a, b) => a - b);
  const p01median = p01sorted.length ? p01sorted[Math.floor(p01sorted.length / 2)] : 0;
  if (p01median > 1000) {
    outCols.P01 = outCols.P01.map((v) => v / 1000);
  }

  return {
    times: outTimes,
    signals: outCols,
    signalsDetected: Object.keys(signalCols).sort(),
  };
}

export function computeTrendsMetrics(
  parsed: ReturnType<typeof parseTrendsCsv>,
  lifecycleWindows: LifecycleWindow[],
  sourceFileName: string,
): TrendsIngestResult {
  const { times, signals, signalsDetected } = parsed;
  const p01 = signals.P01;

  const sampleMin = estimateSampleMinutes(times);
  const { status, stdev, isActive, isHighStress, isOutOfBand } = tagSamples(times, p01);
  const offGaps = detectOffWindows(times, LOGIC.GAP_OFF_MIN);
  const highStress = collapseStatusWindows(times, status, "high_stress");

  let activeTotal = 0;
  let stressTotal = 0;
  let outOfBandTotal = 0;
  for (let i = 0; i < times.length; i++) {
    if (isActive[i]) activeTotal++;
    if (isHighStress[i]) stressTotal++;
    if (isOutOfBand[i]) { activeTotal++; outOfBandTotal++; }
  }

  const sensorMaxMs = times.length ? times[times.length - 1] : Date.now();

  // Resolve effective install/removal boundaries from gap data.
  const offGapObjects: OffGap[] = offGaps.map(([s, e]) => ({ start: s, end: e }));
  const resolvedBoundaries = resolveLifecycleBoundaries(
    lifecycleWindows.map((w) => ({
      installation_id: w.installation_id,
      tracker_install_ms: new Date(w.installation_date).getTime(),
      tracker_removal_ms: w.removal_date ? new Date(w.removal_date).getTime() : null,
    })),
    offGapObjects,
  );
  const resolvedByInstId = new Map(resolvedBoundaries.map((r) => [r.installation_id, r]));

  const lifecycleMetrics: LifecycleMetrics[] = [];

  for (const win of lifecycleWindows) {
    const resolved = resolvedByInstId.get(win.installation_id);
    const installMs = resolved?.effective_install_ms ?? new Date(win.installation_date).getTime();
    if (!Number.isFinite(installMs)) continue;
    const removalMs =
      resolved && resolved.effective_removal_ms !== null
        ? resolved.effective_removal_ms
        : sensorMaxMs;

    let activeSamples = 0;
    let stressSamples = 0;
    let outOfBandSamples = 0;
    let cumStress = 0;
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      if (t < installMs || t > removalMs) continue;
      if (isActive[i]) activeSamples++;
      if (isHighStress[i]) stressSamples++;
      if (isOutOfBand[i]) { activeSamples++; outOfBandSamples++; }
      if (isActive[i] || isHighStress[i] || isOutOfBand[i]) {
        cumStress += Math.max(0, p01[i] - LOGIC.ACTIVE_BAND_LOW_KPSI);
      }
    }
    let inferred = 0;
    for (const [g0, g1] of offGaps) {
      if (overlapMinutes(g0, g1, installMs, removalMs) > 0) inferred++;
    }
    lifecycleMetrics.push({
      installation_id: win.installation_id,
      active_runtime_minutes: Math.round(activeSamples * sampleMin),
      high_stress_minutes: Math.round(stressSamples * sampleMin),
      out_of_band_minutes: Math.round(outOfBandSamples * sampleMin),
      cumulative_pressure_stress: Math.round(cumStress * sampleMin * 100) / 100,
      inferred_failures: inferred,
      effective_installation_date: new Date(installMs).toISOString(),
      effective_removal_date:
        resolved?.effective_removal_ms != null
          ? new Date(resolved.effective_removal_ms).toISOString()
          : null,
      boundary_source: resolved?.boundary_source ?? {
        install: "tracker_fallback",
        removal: win.removal_date ? "tracker_fallback" : "open",
      },
    });
  }

  const offMinutesTotal = offGaps.reduce(
    (acc, [s, e]) => acc + (e - s) / 60_000,
    0,
  );

  // Pass detection + run validation. The pass cumulative-runtime number is
  // more conservative than the sample-count-based active_minutes_total (it
  // only counts samples that lie inside a 34-40 min contiguous excursion)
  // — exposing both keeps backwards compatibility with the existing
  // dashboard while making the run/pass-aware metric available downstream.
  const passes = detectPasses(times, p01, DEFAULT_PASS_CONFIG);
  const passRuntimeMin = cumulativeRuntimeMinutes(passes);
  const { runs, anomalies } = validateRuns(passes);

  return {
    generated_at: new Date().toISOString(),
    sensor_file: sourceFileName,
    rows_ingested: times.length,
    signals: signalsDetected,
    sample_minutes: sampleMin,
    summary: {
      active_minutes_total: Math.round(activeTotal * sampleMin),
      high_stress_minutes_total: Math.round(stressTotal * sampleMin),
      off_minutes_total: Math.round(offMinutesTotal),
      out_of_band_minutes: Math.round(outOfBandTotal * sampleMin),
      active_band_low_kpsi: LOGIC.ACTIVE_BAND_LOW_KPSI,
      active_band_high_kpsi: LOGIC.ACTIVE_BAND_HIGH_KPSI,
      pulsation_threshold_kpsi: LOGIC.PULSATION_STDEV_KPSI,
      rolling_window: `${LOGIC.ROLLING_WINDOW_MIN}min`,
      gap_off_minutes: LOGIC.GAP_OFF_MIN,
      sample_minutes: sampleMin,
      signals_detected: signalsDetected,
      passes_total: passes.length,
      valid_passes_total: passes.filter((p) => p.status === "valid").length,
      pass_runtime_minutes_total: passRuntimeMin,
      runs_total: runs.length,
      conforming_runs_total: runs.filter((r) => r.status === "conforming").length,
      schedule_anomalies_total: anomalies.length,
    },
    off_windows: offGaps.map(toWindowSpan),
    high_stress_windows: highStress.map(toWindowSpan),
    fatigue_series: thinSeries(times, p01, stdev, status, {
      T01: signals.T01,
      T02: signals.T02,
      T03: signals.T03,
    }),
    lifecycle_metrics: lifecycleMetrics,
    passes: passes.map((p) => passToSummary(p)),
    runs: runs.map((r) => runToSummary(r)),
    schedule_anomalies: anomalies.map((a) => anomalyToSummary(a)),
  };
}

function passToSummary(p: Pass): PassSummary {
  return {
    pass_index: p.pass_index,
    started_at: new Date(p.started_at_ms).toISOString(),
    ended_at: new Date(p.ended_at_ms).toISOString(),
    duration_min: p.duration_min,
    peak_p01_kpsi: p.peak_p01_kpsi,
    avg_p01_kpsi: p.avg_p01_kpsi,
    status: p.status,
  };
}

function runToSummary(r: ProductionRun): RunSummary {
  return {
    run_index: r.run_index,
    started_at: new Date(r.started_at_ms).toISOString(),
    ended_at: new Date(r.ended_at_ms).toISOString(),
    expected_pass_count: r.expected_pass_count,
    actual_pass_count: r.actual_pass_count,
    status: r.status,
    pass_indices: r.pass_indices,
  };
}

function anomalyToSummary(a: ScheduleAnomaly): ScheduleAnomalySummary {
  return {
    run_index: a.run_index,
    started_at: new Date(a.started_at_ms).toISOString(),
    ended_at: new Date(a.ended_at_ms).toISOString(),
    detail: a.detail,
  };
}
