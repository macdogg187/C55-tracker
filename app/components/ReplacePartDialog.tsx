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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-lg space-y-4 border-2 border-[#e8a020] bg-[#0e0c0a] p-6 shadow-[0_0_60px_rgba(232,160,32,0.15)]"
      >
        <header>
          <h3 className="font-orbitron text-base font-semibold uppercase tracking-widest text-[#e8a020]">
            {isReport ? "Report Failure" : isFreshInstall ? "Install Part" : "Replace Part"}
          </h3>
          <p className="mt-1 font-mono text-xs text-[#5a4a38]">
            {isReport ? (
              <>
                Logs a failure observation for{" "}
                <span className="text-[#c85a10]">
                  {part.installationId}
                </span>{" "}
                without archiving the lifecycle.
              </>
            ) : isFreshInstall ? (
              <>
                Creates a new lifecycle for{" "}
                <span className="text-[#e8a020]">
                  {part.installationId}
                </span>{" "}
                and starts the runtime odometer.
              </>
            ) : (
              <>
                Archives the current lifecycle and resets the odometer for{" "}
                <span className="text-[#e8a020]">
                  {part.installationId}
                </span>
                .
              </>
            )}
          </p>
        </header>

        <div className="grid gap-3 font-mono text-xs">
          {!isFreshInstall && (
            <>
              <Row label="Outgoing serial number">
                <span className="text-[#f0dfc0]">
                  {part.serialNumber || "—"}
                </span>
              </Row>
              <Row label="Active runtime captured">
                <span className="text-[#f0dfc0]">
                  {part.granularRuntimeMinutes} min
                  {part.highStressMinutes > 0 && (
                    <span className="ml-2 text-[#c85a10]">
                      ({part.highStressMinutes} min high-stress)
                    </span>
                  )}
                </span>
              </Row>
            </>
          )}

          {!isReport && (
            <label className="flex flex-col gap-1">
              <span className="text-[#8a7a60]">
                {isFreshInstall ? "Installation date" : "Replacement date"}
                <span className="ml-1.5 text-[#4a3c28]">(defaults to now · set earlier for backfills)</span>
              </span>
              <input
                type="datetime-local"
                value={installDate}
                max={toDatetimeLocal(new Date().toISOString())}
                onChange={(e) => setInstallDate(e.target.value)}
                className="border border-[#4a3c28] bg-[#1c1814] px-2 py-1.5 font-mono text-[#f0dfc0] focus:border-[#e8a020] focus:outline-none [color-scheme:dark]"
              />
            </label>
          )}

          {!isReport && (
            <label className="flex flex-col gap-1">
              <span className="text-[#8a7a60]">Failure mode</span>
              <select
                value={failureMode}
                onChange={(e) => setFailureMode(e.target.value as FailureMode)}
                className="border border-[#4a3c28] bg-[#1c1814] px-2 py-1.5 font-mono text-[#f0dfc0] focus:border-[#e8a020] focus:outline-none"
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
              <span className="text-[#8a7a60]">Failure mode</span>
              <select
                value={failureMode}
                onChange={(e) => setFailureMode(e.target.value as FailureMode)}
                className="border border-[#4a3c28] bg-[#1c1814] px-2 py-1.5 font-mono text-[#f0dfc0] focus:border-[#e8a020] focus:outline-none"
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
              <span className="text-[#8a7a60]">New serial number</span>
              <input
                required
                value={newSerial}
                onChange={(e) => setNewSerial(e.target.value)}
                placeholder="e.g. HPT-26-014"
                className="border border-[#4a3c28] bg-[#1c1814] px-2 py-1.5 font-mono text-[#f0dfc0] placeholder-[#4a3c28] focus:border-[#e8a020] focus:outline-none"
              />
            </label>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-[#8a7a60]">Notes</span>
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
              className="border border-[#4a3c28] bg-[#1c1814] px-2 py-1.5 font-mono text-[#f0dfc0] placeholder-[#4a3c28] focus:border-[#e8a020] focus:outline-none"
            />
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="border border-[#4a3c28] px-3 py-1.5 font-mono text-xs text-[#8a7a60] hover:border-[#8a7a60] hover:text-[#f0dfc0]"
          >
            Cancel
          </button>
          <button
            type="submit"
            className={
              isReport
                ? "border border-[#c85a10] bg-[#c85a10]/20 px-3 py-1.5 font-orbitron text-xs font-semibold uppercase tracking-wider text-[#c85a10] hover:bg-[#c85a10]/30"
                : "border border-[#e8a020] bg-[#e8a020]/20 px-3 py-1.5 font-orbitron text-xs font-semibold uppercase tracking-wider text-[#e8a020] hover:bg-[#e8a020]/30"
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
    <div className="flex items-center justify-between border border-[#2e2820] bg-[#1c1814] px-2.5 py-1.5">
      <span className="text-[#8a7a60]">{label}</span>
      {children}
    </div>
  );
}
