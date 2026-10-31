// The configuration a run started with (DIPO-150, the DIPO-303 review of 2026-10-22): its
// `config_snapshots` row laid on the configuration in force, key by key, so a key added since falls
// back; the configuration in force alone without a snapshot. The reviewer's model and effort come
// from it, not from the configuration in force.

import { afterEach, describe, expect, it } from "bun:test";

import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import { reviewerSettings, reviewModelOf } from "../../src/run";
import { findRun, recordConfigSnapshot } from "../../src/records";
import { layered, runConfigOf } from "../../src/records/config-snapshot";
import { type RoundsWorld, roundsWorld, storyRun } from "../run/rounds-helpers";

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

// DIPO-405: the reviewer's model and effort per story tier, from the run's start snapshot. The
// office sets sonnet for tier S and only an effort for tier M; tier L and a story with no tier
// label take the office-wide values.
const PER_TIER: OfficeConfig["review"] = {
  ...OFFICE_DEFAULTS.review,
  model: "opus",
  effort: "high",
  tiers: { S: { model: "sonnet", effort: "medium" }, M: { effort: "medium" } },
};

/** A story run of `tier` with the reviewer's caps kept, so no caps snapshot is written. */
const tierRun = (story: string, tier: string | null) =>
  storyRun(w, { story, tier, reviewMaxTurns: 60, reviewMaxMinutes: 30 });

describe("the reviewer's model per tier (DIPO-405)", () => {
  const cases: ReadonlyArray<{ tier: string | null; model: string; effort: string }> = [
    { tier: "S", model: "sonnet", effort: "medium" },
    { tier: "M", model: "opus", effort: "medium" },
    { tier: "L", model: "opus", effort: "high" },
    { tier: null, model: "opus", effort: "high" },
  ];

  for (const entry of cases) {
    const name = entry.tier === null ? "a story without a tier" : `a tier ${entry.tier} story`;
    it(`gives ${name} ${entry.model} at effort ${entry.effort}`, async () => {
      w = await roundsWorld("config-snapshot-");
      const story = tierRun("DIPO-7", entry.tier);
      const started: OfficeConfig = { ...OFFICE_DEFAULTS, review: PER_TIER };
      w.office.immediate(() => recordConfigSnapshot(w.office, "h", started, 0));
      expect(
        reviewerSettings(w.office, findRun(w.office, story.run)!, OFFICE_DEFAULTS),
      ).toMatchObject({ model: entry.model, effort: entry.effort });
    });
  }

  it("takes the office-wide values for a tier the office does not know", () => {
    expect(reviewModelOf(PER_TIER, "XL")).toEqual({ model: "opus", effort: "high" });
    expect(reviewModelOf(OFFICE_DEFAULTS.review, "S")).toEqual({ model: "opus", effort: "high" });
  });

  it("keeps the tier settings a run started with after the office config changes", async () => {
    w = await roundsWorld("config-snapshot-");
    const s = tierRun("DIPO-7", "S");
    const m = tierRun("DIPO-8", "M");
    w.office.immediate(() =>
      recordConfigSnapshot(w.office, "h", { ...OFFICE_DEFAULTS, review: PER_TIER }, 0),
    );
    // A base change since: tier S moves to haiku, and tier M gets a model of its own.
    const inForce: OfficeConfig = {
      ...OFFICE_DEFAULTS,
      review: {
        ...PER_TIER,
        tiers: { S: { model: "haiku", effort: "low" }, M: { model: "haiku" } },
      },
    };
    expect(reviewerSettings(w.office, findRun(w.office, s.run)!, inForce)).toMatchObject({
      model: "sonnet",
      effort: "medium",
    });
    expect(reviewerSettings(w.office, findRun(w.office, m.run)!, inForce)).toMatchObject({
      model: "opus",
      effort: "medium",
    });
  });

  it("gives a run started without tier settings the office-wide values after a tier is added", async () => {
    w = await roundsWorld("config-snapshot-");
    const s = tierRun("DIPO-7", "S");
    w.office.immediate(() => recordConfigSnapshot(w.office, "h", OFFICE_DEFAULTS, 0));
    const inForce: OfficeConfig = { ...OFFICE_DEFAULTS, review: PER_TIER };
    expect(runConfigOf(w.office, findRun(w.office, s.run)!, inForce).review.tiers).toEqual({});
    expect(reviewerSettings(w.office, findRun(w.office, s.run)!, inForce)).toMatchObject({
      model: "opus",
      effort: "high",
    });
  });

  it("lets a run whose snapshot predates review.tiers take the tiers in force", async () => {
    w = await roundsWorld("config-snapshot-");
    const s = tierRun("DIPO-7", "S");
    const { tiers: _tiers, ...before } = OFFICE_DEFAULTS.review;
    w.office.immediate(() =>
      recordConfigSnapshot(w.office, "h", { ...OFFICE_DEFAULTS, review: before }, 0),
    );
    const inForce: OfficeConfig = { ...OFFICE_DEFAULTS, review: PER_TIER };
    expect(reviewerSettings(w.office, findRun(w.office, s.run)!, inForce)).toMatchObject({
      model: "sonnet",
      effort: "medium",
    });
  });
});
