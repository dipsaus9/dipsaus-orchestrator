// The configuration a run started with (DIPO-150, the DIPO-303 review of 2026-10-22): its
// `config_snapshots` row laid on the configuration in force, key by key, so a key added since falls
// back; the configuration in force alone without a snapshot. The reviewer's model and effort come
// from it, not from the configuration in force.

import { afterEach, describe, expect, it } from "bun:test";

import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import { findRun, recordConfigSnapshot, reviewerSettings } from "../../src/run";
import { layered, runConfigOf } from "../../src/run/config-snapshot";
import { type RoundsWorld, roundsWorld, storyRun } from "./rounds-helpers";

let w: RoundsWorld;

afterEach(() => w?.close());

describe("layered", () => {
  it("merges plain objects key by key and replaces anything else", () => {
    expect(layered({ a: { b: 1, c: 2 }, d: [1] }, { a: { b: 3 }, d: [2, 3] })).toEqual({
      a: { b: 3, c: 2 },
      d: [2, 3],
    });
    expect(layered({ a: 1 }, undefined)).toEqual({ a: 1 });
  });
});

describe("runConfigOf", () => {
  it("reads the run's snapshot, a key it lacks from the configuration in force", async () => {
    w = await roundsWorld("config-snapshot-");
    const story = storyRun(w, { story: "DIPO-7" });
    const run = findRun(w.office, story.run)!;
    const inForce: OfficeConfig = {
      ...OFFICE_DEFAULTS,
      merge: { ...OFFICE_DEFAULTS.merge, autoMerge: true, holdLabels: ["later"] },
    };
    // No snapshot: the configuration in force.
    expect(runConfigOf(w.office, run, inForce)).toBe(inForce);
    // A version 13 snapshot: `mergeSlot` without `holdLabels`, and keys version 14 retired.
    const { merge: _merge, caps: _caps, ...rest } = OFFICE_DEFAULTS;
    w.office.immediate(() =>
      recordConfigSnapshot(
        w.office,
        "h",
        {
          ...rest,
          version: 13,
          mergeSlot: { autoMerge: false, ciAttempts: 7, requiredChecks: ["ci-ok"] },
          storyPr: { open: true },
          worker: { adapter: "claude-cli", web: true },
        },
        0,
      ),
    );
    const started = runConfigOf(w.office, run, inForce);
    // The moved keys are read at their new place (the migration of 0017).
    expect(started.merge).toEqual({ ...inForce.merge, autoMerge: false });
    expect(started.caps).toEqual({ ...inForce.caps, ciAttempts: 7 });
    expect(started.version).toBe(14);
    expect(Object.keys(started)).not.toContain("mergeSlot");
    expect(Object.keys(started)).not.toContain("storyPr");
    expect(Object.keys(started)).not.toContain("worker");
  });

  it("gives the reviewer the model and effort the run started with", async () => {
    w = await roundsWorld("config-snapshot-");
    const story = storyRun(w, { story: "DIPO-7", reviewMaxTurns: 60, reviewMaxMinutes: 30 });
    w.office.immediate(() =>
      recordConfigSnapshot(
        w.office,
        "h",
        {
          ...OFFICE_DEFAULTS,
          review: { ...OFFICE_DEFAULTS.review, model: "sonnet", effort: "low" },
        },
        0,
      ),
    );
    const inForce: OfficeConfig = {
      ...OFFICE_DEFAULTS,
      review: { ...OFFICE_DEFAULTS.review, model: "opus", effort: "high" },
    };
    expect(reviewerSettings(w.office, findRun(w.office, story.run)!, inForce)).toMatchObject({
      model: "sonnet",
      effort: "low",
    });
  });
});
