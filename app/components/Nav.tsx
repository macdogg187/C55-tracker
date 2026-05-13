"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

type Tab = { label: string; href: string; noEq?: boolean };

const TABS: Tab[] = [
  { label: "Dashboard", href: "/" },
  { label: "Replace Part", href: "/replace" },
  { label: "Predictions", href: "/predict" },
  { label: "History", href: "/history" },
  { label: "Glossary", href: "/glossary", noEq: true },
];

const EQUIPMENT_OPTIONS = [
  { id: "0091", label: "C55 · 0091" },
  { id: "0938", label: "C55 · 0938" },
  { id: "0198", label: "C55 · 0198" },
];

export function Nav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const eq = searchParams.get("eq") ?? "0091";

  function handleEqChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = new URLSearchParams(searchParams.toString());
    next.set("eq", e.target.value);
    router.push(`${pathname}?${next.toString()}`);
  }

  return (
    <nav className="sticky top-0 z-40 border-b-2 border-[#C04810] bg-[#F0EFE8]">
      <div className="mx-auto flex w-full max-w-[1500px] items-center justify-between gap-4 px-5 py-2.5 lg:px-8">
        <div className="flex items-center gap-1">
          {/* Logo */}
          <div className="mr-5 hidden shrink-0 sm:flex items-center gap-2">
            <div>
              <div className="font-barlow text-sm font-bold uppercase tracking-[0.16em] text-[#C04810]">
                C55 Tracker
              </div>
              <div className="text-[9px] uppercase tracking-[0.3em] text-[#7A7768]">
                Predictive Maintenance
              </div>
            </div>
          </div>

          {/* Nav tabs */}
          {TABS.map((tab) => {
            const isActive = pathname === tab.href;
            const href = tab.noEq ? tab.href : `${tab.href}?eq=${eq}`;
            return (
              <Link
                key={tab.href}
                href={href}
                className={`px-3 py-1.5 text-xs font-medium uppercase tracking-[0.1em] transition-all font-outfit ${
                  isActive
                    ? "bg-[#C04810] text-[#FAFAF5] shadow-sm"
                    : "text-[#4A4A42] hover:bg-[#E5E3DA] hover:text-[#1A1A16]"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>

        {/* Equipment selector */}
        <select
          value={eq}
          onChange={handleEqChange}
          className="border border-[#C04810] bg-[#FAFAF5] px-3 py-1.5 text-xs text-[#C04810] font-outfit uppercase tracking-wider focus:outline-none focus:ring-1 focus:ring-[#C04810] rounded-sm"
        >
          {EQUIPMENT_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </nav>
  );
}
