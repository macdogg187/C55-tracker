// Canonical part nomenclature for the C55 production line.
// Sourced from `MTBF Tracker_cursor.xlsx → "Data Validation"` so names
// round-trip 1:1 with the legacy Excel tracker.
//
// Installation IDs follow the format `{equipment}_{slot}` where slot is:
//   LC1..LC5 / MC1..MC5 / RC1..RC5  → cluster (left/middle/right) positions
//   LP1..LP4 / MP1..MP4 / RP1..RP4  → pump (left/middle/right) positions
//   H1..H4                           → homogenizer head (valve, seat, ring, stem)
//   O                                → outlet manifold
//   T                                → transducer
//
// `sequenceOrder` reflects the *physical, sequential* production flow of fluid
// through the machine and drives the new sequential flowchart.

export type PartCategory =
  | "homogenizer"
  | "cluster"
  | "pump"
  | "manifold"
  | "instrument";

export type Orientation = "left" | "middle" | "right" | "center";
export type Zone = "cluster" | "pump" | "homogenizer" | "manifold" | "instrument";

export type PartCatalogEntry = {
  partCode: string;
  displayName: string;
  category: PartCategory;
  isConsumable: boolean;
  isStructural: boolean;
  // Parts requiring an individual serial number for lifecycle tracking.
  // All others are treated as non-serialized (installed by type, not by unit).
  isSerialized?: boolean;
  expectedMtbfMinutes?: number;
  inspectionThresholdMin?: number;
  failureThresholdMin?: number;
  sealLifeLowMin?: number;
  sealLifeHighMin?: number;
};

export const PART_CATALOG: Record<string, PartCatalogEntry> = {
  ICVB: {
    partCode: "ICVB",
    displayName: "Inlet Check Valve Body",
    category: "cluster",
    isConsumable: false,
    isStructural: false,
    isSerialized: true,
    expectedMtbfMinutes: 10000,
  },
  HPT: {
    partCode: "HPT",
    displayName: "High Pressure Tee",
    category: "cluster",
    isConsumable: false,
    isStructural: true,
    isSerialized: true,
    expectedMtbfMinutes: 9000,
    inspectionThresholdMin: 2000,
    failureThresholdMin: 2400,
  },
  OCVB: {
    partCode: "OCVB",
    displayName: "Outlet Check Valve Body",
    category: "cluster",
    isConsumable: false,
    isStructural: false,
    isSerialized: true,
    expectedMtbfMinutes: 11000,
  },
  ICVBS: {
    partCode: "ICVBS",
    displayName: "Inlet Check Valve Ball Seat",
    category: "cluster",
    isConsumable: true,
    isStructural: false,
    sealLifeLowMin: 800,
    sealLifeHighMin: 1200,
  },
  OCVBS: {
    partCode: "OCVBS",
    displayName: "Outlet Check Valve Ball Seat",
    category: "cluster",
    isConsumable: true,
    isStructural: false,
    sealLifeLowMin: 800,
    sealLifeHighMin: 1200,
  },
  CVBALL: {
    partCode: "CVBALL",
    displayName: "Check Valve Ball",
    category: "cluster",
    isConsumable: true,
    isStructural: false,
    sealLifeLowMin: 800,
    sealLifeHighMin: 1200,
  },
  PLG: {
    partCode: "PLG",
    displayName: "Plunger",
    category: "pump",
    isConsumable: false,
    isStructural: false,
    expectedMtbfMinutes: 8000,
  },
  BUS: {
    partCode: "BUS",
    displayName: "Backup Support Seal (BUS)",
    category: "pump",
    isConsumable: true,
    isStructural: false,
    sealLifeLowMin: 800,
    sealLifeHighMin: 1200,
  },
  PB: {
    partCode: "PB",
    displayName: "Pump Body",
    category: "pump",
    isConsumable: false,
    isStructural: true,
    isSerialized: true,
    expectedMtbfMinutes: 15000,
    inspectionThresholdMin: 12000,
    failureThresholdMin: 14500,
  },
  BSPB: {
    partCode: "BSPB",
    displayName: "Ball Seat (Pump Body)",
    category: "pump",
    isConsumable: true,
    isStructural: false,
    sealLifeLowMin: 800,
    sealLifeHighMin: 1200,
  },
  SPRING: {
    partCode: "SPRING",
    displayName: "Check Valve Spring",
    category: "cluster",
    isConsumable: true,
    isStructural: false,
    sealLifeLowMin: 800,
    sealLifeHighMin: 1200,
  },
  HVB: {
    partCode: "HVB",
    displayName: "Homogenizing Valve Body",
    category: "homogenizer",
    isConsumable: false,
    isStructural: false,
    isSerialized: true,
    expectedMtbfMinutes: 12000,
  },
  CSEAT: {
    partCode: "CSEAT",
    displayName: "Ceramic Seat",
    category: "homogenizer",
    isConsumable: false,
    isStructural: false,
    expectedMtbfMinutes: 6000,
  },
  IR: {
    partCode: "IR",
    displayName: "Impact Ring",
    category: "homogenizer",
    isConsumable: false,
    isStructural: false,
    expectedMtbfMinutes: 6000,
  },
  CSTEM: {
    partCode: "CSTEM",
    displayName: "Ceramic Stem",
    category: "homogenizer",
    isConsumable: false,
    isStructural: false,
    expectedMtbfMinutes: 6000,
  },
  OM: {
    partCode: "OM",
    displayName: "Outlet Manifold",
    category: "manifold",
    isConsumable: false,
    isStructural: true,
    expectedMtbfMinutes: 18000,
    inspectionThresholdMin: 14000,
    failureThresholdMin: 17000,
  },
  TR: {
    partCode: "TR",
    displayName: "Transducer",
    category: "instrument",
    isConsumable: false,
    isStructural: false,
    expectedMtbfMinutes: 20000,
  },
};

