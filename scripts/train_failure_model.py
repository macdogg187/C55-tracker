"""Train the C55 failure-prediction model from historical trends + MTBF data.

Inputs (configurable via CLI; defaults assume the repo layout)
--------------------------------------------------------------
  archive/*.{csv,txt}           VantagePoint trends exports (UTF-16 LE / UTF-8)
  MTBF Tracker_cursor.xlsx      Lifecycle history with failure modes
  data/lifecycles.json          Optional: local-JSON snapshot (Supabase mirror)

Outputs
-------
  models/failure_predictor.joblib   sklearn artefact (full pipeline)
  models/failure_predictor.json     portable JSON dump for the TS scorer
  models/feature_spec.json          input contract (feature order + units)
  models/training_report.json       fit metrics + dataset summary

Why two artefacts:
  - .joblib  -> faster iteration for the data scientist (Python notebooks)
  - .json    -> the dashboard's lib/predict-model.ts can score in-process at
                inference time without spinning up a Python runtime.

Two-headed model:
  - GradientBoostingRegressor predicts time_to_failure_minutes (TTF)
  - GradientBoostingClassifier predicts the most likely failure_mode

Both share the same engineered features so the scorer only computes them once.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np
import pandas as pd

try:
    from sklearn.ensemble import (
        GradientBoostingClassifier,
        GradientBoostingRegressor,
    )
    from sklearn.metrics import classification_report, mean_absolute_error
    from sklearn.model_selection import train_test_split
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler
    import joblib  # type: ignore[import-untyped]
except ImportError as e:  # pragma: no cover - install hint
    print(
        f"missing dependency: {e.name}. Run `pip install -r requirements.txt`",
        file=sys.stderr,
    )
    sys.exit(2)


# --------------------------------------------------------------------------- #
# Constants — keep in sync with lib/analytics.ts and lib/pass-detect.ts        #
# --------------------------------------------------------------------------- #

ACTIVE_BAND_LOW_KPSI = 15.0
ACTIVE_BAND_HIGH_KPSI = 30.0
ROLLING_WINDOW_MIN = 10

SIGNAL_ALIASES: dict[str, list[str]] = {
    "P01": ["p01", "pressure_01", "pressure", "psi"],
    "P02": ["p02", "pressure_02", "back_pressure", "applied_gas_pressure"],
    "T01": ["t01", "temp_01", "seal_flush_left"],
    "T02": ["t02", "temp_02", "seal_flush_middle"],
    "T03": ["t03", "temp_03", "seal_flush_right"],
    "T04": ["t04", "temp_04", "pre_hx_temp", "product_loop_pre_hx"],
    "T05": ["t05", "temp_05", "post_hx_temp", "product_loop_post_hx"],
}

FAILURE_MODES = [
    "normal wear",
    "scratches",
    "binding (threads)",
    "fracture (port)",
    "fracture (body)",
    "weephole leak",
    "thread fracture",
    "internal erosion",
    "thermal drift",
    "other",
    "unknown",
]


# --------------------------------------------------------------------------- #
# Encoding-aware trends loader (twin of lib/trends-ingest-txt.ts)             #
# --------------------------------------------------------------------------- #

def decode_trends_bytes(raw: bytes) -> str:
    """Sniff the BOM and decode (matches lib/trends-ingest-txt.ts)."""
    if raw[:2] == b"\xff\xfe":
        return raw[2:].decode("utf-16-le", errors="replace")
    if raw[:2] == b"\xfe\xff":
        return raw[2:].decode("utf-16-be", errors="replace")
    if raw[:3] == b"\xef\xbb\xbf":
        return raw[3:].decode("utf-8", errors="replace")
    return raw.decode("utf-8", errors="replace")


def _normalise_header(h: str) -> str:
    no_units = h
    while "(" in no_units and ")" in no_units:
        l, r = no_units.find("("), no_units.find(")")
        if l < r:
            no_units = no_units[:l] + no_units[r + 1 :]
        else:
            break
    return no_units.strip().lower().replace(" ", "_")


def _detect_signal_columns(headers: Sequence[str]) -> dict[str, str]:
    norm = [(h, _normalise_header(h)) for h in headers]
    found: dict[str, str] = {}
    for canon, aliases in SIGNAL_ALIASES.items():
        all_aliases = [canon.lower()] + aliases
        for orig, n in norm:
            if n in all_aliases:
                found[canon] = orig
                break
        if canon in found:
            continue
        for orig, n in norm:
            for alias in all_aliases:
                if n == alias or n.startswith(f"{alias}_") or n.startswith(f"{alias}-"):
                    found[canon] = orig
                    break
            if canon in found:
                break
    return found


def _detect_ts_column(headers: Sequence[str]) -> str | None:
    for h in headers:
        n = _normalise_header(h)
        if n in {"timestamp", "time", "datetime", "date_time"}:
            return h
    return None


def load_trends_file(path: Path) -> pd.DataFrame:
    """Load one VantagePoint trends file into a tidy DataFrame.

    Returns a DataFrame indexed by UTC timestamp with columns for any of
    P01..T05 that were present. Missing signals are absent (downstream
    handles them gracefully).
    """
    raw = path.read_bytes()
    text = decode_trends_bytes(raw)

    # Skip any banner rows that precede the real header. Walk the first 50
    # lines until we find one containing "time" or "p01" (case-insensitive).
    lines = text.splitlines()
    header_idx = 0
    for i, line in enumerate(lines[:50]):
        low = line.lower()
        if "time" in low or "p01" in low:
            header_idx = i
            break
    body = "\n".join(lines[header_idx:])

    # Sniff the delimiter on the header line.
    header_line = lines[header_idx] if lines else ""
    delim = ","
    if header_line.count("\t") > max(header_line.count(","), header_line.count(";")):
        delim = "\t"
    elif header_line.count(";") > header_line.count(","):
        delim = ";"

    df = pd.read_csv(io.StringIO(body), delimiter=delim, low_memory=False)
    df.columns = [str(c).strip() for c in df.columns]

    ts_col = _detect_ts_column(df.columns)
    if ts_col is None:
        raise ValueError(f"{path.name}: no timestamp column found in {list(df.columns)}")

    sig_cols = _detect_signal_columns(df.columns)
    if "P01" not in sig_cols:
        raise ValueError(f"{path.name}: no P01 column found in {list(df.columns)}")

    out = pd.DataFrame()
    # pandas parses US-locale timestamps with AM/PM via `format="mixed"`.
    out["ts"] = pd.to_datetime(df[ts_col], errors="coerce", utc=True, format="mixed")
    for canon, orig in sig_cols.items():
        out[canon] = pd.to_numeric(df[orig], errors="coerce")

    out = out.dropna(subset=["ts", "P01"]).sort_values("ts").set_index("ts")

    # If P01 looks like raw psi (median > 1000) auto-convert to kpsi.
    if out["P01"].median() > 1000:
        out["P01"] = out["P01"] / 1000.0

    return out


# --------------------------------------------------------------------------- #
# Feature engineering                                                         #
# --------------------------------------------------------------------------- #

FEATURE_NAMES: list[str] = [
    "p01_mean",
    "p01_std",            # rolling stdev — pulsation proxy
    "p01_max",
    "p01_p95",
    "p02_mean",
    "p02_std",
    "p01_p02_spread",     # P01 - P02 mean diff
    "t01_mean",
    "t02_mean",
    "t03_mean",
    "t04_mean",
    "t05_mean",
    "t04_t05_spread",     # pre vs post heat exchanger
    "t_left_right_spread", # T01 - T03 (seal-flush asymmetry)
    "t04_slope",          # OLS slope over the window (deg C / min)
    "t05_slope",
    "active_minutes",     # samples in band × sample_minutes
    "high_stress_minutes",
    "cumulative_pressure_stress",
    "runtime_minutes",    # cumulative runtime at the end of the window
]


@dataclass
class FeatureWindow:
    """One training row: features + (optional) labels."""

    features: np.ndarray   # shape (len(FEATURE_NAMES),)
    runtime_minutes: float
    installation_id: str
    serial_number: str
    failure_mode: str | None      # label for the classifier; None = censored
    time_to_failure_minutes: float | None  # label for the regressor


def _ols_slope(values: np.ndarray) -> float:
    """OLS slope of an array vs a 0..n-1 x-axis. Returns 0 for <2 points."""
    n = values.size
    if n < 2:
        return 0.0
    x = np.arange(n, dtype=np.float64)
    x_mean = x.mean()
    y_mean = float(values.mean())
    num = ((x - x_mean) * (values - y_mean)).sum()
    den = ((x - x_mean) ** 2).sum()
    return float(num / den) if den else 0.0


def engineer_features(
    df: pd.DataFrame,
    window_min: int = 30,
    step_min: int = 10,
) -> list[dict[str, float]]:
    """Roll a sliding window over the dataframe and emit feature dicts.

    Each window contributes one row to the training set. The dataframe is
    expected to be sorted, timezone-aware, with the columns described in
    SIGNAL_ALIASES (subset is fine; missing columns -> 0).
    """
    if df.empty:
        return []

    # Build a uniform 1-minute grid so rolling-window semantics are stable
    # regardless of the (variable) native sample rate.
    grid = df.resample("1min").mean()

    rows: list[dict[str, float]] = []
    win = pd.Timedelta(minutes=window_min)
    step = pd.Timedelta(minutes=step_min)

    cursor = grid.index[0] + win
    end = grid.index[-1]
    runtime_cum = 0.0
    while cursor <= end:
        chunk = grid.loc[cursor - win : cursor]
        if chunk.empty:
            cursor += step
            continue

        p01 = chunk["P01"].dropna().to_numpy() if "P01" in chunk else np.array([])
        p02 = chunk["P02"].dropna().to_numpy() if "P02" in chunk else np.array([])
        t01 = chunk["T01"].dropna().to_numpy() if "T01" in chunk else np.array([])
        t02 = chunk["T02"].dropna().to_numpy() if "T02" in chunk else np.array([])
        t03 = chunk["T03"].dropna().to_numpy() if "T03" in chunk else np.array([])
        t04 = chunk["T04"].dropna().to_numpy() if "T04" in chunk else np.array([])
        t05 = chunk["T05"].dropna().to_numpy() if "T05" in chunk else np.array([])

        if p01.size == 0:
            cursor += step
            continue

        in_band = (p01 >= ACTIVE_BAND_LOW_KPSI) & (p01 <= ACTIVE_BAND_HIGH_KPSI)
        active_min = float(in_band.sum())  # 1 grid minute per row
        runtime_cum += active_min

        # Pulsation = stdev of P01 inside the window.
        p01_std = float(p01.std(ddof=1)) if p01.size > 1 else 0.0
        high_stress_min = float(((p01 >= ACTIVE_BAND_LOW_KPSI) & (p01_std > 2.0)).sum())

        cumulative_pressure_stress = float(
            np.maximum(0.0, p01[in_band] - ACTIVE_BAND_LOW_KPSI).sum()
        )

        rows.append({
            "ts": cursor.isoformat(),
            "p01_mean": float(p01.mean()),
            "p01_std": p01_std,
            "p01_max": float(p01.max()),
            "p01_p95": float(np.percentile(p01, 95)),
            "p02_mean": float(p02.mean()) if p02.size else 0.0,
            "p02_std": float(p02.std(ddof=1)) if p02.size > 1 else 0.0,
            "p01_p02_spread": float(p01.mean() - (p02.mean() if p02.size else 0.0)),
            "t01_mean": float(t01.mean()) if t01.size else 0.0,
            "t02_mean": float(t02.mean()) if t02.size else 0.0,
            "t03_mean": float(t03.mean()) if t03.size else 0.0,
            "t04_mean": float(t04.mean()) if t04.size else 0.0,
            "t05_mean": float(t05.mean()) if t05.size else 0.0,
            "t04_t05_spread": float(
                (t04.mean() if t04.size else 0.0)
                - (t05.mean() if t05.size else 0.0)
            ),
            "t_left_right_spread": float(
                (t01.mean() if t01.size else 0.0)
                - (t03.mean() if t03.size else 0.0)
            ),
            "t04_slope": _ols_slope(t04),
            "t05_slope": _ols_slope(t05),
            "active_minutes": active_min,
            "high_stress_minutes": high_stress_min,
            "cumulative_pressure_stress": cumulative_pressure_stress,
            "runtime_minutes": runtime_cum,
        })
        cursor += step
    return rows


# --------------------------------------------------------------------------- #
# Label loading (MTBF Tracker .xlsx)                                          #
# --------------------------------------------------------------------------- #

def load_lifecycles(xlsx_path: Path, sheet: str = "Tracker") -> pd.DataFrame:
    df = pd.read_excel(xlsx_path, sheet_name=sheet, engine="openpyxl")
    df.columns = [str(c).strip().lower().replace(" ", "_") for c in df.columns]

    # Map fuzzy headers -> canonical names.
    alias_map = {
        "install_id": "installation_id",
        "slot": "installation_id",
        "part": "part_name",
        "component": "part_name",
        "serial": "serial_number",
        "install_date": "installation_date",
        "remove_date": "removal_date",
        "fail_mode": "failure_mode",
        "runtime": "runtime_minutes",
    }
    df = df.rename(columns=alias_map)

    required = {"installation_id", "installation_date"}
    missing = required - set(df.columns)
    if missing:
        raise SystemExit(
            f"tracker missing required columns {missing}; got {list(df.columns)}",
        )

    df["installation_date"] = pd.to_datetime(df["installation_date"], errors="coerce", utc=True)
    if "removal_date" in df.columns:
        df["removal_date"] = pd.to_datetime(df["removal_date"], errors="coerce", utc=True)
    else:
        df["removal_date"] = pd.NaT
    if "failure_mode" in df.columns:
        df["failure_mode"] = (
            df["failure_mode"].astype(str).str.lower().str.strip().replace({"nan": None})
        )
    else:
        df["failure_mode"] = None
    return df


# --------------------------------------------------------------------------- #
# Dataset assembly                                                            #
# --------------------------------------------------------------------------- #

def assemble_dataset(
    trends_files: list[Path],
    lifecycles: pd.DataFrame,
    window_min: int,
    step_min: int,
) -> pd.DataFrame:
    """Stitch trends windows to lifecycle labels.

    Each feature window inherits the label of any lifecycle whose
    [installation_date, removal_date) interval contains the window's
    timestamp. Censored lifecycles (no removal_date) contribute features but
    time_to_failure_minutes is left null (we drop those rows for the
    regressor but keep them for outlier diagnostics).
    """
    all_rows: list[dict[str, float]] = []
    for fp in trends_files:
        try:
            trends = load_trends_file(fp)
        except Exception as exc:  # pragma: no cover - logged & skipped
            print(f"  ! skip {fp.name}: {exc}", file=sys.stderr)
            continue
        windows = engineer_features(trends, window_min=window_min, step_min=step_min)
        for w in windows:
            w["source_file"] = fp.name
        all_rows.extend(windows)

    if not all_rows:
        return pd.DataFrame()
    feats = pd.DataFrame(all_rows)
    feats["ts"] = pd.to_datetime(feats["ts"], utc=True)

    # Join the latest lifecycle that brackets each window.
    feats["installation_id"] = ""
    feats["serial_number"] = ""
    feats["failure_mode"] = None
    feats["time_to_failure_minutes"] = np.nan

    for _, lc in lifecycles.iterrows():
        if pd.isna(lc["installation_date"]):
            continue
        ts_start = lc["installation_date"]
        ts_end = lc["removal_date"] if not pd.isna(lc["removal_date"]) else feats["ts"].max()
        mask = (feats["ts"] >= ts_start) & (feats["ts"] <= ts_end)
        if not mask.any():
            continue
        feats.loc[mask, "installation_id"] = str(lc.get("installation_id", ""))
        feats.loc[mask, "serial_number"] = str(lc.get("serial_number", ""))
        if lc.get("failure_mode"):
            feats.loc[mask, "failure_mode"] = lc["failure_mode"]
        if not pd.isna(lc["removal_date"]):
            ttf = (lc["removal_date"] - feats.loc[mask, "ts"]).dt.total_seconds() / 60.0
            feats.loc[mask, "time_to_failure_minutes"] = ttf

    return feats


# --------------------------------------------------------------------------- #
# Training                                                                    #
# --------------------------------------------------------------------------- #

def train(
    feats: pd.DataFrame,
    out_dir: Path,
) -> dict[str, object]:
    out_dir.mkdir(parents=True, exist_ok=True)
    X = feats[FEATURE_NAMES].astype(np.float64).fillna(0.0)

    report: dict[str, object] = {
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "n_rows_total": int(len(feats)),
        "feature_names": FEATURE_NAMES,
    }

    # Regression head: predict TTF in minutes. Drop censored rows.
    reg_mask = feats["time_to_failure_minutes"].notna() & (
        feats["time_to_failure_minutes"] > 0
    )
    n_reg = int(reg_mask.sum())
    report["n_rows_regression"] = n_reg

    regressor = None
    if n_reg >= 10:
        Xr, yr = X[reg_mask].to_numpy(), feats.loc[reg_mask, "time_to_failure_minutes"].to_numpy()
        Xr_tr, Xr_te, yr_tr, yr_te = train_test_split(Xr, yr, test_size=0.2, random_state=42)
        regressor = Pipeline([
            ("scaler", StandardScaler()),
            (
                "gbr",
                GradientBoostingRegressor(
                    n_estimators=100,
                    max_depth=3,
                    learning_rate=0.1,
                    random_state=42,
                ),
            ),
        ])
        regressor.fit(Xr_tr, yr_tr)
        preds = regressor.predict(Xr_te)
        report["regression_mae_minutes"] = float(mean_absolute_error(yr_te, preds))
    else:
        report["regression_skipped_reason"] = (
            f"only {n_reg} labelled rows (need >=10); train more lifecycles before retraining"
        )

    # Classification head: predict the most likely failure mode.
    cls_mask = feats["failure_mode"].notna()
    n_cls = int(cls_mask.sum())
    report["n_rows_classification"] = n_cls

    classifier = None
    if n_cls >= 20 and feats.loc[cls_mask, "failure_mode"].nunique() >= 2:
        Xc = X[cls_mask].to_numpy()
        yc = feats.loc[cls_mask, "failure_mode"].astype(str).to_numpy()
        Xc_tr, Xc_te, yc_tr, yc_te = train_test_split(
            Xc, yc, test_size=0.2, random_state=42, stratify=yc,
        )
        classifier = Pipeline([
            ("scaler", StandardScaler()),
            (
                "gbc",
                GradientBoostingClassifier(
                    n_estimators=100,
                    max_depth=3,
                    learning_rate=0.1,
                    random_state=42,
                ),
            ),
        ])
        classifier.fit(Xc_tr, yc_tr)
        report["classification_report"] = classification_report(
            yc_te, classifier.predict(Xc_te), output_dict=True, zero_division=0,
        )
    else:
        report["classification_skipped_reason"] = (
            f"only {n_cls} labelled rows with {feats.loc[cls_mask, 'failure_mode'].nunique() if n_cls else 0} unique modes"
        )

    # Persist artefacts.
    joblib_path = out_dir / "failure_predictor.joblib"
    joblib.dump({"regressor": regressor, "classifier": classifier}, joblib_path)

    # Portable JSON dump: scalers + tree thresholds + class probs. The TS
    # scorer reads this so it doesn't need a Python runtime at inference.
    portable: dict[str, object] = {
        "feature_names": FEATURE_NAMES,
        "trained_at": report["trained_at"],
        "regressor": _dump_regressor(regressor) if regressor else None,
        "classifier": _dump_classifier(classifier) if classifier else None,
    }
    (out_dir / "failure_predictor.json").write_text(json.dumps(portable, indent=2))

    spec = {
        "feature_names": FEATURE_NAMES,
        "window_minutes": 30,
        "step_minutes": 10,
        "active_band_low_kpsi": ACTIVE_BAND_LOW_KPSI,
        "active_band_high_kpsi": ACTIVE_BAND_HIGH_KPSI,
        "rolling_window_min": ROLLING_WINDOW_MIN,
    }
    (out_dir / "feature_spec.json").write_text(json.dumps(spec, indent=2))
    (out_dir / "training_report.json").write_text(json.dumps(report, indent=2, default=str))

    return report


def _dump_regressor(pipe: Pipeline) -> dict[str, object]:
    """Serialise a fitted GradientBoostingRegressor pipeline to JSON.

    We export the StandardScaler params + the per-stage tree dumps. The TS
    scorer reconstructs predictions as scaler -> sum_stages(tree(value)).
    """
    scaler: StandardScaler = pipe.named_steps["scaler"]
    gbr: GradientBoostingRegressor = pipe.named_steps["gbr"]
    return {
        "type": "gbr",
        "scaler": {
            "mean": scaler.mean_.tolist(),
            "scale": scaler.scale_.tolist(),
        },
        "init_prediction": float(gbr.init_.constant_.ravel()[0]),
        "learning_rate": float(gbr.learning_rate),
        "n_estimators": int(gbr.n_estimators_),
        "stages": [
            _dump_tree(est[0].tree_)
            for est in gbr.estimators_
        ],
    }


def _dump_classifier(pipe: Pipeline) -> dict[str, object]:
    scaler: StandardScaler = pipe.named_steps["scaler"]
    gbc: GradientBoostingClassifier = pipe.named_steps["gbc"]
    return {
        "type": "gbc",
        "scaler": {
            "mean": scaler.mean_.tolist(),
            "scale": scaler.scale_.tolist(),
        },
        "classes": [str(c) for c in gbc.classes_],
        "init_prediction": gbc.init_.class_prior_.tolist()
            if hasattr(gbc.init_, "class_prior_") else None,
        "learning_rate": float(gbc.learning_rate),
        "n_estimators": int(gbc.n_estimators_),
        # Each stage is (n_classes, ) tree estimators for multi-class GBC.
        "stages_per_class": [
            [_dump_tree(est_k.tree_) for est_k in stage]
            for stage in gbc.estimators_
        ],
    }


def _dump_tree(tree) -> dict[str, list]:
    return {
        "feature": tree.feature.tolist(),
        "threshold": tree.threshold.tolist(),
        "children_left": tree.children_left.tolist(),
        "children_right": tree.children_right.tolist(),
        "value": tree.value.reshape(tree.value.shape[0], -1).tolist(),
    }


# --------------------------------------------------------------------------- #
# CLI entry point                                                             #
# --------------------------------------------------------------------------- #

def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--trends-dir", type=Path, default=Path("archive"),
                   help="directory containing historical .csv/.txt VantagePoint files")
    p.add_argument("--mtbf-xlsx", type=Path, default=Path("MTBF Tracker_cursor.xlsx"))
    p.add_argument("--out-dir", type=Path, default=Path("models"))
    p.add_argument("--window-min", type=int, default=30)
    p.add_argument("--step-min", type=int, default=10)
    p.add_argument("--include-current",
                   action="store_true",
                   help="also include the top-level vantagepoint_sensor.csv + inbox/*")
    args = p.parse_args()

    candidates: list[Path] = []
    if args.trends_dir.exists():
        candidates.extend(sorted(args.trends_dir.glob("*.csv")))
        candidates.extend(sorted(args.trends_dir.glob("*.txt")))
    if args.include_current:
        for extra in [Path("vantagepoint_sensor.csv"), *Path("inbox").glob("*.csv"), *Path("inbox").glob("*.txt")]:
            if extra.exists():
                candidates.append(extra)

    if not candidates:
        print(
            f"no trends files found under {args.trends_dir} — drop CSVs/TXTs into archive/ first",
            file=sys.stderr,
        )
        # We still write a stub spec so the TS scorer's "no model" fallback
        # path stays exercised in CI.
        args.out_dir.mkdir(parents=True, exist_ok=True)
        (args.out_dir / "feature_spec.json").write_text(json.dumps({
            "feature_names": FEATURE_NAMES,
            "window_minutes": args.window_min,
            "step_minutes": args.step_min,
            "skipped_reason": f"no trends files in {args.trends_dir}",
        }, indent=2))
        return 1

    print(f"loading {len(candidates)} trends file(s)...")
    lifecycles = (
        load_lifecycles(args.mtbf_xlsx)
        if args.mtbf_xlsx.exists()
        else pd.DataFrame(columns=[
            "installation_id", "serial_number", "installation_date",
            "removal_date", "failure_mode",
        ])
    )
    print(f"loaded {len(lifecycles)} lifecycle rows from {args.mtbf_xlsx.name}")

    feats = assemble_dataset(candidates, lifecycles, args.window_min, args.step_min)
    print(f"engineered {len(feats)} feature windows")
    if feats.empty:
        print("no feature windows produced — aborting", file=sys.stderr)
        return 1

    report = train(feats, args.out_dir)
    print(json.dumps({
        k: v for k, v in report.items()
        if k in {"n_rows_total", "n_rows_regression", "n_rows_classification",
                  "regression_mae_minutes", "regression_skipped_reason",
                  "classification_skipped_reason"}
    }, indent=2, default=str))
    print(f"artefacts written to {args.out_dir}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
