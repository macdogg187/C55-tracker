import { NextResponse } from "next/server";
import { getLifecycleStore } from "@/lib/lifecycle-store";
import { parseTrackerWorkbook } from "@/lib/tracker-import";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Hard cap so a stray multi-gig drop can't OOM the server. 25 MB easily
// covers the 80 KB historical workbook and a 100x larger future version.
const MAX_BYTES = 25 * 1024 * 1024;

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return NextResponse.json(
      { error: `invalid multipart payload: ${(err as Error).message}` },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json(
      { error: "form-data must include a `file` field with the .xlsx" },
      { status: 400 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "uploaded file is empty" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `file too large (${file.size} bytes, max ${MAX_BYTES})` },
      { status: 413 },
    );
  }

  const sheetName = (form.get("sheet") as string | null) ?? "Tracker";
  const fileName = (file as File).name ?? "uploaded.xlsx";

  let parsed;
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    parsed = await parseTrackerWorkbook(buf, sheetName);
  } catch (err) {
    return NextResponse.json(
      { error: `tracker parse failed: ${(err as Error).message}` },
      { status: 422 },
    );
  }

  // parseTrackerWorkbook returns a "fatal" string instead of throwing for
  // payload-shape problems (missing required column, unreadable workbook).
  // Surface that as a 422 with the full report so the operator can see what
  // headers we DID find.
  if (parsed.report.fatal) {
    return NextResponse.json(
      { error: parsed.report.fatal, report: parsed.report },
      { status: 422 },
    );
  }

  const store = getLifecycleStore();
  try {
    const result = await store.ingestTracker({
      ...parsed,
      source: fileName,
    });
    return NextResponse.json({
      backend: store.backend,
      file: fileName,
      sheet: sheetName,
      ...result,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `ingest failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
