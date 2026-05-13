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
    <main className="min-h-screen bg-[#030711] text-zinc-100">
      <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-5 py-6 lg:px-8">

        {/* Page header */}
        <div>
          <p className="text-xs uppercase tracking-widest text-cyan-400">Records</p>
          <h1 className="text-2xl font-semibold text-zinc-100">MTBF History</h1>
          <p className="mt-1 text-sm text-zinc-500">
            All lifecycle records — historical Excel imports and in-app entries, active and archived.
          </p>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500">
              ⌕
            </span>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search slot, part, serial, failure mode…"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 py-2 pl-8 pr-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-cyan-700"
            />
          </div>

          {equipmentId && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-400">
              <input
                type="checkbox"
                checked={showOnlyEquipment}
                onChange={(e) => setShowOnlyEquipment(e.target.checked)}
                className="accent-cyan-500"
              />
              Equipment {equipmentId} only
            </label>
          )}

          <div className="ml-auto flex items-center gap-3">
            <div className="flex gap-2 text-xs text-zinc-500">
              <span className="rounded-full border border-emerald-800/60 bg-emerald-950/30 px-2 py-0.5 text-emerald-300">
                {activeCount} active
              </span>
              <span className="rounded-full border border-zinc-700 bg-zinc-900/60 px-2 py-0.5">
                {archivedCount} archived
              </span>
            </div>
            <button
              onClick={() => exportCsv(filtered)}
              disabled={filtered.length === 0}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-40"
            >
              Export CSV
            </button>
          </div>
        </div>

        {/* Table */}
        {loading && (
          <p className="py-12 text-center text-sm text-zinc-500">Loading records…</p>
        )}
        {error && (
          <p className="rounded-xl border border-rose-800/60 bg-rose-950/30 px-4 py-3 text-sm text-rose-200">
            Failed to load history: {error}
          </p>
        )}

        {!loading && !error && (
          <div className="overflow-x-auto rounded-2xl border border-zinc-800">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/60">
                  {COLUMNS.map((col) => (
                    <th
                      key={col.key}
                      onClick={() => toggleSort(col.key)}
                      className={`cursor-pointer select-none whitespace-nowrap px-4 py-3 text-[11px] font-semibold uppercase tracking-widest text-zinc-500 hover:text-zinc-300 ${col.align === "right" ? "text-right" : "text-left"}`}
                    >
                      {col.label}
                      {sortKey === col.key && (
                        <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>
                      )}
                    </th>
                  ))}
                  <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
                    Notes
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={COLUMNS.length + 1} className="px-4 py-8 text-center text-zinc-500">
                      No records match your search.
                    </td>
                  </tr>
                ) : (
                  filtered.map((row) => (
                    <tr
                      key={row.id}
                      className={`transition hover:bg-zinc-800/30 ${
                        row.status === "active" ? "" : "opacity-60"
                      }`}
                    >
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-zinc-400">
                        {row.installation_id}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-zinc-200">
                        {row.part_name || "—"}
                        {row.is_refurb && (
                          <span className="ml-1.5 rounded bg-amber-900/40 px-1 py-0.5 text-[9px] uppercase text-amber-400">
                            refurb
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-zinc-300">
                        {row.serial_number || "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-zinc-400">
                        {fmtDate(row.installation_date)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-zinc-400">
                        {fmtDate(row.removal_date)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono text-xs tabular-nums text-zinc-300">
                        {fmtNum(row.active_runtime_minutes)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono text-xs tabular-nums text-amber-300">
                        {fmtNum(row.high_stress_minutes)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs">
                        {row.failure_mode ? (
                          <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-zinc-300">
                            {row.failure_mode}
                          </span>
                        ) : (
                          <span className="text-zinc-600">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs">
                        {row.status === "active" ? (
                          <span className="rounded-full border border-emerald-800/60 bg-emerald-950/30 px-2 py-0.5 text-[10px] font-semibold uppercase text-emerald-300">
                            active
                          </span>
                        ) : (
                          <span className="rounded-full border border-zinc-700/60 bg-zinc-900/40 px-2 py-0.5 text-[10px] uppercase text-zinc-500">
                            archived
                          </span>
                        )}
                      </td>
                      <td className="max-w-[200px] truncate px-4 py-2.5 text-xs text-zinc-500">
                        {row.notes || "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            {filtered.length > 0 && (
              <div className="border-t border-zinc-800 bg-zinc-900/30 px-4 py-2 text-xs text-zinc-500">
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
