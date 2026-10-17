import { describe, expect, it } from "bun:test";

import {
  migrateOfficeDocument,
  OFFICE_CONFIG_VERSION,
  OFFICE_DEFAULTS,
  OfficeConfigV1,
  OfficeConfigV2,
  OfficeConfigV3,
  OfficeFileV1,
  OfficeFileV2,
  OfficeFileV3,
  OfficeLocalFileV1,
  OfficeLocalFileV2,
  OfficeLocalFileV3,
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

// Version 2 (DIPO-108): version 1 plus worker.plugins (0008 amendment of 2026-10-12).
const VERSION_2_KEY_PATHS = [...VERSION_1_KEY_PATHS, "worker.plugins"];

/** Whether `.dipo/office.yaml` version 2 accepts `worker.plugins`. */
function file(plugins: unknown): boolean {
  return OfficeFileV2.safeParse({ version: 2, worker: { plugins } }).success;
}

describe("version 2 key paths", () => {
  it("are the version 1 paths plus worker.plugins", () => {
    expect(schemaKeyPaths(OfficeConfigV2)).toEqual(VERSION_2_KEY_PATHS.toSorted());
    expect(schemaKeyPaths(OfficeFileV2)).toEqual(
      VERSION_2_KEY_PATHS.filter((path) => !localOnly(path)).toSorted(),
    );
    expect(schemaKeyPaths(OfficeLocalFileV2)).toEqual(
      VERSION_2_KEY_PATHS.filter(localAllowed).toSorted(),
    );
  });

  it("take worker.plugins only in the <plugin>@<marketplace> form", () => {
    expect(file([])).toBe(true);
    expect(file(["warp@claude-code-warp", "learning-output-style@claude-plugins-official"])).toBe(
      true,
    );
    for (const bad of ["warp", "@market", "warp@", "a@b@c", "warp @x", ""]) {
      expect(file([bad])).toBe(false);
    }
  });

  it("keep version 1 without worker.plugins", () => {
    expect(OfficeFileV1.safeParse({ version: 1, worker: { plugins: [] } }).success).toBe(false);
    expect(OfficeFileV1.safeParse({ version: 2 }).success).toBe(false);
  });
});

// Version 3 (DIPO-133): version 2 plus mergeSlot.requiredChecks (0016 rule 2).
const VERSION_3_KEY_PATHS = [...VERSION_2_KEY_PATHS, "mergeSlot.requiredChecks"];

/** Whether `.dipo/office.yaml` version 3 accepts `mergeSlot.requiredChecks` as `names`. */
function checks(names: unknown): boolean {
  return OfficeFileV3.safeParse({ version: 3, mergeSlot: { requiredChecks: names } }).success;
}

describe("version 3 key paths", () => {
  it("are the version 2 paths plus mergeSlot.requiredChecks", () => {
    expect(OFFICE_CONFIG_VERSION).toBe(3);
    expect(schemaKeyPaths(OfficeConfigV3)).toEqual(VERSION_3_KEY_PATHS.toSorted());
    expect(schemaKeyPaths(OfficeFileV3)).toEqual(
      VERSION_3_KEY_PATHS.filter((path) => !localOnly(path)).toSorted(),
    );
    expect(schemaKeyPaths(OfficeLocalFileV3)).toEqual(
      VERSION_3_KEY_PATHS.filter(localAllowed).toSorted(),
    );
  });

  it("take mergeSlot.requiredChecks as a list of distinct, non-empty check names", () => {
    expect(checks(["ci-ok", "pr-title"])).toBe(true);
    expect(checks(["Build (ubuntu)"])).toBe(true);
    expect(checks([])).toBe(false);
    expect(checks(["ci-ok", "ci-ok"])).toBe(false);
    expect(checks([""])).toBe(false);
  });

  it("keep version 2 without mergeSlot", () => {
    expect(
      OfficeFileV2.safeParse({ version: 2, mergeSlot: { requiredChecks: ["a"] } }).success,
    ).toBe(false);
    expect(OfficeLocalFileV2.safeParse({ version: 2, mergeSlot: {} }).success).toBe(false);
  });
});

describe("migrateOfficeDocument", () => {
  it("migrates version 1 to 3 as the identity", () => {
    const v1 = { version: 1, worker: { adapter: "claude-cli" }, remote: "up" };
    expect(migrateOfficeDocument(1, v1)).toEqual({ ...v1, version: 3 });
    expect(v1.version).toBe(1);
  });

  it("migrates version 2 to 3 as the identity", () => {
    const v2 = { version: 2, worker: { plugins: ["warp@claude-code-warp"] } };
    expect(migrateOfficeDocument(2, v2)).toEqual({ ...v2, version: 3 });
  });

  it("leaves a version 3 document as it is", () => {
    const v3 = { version: 3, mergeSlot: { requiredChecks: ["build"] } };
    expect(migrateOfficeDocument(3, v3)).toEqual(v3);
  });

  it("turns the version 1 defaults into the version 3 defaults but worker.plugins and mergeSlot", () => {
    const { plugins: _plugins, ...worker } = OFFICE_DEFAULTS.worker;
    const { mergeSlot: _mergeSlot, ...rest } = OFFICE_DEFAULTS;
    const v1 = OfficeConfigV1.parse({ ...rest, version: 1, worker });
    expect(
      OfficeConfigV3.parse({
        ...migrateOfficeDocument(1, v1),
        worker: OFFICE_DEFAULTS.worker,
        mergeSlot: OFFICE_DEFAULTS.mergeSlot,
      }),
    ).toEqual(OFFICE_DEFAULTS);
  });
});

describe("defaults", () => {
  it("are a complete version 3 configuration", () => {
    expect(OfficeConfigV3.parse(OFFICE_DEFAULTS)).toEqual(OFFICE_DEFAULTS);
  });

  it("let no plugin into a worker session", () => {
    expect(OFFICE_DEFAULTS.worker.plugins).toEqual([]);
  });

  it("wait for ci-ok and pr-title in the merge slot (0016 rule 2)", () => {
    expect(OFFICE_DEFAULTS.mergeSlot.requiredChecks).toEqual(["ci-ok", "pr-title"]);
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
