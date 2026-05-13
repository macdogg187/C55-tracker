"""C55 Homogenizer data pipeline — unified trends + part run-time tracker.

Implements the analytics rules from the Logic Doc:

  active runtime    : 19,000 psi  ≤ P01 ≤ 26,000 psi  (stored in kpsi: 19..26)
  off / maintenance : any inter-sample gap > GAP_OFF_MIN minutes
  pulsation         : rolling 10-min stdev(P01) > 2,000 psi  ⇒  "high stress"
  out-of-band       : pressure above the active band ceiling

Inputs
------
1. VantagePoint sensor CSV — one row per sample.
   Required column: timestamp, P01.
   Optional 7-trend columns auto-merged when present:
       P01, P02, T01, T02, FLOW, RPM, VIB
   (alias mapping is fuzzy and case-insensitive)

2. MTBF Tracker_cursor.xlsx — fuzzy-matched columns:
       installation_id, part_name, serial_number,
       installation_date, removal_date, expected_mtbf_minutes,
       failure_mode (optional), notes (optional)

Outputs
-------
public/pipeline.json — payload consumed by the Next.js dashboard. Includes:
    parts[]              one record per active lifecycle (with health flags)
    fatigue_series[]     timestamp, p01, rolling stdev, status tag
    high_stress_windows  list of (start, end) where pulsation > 2 kpsi
    off_windows          list of (start, end) for Machine Off / Maintenance
    summary              global KPIs

Run
---
    python data_pipeline.py
    python data_pipeline.py --sensor-csv inbox/latest.csv \\
                            --mtbf-xlsx 'MTBF Tracker_cursor.xlsx'
    python data_pipeline.py --generate-placeholder
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd

# --------------------------------------------------------------------------- #
# Logic Doc constants                                                         #
# --------------------------------------------------------------------------- #

ACTIVE_BAND_LOW_KPSI = 15.0      # 15,000 psi
ACTIVE_BAND_HIGH_KPSI = 30.0     # 30,000 psi
PULSATION_STDEV_KPSI = 2.0       # 2,000 psi rolling-stdev threshold
ROLLING_WINDOW = "10min"         # pulsation evaluation window
GAP_OFF_MIN = 5                  # minutes ⇒ "Machine Off / Maintenance"

# Predictive-alerting thresholds (per part code)
ALERT_INSPECTION_MIN = {"HPT": 2000, "PB": 12000, "OM": 14000}
ALERT_FAILURE_MIN = {"HPT": 2400, "PB": 14500, "OM": 17000}

# Consumable seal life envelope (minutes of *active* runtime)
SEAL_LIFE_LOW_MIN = 800
SEAL_LIFE_HIGH_MIN = 1200

# Fuzzy aliases for the 7 supported trend signals
SIGNAL_ALIASES: dict[str, list[str]] = {
    "P01": ["p01", "pressure_01", "pressure", "psi"],
    "P02": ["p02", "pressure_02", "back_pressure"],
    "T01": ["t01", "temp_01", "temperature_01", "inlet_temp"],
    "T02": ["t02", "temp_02", "temperature_02", "outlet_temp"],
    "FLOW": ["flow", "flow_rate", "lpm", "gpm"],
    "RPM": ["rpm", "speed", "motor_speed"],
    "VIB": ["vib", "vibration", "g_rms", "ips"],
}

DEFAULT_OUTPUT_PATH = Path("public/pipeline.json")
DEFAULT_MTBF_PATH = Path("MTBF Tracker_cursor.xlsx")
DEFAULT_SENSOR_CSV = Path("vantagepoint_sensor.csv")


# --------------------------------------------------------------------------- #
# Data classes                                                                #
# --------------------------------------------------------------------------- #


@dataclass
class WindowSpan:
    start: str
    end: str
    duration_min: int


@dataclass
class PartRecord:
    installation_id: str
    part_name: str
    serial_number: str
    installation_date: str
    removal_date: str | None
    active_runtime_minutes: int
    high_stress_minutes: int
    cumulative_pressure_stress: float
    inferred_failures: int
    expected_mtbf_minutes: int
    inspection_threshold_min: int | None
    failure_threshold_min: int | None
    health: str   # nominal | watch | critical
    alert: str | None  # 'inspection' | 'failure' | None


@dataclass
class PipelinePayload:
    generated_at: str
    sensor_file: str
    sensor_sha256: str
    rows_ingested: int
    summary: dict
    parts: list[PartRecord]
    fatigue_series: list[dict] = field(default_factory=list)
    off_windows: list[WindowSpan] = field(default_factory=list)
    high_stress_windows: list[WindowSpan] = field(default_factory=list)


# --------------------------------------------------------------------------- #
# Loaders                                                                     #
# --------------------------------------------------------------------------- #


def _normalise_signal_columns(df: pd.DataFrame) -> dict[str, str]:
    """Map source CSV columns to canonical signal names where possible."""
    found: dict[str, str] = {}
    lower_to_orig = {c.lower().replace(" ", "_"): c for c in df.columns}
    for canon, aliases in SIGNAL_ALIASES.items():
        for alias in [canon.lower(), *aliases]:
            if alias in lower_to_orig:
                found[canon] = lower_to_orig[alias]
                break
    return found


def load_sensor_csv(path: Path) -> tuple[pd.DataFrame, list[str]]:
    """Load a VantagePoint CSV with auto kpsi/psi detection and 7-trend merge."""
    raw = pd.read_csv(path)
    raw.columns = [c.strip() for c in raw.columns]

    ts_col = next(
        (c for c in raw.columns if c.lower() in {"timestamp", "time", "datetime"}),
        None,
    )
    if ts_col is None:
        raise ValueError("Sensor CSV must contain a timestamp column.")

    raw = raw.rename(columns={ts_col: "timestamp"})
    raw["timestamp"] = pd.to_datetime(raw["timestamp"], errors="coerce", utc=False)
    raw = raw.dropna(subset=["timestamp"]).sort_values("timestamp")
    raw = raw.drop_duplicates(subset=["timestamp"], keep="last").reset_index(drop=True)

    signal_cols = _normalise_signal_columns(raw)
    if "P01" not in signal_cols:
        raise ValueError("Sensor CSV must contain a P01 (pressure) column.")

    out = pd.DataFrame({"timestamp": raw["timestamp"]})
    for canon, src in signal_cols.items():
        out[canon] = pd.to_numeric(raw[src], errors="coerce")

    # Auto kpsi conversion: if median P01 looks like raw psi, scale.
    if out["P01"].median() > 1000:
        out["P01"] = out["P01"] / 1000.0

    out = out.dropna(subset=["P01"]).reset_index(drop=True)
    return out, sorted(signal_cols.keys())


def load_mtbf_tracker(path: Path) -> pd.DataFrame:
    df = pd.read_excel(path, sheet_name=0)
    df.columns = [str(c).strip() for c in df.columns]

    rename_map: dict[str, str] = {}
    for col in df.columns:
        key = col.lower().replace(" ", "_")
        if "install" in key and "id" in key:
            rename_map[col] = "installation_id"
        elif key in {"part", "part_name", "component", "component_name"}:
            rename_map[col] = "part_name"
        elif "serial" in key:
            rename_map[col] = "serial_number"
        elif "install" in key and "date" in key:
            rename_map[col] = "installation_date"
        elif ("removal" in key or "remove" in key) and "date" in key:
            rename_map[col] = "removal_date"
        elif "fail" in key and "mode" in key:
            rename_map[col] = "failure_mode"
        elif "mtbf" in key:
            rename_map[col] = "expected_mtbf_minutes"
        elif key.startswith("runtime"):
            rename_map[col] = "tracker_runtime_minutes"

    df = df.rename(columns=rename_map)

    required = {"installation_id", "part_name", "installation_date"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"MTBF tracker missing columns: {sorted(missing)}")

    df["installation_date"] = pd.to_datetime(df["installation_date"], errors="coerce")
    if "removal_date" in df.columns:
        df["removal_date"] = pd.to_datetime(df["removal_date"], errors="coerce")
    else:
        df["removal_date"] = pd.NaT

    for col in ("serial_number", "failure_mode"):
        if col not in df.columns:
            df[col] = ""

    if "expected_mtbf_minutes" not in df.columns:
        df["expected_mtbf_minutes"] = np.nan

    # Strip canonical-name whitespace mismatches (Excel often has trailing spaces)
    df["part_name"] = df["part_name"].astype(str).str.strip().str.lower()
    df["installation_id"] = df["installation_id"].astype(str).str.strip()

    keep = [
        "installation_id",
        "part_name",
        "serial_number",
        "installation_date",
        "removal_date",
        "expected_mtbf_minutes",
        "failure_mode",
    ]
    return df[keep].dropna(subset=["installation_id", "installation_date"])


# --------------------------------------------------------------------------- #
# Logic Doc analytics                                                         #
# --------------------------------------------------------------------------- #


def estimate_sample_minutes(timestamps: pd.Series) -> float:
    if len(timestamps) < 2:
        return 1.0
    diffs = timestamps.diff().dt.total_seconds()
    median = diffs.median()
    if pd.isna(median) or median <= 0:
        return 1.0
    return float(median / 60.0)


def detect_off_windows(
    timestamps: pd.Series,
    gap_minutes: int = GAP_OFF_MIN,
) -> list[tuple[pd.Timestamp, pd.Timestamp]]:
    """Return list of (gap_start, gap_end) windows flagged as Machine Off / Maint."""
    if timestamps.empty:
        return []
    deltas = timestamps.diff().dt.total_seconds().div(60.0)
    gap_idx = deltas[deltas > gap_minutes].index
    return [(timestamps.iloc[i - 1], timestamps.iloc[i]) for i in gap_idx]


def tag_samples(df: pd.DataFrame) -> pd.DataFrame:
    """
    Annotate each sample with its Logic-Doc status.

    Adds columns:
        rolling_stdev   : stdev(P01) over a 10-min trailing window
        is_active       : within active band AND not high-stress
        is_high_stress  : within active band but stdev > 2 kpsi
        is_out_of_band  : above the active ceiling (>30 kpsi)
        is_below_active : below 15 kpsi (ramp / idle)
        status          : 'active' | 'high_stress' | 'out_of_band'
                          | 'below_active'
    """
    df = df.copy()
    indexed = df.set_index("timestamp").sort_index()

    rolling_std = (
        indexed["P01"]
        .rolling(window=ROLLING_WINDOW, min_periods=2)
        .std()
        .fillna(0.0)
    )
    df["rolling_stdev"] = rolling_std.to_numpy()

    in_band = (df["P01"] >= ACTIVE_BAND_LOW_KPSI) & (df["P01"] <= ACTIVE_BAND_HIGH_KPSI)
    out_band = df["P01"] > ACTIVE_BAND_HIGH_KPSI
    below = df["P01"] < ACTIVE_BAND_LOW_KPSI

    df["is_high_stress"] = in_band & (df["rolling_stdev"] > PULSATION_STDEV_KPSI)
    df["is_active"] = in_band & ~df["is_high_stress"]
    df["is_out_of_band"] = out_band
    df["is_below_active"] = below

    df["status"] = np.select(
        [df["is_high_stress"], df["is_active"], df["is_out_of_band"], df["is_below_active"]],
        ["high_stress", "active", "out_of_band", "below_active"],
        default="below_active",
    )
    return df


def overlap_minutes(a0: pd.Timestamp, a1: pd.Timestamp,
                    b0: pd.Timestamp, b1: pd.Timestamp) -> float:
    start = max(a0, b0)
    end = min(a1, b1)
    return max(0.0, (end - start).total_seconds() / 60.0)


def collapse_status_windows(
    df: pd.DataFrame,
    target_status: str,
) -> list[tuple[pd.Timestamp, pd.Timestamp]]:
    """Collapse contiguous samples sharing `target_status` into windows."""
    if df.empty:
        return []
    mask = (df["status"] == target_status).to_numpy()
    if not mask.any():
        return []

    ts = df["timestamp"].to_numpy()
    out: list[tuple[pd.Timestamp, pd.Timestamp]] = []
    i = 0
    n = len(mask)
    while i < n:
        if not mask[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and mask[j + 1]:
            j += 1
        out.append((pd.Timestamp(ts[i]), pd.Timestamp(ts[j])))
        i = j + 1
    return out


def classify_health(
    runtime: float,
    mtbf: float | None,
    inspection: int | None,
    failure: int | None,
) -> tuple[str, str | None]:
    """Return (health, alert).  Threshold-based first, then mtbf percentage."""
    if failure and runtime >= failure:
        return "critical", "failure"
    if inspection and runtime >= inspection:
        return "watch", "inspection"
    if mtbf and not math.isnan(mtbf) and mtbf > 0:
        pct = runtime / mtbf
        if pct >= 0.85:
            return "critical", "failure"
        if pct >= 0.60:
            return "watch", "inspection"
    return "nominal", None


def part_thresholds(part_name: str, expected_mtbf: float) -> tuple[int, int | None, int | None]:
    """Heuristic mapping from part_name → catalog code → thresholds."""
    n = part_name.lower()
    code = None
    if "high pressure tee" in n or "hp tee" in n or "high-pressure tee" in n:
        code = "HPT"
    elif "outlet manifold" in n:
        code = "OM"
    elif "pump body" in n:
        code = "PB"
    insp = ALERT_INSPECTION_MIN.get(code) if code else None
    fail = ALERT_FAILURE_MIN.get(code) if code else None
    return int(round(expected_mtbf)), insp, fail


def compute_part_metrics(
    sensor: pd.DataFrame,
    mtbf: pd.DataFrame,
) -> list[PartRecord]:
    """Compute active runtime, high-stress minutes, and inferred failures."""
    sample_min = estimate_sample_minutes(sensor["timestamp"])
    off_gaps = detect_off_windows(sensor["timestamp"])
    sensor_max = sensor["timestamp"].max() if not sensor.empty else pd.Timestamp.now()

    is_active = sensor["is_active"].to_numpy()
    is_stress = sensor["is_high_stress"].to_numpy()
    p01 = sensor["P01"].to_numpy()
    ts = sensor["timestamp"]

    records: list[PartRecord] = []
    for row in mtbf.itertuples(index=False):
        install_dt = row.installation_date
        removal_dt = row.removal_date if pd.notna(row.removal_date) else sensor_max

        in_window = (ts >= install_dt) & (ts <= removal_dt)
        in_window_arr = in_window.to_numpy()

        active_samples = int((is_active & in_window_arr).sum())
        stress_samples = int((is_stress & in_window_arr).sum())
        active_minutes = active_samples * sample_min
        stress_minutes = stress_samples * sample_min

        # Cumulative pressure-stress proxy: ∫ max(P01 - LOW, 0) dt
        active_p = p01[(is_active | is_stress) & in_window_arr]
        cum_stress = float(np.maximum(active_p - ACTIVE_BAND_LOW_KPSI, 0).sum() * sample_min)

        # Reconcile inferred failure-gaps that overlap the install window.
        inferred = 0
        for g0, g1 in off_gaps:
            if overlap_minutes(g0, g1, install_dt, removal_dt) > 0:
                inferred += 1

        expected_mtbf = (
            float(row.expected_mtbf_minutes)
            if pd.notna(row.expected_mtbf_minutes) else 12000.0
        )
        mtbf_int, insp, fail = part_thresholds(row.part_name, expected_mtbf)
        health, alert = classify_health(active_minutes, expected_mtbf, insp, fail)

        records.append(
            PartRecord(
                installation_id=str(row.installation_id),
                part_name=str(row.part_name).title(),
                serial_number=str(row.serial_number) if row.serial_number else "",
                installation_date=install_dt.isoformat(),
                removal_date=removal_dt.isoformat() if pd.notna(row.removal_date) else None,
                active_runtime_minutes=int(round(active_minutes)),
                high_stress_minutes=int(round(stress_minutes)),
                cumulative_pressure_stress=round(cum_stress, 2),
                inferred_failures=inferred,
                expected_mtbf_minutes=mtbf_int,
                inspection_threshold_min=insp,
                failure_threshold_min=fail,
                health=health,
                alert=alert,
            )
        )
    return records


# --------------------------------------------------------------------------- #
# Placeholder generators (kept for offline iteration)                         #
# --------------------------------------------------------------------------- #


def generate_placeholder_sensor_csv(path: Path, days: int = 7) -> None:
    rng = np.random.default_rng(42)
    start = pd.Timestamp.now().normalize() - pd.Timedelta(days=days)
    minutes = days * 24 * 60
    timestamps = pd.date_range(start, periods=minutes, freq="1min")

    base = 21.0 + 3.5 * np.sin(np.linspace(0, days * 2 * np.pi, minutes))
    noise = rng.normal(0, 0.6, minutes)
    p01 = base + noise

    # Inject a high-stress burst
    burst = rng.integers(60, minutes - 60)
    p01[burst : burst + 30] += rng.normal(0, 3.5, 30)

    df = pd.DataFrame({"timestamp": timestamps, "P01": p01.round(3)})
    drop_starts = rng.integers(0, minutes - 60, size=3)
    drop_idx: list[int] = []
    for s in drop_starts:
        drop_idx.extend(range(int(s), int(s) + int(rng.integers(8, 45))))
    df = df.drop(index=drop_idx, errors="ignore").reset_index(drop=True)

    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False)


def generate_placeholder_mtbf(path: Path) -> None:
    now = pd.Timestamp.now().normalize()
    rows = [
        ("0091_H1",  "homogenizing valve body",       "HVB-24-1081", now - pd.Timedelta(days=6), pd.NaT, 12000),
        ("0091_MP3", "pump body",                     "PB-22-448",   now - pd.Timedelta(days=6), pd.NaT, 15000),
        ("0091_RC2", "high pressure tee",             "HPT-25-301",  now - pd.Timedelta(days=4), pd.NaT, 9000),
        ("0091_LC1", "inlet check valve body",        "ICV-24-772",  now - pd.Timedelta(days=6), pd.NaT, 10000),
        ("0091_RC3", "outlet check valve body",       "OCV-23-512",  now - pd.Timedelta(days=6), pd.NaT, 11000),
        ("0091_O",   "outlet manifold",               "OM-23-117",   now - pd.Timedelta(days=30), pd.NaT, 18000),
        ("0091_LP2", "backup support seal (BUS)",     "BUS-26-204",  now - pd.Timedelta(days=2), pd.NaT, 1000),
    ]
    df = pd.DataFrame(rows, columns=[
        "installation_id", "part_name", "serial_number",
        "installation_date", "removal_date", "expected_mtbf_minutes",
    ])
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_excel(path, index=False)


# --------------------------------------------------------------------------- #
# Output                                                                      #
# --------------------------------------------------------------------------- #


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def thin_series_for_payload(df: pd.DataFrame, max_points: int = 3000) -> list[dict]:
    """Down-sample the tagged sensor series for the dashboard.

    Prefer-active strategy: active/high_stress/out_of_band rows are kept at up
    to 80 % of the quota so the fatigue chart has maximum run-time resolution.
    The remaining 20 % is filled with uniformly-strided below_active rows to
    preserve the band-boundary context.
    """
    ACTIVE_STATUSES = {"active", "high_stress", "out_of_band"}

    if len(df) <= max_points:
        sample = df[["timestamp", "P01", "rolling_stdev", "status"]].copy()
    else:
        active_mask = df["status"].isin(ACTIVE_STATUSES)
        active_df = df[active_mask]
        inactive_df = df[~active_mask]

        active_quota = min(len(active_df), int(max_points * 0.8))
        inactive_quota = max_points - active_quota

        if len(active_df) <= active_quota:
            kept_active = active_df
        else:
            step = max(1, len(active_df) // active_quota)
            kept_active = active_df.iloc[::step]

        if len(inactive_df) <= inactive_quota:
            kept_inactive = inactive_df
        else:
            step = max(1, len(inactive_df) // inactive_quota)
            kept_inactive = inactive_df.iloc[::step]

        sample = (
            pd.concat([kept_active, kept_inactive])
            .sort_values("timestamp")
            [["timestamp", "P01", "rolling_stdev", "status"]]
        )

    return [
        {
            "ts": row.timestamp.isoformat(),
            "p01": float(row.P01),
            "stdev": float(row.rolling_stdev),
            "status": str(row.status),
        }
        for row in sample.itertuples(index=False)
    ]


def windows_to_spans(windows: Iterable[tuple[pd.Timestamp, pd.Timestamp]]) -> list[WindowSpan]:
    spans: list[WindowSpan] = []
    for s, e in windows:
        spans.append(WindowSpan(
            start=s.isoformat(),
            end=e.isoformat(),
            duration_min=int(round((e - s).total_seconds() / 60.0)),
        ))
    return spans


def write_pipeline_json(payload: PipelinePayload, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    obj = {
        "generated_at": payload.generated_at,
        "sensor_file": payload.sensor_file,
        "sensor_sha256": payload.sensor_sha256,
        "rows_ingested": payload.rows_ingested,
        "summary": payload.summary,
        "parts": [asdict(r) for r in payload.parts],
        "fatigue_series": payload.fatigue_series,
        "off_windows": [asdict(w) for w in payload.off_windows],
        "high_stress_windows": [asdict(w) for w in payload.high_stress_windows],
    }
    with path.open("w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, default=str)


# --------------------------------------------------------------------------- #
# CLI                                                                         #
# --------------------------------------------------------------------------- #


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--sensor-csv", type=Path, default=DEFAULT_SENSOR_CSV)
    p.add_argument("--mtbf-xlsx",  type=Path, default=DEFAULT_MTBF_PATH)
    p.add_argument("--output",     type=Path, default=DEFAULT_OUTPUT_PATH)
    p.add_argument("--generate-placeholder", action="store_true")
    p.add_argument("--force-placeholder", action="store_true")
    return p.parse_args()


def main() -> None:
    args = parse_args()

    if not args.sensor_csv.exists() or (args.generate_placeholder and args.force_placeholder):
        print(f"[pipeline] writing placeholder sensor CSV → {args.sensor_csv}")
        generate_placeholder_sensor_csv(args.sensor_csv)
    if not args.mtbf_xlsx.exists() or (args.generate_placeholder and args.force_placeholder):
        print(f"[pipeline] writing placeholder MTBF workbook → {args.mtbf_xlsx}")
        generate_placeholder_mtbf(args.mtbf_xlsx)

    sensor, signals = load_sensor_csv(args.sensor_csv)
    mtbf = load_mtbf_tracker(args.mtbf_xlsx)
    print(f"[pipeline] {len(sensor):,} samples loaded, signals={signals}, "
          f"{len(mtbf)} parts in tracker.")

    sensor = tag_samples(sensor)

    sample_min = estimate_sample_minutes(sensor["timestamp"])
    parts = compute_part_metrics(sensor, mtbf)

    off_gaps = detect_off_windows(sensor["timestamp"])
    high_stress = collapse_status_windows(sensor, "high_stress")

    summary = {
        "active_minutes_total": int(round(sensor["is_active"].sum() * sample_min)),
        "high_stress_minutes_total": int(round(sensor["is_high_stress"].sum() * sample_min)),
        "off_minutes_total": int(round(sum((e - s).total_seconds()/60.0 for s, e in off_gaps))),
        "out_of_band_minutes": int(round(sensor["is_out_of_band"].sum() * sample_min)),
        "signals_detected": signals,
        "active_band_low_kpsi": ACTIVE_BAND_LOW_KPSI,
        "active_band_high_kpsi": ACTIVE_BAND_HIGH_KPSI,
        "pulsation_threshold_kpsi": PULSATION_STDEV_KPSI,
        "rolling_window": ROLLING_WINDOW,
        "gap_off_minutes": GAP_OFF_MIN,
        "sample_minutes": sample_min,
    }

    payload = PipelinePayload(
        generated_at=pd.Timestamp.utcnow().isoformat(),
        sensor_file=str(args.sensor_csv),
        sensor_sha256=file_sha256(args.sensor_csv),
        rows_ingested=len(sensor),
        summary=summary,
        parts=parts,
        fatigue_series=thin_series_for_payload(sensor),
        off_windows=windows_to_spans(off_gaps),
        high_stress_windows=windows_to_spans(high_stress),
    )

    write_pipeline_json(payload, args.output)
    print(f"[pipeline] wrote {len(parts)} part records, "
          f"{len(payload.fatigue_series)} fatigue points → {args.output}")


if __name__ == "__main__":
    main()
