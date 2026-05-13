import { promises as fs } from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import { GlossaryContent } from "./GlossaryContent";

export const metadata: Metadata = {
  title: "Glossary & Calculations | C55 Tracker",
  description:
    "Reference guide for every term, formula, threshold, and assumption used in the C55 predictive-maintenance dashboard.",
};

export default async function GlossaryPage() {
  const filePath = path.join(process.cwd(), "docs", "GLOSSARY.md");
  const markdown = await fs.readFile(filePath, "utf-8");

  return (
    <main className="min-h-screen bg-[#FAFAF5] text-[#3D3427]">
      <div className="mx-auto w-full max-w-4xl px-5 py-10 lg:px-8">
        <GlossaryContent markdown={markdown} />
      </div>
    </main>
  );
}
