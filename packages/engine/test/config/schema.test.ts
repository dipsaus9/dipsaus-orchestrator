import { describe, expect, it } from "bun:test";

import {
  migrateOfficeDocument,
  OFFICE_UPGRADES,
  OLDEST_OFFICE_CONFIG_VERSION,
  OFFICE_DEFAULTS,
  OfficeConfigSchema,
  OfficeFileSchema,
  OfficeLocalFileSchema,
  privacyOptIns,
  RENAMED_KEYS,
  RETIRED_KEYS,
  schemaKeyPaths,
} from "../../src/config";

const sizes = (section: string) => ["S", "M", "L", "XL"].map((size) => `${section}.${size}`);
const tier = (name: string) =>
  ["model", "effort", "budgetTokens", "maxTurns", "maxMinutes", "loops"].map(
    (key) => `tiers.${name}.${key}`,
  );
const box = (name: string) => `box.${name}`;

// Version 16 (0017): only keys code reads. A key added later with a default needs no version bump,
// so a new key is added here and to the schema in the same change.
const KEY_PATHS = [
  "version",
  ...tier("S"),
  ...tier("M"),
  ...tier("L"),
  "review.model",
  "review.effort",
  ...["S", "M", "L"].flatMap((name) => [
    `review.tiers.${name}.model`,
    `review.tiers.${name}.effort`,
  ]),
  "review.maxRounds",
  "review.maxTurns",
  "review.maxMinutes",
  "review.budgetTokens",
  "caps.ciAttempts",
  "caps.conflictAttempts",
  "merge.autoMerge",
  "merge.waitLabels",
  "merge.checksWaitMinutes",
  ...["debian", "packages", "workerCli", "files", "localPorts"].map(box),
  ...["node", "bun", "pnpm", "yarn", "nodeSha256.arm64", "nodeSha256.x64"].map((tool) =>
    box(`toolchain.${tool}`),
  ),
  "scan.model",
  "scan.effort",
  "scan.budgetTokens",
  "scan.maxMinutes",
  "story.types",
  "story.tiers",
  "story.bannedPhrases",
  "story.securityPhrases",
  "story.securityCriteriaPhrases.oldBarrier",
  "story.securityCriteriaPhrases.bypassForms",
  "story.securityCriteriaPhrases.failClosed",
  "story.titleMax",
  "story.criterionMin",
  "story.slugMax",
  ...[
    "context",
    "inputs",
    "dependencies",
    "background",
    "handoff",
    "feedbackItem",
    "feedbackTotal",
    "diff",
    "taskMessage",
  ].flatMap((section) => sizes(`prompt.budgets.${section}`)),
  "prompt.contractMax",
  "base",
  "worktree.root",
  "scripts.*",
  "timeouts.workerStallMinutes",
  "timeouts.workerQuietMinutes",
  "timeouts.scriptMinutes.*",
  "timeouts.testIdleMinutes",
  "polling.prStateSeconds",
  "polling.fetchSeconds",
  "privacy.storePrompts",
  "privacy.storeCommandBodies",
  "privacy.keepRawEvents",
  "retention.days",
];

const localOnly = (path: string) => /^(privacy|retention)\./.test(path);
const localAllowed = (path: string) =>
  path === "version" || /^(timeouts|privacy|retention)\./.test(path);

function boxFile(section: object): boolean {
  return OfficeFileSchema.safeParse({ version: 16, box: section }).success;
}

describe("version 16 key paths", () => {
  it("are the keys code reads", () => {
    expect(schemaKeyPaths(OfficeConfigSchema)).toEqual(KEY_PATHS.toSorted());
  });

  it("office.yaml accepts every key except privacy.* and retention.*", () => {
    expect(schemaKeyPaths(OfficeFileSchema)).toEqual(
      KEY_PATHS.filter((path) => !localOnly(path)).toSorted(),
    );
  });

  it("office.local.yaml accepts only version, timeouts.*, privacy.* and retention.*", () => {
    expect(schemaKeyPaths(OfficeLocalFileSchema)).toEqual(
      KEY_PATHS.filter(localAllowed).toSorted(),
    );
  });

  it("hold no renamed key's old name, and its new name", () => {
    const paths = schemaKeyPaths(OfficeConfigSchema);
    for (const { from, to } of RENAMED_KEYS) {
      expect(paths.filter((key) => key === from || key.startsWith(`${from}.`))).toEqual([]);
      expect(paths.some((key) => key === to || key.startsWith(`${to}.`))).toBe(true);
    }
  });

  it("hold no retired key", () => {
    const paths = schemaKeyPaths(OfficeConfigSchema);
    for (const { path } of RETIRED_KEYS) {
      expect(paths.filter((key) => key === path || key.startsWith(`${path}.`))).toEqual([]);
    }
  });
});

