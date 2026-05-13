"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  buildSeedPartStatuses,
  type PartStatus,
} from "@/lib/dashboard-data";
import { PART_CATALOG, FAILURE_MODES, type FailureMode } from "@/lib/parts-catalog";
import type { PartRecord, PipelinePayload } from "@/lib/analytics";

type LifecycleSnapshot = {
  installation_id: string;
  serial_number: string;
  installation_date: string;
  removal_date: string | null;
  active_runtime_minutes: number;
  high_stress_minutes: number;
  archived_at: string | null;
};

type SnapshotSlot = {
  installation_id: string;
  equipment_id: string;
  part_code: string;
  zone: PartStatus["zone"];
  orientation: PartStatus["orientation"];
  slot_index: number | null;
  sequence_order: number;
};

type SnapshotResponse = {
  backend: "supabase" | "local-json";
  equipment: { equipment_id: string; display_name: string }[];
  slots: SnapshotSlot[];
  lifecycles: LifecycleSnapshot[];
};

function buildParts(
  equipmentId: string,
  snapshot: SnapshotResponse | null,
  pipelineParts: PartRecord[],
): PartStatus[] {
  const seed = buildSeedPartStatuses(equipmentId);
  const seedById = new Map(seed.map((p) => [p.installationId, p]));

  if (snapshot) {
    for (const slot of snapshot.slots) {
      if (slot.equipment_id !== equipmentId) continue;
      if (seedById.has(slot.installation_id)) continue;
      const catalog = PART_CATALOG[slot.part_code];
      if (!catalog) continue;
      seedById.set(slot.installation_id, {
        id: slot.installation_id,
        installationId: slot.installation_id,
        equipmentId: slot.equipment_id,
        partCode: slot.part_code,
        partName: catalog.displayName,
        category: catalog.category,
        isConsumable: catalog.isConsumable,
        isStructural: catalog.isStructural,
        isSerialized: catalog.isSerialized ?? false,
        zone: slot.zone,
        orientation: slot.orientation,
        sequenceOrder: slot.sequence_order,
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
      });
    }
  }

  const lifecycleById = new Map<string, LifecycleSnapshot>();
  for (const lc of snapshot?.lifecycles ?? []) {
    if (lc.removal_date || lc.archived_at) continue;
    lifecycleById.set(lc.installation_id, lc);
  }
  const pipelineById = new Map(pipelineParts.map((p) => [p.installation_id, p]));

  return Array.from(seedById.values()).map((s) => {
    const lc = lifecycleById.get(s.installationId);
    const pp = pipelineById.get(s.installationId);
    const runtime = pp?.active_runtime_minutes ?? lc?.active_runtime_minutes ?? 0;
    const stress = pp?.high_stress_minutes ?? lc?.high_stress_minutes ?? 0;
    const mtbf = pp?.expected_mtbf_minutes || s.expectedMtbfMinutes;
    const failure = pp?.failure_threshold_min ?? s.failureThresholdMin;
    const inspection = pp?.inspection_threshold_min ?? s.inspectionThresholdMin;
    const ceiling = failure ?? mtbf ?? null;
    const pct = ceiling != null ? runtime / Math.max(1, ceiling) : null;
    const health: PartStatus["health"] =
      (pp?.health as PartStatus["health"]) ??
      (failure && runtime >= failure
        ? "critical"
        : inspection && runtime >= inspection
          ? "watch"
          : pct != null && pct >= 0.85
            ? "critical"
            : pct != null && pct >= 0.6
              ? "watch"
              : "nominal");
    const alert: PartStatus["alert"] =
      pp?.alert ??
      (failure && runtime >= failure
        ? "failure"
        : inspection && runtime >= inspection
          ? "inspection"
          : null);
    return {
      ...s,
      serialNumber: lc?.serial_number || pp?.serial_number || "",
      installationDate: lc?.installation_date ?? pp?.installation_date,
      granularRuntimeMinutes: runtime,
      highStressMinutes: stress,
      expectedMtbfMinutes: mtbf,
      inspectionThresholdMin: inspection ?? null,
      failureThresholdMin: failure ?? null,
      health,
      alert,
    };
  });
}

