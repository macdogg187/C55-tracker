import {
  PART_CATALOG,
  buildSlotsForEquipment,
  type SlotDef,
} from "./parts-catalog";

export type Health = "nominal" | "watch" | "critical";

export type PartStatus = {
  id: string;                          // installation_id
  installationId: string;
  equipmentId: string;
  partCode: string;
  partName: string;
  category: string;
  isConsumable: boolean;
  isStructural: boolean;
  // true → part requires an individual serial number (ICVB, HPT, OCVB, HVB, PB).
  // false → non-serialized; tracked by type/position rather than unit serial.
  isSerialized: boolean;
  zone: SlotDef["zone"];
  orientation: SlotDef["orientation"];
  sequenceOrder: number;
  serialNumber: string;
  installationDate?: string;
  granularRuntimeMinutes: number;
  highStressMinutes: number;
  cumulativePressureStress: number;
  expectedMtbfMinutes: number | null;
  inspectionThresholdMin?: number | null;
  failureThresholdMin?: number | null;
  sealLifeLowMin?: number;
  sealLifeHighMin?: number;
  health: Health;
  alert: "inspection" | "failure" | null;
};

// Build a complete slot-map from the canonical catalog so the UI can render
// every position in the machine, including currently-empty ones.
export function buildSeedPartStatuses(equipmentId: string): PartStatus[] {
  return buildSlotsForEquipment(equipmentId).map((slot) => {
    const catalog = PART_CATALOG[slot.partCode];
    return {
      id: slot.installationId,
      installationId: slot.installationId,
      equipmentId,
      partCode: slot.partCode,
      partName: catalog.displayName,
      category: catalog.category,
      isConsumable: catalog.isConsumable,
      isStructural: catalog.isStructural,
      isSerialized: catalog.isSerialized ?? false,
      zone: slot.zone,
      orientation: slot.orientation,
      sequenceOrder: slot.sequenceOrder,
      serialNumber: "",
      granularRuntimeMinutes: 0,
      highStressMinutes: 0,
      cumulativePressureStress: 0,
      expectedMtbfMinutes: catalog.expectedMtbfMinutes ?? null,
      inspectionThresholdMin: catalog.inspectionThresholdMin ?? null,
      failureThresholdMin: catalog.failureThresholdMin ?? null,
      sealLifeLowMin: catalog.sealLifeLowMin,
      sealLifeHighMin: catalog.sealLifeHighMin,
      health: "nominal",
      alert: null,
    };
  });
}

// Default seed for equipment 0091 — the line shown in the demo dashboard.
export const partStatuses: PartStatus[] = buildSeedPartStatuses("0091");
