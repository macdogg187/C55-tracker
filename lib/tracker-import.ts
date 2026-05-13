import "server-only";
import ExcelJS from "exceljs";
import {
  PART_CATALOG,
  FAILURE_MODES,
  type FailureMode,
  type Orientation,
  type Zone,
} from "@/lib/parts-catalog";

// =============================================================================
// TypeScript port of scripts/import_tracker.py — converts a Tracker workbook
// upload (Buffer / ArrayBuffer) into normalised rows that the LifecycleStore
// can UPSERT idempotently.
//
// One source of truth lives in Python (the offline backfill). This port is
// only invoked when an operator drops a fresh .xlsx through the browser.
// Anything that diverges from Python should be migrated back upstream.
// =============================================================================

const CLUSTER_SLOTS: Record<number, string> = {
  1: "ICVB", 2: "HPT", 3: "OCVB", 4: "ICVBS", 5: "OCVBS",
};
const PUMP_SLOTS: Record<number, string> = {
  1: "PLG", 2: "BUS", 3: "PB", 4: "CVBSPB",
};
const HEAD_SLOTS: Record<number, string> = {
  1: "HVB", 2: "CSEAT", 3: "IR", 4: "CSTEM",
};

const SEQUENCE_BASE: Record<string, number> = {
  "cluster:left": 100, "cluster:middle": 110, "cluster:right": 120,
  "pump:left": 200, "pump:middle": 210, "pump:right": 220,
  "manifold:center": 300, "homogenizer:center": 400, "instrument:center": 500,
};

// Lower-cased aliases → canonical part_code. Mirrors NAME_ALIASES in Python.
const NAME_ALIASES: Record<string, string> = {};
for (const [code, entry] of Object.entries(PART_CATALOG)) {
  NAME_ALIASES[entry.displayName.toLowerCase()] = code;
}
Object.assign(NAME_ALIASES, {
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
  "check valve ball seat (pump body)": "CVBSPB",
  "check valve ball": "CVBALL",
  "check valve spring": "SPRING",
  "spring": "SPRING",
});

// Free-text failure-mode → canonical schema enum.
const FAILURE_MODE_ALIASES: Record<string, FailureMode> = {
  "fracture (port)": "fracture (port)",
  "fracture (body)": "fracture (body)",
  "normal wear": "normal wear",
  "scratches": "scratches",
  "binding (threads)": "binding (threads)",
  "other (explain in notes)": "other",
  "other": "other",
  "unknown": "unknown",
  "weephole leak": "weephole leak",
  "weep hole leak": "weephole leak",
  "thread fracture": "thread fracture",
  "internal erosion": "internal erosion",
  "thermal drift": "thermal drift",
};

// Group 1 = equipment_id, group 2 = slot suffix.
const SLOT_RE = /^(\d{3,5})_([A-Z]{1,2}\d?)$/;

export type ParsedSlot = {
  installation_id: string;
  equipment_id: string;
  part_code: string;
  zone: Zone;
  orientation: Orientation;
  slot_index: number | null;
  sequence_order: number;
};

export type ParsedLifecycle = {
  installation_id: string;
  serial_number: string;
  is_refurb: boolean;
  installation_date: string;        // ISO
  removal_date: string | null;
  failure_mode: FailureMode | null;
  failure_notes: string | null;
  active_runtime_minutes: number;
  work_order: string | null;
};

export type ParsedEquipment = {
  equipment_id: string;
  display_name: string;
};

export type TrackerImportReport = {
  rows_total: number;
  lifecycles_imported: number;
  skipped_no_install: number;
  skipped_bad_id: number;
  skipped_no_install_date: number;
  missing_serial_number: number;
  missing_runtime: number;
  missing_failure_mode_for_closed: number;
  name_mismatches: number;
  unknown_failure_modes: number;
  warnings: string[];
  // ExcelJS load failed cleanly (we still return a usable empty result so
  // the UI can render the warning without a 500).
  fatal: string | null;
};

