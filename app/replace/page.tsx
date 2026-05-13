"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  buildSeedPartStatuses,
  type PartStatus,
} from "@/lib/dashboard-data";
import { PART_CATALOG, FAILURE_MODES, type FailureMode } from "@/lib/parts-catalog";
import type { PartRecord, PipelinePayload } from "@/lib/analytics";

// ─── Types mirrored from page.tsx ─────────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
        expectedMtbfMinutes: catalog.expectedMtbfMinutes ?? 12000,
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
    const ceiling = failure ?? mtbf;
    const pct = runtime / Math.max(1, ceiling);
    const health: PartStatus["health"] =
      (pp?.health as PartStatus["health"]) ??
      (failure && runtime >= failure
        ? "critical"
        : inspection && runtime >= inspection
          ? "watch"
          : pct >= 0.85
            ? "critical"
            : pct >= 0.6
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
  const ceiling = p.failureThresholdMin ?? p.expectedMtbfMinutes;
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
  critical: "bg-rose-500/20 text-rose-200 border-rose-700/50",
  watch:    "bg-amber-500/20 text-amber-200 border-amber-700/50",
  nominal:  "bg-emerald-500/20 text-emerald-200 border-emerald-700/50",
};

const STEP_LABELS = ["Select Part", "Enter Details", "Confirm & Complete"];

// ─── Page component ────────────────────────────────────────────────────────────

