import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveLifecycleBoundaries,
  type OffGap,
  type BoundaryInput,
} from "../lifecycle-boundaries.js";

const DAY = 24 * 60 * 60 * 1000;

// Helper: build a gap centred on `midMs` with given width
function gap(midMs: number, widthMs = 60 * 60 * 1000): OffGap {
  return { start: midMs - widthMs / 2, end: midMs + widthMs / 2 };
}

describe("resolveLifecycleBoundaries", () => {
  it("snaps install to gap.end when gap midpoint is within tolerance", () => {
    const baseMs = 1_700_000_000_000;
    const g = gap(baseMs + 2 * 60 * 60 * 1000); // gap 2 hours after tracker date
    const lc: BoundaryInput = {
      installation_id: "A",
      tracker_install_ms: baseMs,
      tracker_removal_ms: null,
    };
    const [r] = resolveLifecycleBoundaries([lc], [g]);
    assert.equal(r.effective_install_ms, g.end);
    assert.equal(r.boundary_source.install, "gap");
    assert.equal(r.boundary_source.removal, "open");
  });

  it("falls back to tracker date when no gap within tolerance", () => {
    const baseMs = 1_700_000_000_000;
    const g = gap(baseMs + 10 * DAY); // gap 10 days away — outside 7-day window
    const lc: BoundaryInput = {
      installation_id: "A",
      tracker_install_ms: baseMs,
      tracker_removal_ms: null,
    };
    const [r] = resolveLifecycleBoundaries([lc], [g]);
    assert.equal(r.effective_install_ms, baseMs);
    assert.equal(r.boundary_source.install, "tracker_fallback");
  });

  it("snaps removal to gap.start when gap midpoint within tolerance", () => {
    const baseMs = 1_700_000_000_000;
    const installMs = baseMs;
    const removalMs = baseMs + 30 * DAY;
    const g = gap(removalMs + 3 * 60 * 60 * 1000); // 3 h after tracker removal
    const lc: BoundaryInput = {
      installation_id: "A",
      tracker_install_ms: installMs,
      tracker_removal_ms: removalMs,
    };
    const [r] = resolveLifecycleBoundaries([lc], [g]);
    assert.equal(r.effective_removal_ms, g.start);
    assert.equal(r.boundary_source.removal, "gap");
  });

  it("allows one gap to serve as boundary for multiple lifecycles (batch replacement)", () => {
    const baseMs = 1_700_000_000_000;
    const g = gap(baseMs + 30 * DAY);
    const lcA: BoundaryInput = {
      installation_id: "A",
      tracker_install_ms: baseMs,
      tracker_removal_ms: baseMs + 30 * DAY,
    };
    const lcB: BoundaryInput = {
      installation_id: "B",
      tracker_install_ms: baseMs,
      tracker_removal_ms: baseMs + 30 * DAY,
    };
    const [rA, rB] = resolveLifecycleBoundaries([lcA, lcB], [g]);
    // Both lifecycles snap their removal to the same gap start
    assert.equal(rA.effective_removal_ms, g.start);
    assert.equal(rB.effective_removal_ms, g.start);
    assert.equal(rA.boundary_source.removal, "gap");
    assert.equal(rB.boundary_source.removal, "gap");
  });

  it("two consecutive lifecycles: prior removal = gap.start, next install = gap.end", () => {
    const baseMs = 1_700_000_000_000;
    const swapMs = baseMs + 30 * DAY;
    const g = gap(swapMs);
    const lcPrior: BoundaryInput = {
      installation_id: "prior",
      tracker_install_ms: baseMs,
      tracker_removal_ms: swapMs,
    };
    const lcNext: BoundaryInput = {
      installation_id: "next",
      tracker_install_ms: swapMs,
      tracker_removal_ms: null,
    };
    const [rPrior, rNext] = resolveLifecycleBoundaries([lcPrior, lcNext], [g]);
    assert.equal(rPrior.effective_removal_ms, g.start);
    assert.equal(rNext.effective_install_ms, g.end);
    // Gap between them is unattributed (g.end - g.start)
    assert.ok(rPrior.effective_removal_ms! < rNext.effective_install_ms);
  });

  it("open lifecycle stays open (no removal)", () => {
    const lc: BoundaryInput = {
      installation_id: "open",
      tracker_install_ms: 1_700_000_000_000,
      tracker_removal_ms: null,
    };
    const [r] = resolveLifecycleBoundaries([lc], []);
    assert.equal(r.effective_removal_ms, null);
    assert.equal(r.boundary_source.removal, "open");
  });

  it("first install before any sensor data (no gaps) → tracker_fallback", () => {
    const lc: BoundaryInput = {
      installation_id: "first",
      tracker_install_ms: 1_000_000_000_000, // long before any sensor data
      tracker_removal_ms: null,
    };
    const [r] = resolveLifecycleBoundaries([lc], []); // no gaps
    assert.equal(r.effective_install_ms, lc.tracker_install_ms);
    assert.equal(r.boundary_source.install, "tracker_fallback");
  });

  it("respects custom tolerance", () => {
    const baseMs = 1_700_000_000_000;
    const g = gap(baseMs + 2 * DAY); // 2 days away from tracker date
    const lc: BoundaryInput = {
      installation_id: "A",
      tracker_install_ms: baseMs,
      tracker_removal_ms: null,
    };
    // With tight 1-day tolerance: falls back to tracker
    const [rTight] = resolveLifecycleBoundaries([lc], [g], 1 * DAY);
    assert.equal(rTight.boundary_source.install, "tracker_fallback");

    // With loose 3-day tolerance: snaps to gap
    const [rLoose] = resolveLifecycleBoundaries([lc], [g], 3 * DAY);
    assert.equal(rLoose.boundary_source.install, "gap");
  });
});
