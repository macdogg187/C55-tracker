"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { HistoryRow } from "../api/history/route";

type SortKey = keyof Pick<
  HistoryRow,
  | "installation_id"
  | "part_name"
  | "serial_number"
  | "installation_date"
  | "removal_date"
  | "active_runtime_minutes"
  | "high_stress_minutes"
  | "failure_mode"
  | "status"
>;

type SortDir = "asc" | "desc";

const COLUMNS: { key: SortKey; label: string; align?: "right" }[] = [
  { key: "installation_id",       label: "Slot" },
  { key: "part_name",             label: "Part" },
  { key: "serial_number",         label: "Serial #" },
  { key: "installation_date",     label: "Installed" },
  { key: "removal_date",          label: "Removed" },
  { key: "active_runtime_minutes", label: "Runtime (min)", align: "right" },
  { key: "high_stress_minutes",   label: "High-Stress (min)", align: "right" },
  { key: "failure_mode",          label: "Failure Mode" },
  { key: "status",                label: "Status" },
];

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

function fmtNum(n: number) {
  return n === 0 ? "—" : n.toLocaleString();
}

function rowMatchesSearch(row: HistoryRow, q: string): boolean {
  const lower = q.toLowerCase();
  return (
    row.installation_id.toLowerCase().includes(lower) ||
    row.part_name.toLowerCase().includes(lower) ||
    row.serial_number.toLowerCase().includes(lower) ||
    (row.failure_mode ?? "").toLowerCase().includes(lower) ||
    (row.notes ?? "").toLowerCase().includes(lower) ||
    row.equipment_id.toLowerCase().includes(lower)
  );
}

function compareRows(a: HistoryRow, b: HistoryRow, key: SortKey, dir: SortDir): number {
  let av: string | number | null;
  let bv: string | number | null;

  if (key === "active_runtime_minutes" || key === "high_stress_minutes") {
    av = a[key] as number;
    bv = b[key] as number;
    return dir === "asc" ? av - bv : bv - av;
  }

  av = (a[key] ?? "") as string;
  bv = (b[key] ?? "") as string;
  const cmp = av.localeCompare(bv);
  return dir === "asc" ? cmp : -cmp;
}

