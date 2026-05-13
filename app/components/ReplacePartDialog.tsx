"use client";

import { useState } from "react";
import type { PartStatus } from "@/lib/dashboard-data";
import { FAILURE_MODES, type FailureMode } from "@/lib/parts-catalog";

export type ReplacePartEntry = {
  installationId: string;
  newSerial: string;
  failureMode: FailureMode;
  notes: string;
  timestamp: string;
};

export type ReportFailureEntry = {
  installationId: string;
  failureMode: FailureMode;
  notes: string;
  timestamp: string;
};

type Props = {
  part: PartStatus;
  open: boolean;
  // "replace": archive the current lifecycle and reset the odometer.
  // "report":  log a failure observation without archiving (part stays in).
  mode?: "replace" | "report";
  onClose: () => void;
  onSubmit: (entry: ReplacePartEntry) => void;
  onReport?: (entry: ReportFailureEntry) => void;
};

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

// "Replace" archives the previous lifecycle, captures the timestamp + the
// failure mode, and resets the runtime odometer for that installation_id.
// "Report" logs a failure_observation maintenance event for the same slot
// without archiving — useful for early warnings, observed scratches, etc.
export function ReplacePartDialog({
  part,
  open,
  mode = "replace",
  onClose,
  onSubmit,
  onReport,
}: Props) {
  const [newSerial, setNewSerial] = useState("");
  const [failureMode, setFailureMode] = useState<FailureMode>("normal wear");
  const [notes, setNotes] = useState("");
  const [installDate, setInstallDate] = useState<string>(
    toDatetimeLocal(new Date().toISOString()),
  );

  if (!open) return null;

  const isReport = mode === "report";
  const isFreshInstall = !part.serialNumber && !isReport;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const timestamp = fromDatetimeLocal(installDate);
    if (isReport) {
      onReport?.({
        installationId: part.installationId,
        failureMode,
        notes: notes.trim(),
        timestamp,
      });
    } else {
      onSubmit({
        installationId: part.installationId,
        newSerial: newSerial.trim(),
        failureMode,
        notes: notes.trim(),
        timestamp,
      });
    }
    setNewSerial("");
    setNotes("");
    setFailureMode("normal wear");
    setInstallDate(toDatetimeLocal(new Date().toISOString()));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-lg space-y-4 rounded-2xl border border-cyan-800/40 bg-[#040a14] p-6 shadow-[0_0_60px_rgba(6,182,212,0.18)]"
      >
        <header>
          <h3 className="text-lg font-semibold text-zinc-100">
            {isReport ? "Report Failure" : isFreshInstall ? "Install Part" : "Replace Part"}
          </h3>
          <p className="text-xs text-zinc-400">
            {isReport ? (
              <>
                Logs a failure observation for{" "}
                <span className="font-mono text-amber-300">
                  {part.installationId}
                </span>{" "}
                without archiving the lifecycle.
              </>
            ) : isFreshInstall ? (
              <>
                Creates a new lifecycle for{" "}
                <span className="font-mono text-cyan-300">
                  {part.installationId}
                </span>{" "}
                and starts the runtime odometer.
              </>
            ) : (
              <>
                Archives the current lifecycle and resets the odometer for{" "}
                <span className="font-mono text-cyan-300">
                  {part.installationId}
                </span>
                .
              </>
            )}
          </p>
        </header>

        <div className="grid gap-3 text-xs">
          {!isFreshInstall && (
            <>
              <Row label="Outgoing serial number">
                <span className="font-mono text-zinc-300">
                  {part.serialNumber || "—"}
                </span>
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
            </>
          )}

          {!isReport && (
            <label className="flex flex-col gap-1">
              <span className="text-zinc-400">
                {isFreshInstall ? "Installation date" : "Replacement date"}
                <span className="ml-1.5 text-zinc-600">(defaults to now · set earlier for backfills)</span>
              </span>
              <input
                type="datetime-local"
                value={installDate}
                max={toDatetimeLocal(new Date().toISOString())}
                onChange={(e) => setInstallDate(e.target.value)}
                className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-zinc-100 [color-scheme:dark]"
              />
            </label>
          )}

          {!isReport && (
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
          )}

          {isReport && (
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
          )}

          {!isReport && (
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
          )}

          <label className="flex flex-col gap-1">
            <span className="text-zinc-400">Notes</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder={
                isReport
                  ? "Weephole weep observed at left HP thread root; will monitor before replace."
                  : isFreshInstall
                    ? "New part sourced from batch lot 26-B."
                    : "Weephole leak observed at the HP thread root."
              }
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
            className={
              isReport
                ? "rounded-md border border-amber-600 bg-amber-700/40 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:bg-amber-700/60"
                : "rounded-md border border-cyan-600 bg-cyan-700/40 px-3 py-1.5 text-xs font-semibold text-cyan-100 hover:bg-cyan-700/60"
            }
          >
            {isReport
              ? "Log Failure Observation"
              : isFreshInstall
                ? "Log Installation"
                : "Archive & Reset Odometer"}
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
