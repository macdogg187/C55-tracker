"use client";

import { useState } from "react";
import type { PartStatus } from "@/lib/dashboard-data";
import { FAILURE_MODES, type FailureMode } from "@/lib/parts-catalog";

type Props = {
  part: PartStatus;
  open: boolean;
  onClose: () => void;
  onSubmit: (entry: {
    installationId: string;
    newSerial: string;
    failureMode: FailureMode;
    notes: string;
    timestamp: string;
  }) => void;
};

// "Replace Part" archives the previous lifecycle, captures the timestamp + the
// failure mode, and resets the runtime odometer for that installation_id.
export function ReplacePartDialog({ part, open, onClose, onSubmit }: Props) {
  const [newSerial, setNewSerial] = useState("");
  const [failureMode, setFailureMode] = useState<FailureMode>("normal wear");
  const [notes, setNotes] = useState("");

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({
            installationId: part.installationId,
            newSerial: newSerial.trim(),
            failureMode,
            notes: notes.trim(),
            timestamp: new Date().toISOString(),
          });
          setNewSerial("");
          setNotes("");
          setFailureMode("normal wear");
        }}
        className="w-full max-w-lg space-y-4 rounded-2xl border border-cyan-800/40 bg-[#040a14] p-6 shadow-[0_0_60px_rgba(6,182,212,0.18)]"
      >
        <header>
          <h3 className="text-lg font-semibold text-zinc-100">Replace Part</h3>
          <p className="text-xs text-zinc-400">
            Archives the current lifecycle and resets the odometer for{" "}
            <span className="font-mono text-cyan-300">{part.installationId}</span>.
          </p>
        </header>

        <div className="grid gap-3 text-xs">
          <Row label="Outgoing serial number">
            <span className="font-mono text-zinc-300">{part.serialNumber || "—"}</span>
          </Row>
          <Row label="Active runtime captured">
            <span className="font-mono text-zinc-300">
              {part.granularRuntimeMinutes} min
              {part.highStressMinutes > 0 && (
                <span className="ml-2 text-amber-300">
                  ({part.highStressMinutes} min high-stress)
                </span>
              )}
            </span>
          </Row>

          <label className="flex flex-col gap-1">
            <span className="text-zinc-400">Failure mode</span>
            <select
              value={failureMode}
              onChange={(e) => setFailureMode(e.target.value as FailureMode)}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-100"
            >
              {FAILURE_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-zinc-400">New serial number</span>
            <input
              required
              value={newSerial}
              onChange={(e) => setNewSerial(e.target.value)}
              placeholder="e.g. HPT-26-014"
              className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-zinc-100"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-zinc-400">Notes</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Weephole leak observed at the HP thread root."
              className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-100"
            />
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-900"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-md border border-cyan-600 bg-cyan-700/40 px-3 py-1.5 text-xs font-semibold text-cyan-100 hover:bg-cyan-700/60"
          >
            Archive & Reset Odometer
          </button>
        </div>
      </form>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-950/60 px-2.5 py-1.5">
      <span className="text-zinc-400">{label}</span>
      {children}
    </div>
  );
}