function wearPct(p: PartStatus) {
  const ceiling = p.failureThresholdMin ?? p.expectedMtbfMinutes ?? null;
  if (ceiling == null) return null;
  return p.granularRuntimeMinutes / Math.max(1, ceiling);
}

function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function fromDatetimeLocal(local: string): string {
  const d = new Date(local);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

const HEALTH_BADGE: Record<PartStatus["health"], string> = {
  critical: "bg-[#A82020]/15 text-[#A82020] border-[#A82020]/50",
  watch:    "bg-[#B8860B]/15 text-[#B8860B] border-[#B8860B]/50",
  nominal:  "bg-[#2B7A3E]/15 text-[#2B7A3E] border-[#2B7A3E]/50",
};

const STEP_LABELS = ["Select Part", "Enter Details", "Confirm & Complete"];

export default function ReplacePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#FAFAF5]" />}>
      <ReplaceContent />
    </Suspense>
  );
}

function ReplaceContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const equipmentId = searchParams.get("eq") ?? "0091";
  const preselectedPartId = searchParams.get("part") ?? "";

  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null);
  const [pipelineParts, setPipelineParts] = useState<PartRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [selectedPartId, setSelectedPartId] = useState<string>(preselectedPartId);
  const [newSerial, setNewSerial] = useState("");
  const [failureMode, setFailureMode] = useState<FailureMode>("normal wear");
  const [notes, setNotes] = useState("");
  const [replaceDate, setReplaceDate] = useState(toDatetimeLocal(new Date().toISOString()));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const [snapRes, pipelineRes] = await Promise.all([
          fetch("/api/lifecycles", { cache: "no-store" }),
          fetch("/pipeline.json", { cache: "no-store" }).catch(() => null),
        ]);
        if (snapRes.ok) setSnapshot((await snapRes.json()) as SnapshotResponse);
        if (pipelineRes?.ok) {
          const payload = (await pipelineRes.json()) as PipelinePayload;
          setPipelineParts(payload.parts ?? []);
        }
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  const parts = useMemo(
    () => buildParts(equipmentId, snapshot, pipelineParts),
    [equipmentId, snapshot, pipelineParts],
  );

  const replaceableParts = useMemo(() => {
    return parts
      .filter((p) => p.isSerialized || p.serialNumber)
      .sort((a, b) => {
        const healthOrder = { critical: 0, watch: 1, nominal: 2 };
        const hDiff = (healthOrder[a.health] ?? 2) - (healthOrder[b.health] ?? 2);
        if (hDiff !== 0) return hDiff;
        return (wearPct(b) ?? 0) - (wearPct(a) ?? 0);
      });
  }, [parts]);

  const selectedPart = parts.find((p) => p.id === selectedPartId) ?? null;
  const isFreshInstall = selectedPart ? !selectedPart.serialNumber : false;

  function handleSelectPart(id: string) {
    setSelectedPartId(id);
    setStep(2);
  }

  function handleBack() {
    if (step === 2) setStep(1);
    else if (step === 3) setStep(2);
  }

  async function handleSubmit() {
    if (!selectedPart) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/lifecycle/replace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          installation_id: selectedPart.installationId,
          new_serial: newSerial.trim(),
          failure_mode: failureMode,
          notes: notes.trim() || undefined,
          timestamp: fromDatetimeLocal(replaceDate),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setSuccess(true);
      setTimeout(() => {
        router.push(`/?eq=${equipmentId}&replaced=${selectedPart.installationId}`);
      }, 1800);
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#FAFAF5] text-[#1A1A16]">
      <div className="mx-auto w-full max-w-[1000px] px-5 py-8 lg:px-8">

        <div className="mb-8">
          <p className="font-barlow text-xs uppercase tracking-widest text-[#C04810]">Maintenance Workflow</p>
          <h1 className="mt-1 font-barlow text-2xl font-semibold text-[#1A1A16]">Replace / Install Part</h1>
          <p className="mt-1 text-sm text-[#787870]">
            Equipment{" "}
            <span className="text-[#C04810]">{equipmentId}</span>
          </p>
        </div>

        <StepIndicator current={step} />

        <div className="mt-8">
          {step === 1 && (
            <div>
              <p className="mb-4 text-sm text-[#4A4A42]">
                Select the part to replace or install. Parts are listed with the most critical first.
              </p>
              {loading ? (
                <p className="py-8 text-center text-sm text-[#787870]">Loading parts…</p>
              ) : (
                <div className="space-y-2">
                  {replaceableParts.map((p) => (
                    <PartSelectRow
                      key={p.id}
                      part={p}
                      selected={selectedPartId === p.id}
                      onClick={() => handleSelectPart(p.id)}
                    />
                  ))}
                  {replaceableParts.length === 0 && (
                    <p className="py-8 text-center text-sm text-[#787870]">
                      No serialized parts found for equipment {equipmentId}.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {step === 2 && selectedPart && (
            <div className="border border-[#B0AD9E] bg-[#F0EFE8] p-6 rounded-sm shadow-sm">
              <h2 className="mb-1 font-barlow text-lg font-semibold uppercase tracking-widest text-[#C04810]">
                {isFreshInstall ? "Install New Part" : "Replace Part"}
              </h2>
              <p className="mb-6 text-sm text-[#787870]">
                {isFreshInstall
                  ? `Creating a new lifecycle for slot `
                  : `Archiving current lifecycle for slot `}
                <span className="text-[#C04810]">{selectedPart.installationId}</span>.
              </p>

              {!isFreshInstall && (
                <div className="mb-6 space-y-2 border border-[#B0AD9E] bg-[#E5E3DA] p-4 text-sm rounded-sm">
                  <div className="flex justify-between">
                    <span className="text-[#4A4A42]">Outgoing serial</span>
                    <span className="text-[#1A1A16]">{selectedPart.serialNumber}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#4A4A42]">Active runtime</span>
                    <span className="text-[#1A1A16]">
                      {selectedPart.granularRuntimeMinutes.toLocaleString()} min
                      {selectedPart.highStressMinutes > 0 && (
                        <span className="ml-2 text-[#B8860B]">
                          ({selectedPart.highStressMinutes.toLocaleString()} min high-stress)
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#4A4A42]">Health</span>
                    <span
                      className={`border px-2 py-0.5 text-xs font-semibold uppercase rounded-sm ${HEALTH_BADGE[selectedPart.health]}`}
                    >
                      {selectedPart.health}
                    </span>
                  </div>
                </div>
              )}

              <div className="space-y-4">
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm text-[#4A4A42]">
                    {isFreshInstall ? "Installation date" : "Replacement date"}
                  </span>
                  <input
                    type="datetime-local"
                    value={replaceDate}
                    max={toDatetimeLocal(new Date().toISOString())}
                    onChange={(e) => setReplaceDate(e.target.value)}
                    className="border border-[#7A7768] bg-[#F0EFE8] px-3 py-2 text-sm text-[#1A1A16] focus:border-[#C04810] focus:outline-none rounded-sm"
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-sm text-[#4A4A42]">New serial number</span>
                  <input
                    type="text"
                    value={newSerial}
                    onChange={(e) => setNewSerial(e.target.value)}
                    placeholder={`e.g. ${selectedPart.partCode}-26-001`}
                    className="border border-[#7A7768] bg-[#F0EFE8] px-3 py-2 text-sm text-[#1A1A16] placeholder:text-[#7A7768] focus:border-[#C04810] focus:outline-none rounded-sm"
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-sm text-[#4A4A42]">
                    {isFreshInstall ? "Reason / notes" : "Failure mode (outgoing part)"}
                  </span>
                  {!isFreshInstall && (
                    <select
                      value={failureMode}
                      onChange={(e) => setFailureMode(e.target.value as FailureMode)}
                      className="border border-[#7A7768] bg-[#F0EFE8] px-3 py-2 text-sm text-[#1A1A16] focus:border-[#C04810] focus:outline-none rounded-sm"
                    >
                      {FAILURE_MODES.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  )}
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-sm text-[#4A4A42]">Notes</span>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={3}
                    placeholder={
                      isFreshInstall
                        ? "New part sourced from batch lot 26-B."
                        : "Weephole leak observed at HP thread root."
                    }
                    className="border border-[#7A7768] bg-[#F0EFE8] px-3 py-2 text-sm text-[#1A1A16] placeholder:text-[#7A7768] focus:border-[#C04810] focus:outline-none rounded-sm"
                  />
                </label>
              </div>

              <div className="mt-6 flex items-center justify-between gap-3">
                <button
                  onClick={handleBack}
                  className="border border-[#7A7768] px-4 py-2 text-sm text-[#4A4A42] hover:border-[#4A4A42] rounded-sm"
                >
                  ← Back
                </button>
                <button
                  onClick={() => setStep(3)}
                  disabled={!newSerial.trim() && !isFreshInstall}
                  className="border border-[#C04810] bg-[#C04810]/15 px-5 py-2 font-barlow text-sm font-semibold uppercase tracking-wider text-[#C04810] transition hover:bg-[#C04810]/25 disabled:cursor-not-allowed disabled:opacity-40 rounded-sm"
                >
                  Review →
                </button>
              </div>
            </div>
          )}

          {step === 3 && selectedPart && !success && (
            <div className="border border-[#C04810] bg-[#FAFAF5] p-6 shadow-xl rounded-sm">
              <h2 className="mb-1 font-barlow text-lg font-semibold uppercase tracking-widest text-[#C04810]">Confirm Replacement</h2>
              <p className="mb-6 text-sm text-[#787870]">
                Review the details below. This action will{" "}
                {isFreshInstall
                  ? "create a new lifecycle and start the runtime odometer."
                  : "archive the current lifecycle and reset the odometer to zero."}
              </p>

              <div className="mb-6 space-y-2 border border-[#B0AD9E] bg-[#F0EFE8] p-4 text-sm rounded-sm">
                <SummaryRow label="Slot" value={selectedPart.installationId} mono />
                <SummaryRow label="Part" value={selectedPart.partName} />
                {!isFreshInstall && (
                  <>
                    <SummaryRow label="Outgoing serial" value={selectedPart.serialNumber} mono />
                    <SummaryRow
                      label="Runtime captured"
                      value={`${selectedPart.granularRuntimeMinutes.toLocaleString()} min`}
                      mono
                    />
                    <SummaryRow label="Failure mode" value={failureMode} />
                  </>
                )}
                <SummaryRow
                  label={isFreshInstall ? "Install date" : "Replacement date"}
                  value={new Date(fromDatetimeLocal(replaceDate)).toLocaleString()}
                />
                {newSerial && <SummaryRow label="New serial" value={newSerial} mono />}
                {notes && <SummaryRow label="Notes" value={notes} />}
              </div>

              {submitError && (
                <p className="mb-4 border border-[#A82020]/40 bg-[#A82020]/8 px-3 py-2 text-sm text-[#A82020] rounded-sm">
                  {submitError}
                </p>
              )}

              <div className="flex items-center justify-between gap-3">
                <button
                  onClick={handleBack}
                  disabled={submitting}
                  className="border border-[#7A7768] px-4 py-2 text-sm text-[#4A4A42] hover:border-[#4A4A42] disabled:opacity-50 rounded-sm"
                >
                  ← Back
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={submitting}
                  className="border border-[#C04810] bg-[#C04810]/25 px-6 py-2.5 font-barlow text-sm font-bold uppercase tracking-wider text-[#C04810] shadow-[0_0_20px_rgba(212,96,42,0.15)] transition hover:bg-[#C04810]/35 disabled:opacity-60 rounded-sm"
                >
                  {submitting
                    ? "Processing…"
                    : isFreshInstall
                      ? "Log Installation"
                      : "Archive & Reset Odometer"}
                </button>
              </div>
            </div>
          )}

          {success && (
            <div className="border border-[#2B7A3E]/50 bg-[#2B7A3E]/10 p-8 text-center rounded-sm">
              <p className="text-4xl text-[#2B7A3E]">✓</p>
              <p className="mt-3 font-barlow text-lg font-semibold uppercase tracking-wider text-[#2B7A3E]">
                {isFreshInstall ? "Part installed successfully" : "Part replaced — odometer reset"}
              </p>
              <p className="mt-1 text-sm text-[#787870]">
                Returning to dashboard…
              </p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function StepIndicator({ current }: { current: 1 | 2 | 3 }) {
  return (
    <div className="flex items-center gap-0">
      {STEP_LABELS.map((label, i) => {
        const n = (i + 1) as 1 | 2 | 3;
        const done = n < current;
        const active = n === current;
        return (
          <div key={n} className="flex items-center">
            <div className="flex flex-col items-center gap-1">
              <div
                className={`flex h-8 w-8 items-center justify-center border text-xs font-bold transition-colors rounded-full ${
                  done
                    ? "border-[#2B7A3E] bg-[#2B7A3E]/15 text-[#2B7A3E]"
                    : active
                      ? "border-[#C04810] bg-[#C04810]/15 text-[#C04810]"
                      : "border-[#7A7768] bg-[#E5E3DA] text-[#7A7768]"
                }`}
              >
                {done ? "✓" : n}
              </div>
              <span
                className={`text-[11px] font-medium ${
                  active ? "text-[#1A1A16]" : done ? "text-[#4A4A42]" : "text-[#7A7768]"
                }`}
              >
                {label}
              </span>
            </div>
            {i < STEP_LABELS.length - 1 && (
              <div
                className={`mx-3 mb-4 h-px w-16 ${
                  done ? "bg-[#2B7A3E]/60" : "bg-[#B0AD9E]"
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function PartSelectRow({
  part,
  selected,
  onClick,
}: {
  part: PartStatus;
  selected: boolean;
  onClick: () => void;
}) {
  const pct = wearPct(part);
  const pctDisplay = pct != null ? Math.min(100, Math.round(pct * 100)) : null;
  const isFresh = !part.serialNumber;

  const borderColor =
    part.health === "critical"
      ? "border-[#A82020]/50 hover:border-[#A82020]"
      : part.health === "watch"
        ? "border-[#B8860B]/50 hover:border-[#B8860B]"
        : "border-[#B0AD9E] hover:border-[#7A7768]";

  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-4 border-2 px-4 py-3.5 text-left transition-all rounded-sm ${borderColor} ${
        selected ? "bg-[#E5E3DA] ring-1 ring-[#C04810]" : "bg-[#F0EFE8]"
      }`}
    >
      <div className="relative h-12 w-2.5 shrink-0 overflow-hidden bg-[#B0AD9E] rounded-sm">
        {!isFresh && (
          <div
            className={`absolute bottom-0 left-0 right-0 transition-all rounded-sm ${
              pctDisplay == null
                ? "bg-[#7A7768]"
                : pctDisplay >= 85
                  ? "bg-[#A82020]"
                  : pctDisplay >= 60
                    ? "bg-[#B8860B]"
                    : "bg-[#2B7A3E]"
            }`}
            style={{ height: `${pctDisplay ?? 0}%` }}
          />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold text-[#1A1A16]">{part.partName}</p>
          {part.alert && (
            <span className="bg-[#A82020]/15 px-2 py-0.5 font-barlow text-[9px] font-semibold uppercase text-[#A82020] rounded-sm">
              {part.alert === "failure" ? "Replace now" : "Inspection due"}
            </span>
          )}
          {isFresh && (
            <span className="bg-[#B0AD9E]/40 px-2 py-0.5 text-[10px] font-semibold uppercase text-[#787870] rounded-sm">
              Empty slot
            </span>
          )}
        </div>
        <p className="text-xs text-[#7A7768]">{part.installationId}</p>
        {!isFresh && (
          <p className="mt-0.5 text-xs text-[#4A4A42]">
            S/N: {part.serialNumber} · {part.granularRuntimeMinutes.toLocaleString()} min active
            {part.highStressMinutes > 0 && (
              <span className="text-[#B8860B]"> · {part.highStressMinutes.toLocaleString()} min σ-stress</span>
            )}
          </p>
        )}
      </div>

      {!isFresh && (
        <div
          className={`shrink-0 text-right text-lg font-bold tabular-nums ${
            pctDisplay == null
              ? "text-[#7A7768]"
              : pctDisplay >= 85
                ? "text-[#A82020]"
                : pctDisplay >= 60
                  ? "text-[#B8860B]"
                  : "text-[#2B7A3E]"
          }`}
        >
          {pctDisplay != null ? `${pctDisplay}%` : "—"}
        </div>
      )}

      <span className="shrink-0 text-[#787870]">→</span>
    </button>
  );
}

function SummaryRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="shrink-0 text-[#4A4A42]">{label}</span>
      <span className={`text-right text-[#1A1A16] ${mono ? "font-mono" : ""}`}>
        {value}
      </span>
    </div>
  );
}
