/**
 * lifecycle-boundaries.ts
 *
 * Resolves the effective install/removal timestamps for each lifecycle by
 * snapping tracker-entered dates to the nearest detected off-gap.
 *
 * Rationale: parts are physically swapped only during maintenance off-windows.
 * Trend-data gaps (periods with no sensor readings at all) are ground truth for
 * when the machine went down. Tracker spreadsheet dates are operator-entered and
 * can drift by hours or days.
 *
 * Algorithm (per boundary):
 *   1. Find the off-gap whose midpoint is closest to the tracker date.
 *   2. If that gap midpoint is within `toleranceMs` (default 7 days), snap:
 *        install  → gap.end   (machine came back up after the swap)
 *        removal  → gap.start (machine went down for the swap)
 *   3. Otherwise fall back to the tracker date and mark boundary_source as
 *      "tracker_fallback" so the UI can flag it.
 *
 * A single off-gap may serve as the boundary for many lifecycles — batch
 * replacements where multiple parts are swapped in one maintenance window.
 * Gaps are NOT consumed; there is no cap on reuse.
 */

export type OffGap = {
  start: number; // unix ms — last sample before the gap
  end: number;   // unix ms — first sample after the gap
};

export type BoundaryInput = {
  installation_id: string;
  tracker_install_ms: number;
  tracker_removal_ms: number | null; // null = still installed
};

export type BoundarySource =
  | "gap"               // snapped to a detected off-gap
  | "tracker_fallback"  // no gap within tolerance; using tracker date
  | "open";             // still installed; no removal date

export type ResolvedBoundary = {
  installation_id: string;
  effective_install_ms: number;
  effective_removal_ms: number | null;
  boundary_source: {
    install: Exclude<BoundarySource, "open">;
    removal: BoundarySource;
  };
};

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Find the off-gap whose midpoint is nearest to `targetMs`.
 * Returns null if there are no gaps.
 */
function nearestGap(gaps: OffGap[], targetMs: number): OffGap | null {
  if (gaps.length === 0) return null;
  let best = gaps[0];
  let bestDist = Math.abs((best.start + best.end) / 2 - targetMs);
  for (let i = 1; i < gaps.length; i++) {
    const mid = (gaps[i].start + gaps[i].end) / 2;
    const dist = Math.abs(mid - targetMs);
    if (dist < bestDist) {
      bestDist = dist;
      best = gaps[i];
    }
  }
  return best;
}

/**
 * Resolve effective lifecycle boundaries from tracker dates and sensor off-gaps.
 *
 * @param lifecycles  - array of lifecycles with tracker-entered dates
 * @param offGaps     - off-gaps detected from the sensor timestamp stream
 * @param toleranceMs - how far a gap midpoint may be from the tracker date
 *                      before falling back to the tracker value (default 7 days)
 */
export function resolveLifecycleBoundaries(
  lifecycles: BoundaryInput[],
  offGaps: OffGap[],
  toleranceMs = SEVEN_DAYS_MS,
): ResolvedBoundary[] {
  return lifecycles.map((lc) => {
    // ── Install boundary ─────────────────────────────────────────────────────
    const installGap = nearestGap(offGaps, lc.tracker_install_ms);
    const installMid = installGap ? (installGap.start + installGap.end) / 2 : null;
    const installSnapped =
      installGap !== null &&
      installMid !== null &&
      Math.abs(installMid - lc.tracker_install_ms) <= toleranceMs;

    const effective_install_ms = installSnapped
      ? installGap!.end   // machine came back up after swap
      : lc.tracker_install_ms;
    const install_source: Exclude<BoundarySource, "open"> = installSnapped
      ? "gap"
      : "tracker_fallback";

    // ── Removal boundary ─────────────────────────────────────────────────────
    if (lc.tracker_removal_ms === null) {
      return {
        installation_id: lc.installation_id,
        effective_install_ms,
        effective_removal_ms: null,
        boundary_source: { install: install_source, removal: "open" },
      };
    }

    const removalGap = nearestGap(offGaps, lc.tracker_removal_ms);
    const removalMid = removalGap ? (removalGap.start + removalGap.end) / 2 : null;
    const removalSnapped =
      removalGap !== null &&
      removalMid !== null &&
      Math.abs(removalMid - lc.tracker_removal_ms) <= toleranceMs;

    const effective_removal_ms = removalSnapped
      ? removalGap!.start // machine went down for the swap
      : lc.tracker_removal_ms;
    const removal_source: Exclude<BoundarySource, "open"> = removalSnapped
      ? "gap"
      : "tracker_fallback";

    return {
      installation_id: lc.installation_id,
      effective_install_ms,
      effective_removal_ms,
      boundary_source: { install: install_source, removal: removal_source },
    };
  });
}