export default function ReplacePage() {
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

  // Load data
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

  // All replaceable slots: installed parts (have serial) + empty serialized slots (fresh install)
  const replaceableParts = useMemo(() => {
    return parts
      .filter((p) => p.isSerialized || p.serialNumber)
      .sort((a, b) => {
        // Critical/failing first, then by wear % desc
        const healthOrder = { critical: 0, watch: 1, nominal: 2 };
        const hDiff = (healthOrder[a.health] ?? 2) - (healthOrder[b.health] ?? 2);
        if (hDiff !== 0) return hDiff;
        return wearPct(b) - wearPct(a);
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
      // Short delay then redirect home so the odometer reorder is visible
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
    <main className="min-h-screen bg-[#030711] text-zinc-100">
      <div className="mx-auto w-full max-w-[1000px] px-5 py-8 lg:px-8">

        {/* Page title */}
        <div className="mb-8">
          <p className="text-xs uppercase tracking-widest text-cyan-400">Maintenance Workflow</p>
          <h1 className="text-2xl font-semibold text-zinc-100">Replace / Install Part</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Equipment{" "}
            <span className="font-mono text-zinc-300">{equipmentId}</span>
          </p>
        </div>

        {/* Step indicator */}
        <StepIndicator current={step} />

        {/* Step content */}
        <div className="mt-8">
          {/* Step 1: Select Part */}
          {step === 1 && (
            <div>
              <p className="mb-4 text-sm text-zinc-400">
                Select the part to replace or install. Parts are listed with the most critical first.
              </p>
              {loading ? (
                <p className="py-8 text-center text-sm text-zinc-500">Loading parts…</p>
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
                    <p className="py-8 text-center text-sm text-zinc-500">
                      No serialized parts found for equipment {equipmentId}.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Step 2: Enter Details */}
          {step === 2 && selectedPart && (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
              <h2 className="mb-1 text-lg font-semibold text-zinc-100">
                {isFreshInstall ? "Install New Part" : "Replace Part"}
              </h2>
              <p className="mb-6 text-sm text-zinc-500">
                {isFreshInstall
                  ? `Creating a new lifecycle for slot `
                  : `Archiving current lifecycle for slot `}
                <span className="font-mono text-zinc-300">{selectedPart.installationId}</span>.
              </p>

              {/* Current part summary */}
              {!isFreshInstall && (
                <div className="mb-6 space-y-2 rounded-xl border border-zinc-700/60 bg-zinc-950/40 p-4 text-sm">
                  <div className="flex justify-between">
                    <span className="text-zinc-400">Outgoing serial</span>
                    <span className="font-mono text-zinc-200">{selectedPart.serialNumber}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-400">Active runtime</span>
                    <span className="font-mono text-zinc-200">
                      {selectedPart.granularRuntimeMinutes.toLocaleString()} min
                      {selectedPart.highStressMinutes > 0 && (
                        <span className="ml-2 text-amber-300">
                          ({selectedPart.highStressMinutes.toLocaleString()} min high-stress)
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-400">Health</span>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-xs font-semibold uppercase ${HEALTH_BADGE[selectedPart.health]}`}
                    >
                      {selectedPart.health}
                    </span>
                  </div>
                </div>
              )}

              <div className="space-y-4">
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm text-zinc-400">
                    {isFreshInstall ? "Installation date" : "Replacement date"}
                  </span>
                  <input
                    type="datetime-local"
                    value={replaceDate}
                    max={toDatetimeLocal(new Date().toISOString())}
                    onChange={(e) => setReplaceDate(e.target.value)}
                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100 [color-scheme:dark]"
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-sm text-zinc-400">New serial number</span>
                  <input
                    type="text"
                    value={newSerial}
                    onChange={(e) => setNewSerial(e.target.value)}
                    placeholder={`e.g. ${selectedPart.partCode}-26-001`}
                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100 placeholder:text-zinc-600"
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-sm text-zinc-400">
                    {isFreshInstall ? "Reason / notes" : "Failure mode (outgoing part)"}
                  </span>
                  {!isFreshInstall && (
                    <select
                      value={failureMode}
                      onChange={(e) => setFailureMode(e.target.value as FailureMode)}
                      className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
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
                  <span className="text-sm text-zinc-400">Notes</span>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={3}
                    placeholder={
                      isFreshInstall
                        ? "New part sourced from batch lot 26-B."
                        : "Weephole leak observed at HP thread root."
                    }
                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600"
                  />
                </label>
              </div>

              <div className="mt-6 flex items-center justify-between gap-3">
                <button
                  onClick={handleBack}
                  className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
                >
                  ← Back
                </button>
                <button
                  onClick={() => setStep(3)}
                  disabled={!newSerial.trim() && !isFreshInstall}
                  className="rounded-lg border border-cyan-600 bg-cyan-700/40 px-5 py-2 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-700/60 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Review →
                </button>
              </div>
            </div>
          )}

          {/* Step 3: Confirm */}
          {step === 3 && selectedPart && !success && (
            <div className="rounded-2xl border border-cyan-800/40 bg-zinc-900/40 p-6 shadow-[0_0_60px_rgba(6,182,212,0.1)]">
              <h2 className="mb-1 text-lg font-semibold text-zinc-100">Confirm Replacement</h2>
              <p className="mb-6 text-sm text-zinc-500">
                Review the details below. This action will{" "}
                {isFreshInstall
                  ? "create a new lifecycle and start the runtime odometer."
                  : "archive the current lifecycle and reset the odometer to zero."}
              </p>

              <div className="mb-6 space-y-2 rounded-xl border border-zinc-700/60 bg-zinc-950/60 p-4 text-sm">
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
                <p className="mb-4 rounded-lg border border-rose-800/60 bg-rose-950/30 px-3 py-2 text-sm text-rose-200">
                  {submitError}
                </p>
              )}

              <div className="flex items-center justify-between gap-3">
                <button
                  onClick={handleBack}
                  disabled={submitting}
                  className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                >
                  ← Back
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={submitting}
                  className="rounded-lg border border-cyan-500 bg-cyan-600/50 px-6 py-2.5 text-sm font-bold text-cyan-50 shadow-[0_0_20px_rgba(6,182,212,0.3)] transition hover:bg-cyan-600/70 disabled:opacity-60"
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

          {/* Success state */}
          {success && (
            <div className="rounded-2xl border border-emerald-700/50 bg-emerald-950/30 p-8 text-center">
              <p className="text-4xl">✓</p>
              <p className="mt-3 text-lg font-semibold text-emerald-300">
                {isFreshInstall ? "Part installed successfully" : "Part replaced — odometer reset"}
              </p>
              <p className="mt-1 text-sm text-zinc-400">
                Returning to dashboard…
              </p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

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
                className={`flex h-8 w-8 items-center justify-center rounded-full border text-xs font-bold transition-colors ${
                  done
                    ? "border-emerald-600 bg-emerald-700/40 text-emerald-200"
                    : active
                      ? "border-cyan-500 bg-cyan-700/40 text-cyan-100"
                      : "border-zinc-700 bg-zinc-900 text-zinc-500"
                }`}
              >
                {done ? "✓" : n}
              </div>
              <span
                className={`text-[11px] font-medium ${
                  active ? "text-zinc-200" : done ? "text-zinc-400" : "text-zinc-600"
                }`}
              >
                {label}
              </span>
            </div>
            {i < STEP_LABELS.length - 1 && (
              <div
                className={`mx-3 mb-4 h-px w-16 ${
                  done ? "bg-emerald-700/60" : "bg-zinc-800"
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
  const pctDisplay = Math.min(100, Math.round(pct * 100));
  const isFresh = !part.serialNumber;

  const borderColor =
    part.health === "critical"
      ? "border-rose-700/50 hover:border-rose-500"
      : part.health === "watch"
        ? "border-amber-700/50 hover:border-amber-500"
        : "border-zinc-700/60 hover:border-zinc-500";

  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-4 rounded-xl border px-4 py-3.5 text-left transition ${borderColor} ${
        selected ? "bg-cyan-950/25 ring-1 ring-cyan-500" : "bg-zinc-900/40"
      }`}
    >
      {/* Wear bar */}
      <div className="relative h-12 w-2.5 shrink-0 overflow-hidden rounded-full bg-zinc-800">
        {!isFresh && (
          <div
            className={`absolute bottom-0 left-0 right-0 rounded-full transition-all ${
              pctDisplay >= 85
                ? "bg-rose-400"
                : pctDisplay >= 60
                  ? "bg-amber-400"
                  : "bg-emerald-400"
            }`}
            style={{ height: `${pctDisplay}%` }}
          />
        )}
      </div>

      {/* Part info */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold text-zinc-100">{part.partName}</p>
          {part.alert && (
            <span className="rounded-full bg-rose-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase text-rose-200">
              {part.alert === "failure" ? "Replace now" : "Inspection due"}
            </span>
          )}
          {isFresh && (
            <span className="rounded-full bg-zinc-700/50 px-2 py-0.5 text-[10px] font-semibold uppercase text-zinc-400">
              Empty slot
            </span>
          )}
        </div>
        <p className="font-mono text-xs text-zinc-500">{part.installationId}</p>
        {!isFresh && (
          <p className="mt-0.5 text-xs text-zinc-400">
            S/N: {part.serialNumber} · {part.granularRuntimeMinutes.toLocaleString()} min active
            {part.highStressMinutes > 0 && (
              <span className="text-amber-300"> · {part.highStressMinutes.toLocaleString()} min σ-stress</span>
            )}
          </p>
        )}
      </div>

      {/* Wear % */}
      {!isFresh && (
        <div
          className={`shrink-0 text-right text-lg font-bold tabular-nums ${
            pctDisplay >= 85
              ? "text-rose-300"
              : pctDisplay >= 60
                ? "text-amber-300"
                : "text-emerald-300"
          }`}
        >
          {pctDisplay}%
        </div>
      )}

      <span className="shrink-0 text-zinc-500">→</span>
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
      <span className="shrink-0 text-zinc-400">{label}</span>
      <span className={`text-right text-zinc-200 ${mono ? "font-mono" : ""}`}>
        {value}
      </span>
    </div>
  );
}