export type TrackerImportResult = {
  equipment: ParsedEquipment[];
  slots: ParsedSlot[];
  lifecycles: ParsedLifecycle[];
  report: TrackerImportReport;
};

function parseSlot(rawId: string): ParsedSlot | null {
  const m = SLOT_RE.exec(rawId.trim());
  if (!m) return null;
  const eq = m[1];
  const slot = m[2];

  const cluster = /^([LMR])C([1-5])$/.exec(slot);
  if (cluster) {
    const orient: Orientation = ({ L: "left", M: "middle", R: "right" } as const)[
      cluster[1] as "L" | "M" | "R"
    ];
    const idx = Number(cluster[2]);
    const code = CLUSTER_SLOTS[idx];
    if (!code) return null;
    return {
      installation_id: rawId,
      equipment_id: eq,
      part_code: code,
      zone: "cluster",
      orientation: orient,
      slot_index: idx,
      sequence_order: SEQUENCE_BASE[`cluster:${orient}`] + idx,
    };
  }
  const pump = /^([LMR])P([1-5])$/.exec(slot);
  if (pump) {
    const orient: Orientation = ({ L: "left", M: "middle", R: "right" } as const)[
      pump[1] as "L" | "M" | "R"
    ];
    const idx = Number(pump[2]);
    const code = PUMP_SLOTS[idx];
    if (!code) return null;
    return {
      installation_id: rawId,
      equipment_id: eq,
      part_code: code,
      zone: "pump",
      orientation: orient,
      slot_index: idx,
      sequence_order: SEQUENCE_BASE[`pump:${orient}`] + idx,
    };
  }
  const head = /^H([1-4])$/.exec(slot);
  if (head) {
    const idx = Number(head[1]);
    const code = HEAD_SLOTS[idx];
    if (!code) return null;
    return {
      installation_id: rawId,
      equipment_id: eq,
      part_code: code,
      zone: "homogenizer",
      orientation: "center",
      slot_index: idx,
      sequence_order: SEQUENCE_BASE["homogenizer:center"] + idx,
    };
  }
  if (slot === "O") {
    return {
      installation_id: rawId,
      equipment_id: eq,
      part_code: "OM",
      zone: "manifold",
      orientation: "center",
      slot_index: null,
      sequence_order: SEQUENCE_BASE["manifold:center"],
    };
  }
  if (slot === "T") {
    return {
      installation_id: rawId,
      equipment_id: eq,
      part_code: "TR",
      zone: "instrument",
      orientation: "center",
      slot_index: null,
      sequence_order: SEQUENCE_BASE["instrument:center"],
    };
  }
  return null;
}

function resolveCodeFromName(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const key = String(raw).trim().toLowerCase();
  if (!key) return null;
  if (NAME_ALIASES[key]) return NAME_ALIASES[key];
  const stripped = key.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  return NAME_ALIASES[stripped] ?? null;
}

function normaliseFailureMode(raw: unknown): FailureMode | null {
  if (raw === null || raw === undefined) return null;
  const key = String(raw).trim().toLowerCase();
  if (!key || key === "nan") return null;
  if (FAILURE_MODE_ALIASES[key]) return FAILURE_MODE_ALIASES[key];
  return (FAILURE_MODES as readonly string[]).includes(key)
    ? (key as FailureMode)
    : null;
}

function coerceCellValue(v: ExcelJS.CellValue): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object" && v !== null) {
    const obj = v as unknown as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (Array.isArray(obj.richText)) {
      return (obj.richText as { text?: string }[])
        .map((r) => r.text ?? "")
        .join("");
    }
    if ("result" in obj) return obj.result;
    if ("hyperlink" in obj && "text" in obj) return obj.text;
  }
  return v;
}