// Cluster slot 1..5 → part code mapping (left, middle, right share the schema)
const CLUSTER_SLOTS: Record<number, string> = {
  1: "ICVB",
  2: "HPT",
  3: "OCVB",
  4: "ICVBS",
  5: "OCVBS",
};

// Pump slot 1..4
const PUMP_SLOTS: Record<number, string> = {
  1: "PLG",
  2: "BUS",
  3: "PB",
  4: "BSPB",
};

// Homogenizer head slot 1..4
const HEAD_SLOTS: Record<number, string> = {
  1: "HVB",
  2: "CSEAT",
  3: "IR",
  4: "CSTEM",
};

export type SlotDef = {
  installationId: string;
  equipmentId: string;
  partCode: string;
  zone: Zone;
  orientation: Orientation;
  slotIndex?: number;
  sequenceOrder: number;
};

// Sequential physical flow:
//   1) Inlet manifold (not tracked)
//   → 2) Three Inlet Check Valve clusters (ICVB → HPT → OCVB → seats)
//   → 3) Three Pumps (Plunger → BUS → Pump Body → CV Ball Seat)
//   → 4) Outlet Manifold
//   → 5) Homogenizer head (HVB → Ceramic Seat → Impact Ring → Ceramic Stem)
//   → 6) Transducer (instrumentation)
const SEQUENCE_BY_ZONE_ORIENTATION: Record<string, number> = {
  "cluster:left": 100,
  "cluster:middle": 110,
  "cluster:right": 120,
  "pump:left": 200,
  "pump:middle": 210,
  "pump:right": 220,
  "manifold:center": 300,
  "homogenizer:center": 400,
  "instrument:center": 500,
};

export function buildSlotsForEquipment(equipmentId: string): SlotDef[] {
  const slots: SlotDef[] = [];

  const orientations: { code: string; orientation: Orientation }[] = [
    { code: "L", orientation: "left" },
    { code: "M", orientation: "middle" },
    { code: "R", orientation: "right" },
  ];

  for (const { code, orientation } of orientations) {
    for (const [idxStr, partCode] of Object.entries(CLUSTER_SLOTS)) {
      const slotIndex = Number(idxStr);
      slots.push({
        installationId: `${equipmentId}_${code}C${slotIndex}`,
        equipmentId,
        partCode,
        zone: "cluster",
        orientation,
        slotIndex,
        sequenceOrder:
          (SEQUENCE_BY_ZONE_ORIENTATION[`cluster:${orientation}`] ?? 0) +
          slotIndex,
      });
    }
    for (const [idxStr, partCode] of Object.entries(PUMP_SLOTS)) {
      const slotIndex = Number(idxStr);
      slots.push({
        installationId: `${equipmentId}_${code}P${slotIndex}`,
        equipmentId,
        partCode,
        zone: "pump",
        orientation,
        slotIndex,
        sequenceOrder:
          (SEQUENCE_BY_ZONE_ORIENTATION[`pump:${orientation}`] ?? 0) +
          slotIndex,
      });
    }
  }

  for (const [idxStr, partCode] of Object.entries(HEAD_SLOTS)) {
    const slotIndex = Number(idxStr);
    slots.push({
      installationId: `${equipmentId}_H${slotIndex}`,
      equipmentId,
      partCode,
      zone: "homogenizer",
      orientation: "center",
      slotIndex,
      sequenceOrder:
        SEQUENCE_BY_ZONE_ORIENTATION["homogenizer:center"] + slotIndex,
    });
  }

  slots.push({
    installationId: `${equipmentId}_O`,
    equipmentId,
    partCode: "OM",
    zone: "manifold",
    orientation: "center",
    sequenceOrder: SEQUENCE_BY_ZONE_ORIENTATION["manifold:center"],
  });
  slots.push({
    installationId: `${equipmentId}_T`,
    equipmentId,
    partCode: "TR",
    zone: "instrument",
    orientation: "center",
    sequenceOrder: SEQUENCE_BY_ZONE_ORIENTATION["instrument:center"],
  });

  return slots.sort((a, b) => a.sequenceOrder - b.sequenceOrder);
}

export const FAILURE_MODES = [
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
] as const;

export type FailureMode = (typeof FAILURE_MODES)[number];
