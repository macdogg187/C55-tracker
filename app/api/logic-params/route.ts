import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  loadLogicParams,
  invalidateLogicParamsCache,
  DEFAULT_LOGIC_PARAMS,
  type LogicParams,
} from "@/lib/logic-params";

const CONFIG_PATH = path.join(process.cwd(), "config", "logic-params.json");

// ---------------------------------------------------------------------------
// GET /api/logic-params — return the active parameter set
// ---------------------------------------------------------------------------

export async function GET() {
  const params = loadLogicParams();
  return NextResponse.json(params);
}

// ---------------------------------------------------------------------------
// PUT /api/logic-params — validate and persist a full or partial param update
// ---------------------------------------------------------------------------

export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const errors = validateParams(body);
  if (errors.length) {
    return NextResponse.json({ error: "Validation failed", details: errors }, { status: 422 });
  }

  // Merge the incoming partial update onto the current active params.
  const current = loadLogicParams();
  const incoming = body as Partial<LogicParams>;
  const merged: LogicParams = {
    ...current,
    ...incoming,
    pass_detection: { ...current.pass_detection, ...incoming.pass_detection },
    run_validation: { ...current.run_validation, ...incoming.run_validation },
    risk_score:     { ...current.risk_score,     ...incoming.risk_score },
    risk_bands:     { ...current.risk_bands,     ...incoming.risk_bands },
    health_thresholds: { ...current.health_thresholds, ...incoming.health_thresholds },
    parts: { ...current.parts, ...(incoming.parts ?? {}) },
  };

  // Remove the _comment key so we don't corrupt the JSON schema.
  const toWrite = { ...merged } as Record<string, unknown>;
  delete toWrite["_comment"];

  try {
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.writeFile(CONFIG_PATH, JSON.stringify(toWrite, null, 2), "utf-8");
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to write config file", detail: String(err) },
      { status: 500 },
    );
  }

  invalidateLogicParamsCache();
  const updated = loadLogicParams();

  return NextResponse.json({ ok: true, params: updated });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateParams(body: unknown): string[] {
  const errors: string[] = [];
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return ["Body must be a JSON object"];
  }
  const b = body as Record<string, unknown>;

  // Top-level numeric fields
  const topNums: Array<[string, number, number]> = [
    ["active_band_low_kpsi",  0,   100],
    ["active_band_high_kpsi", 0,   100],
    ["pulsation_stdev_kpsi",  0,   50],
    ["rolling_window_min",    1,   120],
    ["gap_off_min",           1,   60],
    ["default_mtbf_fallback_minutes", 1, 100_000],
  ];
  for (const [key, min, max] of topNums) {
    if (key in b) {
      const v = b[key];
      if (typeof v !== "number" || !isFinite(v) || v < min || v > max) {
        errors.push(`${key} must be a number in [${min}, ${max}]`);
      }
    }
  }

  // active_band ordering
  const low  = (b.active_band_low_kpsi  as number | undefined) ?? DEFAULT_LOGIC_PARAMS.active_band_low_kpsi;
  const high = (b.active_band_high_kpsi as number | undefined) ?? DEFAULT_LOGIC_PARAMS.active_band_high_kpsi;
  if (low >= high) {
    errors.push("active_band_low_kpsi must be less than active_band_high_kpsi");
  }

  // pass_detection
  if ("pass_detection" in b) {
    const pd = b.pass_detection as Record<string, unknown>;
    if (typeof pd !== "object" || pd === null) {
      errors.push("pass_detection must be an object");
    } else {
      const minD = numField(pd, "min_duration_min", errors, 1, 60);
      const maxD = numField(pd, "max_duration_min", errors, 1, 120);
      if (minD !== null && maxD !== null && minD >= maxD) {
        errors.push("pass_detection.min_duration_min must be less than max_duration_min");
      }
      numField(pd, "intra_pass_gap_min", errors, 0, 30);
    }
  }

  // run_validation
  if ("run_validation" in b) {
    const rv = b.run_validation as Record<string, unknown>;
    if (typeof rv !== "object" || rv === null) {
      errors.push("run_validation must be an object");
    } else {
      numField(rv, "inter_run_gap_min", errors, 1, 1440);
      numField(rv, "long_pass_count", errors, 1, 100);
      numField(rv, "short_pass_count", errors, 1, 100);
      numField(rv, "expected_runs_per_period", errors, 1, 50);
      numField(rv, "expected_short_runs_per_period", errors, 0, 50);
    }
  }

  // risk_score
  if ("risk_score" in b) {
    const rs = b.risk_score as Record<string, unknown>;
    if (typeof rs !== "object" || rs === null) {
      errors.push("risk_score must be an object");
    } else {
      numField(rs, "composite_max_factor_weight", errors, 0, 1);
      numField(rs, "composite_mean_factor_weight", errors, 0, 1);
      numField(rs, "inspection_proximity_multiplier", errors, 0, 2);
      numField(rs, "high_stress_exposure_multiplier", errors, 0, 2);
      numField(rs, "pressure_intensity_multiplier", errors, 0, 2);
      numField(rs, "pressure_intensity_ceiling_kpsi_per_min", errors, 0.1, 20);
      numField(rs, "inferred_failures_multiplier", errors, 0, 2);
      numField(rs, "inferred_failures_normalizer", errors, 1, 100);
      numField(rs, "overlife_boost_points", errors, 0, 50);
    }
  }

  // risk_bands — must be strictly decreasing
  if ("risk_bands" in b) {
    const rb = b.risk_bands as Record<string, unknown>;
    if (typeof rb !== "object" || rb === null) {
      errors.push("risk_bands must be an object");
    } else {
      const crit = numField(rb, "critical_min", errors, 1, 100);
      const high2 = numField(rb, "high_min", errors, 1, 100);
      const mod  = numField(rb, "moderate_min", errors, 0, 100);
      if (crit !== null && high2 !== null && crit <= high2) {
        errors.push("risk_bands.critical_min must be greater than high_min");
      }
      if (high2 !== null && mod !== null && high2 <= mod) {
        errors.push("risk_bands.high_min must be greater than moderate_min");
      }
    }
  }

  // health_thresholds
  if ("health_thresholds" in b) {
    const ht = b.health_thresholds as Record<string, unknown>;
    if (typeof ht !== "object" || ht === null) {
      errors.push("health_thresholds must be an object");
    } else {
      const crit = numField(ht, "critical_mtbf_pct", errors, 0, 1);
      const watch = numField(ht, "watch_mtbf_pct", errors, 0, 1);
      if (crit !== null && watch !== null && crit <= watch) {
        errors.push("health_thresholds.critical_mtbf_pct must be greater than watch_mtbf_pct");
      }
    }
  }

  // parts: each entry must have valid numeric fields
  if ("parts" in b) {
    const parts = b.parts as Record<string, unknown>;
    if (typeof parts !== "object" || parts === null) {
      errors.push("parts must be an object");
    } else {
      for (const [code, entry] of Object.entries(parts)) {
        if (typeof entry !== "object" || entry === null) {
          errors.push(`parts.${code} must be an object`);
          continue;
        }
        const pe = entry as Record<string, unknown>;
        const optNum = (key: string, min: number, max: number) => {
          if (key in pe) numField(pe, key, errors, min, max, `parts.${code}.${key}`);
        };
        optNum("expected_mtbf_minutes", 1, 1_000_000);
        optNum("inspection_threshold_min", 1, 1_000_000);
        optNum("failure_threshold_min", 1, 1_000_000);
        optNum("seal_life_low_min", 1, 100_000);
        optNum("seal_life_high_min", 1, 100_000);
      }
    }
  }

  return errors;
}

function numField(
  obj: Record<string, unknown>,
  key: string,
  errors: string[],
  min: number,
  max: number,
  label?: string,
): number | null {
  if (!(key in obj)) return null;
  const v = obj[key];
  const name = label ?? key;
  if (typeof v !== "number" || !isFinite(v) || v < min || v > max) {
    errors.push(`${name} must be a finite number in [${min}, ${max}]`);
    return null;
  }
  return v;
}