function exportCsv(rows: HistoryRow[]) {
  const headers = [
    "slot", "equipment", "part", "serial", "refurb",
    "installed", "removed", "runtime_min", "high_stress_min",
    "failure_mode", "notes", "status",
  ];
  const lines = rows.map((r) =>
    [
      r.installation_id,
      r.equipment_id,
      r.part_name,
      r.serial_number,
      r.is_refurb ? "yes" : "no",
      r.installation_date ? new Date(r.installation_date).toISOString() : "",
      r.removal_date ? new Date(r.removal_date).toISOString() : "",
      r.active_runtime_minutes,
      r.high_stress_minutes,
      r.failure_mode ?? "",
      (r.notes ?? "").replace(/,/g, ";"),
      r.status,
    ].join(","),
  );
  const blob = new Blob([[headers.join(","), ...lines].join("\n")], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mtbf-history-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function HistoryPage() {
  const searchParams = useSearchParams();
  const equipmentId = searchParams.get("eq") ?? "";

  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("installation_date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [showOnlyEquipment, setShowOnlyEquipment] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/history", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { rows: HistoryRow[] };
        setRows(json.rows);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const filtered = useMemo(() => {
    let result = rows;
    if (showOnlyEquipment && equipmentId) {
      result = result.filter((r) => r.equipment_id === equipmentId);
    }
    if (query.trim()) {
      result = result.filter((r) => rowMatchesSearch(r, query));
    }
    return [...result].sort((a, b) => compareRows(a, b, sortKey, sortDir));
  }, [rows, query, sortKey, sortDir, showOnlyEquipment, equipmentId]);

  const activeCount  = filtered.filter((r) => r.status === "active").length;
  const archivedCount = filtered.filter((r) => r.status === "archived").length;

  return (
    <main className="min-h-screen bg-[#12100e] text-[#f0dfc0]">
      <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-5 py-6 lg:px-8">

        {/* Page header */}
        <div>
          <p className="font-orbitron text-xs uppercase tracking-widest text-[#e8a020]">Records</p>
          <h1 className="mt-1 font-orbitron text-2xl font-semibold text-[#f0dfc0]">MTBF History</h1>
          <p className="mt-1 font-mono text-sm text-[#5a4a38]">
            All lifecycle records — historical Excel imports and in-app entries, active and archived.
          </p>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] flex-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#5a4a38]">
              ⌕
            </span>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search slot, part, serial, failure mode…"
              className="w-full border border-[#4a3c28] bg-[#1c1814] py-2 pl-8 pr-3 font-mono text-sm text-[#f0dfc0] placeholder:text-[#4a3c28] focus:border-[#e8a020] focus:outline-none"
            />
          </div>

          {equipmentId && (
            <label className="flex cursor-pointer items-center gap-2 font-mono text-sm text-[#8a7a60]">
              <input
                type="checkbox"
                checked={showOnlyEquipment}
                onChange={(e) => setShowOnlyEquipment(e.target.checked)}
                className="accent-[#e8a020]"
              />
              Equipment {equipmentId} only
            </label>
          )}

          <div className="ml-auto flex items-center gap-3">
            <div className="flex gap-2 font-mono text-xs">
              <span className="border border-[#6ab04c]/60 bg-[#6ab04c]/10 px-2 py-0.5 text-[#6ab04c]">
                {activeCount} active
              </span>
              <span className="border border-[#2e2820] bg-[#1c1814] px-2 py-0.5 text-[#5a4a38]">
                {archivedCount} archived
              </span>
            </div>
            <button
              onClick={() => exportCsv(filtered)}
              disabled={filtered.length === 0}
              className="border border-[#4a3c28] bg-[#1c1814] px-3 py-1.5 font-mono text-xs font-medium text-[#8a7a60] transition hover:border-[#8a7a60] hover:text-[#f0dfc0] disabled:opacity-40"
            >
              Export CSV
            </button>
          </div>
        </div>

        {/* Table */}
        {loading && (
          <p className="py-12 text-center font-mono text-sm text-[#5a4a38]">Loading records…</p>
        )}
        {error && (
          <p className="border border-[#cc3311]/60 bg-[#cc3311]/10 px-4 py-3 font-mono text-sm text-[#ff6644]">
            Failed to load history: {error}
          </p>
        )}

        {!loading && !error && (
          <div className="overflow-x-auto border-2 border-[#2e2820]">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-[#2e2820] bg-[#1c1814]">
                  {COLUMNS.map((col) => (
                    <th
                      key={col.key}
                      onClick={() => toggleSort(col.key)}
                      className={`cursor-pointer select-none whitespace-nowrap px-4 py-3 font-mono text-[11px] font-semibold uppercase tracking-widest text-[#4a3c28] hover:text-[#e8a020] ${col.align === "right" ? "text-right" : "text-left"}`}
                    >
                      {col.label}
                      {sortKey === col.key && (
                        <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>
                      )}
                    </th>
                  ))}
                  <th className="px-4 py-3 text-left font-mono text-[11px] font-semibold uppercase tracking-widest text-[#4a3c28]">
                    Notes
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#2e2820]">
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={COLUMNS.length + 1} className="px-4 py-8 text-center font-mono text-[#5a4a38]">
                      No records match your search.
                    </td>
                  </tr>
                ) : (
                  filtered.map((row) => (
                    <tr
                      key={row.id}
                      className={`transition hover:bg-[#2e2820]/30 ${
                        row.status === "active" ? "" : "opacity-60"
                      }`}
                    >
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-[#8a7a60]">
                        {row.installation_id}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-[#f0dfc0]">
                        {row.part_name || "—"}
                        {row.is_refurb && (
                          <span className="ml-1.5 bg-[#c85a10]/20 px-1 py-0.5 font-mono text-[9px] uppercase text-[#c85a10]">
                            refurb
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-[#8a7a60]">
                        {row.serial_number || "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-[#5a4a38]">
                        {fmtDate(row.installation_date)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-[#5a4a38]">
                        {fmtDate(row.removal_date)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono text-xs tabular-nums text-[#8a7a60]">
                        {fmtNum(row.active_runtime_minutes)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono text-xs tabular-nums text-[#c85a10]">
                        {fmtNum(row.high_stress_minutes)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs">
                        {row.failure_mode ? (
                          <span className="border border-[#2e2820] bg-[#1c1814] px-2 py-0.5 font-mono text-[#8a7a60]">
                            {row.failure_mode}
                          </span>
                        ) : (
                          <span className="text-[#4a3c28]">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs">
                        {row.status === "active" ? (
                          <span className="border border-[#6ab04c]/60 bg-[#6ab04c]/10 px-2 py-0.5 font-orbitron text-[10px] font-semibold uppercase text-[#6ab04c]">
                            active
                          </span>
                        ) : (
                          <span className="border border-[#2e2820]/60 bg-[#1c1814] px-2 py-0.5 font-mono text-[10px] uppercase text-[#5a4a38]">
                            archived
                          </span>
                        )}
                      </td>
                      <td className="max-w-[200px] truncate px-4 py-2.5 font-mono text-xs text-[#5a4a38]">
                        {row.notes || "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            {filtered.length > 0 && (
              <div className="border-t border-[#2e2820] bg-[#1c1814] px-4 py-2 font-mono text-xs text-[#5a4a38]">
                {filtered.length.toLocaleString()} records
                {rows.length !== filtered.length && ` of ${rows.length.toLocaleString()} total`}
              </div>
            )}
          </div>
        )}

      </div>
    </main>
  );
}
