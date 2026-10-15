import { describe, expect, it } from "bun:test";

import {
  OFFICE_DEFAULTS,
  OfficeConfigV1,
  OfficeFileV1,
  OfficeLocalFileV1,
  privacyOptIns,
  schemaKeyPaths,
} from "../../src/config";

const sizes = (section: string) => ["S", "M", "L", "XL"].map((size) => `${section}.${size}`);
const tier = (name: string) =>
  ["model", "effort", "budgetTokens", "maxTurns", "maxMinutes", "loops"].map(
    (key) => `tiers.${name}.${key}`,
  );

// The M0 key paths of version 1, as listed in DIPO-26. `*` is any name under a record. A key
// added here needs a version 2 schema with a migration (0017 amendment of 2026-10-12), not an
// edit of version 1.
const VERSION_1_KEY_PATHS = [
  "version",
  ...tier("S"),
  ...tier("M"),
  ...tier("L"),
  "worker.adapter",
  "worker.allowProjectSettings",
  "permissions.ask",
  "permissions.presentMinutes",
  "timeouts.workerStallMinutes",
  "timeouts.workerQuietMinutes",
  "timeouts.questionWaitMinutes",
  "timeouts.permissionWaitSeconds",
  "timeouts.scriptMinutes.*",
  "base",
  "remote",
  "worktree.root",
  "worktree.files",
  "worktree.ports.stride",
  "worktree.ports.named.*",
  "worktree.env.*",
  "worktree.post_create",
  "worktree.maxSlots",
  "scripts.*",
  "story.types",
  "story.tiers",
  "story.bannedPhrases",
  "story.titleMax",
  "story.outcomeMin",
  "story.criterionMin",
  "story.slugMax",
  ...[
    "context",
    "contextItem",
    "inputs",
    "inputsFile",
    "dependencies",
    "background",
    "handoff",
    "feedbackItem",
    "feedbackTotal",
    "feedbackLogLines",
    "diff",
    "nudge",
    "taskMessage",
  ].flatMap((section) => sizes(`prompt.budgets.${section}`)),
  "prompt.contractMax",
  "sandbox.toolchainReadPaths",
  "sandbox.installCachePaths",
  "sandbox.registryHosts",
  "sandbox.allowRead",
  "sandbox.allowedDomains",
  "sandbox.allowLocalBinding",
  "polling.prStateSeconds",
  "polling.fetchSeconds",
  "privacy.storePrompts",
  "privacy.storeCommandBodies",
  "privacy.keepRawEvents",
  "retention.shortDays",
  "retention.stateDays",
];

const localOnly = (path: string) => /^(privacy|retention)\./.test(path);
const localAllowed = (path: string) =>
  path === "version" || /^(timeouts|privacy|retention)\./.test(path);

describe("version 1 key paths", () => {
  it("equal the DIPO-26 list; adding a key needs a new version", () => {
    expect(schemaKeyPaths(OfficeConfigV1)).toEqual(VERSION_1_KEY_PATHS.toSorted());
  });

  it("office.yaml accepts every key except privacy.* and retention.*", () => {
    expect(schemaKeyPaths(OfficeFileV1)).toEqual(
      VERSION_1_KEY_PATHS.filter((path) => !localOnly(path)).toSorted(),
    );
  });

  it("office.local.yaml accepts only version, timeouts.*, privacy.* and retention.*", () => {
    expect(schemaKeyPaths(OfficeLocalFileV1)).toEqual(
      VERSION_1_KEY_PATHS.filter(localAllowed).toSorted(),
    );
  });
});

describe("defaults", () => {
  it("are a complete version 1 configuration", () => {
    expect(OfficeConfigV1.parse(OFFICE_DEFAULTS)).toEqual(OFFICE_DEFAULTS);
  });

  it("carry the ADR values", () => {
    expect(OFFICE_DEFAULTS.tiers.M).toEqual({
      model: "sonnet",
      effort: "medium",
      budgetTokens: 800_000,
      maxTurns: 120,
      maxMinutes: 60,
      loops: 5,
    });
    expect(OFFICE_DEFAULTS.timeouts).toEqual({
      workerStallMinutes: 20,
      workerQuietMinutes: 3,
      questionWaitMinutes: 15,
      permissionWaitSeconds: 300,
      scriptMinutes: { install: 15, setup: 10, post_create: 10, verify: 20 },
    });
    expect(OFFICE_DEFAULTS.base).toBeUndefined();
    expect(OFFICE_DEFAULTS.remote).toBe("origin");
    expect(OFFICE_DEFAULTS.worktree.root).toBe("../{repo}.worktrees");
    expect(OFFICE_DEFAULTS.worktree.maxSlots).toBe(20);
    expect(OFFICE_DEFAULTS.worktree.ports).toEqual({ stride: 10, named: {} });
    expect(OFFICE_DEFAULTS.sandbox.toolchainReadPaths).toEqual(["~/.bun", "~/.npm", "~/.cache"]);
    // ~/.cache is read but not written by default (0008 amendment of 2026-10-12).
    expect(OFFICE_DEFAULTS.sandbox.installCachePaths).toEqual([
      "~/.bun/install/cache",
      "~/.npm/_cacache",
    ]);
    expect(OFFICE_DEFAULTS.story.tiers).toEqual(["S", "M", "L"]);
    expect(OFFICE_DEFAULTS.prompt.contractMax).toBe(12_000);
    expect(OFFICE_DEFAULTS.polling).toEqual({ prStateSeconds: 60, fetchSeconds: 300 });
    expect(OFFICE_DEFAULTS.privacy).toEqual({
      storePrompts: false,
      storeCommandBodies: false,
      keepRawEvents: false,
    });
    expect(OFFICE_DEFAULTS.retention).toEqual({ shortDays: 7, stateDays: 365 });
  });
});

describe("privacyOptIns (DIPO-83)", () => {
  it("lists the privacy opt-ins that are on as full keys, in schema order", () => {
    expect(privacyOptIns(undefined)).toEqual([]);
    expect(privacyOptIns(OFFICE_DEFAULTS)).toEqual([]);
    expect(
      privacyOptIns({
        privacy: { storePrompts: false, storeCommandBodies: true, keepRawEvents: true },
      }),
    ).toEqual(["privacy.storeCommandBodies", "privacy.keepRawEvents"]);
  });
});
