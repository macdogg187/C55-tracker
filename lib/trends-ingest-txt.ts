import "server-only";
import { decodeTrendsBuffer, parseTrendsCsv } from "@/lib/trends-ingest";

// =============================================================================
// VantagePoint .txt / .csv adapter
//
// In practice VantagePoint emits the SAME comma-separated CSV format whether
// the user picks "Save As .csv" or "Save As .txt" — the only differences are
// the file extension and (sometimes) the text encoding (UTF-16 LE for newer
// exports, UTF-8 for older ones). This module:
//
//   1. Sniffs the BOM and decodes accordingly (utf-16le, utf-16be, utf-8).
//   2. Detects the delimiter on the decoded header line (tab vs comma vs
//      semicolon) and rewrites tabs to commas so the downstream Papa Parse
//      stays in a single config.
//   3. Skips any blank or "info banner" preamble lines until we find a row
//      that looks like a header (i.e. contains the timestamp + a pressure
//      alias).
//   4. Hands the cleaned-up text to parseTrendsCsv() so the entire metrics
//      pipeline stays in one place.
// =============================================================================

const HEADER_HINTS = ["time", "timestamp", "datetime", "date_time", "p01"];

function looksLikeHeader(line: string): boolean {
  const low = line.toLowerCase();
  return HEADER_HINTS.some((h) => low.includes(h));
}

function detectDelimiter(line: string): "," | "\t" | ";" {
  const tabs = (line.match(/\t/g) || []).length;
  const commas = (line.match(/,/g) || []).length;
  const semis = (line.match(/;/g) || []).length;
  if (tabs > commas && tabs > semis) return "\t";
  if (semis > commas && semis > tabs) return ";";
  return ",";
}

export type TrendsParseResult = ReturnType<typeof parseTrendsCsv>;

export function parseTrendsText(
  buf: ArrayBuffer | Uint8Array,
): TrendsParseResult {
  const decoded = decodeTrendsBuffer(buf);

  // VantagePoint occasionally emits a banner block ahead of the headers
  // (point names, units, etc). Walk lines until one of them looks like a
  // header row (case-insensitive substring match on "time" or "p01").
  const lines = decoded.split(/\r?\n/);
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 50); i++) {
    if (looksLikeHeader(lines[i])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) {
    // No banner detected — assume the first non-empty line is the header.
    headerIdx = lines.findIndex((l) => l.trim().length > 0);
  }
  if (headerIdx < 0) {
    throw new Error("trends file appears to be empty");
  }

  const headerLine = lines[headerIdx];
  const delimiter = detectDelimiter(headerLine);

  // Normalise to comma-separated so parseTrendsCsv can stay simple. We do
  // this on the body slice that starts at the header (drop any banner).
  let body = lines.slice(headerIdx).join("\n");
  if (delimiter !== ",") {
    // Use a regex over the whole body — quoted fields are rare in
    // VantagePoint exports so this is safe; if we ever hit quoted commas
    // we should switch to per-line tokenisation here.
    const re = new RegExp(delimiter === "\t" ? "\\t" : delimiter, "g");
    body = body.replace(re, ",");
  }

  return parseTrendsCsv(body);
}