function coerceDate(raw: unknown): Date | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return Number.isFinite(raw.getTime()) ? raw : null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Excel serial date → JS Date. 25569 = days between 1900-01-01 epoch and Unix.
    const ms = Math.round((raw - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return null;
    const low = s.toLowerCase();
    if (["unknown", "?", "tbd", "n/a", "na"].includes(low) || s.startsWith("#")) {
      return null;
    }
    const d = new Date(s);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

function coerceBool(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  if (typeof raw === "boolean") return raw;
  const s = String(raw).trim().toLowerCase();
  return ["y", "yes", "true", "1"].includes(s);
}

function coerceInt(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : null;
}

function asString(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (raw instanceof Date) return raw.toISOString();
  return String(raw).trim();
}

const HEADER_ALIASES: Record<string, string> = {
  installation_id: "installation_id",
  install_id: "installation_id",
  slot: "installation_id",
  part_name: "part_name",
  part: "part_name",
  component: "part_name",
  serial_number: "serial_number",
  serial: "serial_number",
  installation_date: "installation_date",
  install_date: "installation_date",
  removal_date: "removal_date",
  remove_date: "removal_date",
  failure_mode: "failure_mode",
  fail_mode: "failure_mode",
  notes: "notes",
  comment: "notes",
  comments: "notes",
  runtime_minutes: "runtime_minutes",
  runtime: "runtime_minutes",
  work_order: "work_order",
  work_order_removal: "work_order",
  wo: "work_order",
  refurb: "is_refurb",
  is_refurb: "is_refurb",
};

function normaliseHeader(label: string): string | null {
  const k = label
    .trim()
    .toLowerCase()
    .replace(/[()/]/g, "")
    .replace(/\s+/g, "_")
    .replace(/__+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
  if (!k) return null;
  if (HEADER_ALIASES[k]) return HEADER_ALIASES[k];
  // Loose matches: "installation_id" might come in as "installationid" or
  // "installation_id_1"; try a few stems.
  for (const [alias, canon] of Object.entries(HEADER_ALIASES)) {
    if (k.includes(alias)) return canon;
  }
  return null;
}

function emptyReport(): TrackerImportReport {
  return {
    rows_total: 0,
    lifecycles_imported: 0,
    skipped_no_install: 0,
    skipped_bad_id: 0,
    skipped_no_install_date: 0,
    missing_serial_number: 0,
    missing_runtime: 0,
    missing_failure_mode_for_closed: 0,
    name_mismatches: 0,
    unknown_failure_modes: 0,
    warnings: [],
    fatal: null,
  };
}

export async function parseTrackerWorkbook(
  source: ArrayBuffer | Buffer,
  sheetName = "Tracker",
): Promise<TrackerImportResult> {
  const report = emptyReport();

  const wb = new ExcelJS.Workbook();
  const buf: ArrayBuffer =
    source instanceof ArrayBuffer
      ? source
      : (source.buffer.slice(
          source.byteOffset,
          source.byteOffset + source.byteLength,
        ) as ArrayBuffer);

  try {
    await wb.xlsx.load(buf);
  } catch (err) {
    report.fatal = `workbook load failed: ${(err as Error).message}`;
    return { equipment: [], slots: [], lifecycles: [], report };
  }

  let sheet = wb.getWorksheet(sheetName);
  if (!sheet) {
    // Fall back to first sheet that has the expected header set.
    sheet = wb.worksheets[0];
    if (sheet) {
      report.warnings.push(
        `requested sheet "${sheetName}" not found — using "${sheet.name}"`,
      );
    }
  }
  if (!sheet) {
    report.fatal = "workbook has no worksheets";
    return { equipment: [], slots: [], lifecycles: [], report };
  }

  const headerRow = sheet.getRow(1);
  const headerMap: Record<number, string> = {};
  headerRow.eachCell({ includeEmpty: false }, (cell, colIdx) => {
    const label = asString(coerceCellValue(cell.value));
    const canon = normaliseHeader(label);
    if (canon) headerMap[colIdx] = canon;
  });

  const requiredHeaders = ["installation_id", "installation_date"];
  for (const h of requiredHeaders) {
    if (!Object.values(headerMap).includes(h)) {
      report.fatal =
        `tracker sheet "${sheet.name}" missing required column ${h} ` +
        `(found: ${Object.values(headerMap).join(", ") || "<none>"})`;
      return { equipment: [], slots: [], lifecycles: [], report };
    }
  }

  const equipmentById = new Map<string, ParsedEquipment>();
  const slotById = new Map<string, ParsedSlot>();
  const lifecycles: ParsedLifecycle[] = [];

  const lastRow = sheet.actualRowCount ?? sheet.rowCount;
  for (let r = 2; r <= lastRow; r++) {
    const row = sheet.getRow(r);
    if (!row || row.actualCellCount === 0) continue;
    const record: Record<string, unknown> = {};
    try {
      row.eachCell({ includeEmpty: false }, (cell, colIdx) => {
        const key = headerMap[colIdx];
        if (key) record[key] = coerceCellValue(cell.value);
      });
    } catch (err) {
      // A single corrupt cell shouldn't blow up the import — record it and
      // continue with whatever we managed to extract.
      report.warnings.push(`row ${r}: cell read error — ${(err as Error).message}`);
    }
    if (Object.keys(record).length === 0) continue;
    report.rows_total += 1;

    const rawInst = asString(record.installation_id);
    if (!rawInst || rawInst.toLowerCase() === "nan") {
      report.skipped_no_install += 1;
      continue;
    }
    const slot = parseSlot(rawInst);
    if (!slot) {
      report.skipped_bad_id += 1;
      report.warnings.push(`unparseable installation_id: ${JSON.stringify(rawInst)}`);
      continue;
    }

    const resolvedFromName = resolveCodeFromName(record.part_name);
    if (resolvedFromName && resolvedFromName !== slot.part_code) {
      report.name_mismatches += 1;
      report.warnings.push(
        `${rawInst}: tracker says ${JSON.stringify(record.part_name)} ` +
          `(${resolvedFromName}) but slot is ${slot.part_code}`,
      );
    }

    if (!equipmentById.has(slot.equipment_id)) {
      equipmentById.set(slot.equipment_id, {
        equipment_id: slot.equipment_id,
        display_name: `C55 Equipment ${slot.equipment_id}`,
      });
    }
    if (!slotById.has(slot.installation_id)) {
      slotById.set(slot.installation_id, slot);
    }

    const installDate = coerceDate(record.installation_date);
    if (!installDate) {
      report.skipped_no_install_date += 1;
      report.warnings.push(`${rawInst}: missing/unparseable installation_date — skipped`);
      continue;
    }
    const removalDate = coerceDate(record.removal_date);

    const rawFm = record.failure_mode;
    const fm = normaliseFailureMode(rawFm);
    const fmPresent = rawFm !== null && rawFm !== undefined && String(rawFm).trim() !== "";
    if (fmPresent && !fm) {
      report.unknown_failure_modes += 1;
      report.warnings.push(`${rawInst}: unknown failure_mode ${JSON.stringify(rawFm)}`);
    }
    if (removalDate && !fm) {
      // A closed lifecycle with no failure_mode is a data-quality smell —
      // we still import it (with failure_mode=null) so the predictor can
      // ignore it cleanly.
      report.missing_failure_mode_for_closed += 1;
      report.warnings.push(
        `${rawInst}: closed (${removalDate.toISOString()}) but missing failure_mode`,
      );
    }

    const serial = asString(record.serial_number);
    if (!serial) {
      report.missing_serial_number += 1;
      // Don't warn per row — the counter is enough to keep the warnings list
      // legible. The lifecycle still imports with an empty serial.
    }

    const runtime = coerceInt(record.runtime_minutes);
    if (runtime === null) {
      report.missing_runtime += 1;
    }

    lifecycles.push({
      installation_id: rawInst,
      serial_number: serial,
      is_refurb: coerceBool(record.is_refurb),
      installation_date: installDate.toISOString(),
      removal_date: removalDate ? removalDate.toISOString() : null,
      failure_mode: fm,
      failure_notes: asString(record.notes) || null,
      active_runtime_minutes: runtime ?? 0,
      work_order: asString(record.work_order) || null,
    });
    report.lifecycles_imported += 1;
  }

  return {
    equipment: Array.from(equipmentById.values()),
    slots: Array.from(slotById.values()),
    lifecycles,
    report,
  };
}