describe("the box block", () => {
  it("accepts a full box block, and any part of it", () => {
    expect(
      boxFile({
        debian: "trixie",
        toolchain: { node: "24.22.1", bun: "1.4.2", pnpm: "12.14.0", yarn: "1.22.22" },
        packages: ["jq", "libssl-dev=3.5.1-1", "g++"],
        workerCli: "2.1.303",
        files: [{ path: "config/dev.env.example", noRealSecrets: true }],
        localPorts: [5432],
      }),
    ).toBe(true);
    expect(boxFile({})).toBe(true);
    expect(boxFile({ toolchain: { bun: "1.4.2" } })).toBe(true);
  });

  it("refuses a file outside git that is not marked as holding no real secrets", () => {
    expect(boxFile({ files: [{ path: ".env.local" }] })).toBe(false);
    expect(boxFile({ files: [{ path: ".env.local", noRealSecrets: false }] })).toBe(false);
    expect(boxFile({ files: [".env.local"] })).toBe(false);
  });

  it("refuses a file path that leaves the repository or names git's folder", () => {
    for (const path of ["/etc/passwd", "../secrets.env", "a//b", ".git/config", ".GIT/x", "a:b"]) {
      expect(boxFile({ files: [{ path, noRealSecrets: true }] })).toBe(false);
    }
  });

  it("refuses versions that are not exact, Yarn 2+, unknown tools and bad package names", () => {
    expect(boxFile({ toolchain: { bun: "^1.4.2" } })).toBe(false);
    expect(boxFile({ workerCli: "latest" })).toBe(false);
    // Version 16 renamed the key with no migration: the old name is refused.
    expect(boxFile({ claudeCode: "2.1.303" })).toBe(false);
    expect(boxFile({ toolchain: { yarn: "4.5.0" } })).toBe(false);
    expect(boxFile({ toolchain: { deno: "2.0.0" } })).toBe(false);
    expect(boxFile({ packages: ["jq; curl evil"] })).toBe(false);
    expect(boxFile({ packages: ["git"] })).toBe(true);
    expect(boxFile({ debian: "Trixie" })).toBe(false);
  });

  it("refuses a local port out of range or named twice", () => {
    for (const localPorts of [[0], [65_536], [80.5], ["5432"], [5432, 5432]]) {
      expect(boxFile({ localPorts })).toBe(false);
    }
  });
});

describe("migrateOfficeDocument", () => {
  it("carries no upgrade: version 16 is the only version this binary reads", () => {
    expect(OFFICE_UPGRADES).toEqual([]);
    expect(OLDEST_OFFICE_CONFIG_VERSION).toBe(16);
  });

  it("leaves a version 16 document as it is", () => {
    const document = { version: 16, base: "main", timeouts: { workerStallMinutes: 40 } };
    expect(migrateOfficeDocument(16, document)).toEqual({ document, steps: [] });
  });

  it("refuses an older document with the version it found and the one it needs", () => {
    for (const version of [1, 14, 15]) {
      expect(() => migrateOfficeDocument(version, { version, base: "main" })).toThrow(
        `configuration version ${version} is older than this dipo reads (version 16), and this dipo has no upgrade from it`,
      );
    }
  });
});

describe("defaults", () => {
  it("are a complete version 16 configuration", () => {
    expect(OfficeConfigSchema.parse(OFFICE_DEFAULTS)).toEqual(OFFICE_DEFAULTS);
  });

  it("carry the ADR values", () => {
    expect(OFFICE_DEFAULTS.tiers.M).toEqual({
      model: "sonnet",
      effort: "medium",
      budgetTokens: 800_000,
      maxTurns: 200,
      maxMinutes: 90,
      loops: 5,
    });
    expect(OFFICE_DEFAULTS.review).toEqual({
      model: "opus",
      effort: "high",
      tiers: {},
      maxRounds: 3,
      maxTurns: 60,
      maxMinutes: 30,
      budgetTokens: 200_000,
    });
    expect(OFFICE_DEFAULTS.scan).toEqual({
      model: "sonnet",
      effort: "low",
      budgetTokens: 100_000,
      maxMinutes: 5,
    });
    expect(OFFICE_DEFAULTS.timeouts).toEqual({
      workerStallMinutes: 20,
      workerQuietMinutes: 3,
      scriptMinutes: { install: 15, setup: 10, verify: 20 },
      testIdleMinutes: 240,
    });
    expect(OFFICE_DEFAULTS.box).toEqual({});
    expect(OFFICE_DEFAULTS.prompt.contractMax).toBe(12_000);
    expect(OFFICE_DEFAULTS.polling).toEqual({ prStateSeconds: 60, fetchSeconds: 300 });
    expect(OFFICE_DEFAULTS.privacy).toEqual({
      storePrompts: true,
      storeCommandBodies: true,
      keepRawEvents: false,
    });
    // One retention rule (0007).
    expect(OFFICE_DEFAULTS.retention).toEqual({ days: 30 });
  });

  it("give R30 a phrase list for each criteria part (DIPO-251)", () => {
    expect(OFFICE_DEFAULTS.story.securityPhrases).toContain("deny rule");
    expect(Object.keys(OFFICE_DEFAULTS.story.securityCriteriaPhrases)).toEqual([
      "oldBarrier",
      "bypassForms",
      "failClosed",
    ]);
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
