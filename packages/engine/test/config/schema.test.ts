import { describe, expect, it } from "bun:test";

import {
  migrateOfficeDocument,
  OFFICE_CONFIG_VERSION,
  OFFICE_DEFAULTS,
  OfficeConfigV1,
  OfficeConfigV2,
  OfficeConfigV3,
  OfficeConfigV4,
  OfficeConfigV5,
  OfficeConfigV6,
  OfficeConfigV7,
  OfficeFileV1,
  OfficeFileV2,
  OfficeFileV3,
  OfficeFileV4,
  OfficeFileV5,
  OfficeFileV6,
  OfficeFileV7,
  OfficeLocalFileV1,
  OfficeLocalFileV2,
  OfficeLocalFileV3,
  OfficeLocalFileV4,
  OfficeLocalFileV5,
  OfficeLocalFileV6,
  OfficeLocalFileV7,
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

// Version 4 (DIPO-172): the office keys of version 3; office.local.yaml adds
// sandbox.toolchainReadPaths and no other sandbox key (0017 amendment of 2026-10-18).
const VERSION_4_KEY_PATHS = VERSION_3_KEY_PATHS;
const localAllowedV4 = (path: string) =>
  localAllowed(path) || path === "sandbox.toolchainReadPaths";

/** Whether `.dipo/office.local.yaml` of `version` (3 or 4) accepts `sandbox` as given. */
function localSandbox(version: 3 | 4, sandbox: unknown): boolean {
  const schema = version === 4 ? OfficeLocalFileV4 : OfficeLocalFileV3;
  return schema.safeParse({ version, sandbox }).success;
}

describe("version 4 key paths", () => {
  it("are the version 3 paths; office.local.yaml also takes sandbox.toolchainReadPaths", () => {
    expect(schemaKeyPaths(OfficeConfigV4)).toEqual(VERSION_4_KEY_PATHS.toSorted());
    expect(schemaKeyPaths(OfficeFileV4)).toEqual(
      VERSION_4_KEY_PATHS.filter((path) => !localOnly(path)).toSorted(),
    );
    expect(schemaKeyPaths(OfficeLocalFileV4)).toEqual(
      VERSION_4_KEY_PATHS.filter(localAllowedV4).toSorted(),
    );
  });

  it("take only toolchainReadPaths under sandbox in office.local.yaml, as ~/ or absolute paths", () => {
    expect(localSandbox(4, { toolchainReadPaths: ["~/.nvm/versions/node", "/opt/node"] })).toBe(
      true,
    );
    expect(localSandbox(4, {})).toBe(true);
    expect(localSandbox(4, { toolchainReadPaths: ["relative/node"] })).toBe(false);
    for (const key of ["allowRead", "installCachePaths", "registryHosts", "allowLocalBinding"]) {
      expect(localSandbox(4, { [key]: [] })).toBe(false);
    }
  });

  it("keep version 3 office.local.yaml without sandbox", () => {
    expect(localSandbox(3, { toolchainReadPaths: ["~/.nvm/versions/node"] })).toBe(false);
    expect(OfficeFileV3.safeParse({ version: 4 }).success).toBe(false);
    expect(
      OfficeFileV4.safeParse({ version: 4, mergeSlot: { requiredChecks: ["a"] } }).success,
    ).toBe(true);
  });
});

// Version 5 (DIPO-139): the review block and the rest of mergeSlot.
const VERSION_5_KEY_PATHS = [
  ...VERSION_4_KEY_PATHS,
  "review.model",
  "review.effort",
  "review.maxRounds",
  "review.maxTurns",
  "review.maxMinutes",
  "review.budgetTokens",
  "mergeSlot.autoMerge",
  "mergeSlot.conflictAttempts",
  "mergeSlot.ciAttempts",
  "mergeSlot.holdLabels",
  "mergeSlot.checksWaitMinutes",
];

/** Whether `.dipo/office.yaml` version 5 accepts `body` as given. */
function officeFileV5(body: object): boolean {
  return OfficeFileV5.safeParse({ version: 5, ...body }).success;
}

describe("version 5 key paths", () => {
  it("are the version 4 paths plus review and the rest of mergeSlot", () => {
    expect(schemaKeyPaths(OfficeConfigV5)).toEqual(VERSION_5_KEY_PATHS.toSorted());
    expect(schemaKeyPaths(OfficeFileV5)).toEqual(
      VERSION_5_KEY_PATHS.filter((path) => !localOnly(path)).toSorted(),
    );
    expect(schemaKeyPaths(OfficeLocalFileV5)).toEqual(
      VERSION_5_KEY_PATHS.filter(localAllowedV4).toSorted(),
    );
  });

  it("refuse a count below 1 and a duplicate hold label", () => {
    expect(officeFileV5({ review: { maxRounds: 0 } })).toBe(false);
    expect(officeFileV5({ mergeSlot: { ciAttempts: 0 } })).toBe(false);
    expect(officeFileV5({ mergeSlot: { holdLabels: ["hold", "hold"] } })).toBe(false);
    expect(officeFileV5({ mergeSlot: { holdLabels: ["hold", "wip"] } })).toBe(true);
  });
});

// Version 6 (DIPO-188): story.maintainerStepPhrases, the phrases of R27.
const VERSION_6_KEY_PATHS = [...VERSION_5_KEY_PATHS, "story.maintainerStepPhrases"];

/** Whether `.dipo/office.yaml` version 6 accepts `body` as given. */
function officeFileV6(body: object): boolean {
  return OfficeFileV6.safeParse({ version: 6, ...body }).success;
}

describe("version 6 key paths", () => {
  it("are the version 5 paths plus story.maintainerStepPhrases", () => {
    expect(schemaKeyPaths(OfficeConfigV6)).toEqual(VERSION_6_KEY_PATHS.toSorted());
    expect(schemaKeyPaths(OfficeFileV6)).toEqual(
      VERSION_6_KEY_PATHS.filter((path) => !localOnly(path)).toSorted(),
    );
    expect(schemaKeyPaths(OfficeLocalFileV6)).toEqual(
      VERSION_6_KEY_PATHS.filter(localAllowedV4).toSorted(),
    );
  });

  it("accept a list of phrases and refuse a non-string or empty entry", () => {
    expect(officeFileV6({ story: { maintainerStepPhrases: ["task notes"] } })).toBe(true);
    expect(officeFileV6({ story: { maintainerStepPhrases: [3] } })).toBe(false);
    expect(officeFileV6({ story: { maintainerStepPhrases: [""] } })).toBe(false);
  });

  it("keep version 5 without story.maintainerStepPhrases", () => {
    expect(
      OfficeFileV5.safeParse({ version: 5, story: { maintainerStepPhrases: [] } }).success,
    ).toBe(false);
  });
});

// Version 7 (DIPO-210): storyPr.open, the office switch for the story PR. office.local.yaml
// gains no key.
const VERSION_7_KEY_PATHS = [...VERSION_6_KEY_PATHS, "storyPr.open"];

/** Whether `.dipo/office.yaml` version 7 accepts `body` as given. */
function officeFileV7(body: object): boolean {
  return OfficeFileV7.safeParse({ version: 7, ...body }).success;
}

describe("version 7 key paths", () => {
  it("are the version 6 paths plus storyPr.open, which office.local.yaml does not take", () => {
    expect(OFFICE_CONFIG_VERSION).toBe(7);
    expect(schemaKeyPaths(OfficeConfigV7)).toEqual(VERSION_7_KEY_PATHS.toSorted());
    expect(schemaKeyPaths(OfficeFileV7)).toEqual(
      VERSION_7_KEY_PATHS.filter((path) => !localOnly(path)).toSorted(),
    );
    expect(schemaKeyPaths(OfficeLocalFileV7)).toEqual(
      VERSION_7_KEY_PATHS.filter(localAllowedV4).toSorted(),
    );
    expect(OfficeLocalFileV7.safeParse({ version: 7, storyPr: { open: false } }).success).toBe(
      false,
    );
  });

  it("accept a boolean storyPr.open and refuse anything else", () => {
    expect(officeFileV7({ storyPr: { open: false } })).toBe(true);
    expect(officeFileV7({ storyPr: {} })).toBe(true);
    expect(officeFileV7({ storyPr: { open: "no" } })).toBe(false);
    expect(officeFileV7({ storyPr: { open: false, draft: true } })).toBe(false);
  });

  it("keep version 6 without storyPr", () => {
    expect(OfficeFileV6.safeParse({ version: 6, storyPr: { open: false } }).success).toBe(false);
  });
});

describe("migrateOfficeDocument", () => {
  it("migrates version 1 to 7 as the identity", () => {
    const v1 = { version: 1, worker: { adapter: "claude-cli" }, remote: "up" };
    expect(migrateOfficeDocument(1, v1)).toEqual({ ...v1, version: 7 });
    expect(v1.version).toBe(1);
  });

  it("migrates version 2 to 7 as the identity", () => {
    const v2 = { version: 2, worker: { plugins: ["warp@claude-code-warp"] } };
    expect(migrateOfficeDocument(2, v2)).toEqual({ ...v2, version: 7 });
  });

  it("migrates version 3 to 7 as the identity", () => {
    const v3 = { version: 3, mergeSlot: { requiredChecks: ["build"] } };
    expect(migrateOfficeDocument(3, v3)).toEqual({ ...v3, version: 7 });
  });

  it("migrates version 4 to 7 as the identity", () => {
    const v4 = { version: 4, sandbox: { toolchainReadPaths: ["~/.nvm/versions/node"] } };
    expect(migrateOfficeDocument(4, v4)).toEqual({ ...v4, version: 7 });
  });

  it("migrates version 5 to 7 as the identity", () => {
    const v5 = { version: 5, review: { maxRounds: 2 } };
    expect(migrateOfficeDocument(5, v5)).toEqual({ ...v5, version: 7 });
  });

  it("migrates version 6 to 7 as the identity", () => {
    const v6 = { version: 6, story: { maintainerStepPhrases: ["task notes"] } };
    expect(migrateOfficeDocument(6, v6)).toEqual({ ...v6, version: 7 });
  });

  it("leaves a version 7 document as it is", () => {
    const v7 = { version: 7, storyPr: { open: false } };
    expect(migrateOfficeDocument(7, v7)).toEqual(v7);
  });

  it("turns the version 1 defaults into the version 7 defaults but worker.plugins, mergeSlot, review, the step phrases and storyPr", () => {
    const { plugins: _plugins, ...worker } = OFFICE_DEFAULTS.worker;
    const { maintainerStepPhrases: _phrases, ...story } = OFFICE_DEFAULTS.story;
    const { mergeSlot: _mergeSlot, review: _review, storyPr: _storyPr, ...rest } = OFFICE_DEFAULTS;
    const v1 = OfficeConfigV1.parse({ ...rest, story, version: 1, worker });
    expect(
      OfficeConfigV7.parse({
        ...migrateOfficeDocument(1, v1),
        worker: OFFICE_DEFAULTS.worker,
        mergeSlot: OFFICE_DEFAULTS.mergeSlot,
        review: OFFICE_DEFAULTS.review,
        story: OFFICE_DEFAULTS.story,
        storyPr: OFFICE_DEFAULTS.storyPr,
      }),
    ).toEqual(OFFICE_DEFAULTS);
  });
});

describe("defaults", () => {
  it("are a complete version 7 configuration", () => {
    expect(OfficeConfigV7.parse(OFFICE_DEFAULTS)).toEqual(OFFICE_DEFAULTS);
  });

  it("open the story PR (0019 section 3)", () => {
    expect(OFFICE_DEFAULTS.storyPr).toEqual({ open: true });
  });

  it("give the story the step phrases that R27 refuses", () => {
    expect(OFFICE_DEFAULTS.story.maintainerStepPhrases).toEqual([
      "task notes",
      "implementation notes",
      "by the maintainer",
      "backlog task edit",
    ]);
  });

  it("give the review loop opus, high effort and the ADR 0019 limits", () => {
    expect(OFFICE_DEFAULTS.review).toEqual({
      model: "opus",
      effort: "high",
      maxRounds: 3,
      maxTurns: 60,
      maxMinutes: 30,
      budgetTokens: 200_000,
    });
  });

  it("give the merge slot its ADR 0019 keys", () => {
    expect(OFFICE_DEFAULTS.mergeSlot).toEqual({
      requiredChecks: ["ci-ok", "pr-title"],
      autoMerge: true,
      conflictAttempts: 2,
      ciAttempts: 2,
      holdLabels: [],
      checksWaitMinutes: 30,
    });
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
    // Commands and prompts are stored by default (DIPO-135, DIPO-137); raw events stay off.
    expect(OFFICE_DEFAULTS.privacy).toEqual({
      storePrompts: true,
      storeCommandBodies: true,
      keepRawEvents: false,
    });
    expect(OFFICE_DEFAULTS.retention).toEqual({ shortDays: 7, stateDays: 365 });
  });
});

describe("privacyOptIns (DIPO-83)", () => {
  it("lists the privacy opt-ins that are on as full keys, in schema order", () => {
    expect(privacyOptIns(undefined)).toEqual([]);
    expect(privacyOptIns(OFFICE_DEFAULTS)).toEqual([
      "privacy.storePrompts",
      "privacy.storeCommandBodies",
    ]);
    expect(
      privacyOptIns({
        privacy: { storePrompts: false, storeCommandBodies: true, keepRawEvents: true },
      }),
    ).toEqual(["privacy.storeCommandBodies", "privacy.keepRawEvents"]);
  });
});
