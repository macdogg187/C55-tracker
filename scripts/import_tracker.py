"""Backfill the Postgres database from `MTBF Tracker_cursor.xlsx`.

Reads the legacy "Tracker" sheet, normalises every row to the canonical
nomenclature, and emits TWO artifacts:

    supabase/seed.sql       idempotent SQL — UPSERT equipment / catalog / slots
                            and `INSERT ... ON CONFLICT DO UPDATE` lifecycles
                            and maintenance_event rows.

    public/lifecycles.json  snapshot consumed by the dashboard when no
                            Supabase credentials are configured (local-first).

The same module is importable from API routes and the watcher, so we have
ONE definition of "what the Tracker says" no matter who's reading.

Usage
-----
    python scripts/import_tracker.py
    python scripts/import_tracker.py --xlsx 'MTBF Tracker_cursor.xlsx' \
                                     --seed supabase/seed.sql \
                                     --json public/lifecycles.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import warnings
from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import pandas as pd

warnings.filterwarnings("ignore")

# --------------------------------------------------------------------------- #
# Canonical nomenclature (mirrors lib/parts-catalog.ts)                       #
# --------------------------------------------------------------------------- #

CLUSTER_SLOTS = {1: "ICVB", 2: "HPT", 3: "OCVB", 4: "ICVBS", 5: "OCVBS"}
PUMP_SLOTS    = {1: "PLG", 2: "BUS", 3: "PB", 4: "BSPB"}
HEAD_SLOTS    = {1: "HVB", 2: "CSEAT", 3: "IR", 4: "CSTEM"}

PART_CODE_TO_NAME = {
    "ICVB": "Inlet Check Valve Body",
    "HPT": "High Pressure Tee",
    "OCVB": "Outlet Check Valve Body",
    "ICVBS": "Inlet Check Valve Ball Seat",
    "OCVBS": "Outlet Check Valve Ball Seat",
    "CVBALL": "Check Valve Ball",
    "PLG": "Plunger",
    "BUS": "Backup Support Seal (BUS)",
    "PB": "Pump Body",
    "BSPB": "Ball Seat (Pump Body)",
    "SPRING": "Check Valve Spring",
    "HVB": "Homogenizing Valve Body",
    "CSEAT": "Ceramic Seat",
    "IR": "Impact Ring",
    "CSTEM": "Ceramic Stem",
    "OM": "Outlet Manifold",
    "TR": "Transducer",
}

# Inverse lookup: legacy part_name string → canonical part_code.
NAME_ALIASES: dict[str, str] = {}
for code, name in PART_CODE_TO_NAME.items():
    NAME_ALIASES[name.lower()] = code
NAME_ALIASES.update({
    "homogenizing valve body": "HVB",
    "homogenizing valve": "HVB",
    "high pressure tee": "HPT",
    "high-pressure tee": "HPT",
    "hp tee": "HPT",
    "pump body": "PB",
    "outlet manifold": "OM",
    "transducer": "TR",
    "ceramic stem": "CSTEM",
    "ceramic seat": "CSEAT",
    "impact ring": "IR",
    "plunger": "PLG",
    "backup support seal": "BUS",
    "backup support seal (bus)": "BUS",
    "bus": "BUS",
    "inlet check valve body": "ICVB",
    "outlet check valve body": "OCVB",
    "inlet check valve ball seat": "ICVBS",
    "outlet check valve ball seat": "OCVBS",
    "ball seat (pump body)": "BSPB",
    "check valve ball": "CVBALL",
    "check valve spring": "SPRING",
    "spring": "SPRING",
})

# Failure-mode normalisation (Tracker has free-text variants).
FAILURE_MODE_ALIASES: dict[str, str] = {
    "fracture (port)": "fracture (port)",
    "fracture (body)": "fracture (body)",
    "normal wear": "normal wear",
    "scratches": "scratches",
    "binding (threads)": "binding (threads)",
    "other (explain in notes)": "other",
    "other": "other",
    "unknown": "unknown",
    # New Logic-Doc additions
    "weephole leak": "weephole leak",
    "weep hole leak": "weephole leak",
    "thread fracture": "thread fracture",
    "internal erosion": "internal erosion",
    "thermal drift": "thermal drift",
}

ALLOWED_FAILURE_MODES = {
    "normal wear", "scratches", "binding (threads)",
    "fracture (port)", "fracture (body)",
    "weephole leak", "thread fracture", "internal erosion", "thermal drift",
    "other", "unknown",
}

# installation_id regex: <equipment>_<zone-orientation-index>
SLOT_RE = re.compile(r"^(?P<eq>\d{3,5})_(?P<slot>[A-Z]{1,2}\d?)$")

# Heuristic MTBF defaults (synced with lib/parts-catalog.ts)
DEFAULT_MTBF: dict[str, int] = {
    "HVB": 12000, "PB": 15000, "HPT": 9000, "ICVB": 10000,
    "OCVB": 11000, "ICVBS": 1000, "OCVBS": 1000, "PLG": 8000,
    "BUS": 1000, "BSPB": 1000, "CVBALL": 1000, "SPRING": 1000,
    "CSEAT": 6000, "IR": 6000, "CSTEM": 6000, "OM": 18000, "TR": 20000,
}

CONSUMABLE_CODES = {"ICVBS", "OCVBS", "CVBALL", "BUS", "BSPB", "SPRING"}
STRUCTURAL_CODES = {"HPT", "PB", "OM"}
SEAL_LIFE_LOW, SEAL_LIFE_HIGH = 800, 1200

# Inspection / failure thresholds (match data_pipeline.py)
INSPECTION_MIN = {"HPT": 2000, "PB": 12000, "OM": 14000}
FAILURE_MIN = {"HPT": 2400, "PB": 14500, "OM": 17000}


# --------------------------------------------------------------------------- #
# Data classes                                                                #
# --------------------------------------------------------------------------- #


@dataclass
class SlotRow:
    installation_id: str
    equipment_id: str
    part_code: str
    zone: str
    orientation: str
    slot_index: int | None
    sequence_order: int


@dataclass
class LifecycleRow:
    installation_id: str
    serial_number: str
    is_refurb: bool
    installation_date: str
    removal_date: str | None
    failure_mode: str | None
    failure_notes: str | None
    runtime_minutes_legacy: int | None
    work_order: str | None


@dataclass
class ImportReport:
    rows_total: int = 0
    lifecycles_imported: int = 0
    skipped_no_install: int = 0
    skipped_bad_id: int = 0
    name_mismatches: int = 0
    unknown_failure_modes: int = 0
    warnings: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------- #
# Resolvers                                                                   #
# --------------------------------------------------------------------------- #


SEQUENCE_BASE = {
    ("cluster", "left"): 100, ("cluster", "middle"): 110, ("cluster", "right"): 120,
    ("pump", "left"): 200, ("pump", "middle"): 210, ("pump", "right"): 220,
    ("manifold", "center"): 300, ("homogenizer", "center"): 400,
    ("instrument", "center"): 500,
}


def parse_slot(installation_id: str) -> SlotRow | None:
    """Parse '0091_LC2' → SlotRow(part_code=HPT, zone=cluster, orientation=left, slot_index=2)."""
    m = SLOT_RE.match(installation_id.strip())
    if not m:
        return None
    eq = m.group("eq")
    slot = m.group("slot")

    cluster = re.match(r"^([LMR])C([1-5])$", slot)
    pump = re.match(r"^([LMR])P([1-5])$", slot)
    head = re.match(r"^H([1-4])$", slot)

    if cluster:
        orient_map = {"L": "left", "M": "middle", "R": "right"}
        orientation = orient_map[cluster.group(1)]
        idx = int(cluster.group(2))
        code = CLUSTER_SLOTS.get(idx)
        if not code:
            return None
        return SlotRow(installation_id, eq, code, "cluster", orientation, idx,
                       SEQUENCE_BASE[("cluster", orientation)] + idx)
    if pump:
        orient_map = {"L": "left", "M": "middle", "R": "right"}
        orientation = orient_map[pump.group(1)]
        idx = int(pump.group(2))
        code = PUMP_SLOTS.get(idx)
        if not code:
            return None
        return SlotRow(installation_id, eq, code, "pump", orientation, idx,
                       SEQUENCE_BASE[("pump", orientation)] + idx)
    if head:
        idx = int(head.group(1))
        code = HEAD_SLOTS.get(idx)
        if not code:
            return None
        return SlotRow(installation_id, eq, code, "homogenizer", "center", idx,
                       SEQUENCE_BASE[("homogenizer", "center")] + idx)
    if slot == "O":
        return SlotRow(installation_id, eq, "OM", "manifold", "center", None,
                       SEQUENCE_BASE[("manifold", "center")])
    if slot == "T":
        return SlotRow(installation_id, eq, "TR", "instrument", "center", None,
                       SEQUENCE_BASE[("instrument", "center")])
    return None


def normalise_part_name(raw: Any) -> str:
    return str(raw or "").strip().lower()


def resolve_part_code_from_name(raw_name: str) -> str | None:
    key = normalise_part_name(raw_name)
    if key in NAME_ALIASES:
        return NAME_ALIASES[key]
    # Strip parenthetical orientation hints like "(left)" before retry.
    stripped = re.sub(r"\s*\([^)]*\)\s*", " ", key).strip()
    return NAME_ALIASES.get(stripped)


def normalise_failure_mode(raw: Any) -> str | None:
    if raw is None:
        return None
    if isinstance(raw, float) and pd.isna(raw):
        return None
    key = str(raw).strip().lower()
    if not key or key == "nan":
        return None
    return FAILURE_MODE_ALIASES.get(key, key if key in ALLOWED_FAILURE_MODES else None)


def coerce_date(raw: Any) -> datetime | None:
    """Coerce Tracker dates → datetime; reject 'unknown', '?', '#VALUE!'."""
    if raw is None or pd.isna(raw):
        return None
    if isinstance(raw, datetime):
        return raw
    if isinstance(raw, str):
        s = raw.strip()
        if not s or s.lower() in {"unknown", "?", "tbd", "n/a", "na"} or s.startswith("#"):
            return None
        try:
            return pd.to_datetime(s).to_pydatetime()
        except (ValueError, TypeError):
            return None
    try:
        return pd.to_datetime(raw).to_pydatetime()
    except (ValueError, TypeError):
        return None


# --------------------------------------------------------------------------- #
# Importer                                                                    #
# --------------------------------------------------------------------------- #


def import_tracker(xlsx_path: Path) -> tuple[
    list[dict[str, Any]],   # equipment rows
    list[SlotRow],          # slots
    list[LifecycleRow],     # lifecycles
    ImportReport,
]:
    df = pd.read_excel(xlsx_path, sheet_name="Tracker")
    df.columns = [str(c).strip() for c in df.columns]

    report = ImportReport(rows_total=len(df))

    seen_slots: dict[str, SlotRow] = {}
    equipment_seen: dict[str, dict[str, Any]] = {}
    lifecycles: list[LifecycleRow] = []

    for row in df.itertuples(index=False):
        raw_inst = getattr(row, "installation_id", None)
        if raw_inst is None or (isinstance(raw_inst, float) and pd.isna(raw_inst)):
            report.skipped_no_install += 1
            continue
        inst = str(raw_inst).strip()
        if not inst or inst.lower() == "nan":
            report.skipped_no_install += 1
            continue
        slot = parse_slot(inst)
        if not slot:
            report.skipped_bad_id += 1
            report.warnings.append(f"unparseable installation_id: {inst!r}")
            continue

        # Validate part_name vs. slot's expected part_code.
        raw_name = getattr(row, "part_name", None)
        resolved_code = resolve_part_code_from_name(raw_name or "")
        if resolved_code and resolved_code != slot.part_code:
            report.name_mismatches += 1
            report.warnings.append(
                f"{inst}: tracker says {raw_name!r} ({resolved_code}) but slot is {slot.part_code}"
            )
            # Slot wins — installation_id is the canonical source.

        equipment_seen.setdefault(slot.equipment_id, {
            "equipment_id": slot.equipment_id,
            "display_name": f"C55 Equipment {slot.equipment_id}",
        })
        seen_slots.setdefault(slot.installation_id, slot)

        install_dt = coerce_date(getattr(row, "installation_date", None))
        removal_dt = coerce_date(getattr(row, "removal_date", None))
        if install_dt is None:
            report.warnings.append(f"{inst}: missing installation_date — skipped")
            continue

        raw_fm = getattr(row, "failure_mode", None)
        fm = normalise_failure_mode(raw_fm)
        raw_fm_present = (
            raw_fm is not None
            and not (isinstance(raw_fm, float) and pd.isna(raw_fm))
            and str(raw_fm).strip().lower() not in ("", "nan")
        )
        if raw_fm_present and not fm:
            report.unknown_failure_modes += 1
            report.warnings.append(f"{inst}: unknown failure_mode {raw_fm!r}")

        runtime_legacy = getattr(row, "_8", None)  # 'runtime (minutes)' → tuple-name munged
        # Pandas itertuples munges 'runtime (minutes)' awkwardly; fall back to dict access.
        runtime_legacy = None
        for attr in ("runtime__minutes_", "runtime_minutes", "runtime", "runtime_minutes_"):
            if hasattr(row, attr):
                runtime_legacy = getattr(row, attr)
                break
        if runtime_legacy is None:
            # Final fallback — locate by index using known column order.
            try:
                runtime_legacy = list(row)[8]
            except IndexError:
                runtime_legacy = None
        try:
            runtime_int = int(runtime_legacy) if runtime_legacy is not None and not pd.isna(runtime_legacy) else None
        except (TypeError, ValueError):
            runtime_int = None

        notes_raw = getattr(row, "notes", None)
        wo_raw = None
        for attr in ("work_order__removal_", "work_order_removal", "work_order", "work_order_removal_"):
            if hasattr(row, attr):
                wo_raw = getattr(row, attr)
                break
        if wo_raw is None:
            try:
                wo_raw = list(row)[9]
            except IndexError:
                wo_raw = None

        refurb_raw = getattr(row, "Refurb_", None) or getattr(row, "Refurb", None)
        refurb = bool(refurb_raw) and str(refurb_raw).strip().lower() in {"y", "yes", "true", "1"}

        lifecycles.append(LifecycleRow(
            installation_id=inst,
            serial_number=str(getattr(row, "serial_number", "") or "").strip(),
            is_refurb=refurb,
            installation_date=install_dt.replace(tzinfo=install_dt.tzinfo or timezone.utc).isoformat(),
            removal_date=(removal_dt.replace(tzinfo=removal_dt.tzinfo or timezone.utc).isoformat()
                          if removal_dt else None),
            failure_mode=fm,
            failure_notes=(str(notes_raw).strip() if notes_raw and not pd.isna(notes_raw) else None),
            runtime_minutes_legacy=runtime_int,
            work_order=(str(wo_raw).strip() if wo_raw and not pd.isna(wo_raw) and not str(wo_raw).startswith("#") else None),
        ))
        report.lifecycles_imported += 1

    return list(equipment_seen.values()), list(seen_slots.values()), lifecycles, report


# --------------------------------------------------------------------------- #
# Emitters                                                                    #
# --------------------------------------------------------------------------- #


def sql_str(v: Any) -> str:
    """Postgres-safe literal."""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v).replace("'", "''")
    return f"'{s}'"


def emit_seed_sql(
    equipment: list[dict[str, Any]],
    slots: list[SlotRow],
    lifecycles: list[LifecycleRow],
    out_path: Path,
) -> None:
    lines: list[str] = [
        "-- Generated by scripts/import_tracker.py — re-runnable.",
        "-- Order: equipment → part_catalog → installation_slot → part_lifecycle.",
        "",
        "begin;",
        "",
    ]

    # Equipment
    for eq in equipment:
        lines.append(
            f"insert into public.equipment (equipment_id, display_name) "
            f"values ({sql_str(eq['equipment_id'])}, {sql_str(eq['display_name'])}) "
            f"on conflict (equipment_id) do update set display_name = excluded.display_name;"
        )
    lines.append("")

    # Part catalog (idempotent — pulled from in-process constants)
    for code, name in PART_CODE_TO_NAME.items():
        category = (
            "homogenizer" if code in {"HVB", "CSEAT", "IR", "CSTEM"}
            else "manifold" if code == "OM"
            else "instrument" if code == "TR"
            else "pump" if code in {"PLG", "BUS", "PB", "BSPB"}
            else "cluster"
        )
        is_consumable = code in CONSUMABLE_CODES
        is_structural = code in STRUCTURAL_CODES
        mtbf = DEFAULT_MTBF.get(code)
        insp = INSPECTION_MIN.get(code)
        fail = FAILURE_MIN.get(code)
        seal_lo = SEAL_LIFE_LOW if is_consumable else None
        seal_hi = SEAL_LIFE_HIGH if is_consumable else None
        lines.append(
            "insert into public.part_catalog "
            "(part_code, display_name, category, is_consumable, is_structural, "
            "expected_mtbf_minutes, inspection_threshold_min, failure_threshold_min, "
            "seal_life_low_min, seal_life_high_min) values ("
            f"{sql_str(code)}, {sql_str(name)}, {sql_str(category)}, "
            f"{sql_str(is_consumable)}, {sql_str(is_structural)}, "
            f"{sql_str(mtbf)}, {sql_str(insp)}, {sql_str(fail)}, "
            f"{sql_str(seal_lo)}, {sql_str(seal_hi)}) "
            "on conflict (part_code) do update set "
            "display_name = excluded.display_name, category = excluded.category, "
            "is_consumable = excluded.is_consumable, is_structural = excluded.is_structural, "
            "expected_mtbf_minutes = excluded.expected_mtbf_minutes, "
            "inspection_threshold_min = excluded.inspection_threshold_min, "
            "failure_threshold_min = excluded.failure_threshold_min, "
            "seal_life_low_min = excluded.seal_life_low_min, "
            "seal_life_high_min = excluded.seal_life_high_min;"
        )
    lines.append("")

    # Installation slots
    for slot in slots:
        lines.append(
            "insert into public.installation_slot "
            "(installation_id, equipment_id, part_code, zone, orientation, slot_index, sequence_order) "
            f"values ({sql_str(slot.installation_id)}, {sql_str(slot.equipment_id)}, "
            f"{sql_str(slot.part_code)}, {sql_str(slot.zone)}, {sql_str(slot.orientation)}, "
            f"{sql_str(slot.slot_index)}, {sql_str(slot.sequence_order)}) "
            "on conflict (installation_id) do update set "
            "equipment_id = excluded.equipment_id, part_code = excluded.part_code, "
            "zone = excluded.zone, orientation = excluded.orientation, "
            "slot_index = excluded.slot_index, sequence_order = excluded.sequence_order;"
        )
    lines.append("")

    # Lifecycles — composite-unique on (installation_id, installation_date)
    for lc in lifecycles:
        lines.append(
            "insert into public.part_lifecycle "
            "(installation_id, serial_number, is_refurb, installation_date, removal_date, "
            "failure_mode, failure_notes, active_runtime_minutes) values ("
            f"{sql_str(lc.installation_id)}, {sql_str(lc.serial_number or '')}, "
            f"{sql_str(lc.is_refurb)}, {sql_str(lc.installation_date)}, "
            f"{sql_str(lc.removal_date)}, {sql_str(lc.failure_mode)}, "
            f"{sql_str(lc.failure_notes)}, {sql_str(lc.runtime_minutes_legacy or 0)}) "
            "on conflict (installation_id, installation_date) do update set "
            "serial_number = excluded.serial_number, is_refurb = excluded.is_refurb, "
            "removal_date = excluded.removal_date, failure_mode = excluded.failure_mode, "
            "failure_notes = excluded.failure_notes, "
            "active_runtime_minutes = greatest(public.part_lifecycle.active_runtime_minutes, excluded.active_runtime_minutes);"
        )
    lines.append("")
    lines.append("commit;")
    lines.append("")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines), encoding="utf-8")


def emit_lifecycles_json(
    equipment: list[dict[str, Any]],
    slots: list[SlotRow],
    lifecycles: list[LifecycleRow],
    report: ImportReport,
    out_path: Path,
) -> None:
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "equipment": equipment,
        "slots": [asdict(s) for s in slots],
        "lifecycles": [asdict(lc) for lc in lifecycles],
        "report": {
            "rows_total": report.rows_total,
            "lifecycles_imported": report.lifecycles_imported,
            "skipped_no_install": report.skipped_no_install,
            "skipped_bad_id": report.skipped_bad_id,
            "name_mismatches": report.name_mismatches,
            "unknown_failure_modes": report.unknown_failure_modes,
            "warning_count": len(report.warnings),
        },
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")


# --------------------------------------------------------------------------- #
# CLI                                                                         #
# --------------------------------------------------------------------------- #


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--xlsx", type=Path, default=Path("MTBF Tracker_cursor.xlsx"))
    p.add_argument("--seed", type=Path, default=Path("supabase/seed.sql"))
    p.add_argument("--json", type=Path, default=Path("public/lifecycles.json"))
    p.add_argument("--verbose", action="store_true", help="Print all warnings.")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    if not args.xlsx.exists():
        print(f"[import] xlsx not found: {args.xlsx}", file=sys.stderr)
        return 2

    equipment, slots, lifecycles, report = import_tracker(args.xlsx)
    emit_seed_sql(equipment, slots, lifecycles, args.seed)
    emit_lifecycles_json(equipment, slots, lifecycles, report, args.json)

    print(
        f"[import] {report.lifecycles_imported}/{report.rows_total} lifecycles "
        f"({len(slots)} slots, {len(equipment)} equipment) "
        f"→ {args.seed} + {args.json}"
    )
    if report.skipped_bad_id:
        print(f"[import]   skipped_bad_id: {report.skipped_bad_id}")
    if report.name_mismatches:
        print(f"[import]   part_name mismatches: {report.name_mismatches}")
    if report.unknown_failure_modes:
        print(f"[import]   unknown failure_modes: {report.unknown_failure_modes}")
    if args.verbose:
        for w in report.warnings:
            print(f"[import]   ! {w}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
