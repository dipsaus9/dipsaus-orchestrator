import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  canonicalJson,
  configHash,
  loadOfficeConfig,
  mergeLayer,
  OFFICE_CONFIG_VERSION,
  OFFICE_DEFAULTS,
  resolveOfficeConfig,
  type ConfigError,
  type OfficeConfigResult,
} from "../../src/config";

// The sample of 0017, with its elided phrase lists filled in.
const SAMPLE_0017 = `# yaml-language-server: $schema=https://<release-url>/office.schema.json
version: 14
tiers:            # 0008
  S: { model: haiku,  effort: low,    budgetTokens: 300000,  maxTurns: 90,  maxMinutes: 45,  loops: 3 }
  M: { model: sonnet, effort: medium, budgetTokens: 800000,  maxTurns: 200, maxMinutes: 90,  loops: 5 }
  L: { model: opus,   effort: high,   budgetTokens: 2000000, maxTurns: 300, maxMinutes: 180, loops: 8 }
review: { model: opus, effort: high, maxRounds: 3, maxTurns: 60, maxMinutes: 30, budgetTokens: 200000 }  # 0002
caps: { ciAttempts: 2, conflictAttempts: 2 }                       # 0002
merge: { autoMerge: true, holdLabels: [] }                         # 0002
box: { files: [], localPorts: [] }                                 # 0008
scan: { model: sonnet, effort: low, budgetTokens: 100000, maxMinutes: 5 }  # 0013
story: { bannedPhrases: [maybe], securityPhrases: [guard] }        # 0012
prompt: { contractMax: 12000 }                                     # 0014
base: main                                                         # 0010
worktree: { root: "../{repo}.worktrees" }                          # 0010
scripts: { verify: bun run verify }                                # 0013
`;

const NEWER_DIPO = "this key may need a newer dipo";

function ok(result: OfficeConfigResult) {
  if (!result.ok) throw new Error(result.errors.map((error) => error.message).join("\n"));
  return result;
}

function errors(result: OfficeConfigResult): readonly ConfigError[] {
  if (result.ok) throw new Error("expected errors");
  return result.errors;
}

function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
}

describe("version 14", () => {
  it("is the version this binary knows", () => {
    expect(OFFICE_CONFIG_VERSION).toBe(14);
  });

  it("parses the 0017 sample with no warning", () => {
    const result = ok(resolveOfficeConfig({ office: SAMPLE_0017 }));
    expect(result.warnings).toEqual([]);
    expect(result.config.base).toBe("main");
    expect(result.config.scripts).toEqual({ verify: "bun run verify" });
    expect(result.config.box).toEqual({ files: [], localPorts: [] });
    expect(result.config.story.bannedPhrases).toEqual(["maybe"]);
    expect(result.config.story.titleMax).toBe(OFFICE_DEFAULTS.story.titleMax);
  });

  it("has the sections of the 0017 sample and timeouts, polling, privacy and retention", () => {
    expect(Object.keys(OFFICE_DEFAULTS)).toEqual([
      "version",
      "tiers",
      "review",
      "caps",
      "merge",
      "box",
      "scan",
      "story",
      "prompt",
      "worktree",
      "scripts",
      "timeouts",
      "polling",
      "privacy",
      "retention",
    ]);
    expect(OFFICE_DEFAULTS.worktree).toEqual({ root: "../{repo}.worktrees" });
    expect(OFFICE_DEFAULTS.caps).toEqual({ ciAttempts: 2, conflictAttempts: 2 });
    expect(OFFICE_DEFAULTS.merge).toEqual({
      autoMerge: true,
      holdLabels: [],
      checksWaitMinutes: 30,
    });
  });

  it("gives every key a default: an empty file loads as the defaults", () => {
    const result = ok(resolveOfficeConfig({ office: "version: 14\n", local: "version: 14\n" }));
    expect(result.config).toEqual(OFFICE_DEFAULTS);
  });

  it("has timeouts.testIdleMinutes (DIPO-309) with its default and accepts it in both files", () => {
    expect(OFFICE_DEFAULTS.timeouts.testIdleMinutes).toBe(240);
    const office = "version: 14\ntimeouts: { testIdleMinutes: 30 }\n";
    expect(ok(resolveOfficeConfig({ office })).config.timeouts.testIdleMinutes).toBe(30);
    const local = "version: 14\ntimeouts: { testIdleMinutes: 45 }\n";
    expect(ok(resolveOfficeConfig({ local })).config.timeouts.testIdleMinutes).toBe(45);
  });

  it("reads the moved keys at their new place", () => {
    const office = [
      "version: 14",
      "caps: { ciAttempts: 5 }",
      "merge: { autoMerge: false, holdLabels: [hold], checksWaitMinutes: 10 }",
      "",
    ].join("\n");
    const result = ok(resolveOfficeConfig({ office }));
    expect(result.config.caps).toEqual({ ciAttempts: 5, conflictAttempts: 2 });
    expect(result.config.merge).toEqual({
      autoMerge: false,
      holdLabels: ["hold"],
      checksWaitMinutes: 10,
    });
  });
});

describe("validation", () => {
  it("names the file, key path and 'may need a newer dipo' for an unknown key", () => {
    expect(
      errors(resolveOfficeConfig({ office: "version: 14\ntiers: { S: { loopz: 1 } }\n" })),
    ).toEqual([
      {
        file: ".dipo/office.yaml",
        path: "tiers.S.loopz",
        expected: "one of the keys model, effort, budgetTokens, maxTurns, maxMinutes, loops",
        message: `.dipo/office.yaml: tiers.S.loopz: unknown key; expected one of the keys model, effort, budgetTokens, maxTurns, maxMinutes, loops; ${NEWER_DIPO}`,
      },
    ]);
    const [top] = errors(resolveOfficeConfig({ office: "version: 14\nnewSection: {}\n" }));
    expect(top?.path).toBe("newSection");
    expect(top?.message).toEndWith(NEWER_DIPO);
  });

  it("says the same for an unknown key in an older file", () => {
    const [error, ...rest] = errors(
      resolveOfficeConfig({ office: "version: 3\ntimeouts: { workerStalMinutes: 5 }\n" }),
    );
    expect(rest).toEqual([]);
    expect(error?.path).toBe("timeouts.workerStalMinutes");
    expect(error?.expected).toContain("workerStallMinutes");
    expect(error?.message).toEndWith(NEWER_DIPO);
  });

  it("says why a retired or moved key is refused in a version 14 file", () => {
    const retired = errors(
      resolveOfficeConfig({ office: "version: 14\nsandbox: { toolchainReadPaths: [~/.bun] }\n" }),
    );
    expect(retired).toEqual([
      {
        file: ".dipo/office.yaml",
        path: "sandbox",
        expected: expect.any(String) as unknown as string,
        message:
          ".dipo/office.yaml: sandbox: unknown key; version 14 removed sandbox, because the Mac sandbox is gone: the box is the boundary (0008). Delete it",
      },
    ]);
    const nested = errors(
      resolveOfficeConfig({ office: "version: 14\nworktree: { files: [] }\n" }),
    );
    expect(nested[0]?.message).toContain("version 14 removed worktree.files");
    const moved = errors(resolveOfficeConfig({ office: "version: 14\nmergeSlot: {}\n" }));
    expect(moved[0]?.path).toBe("mergeSlot");
    expect(moved[0]?.message).toEndWith(NEWER_DIPO);
  });

  it("names the expected type of a wrong type", () => {
    expect(
      errors(
        resolveOfficeConfig({ office: "version: 14\ntiers: { S: { budgetTokens: lots } }\n" }),
      ),
    ).toEqual([
      {
        file: ".dipo/office.yaml",
        path: "tiers.S.budgetTokens",
        expected: "integer",
        message: ".dipo/office.yaml: tiers.S.budgetTokens: expected integer, got string",
      },
    ]);
  });

  it("refuses a missing version", () => {
    expect(errors(resolveOfficeConfig({ office: "base: main\n" }))).toEqual([
      {
        file: ".dipo/office.yaml",
        path: "version",
        expected: "integer",
        message: ".dipo/office.yaml: version: expected integer, got nothing; version is required",
      },
    ]);
    expect(errors(resolveOfficeConfig({ office: "# nothing yet\n" }))[0]?.path).toBe("version");
  });

  it("refuses a version that is not an integer", () => {
    expect(errors(resolveOfficeConfig({ office: "version: '14'\n" }))[0]?.message).toBe(
      ".dipo/office.yaml: version: expected integer, got string",
    );
  });

  it("refuses a file with two documents and a top level that is not a mapping", () => {
    const [two] = errors(resolveOfficeConfig({ office: "version: 14\n---\nversion: 14\n" }));
    expect(two?.message).toContain("more than one YAML document");
    expect(errors(resolveOfficeConfig({ office: "- version\n" }))[0]?.message).toBe(
      ".dipo/office.yaml: (top level): expected mapping, got list",
    );
  });

  it("refuses a newer version with a message to upgrade dipo, in either file", () => {
    const [office] = errors(resolveOfficeConfig({ office: "version: 15\nnewKey: true\n" }));
    expect(office?.path).toBe("version");
    expect(office?.message).toContain("upgrade dipo");
    const [local] = errors(resolveOfficeConfig({ local: "version: 15\n" }));
    expect(local?.file).toBe(".dipo/office.local.yaml");
    expect(local?.message).toContain("upgrade dipo");
  });

  it("points privacy.* and retention.* in office.yaml to the local file", () => {
    const result = errors(
      resolveOfficeConfig({
        office: "version: 14\nprivacy: { x: true }\nretention: { shortDays: 3 }\n",
      }),
    );
    expect(result.map((error) => error.path)).toEqual(["privacy.x", "retention.shortDays"]);
    for (const error of result) {
      expect(error.message).toContain("accepted only in .dipo/office.local.yaml");
    }
  });

  it("refuses any local key outside timeouts.*, privacy.* and retention.*", () => {
    expect(errors(resolveOfficeConfig({ local: "version: 14\ntiers: {}\n" }))).toEqual([
      {
        file: ".dipo/office.local.yaml",
        path: "tiers",
        expected: "one of the keys version, timeouts, privacy, retention",
        message: `.dipo/office.local.yaml: tiers: unknown key; .dipo/office.local.yaml accepts only version, timeouts.*, privacy.*, retention.*; ${NEWER_DIPO}`,
      },
    ]);
    const [nested] = errors(resolveOfficeConfig({ local: "version: 14\ntimeouts: { nope: 1 }\n" }));
    expect(nested?.expected).toBe(
      "one of the keys workerStallMinutes, workerQuietMinutes, questionWaitMinutes, scriptMinutes, testIdleMinutes",
    );
  });

  it("refuses box as a command flag override, so no flag can feed a build", () => {
    const [error] = errors(resolveOfficeConfig({ flags: { box: { debian: "trixie" } } }));
    expect(error?.file).toBe("command flags");
    expect(error?.path).toBe("box");
  });

  it("refuses a box file without its noRealSecrets mark", () => {
    const [error] = errors(
      resolveOfficeConfig({ office: "version: 14\nbox: { files: [{ path: .env }] }\n" }),
    );
    expect(error?.path).toBe("box.files.0.noRealSecrets");
  });

  it("reports errors from every file at once", () => {
    const result = errors(
      resolveOfficeConfig({
        office: "version: 14\nbase: 7\n",
        local: "version: 14\nprivacy: { storePrompts: yes }\n",
        flags: { polling: { fetchSeconds: 0 } },
      }),
    );
    expect(result.map((error) => `${error.file} ${error.path}`)).toEqual([
      ".dipo/office.yaml base",
      ".dipo/office.local.yaml privacy.storePrompts",
      "command flags polling.fetchSeconds",
    ]);
  });

  it("returns errors as values and throws nothing for bad input", () => {
    const bad = [
      "tiers: [\n",
      "\u0000\u0001",
      ":::",
      "version: 14\ntiers: 5\n",
      "version: 1e400\n",
    ];
    for (const office of bad) {
      expect(() => resolveOfficeConfig({ office })).not.toThrow();
      expect(resolveOfficeConfig({ office }).ok).toBe(false);
    }
    expect(resolveOfficeConfig({ flags: "not a mapping" }).ok).toBe(false);
  });
});

describe("precedence and merge", () => {
  it("uses the built-in defaults without files", () => {
    const result = ok(resolveOfficeConfig({}));
    expect(result.config).toEqual(OFFICE_DEFAULTS);
    expect(result.localOverrideKeys).toEqual([]);
    expect(result.config.base).toBeUndefined();
  });

  it("orders defaults < office.yaml < local keys < command flags", () => {
    const result = ok(
      resolveOfficeConfig({
        office: "version: 14\ntimeouts: { workerStallMinutes: 30, workerQuietMinutes: 4 }\n",
        local: "version: 14\ntimeouts: { workerStallMinutes: 40, questionWaitMinutes: 5 }\n",
        flags: { timeouts: { questionWaitMinutes: 6 } },
      }),
    );
    expect(result.config.timeouts).toEqual({
      ...OFFICE_DEFAULTS.timeouts,
      workerStallMinutes: 40,
      workerQuietMinutes: 4,
      questionWaitMinutes: 6,
    });
  });

  it("takes privacy.* and retention.* from the local file only", () => {
    const result = ok(
      resolveOfficeConfig({
        local: "version: 14\nprivacy: { keepRawEvents: true }\nretention: { stateDays: 30 }\n",
      }),
    );
    expect(result.config.privacy).toEqual({ ...OFFICE_DEFAULTS.privacy, keepRawEvents: true });
    expect(result.config.retention).toEqual({ shortDays: 7, stateDays: 30 });
    expect(resolveOfficeConfig({ flags: { privacy: { keepRawEvents: true } } }).ok).toBe(false);
  });

  it("merges objects and records per key and replaces lists and scalars", () => {
    const result = ok(
      resolveOfficeConfig({
        office: [
          "version: 14",
          "tiers: { L: { model: opus-4 } }",
          "story: { types: [feature, spike] }",
          "scripts: { verify: bun run check }",
          "",
        ].join("\n"),
        local: "version: 14\ntimeouts: { scriptMinutes: { verify: 45 } }\n",
        flags: { story: { bannedPhrases: ["maybe"] }, scripts: { test: "bun test" } },
      }),
    );
    expect(result.config.tiers.L).toEqual({ ...OFFICE_DEFAULTS.tiers.L, model: "opus-4" });
    expect(result.config.story.types).toEqual(["feature", "spike"]);
    expect(result.config.story.bannedPhrases).toEqual(["maybe"]);
    expect(result.config.scripts).toEqual({ verify: "bun run check", test: "bun test" });
    expect(result.config.timeouts.scriptMinutes).toEqual({ install: 15, setup: 10, verify: 45 });
  });

  it("returns the active local override keys", () => {
    const result = ok(
      resolveOfficeConfig({
        office: "version: 14\ntimeouts: { workerQuietMinutes: 4 }\n",
        local: [
          "version: 14",
          "timeouts: { workerStallMinutes: 40, scriptMinutes: { verify: 30 } }",
          "privacy: { storePrompts: true }",
          "",
        ].join("\n"),
      }),
    );
    expect(result.localOverrideKeys).toEqual([
      "privacy.storePrompts",
      "timeouts.scriptMinutes.verify",
      "timeouts.workerStallMinutes",
    ]);
  });

  it("mergeLayer leaves its inputs unchanged", () => {
    const base = { a: { b: 1, c: [1, 2] } };
    const over = { a: { c: [3] } };
    expect(mergeLayer(base, over)).toEqual({ a: { b: 1, c: [3] } });
    expect(base).toEqual({ a: { b: 1, c: [1, 2] } });
  });
});

describe("configHash", () => {
  it("is sha256 hex over the canonical JSON", () => {
    const result = ok(resolveOfficeConfig({}));
    const expected = new Bun.CryptoHasher("sha256")
      .update(canonicalJson(result.config))
      .digest("hex");
    expect(result.configHash).toBe(expected);
  });

  it("is stable across key order and changes with any value", () => {
    const a = ok(
      resolveOfficeConfig({
        office: "version: 14\npolling: { fetchSeconds: 9, prStateSeconds: 8 }\n",
      }),
    );
    const b = ok(
      resolveOfficeConfig({
        office: "polling: { prStateSeconds: 8, fetchSeconds: 9 }\nversion: 14\n",
      }),
    );
    expect(a.configHash).toBe(b.configHash);
    const changed = ok(
      resolveOfficeConfig({ local: "version: 14\nretention: { shortDays: 8 }\n" }),
    ).configHash;
    expect(changed).not.toBe(ok(resolveOfficeConfig({})).configHash);
    expect(configHash({ list: [1, 2] })).not.toBe(configHash({ list: [2, 1] }));
  });

  it("is the same for an older file and its version 14 form", () => {
    const old = ok(resolveOfficeConfig({ office: fixture("office-v5.yaml") }));
    const migrated = ok(
      resolveOfficeConfig({
        office: [
          "version: 14",
          "review: { maxRounds: 2 }",
          "caps: { conflictAttempts: 4, ciAttempts: 3 }",
          "merge: { autoMerge: false, holdLabels: [hold], checksWaitMinutes: 45 }",
          "",
        ].join("\n"),
      }),
    );
    expect(old.configHash).toBe(migrated.configHash);
  });
});

// One fixture per earlier version (test plan of DIPO-353): each migrates to version 14 in memory,
// names every key it dropped or moved, and keeps the rest.
describe("the migration from every earlier version", () => {
  const cases: ReadonlyArray<{
    readonly version: number;
    readonly warned: readonly string[];
    readonly check: (config: ReturnType<typeof ok>["config"]) => void;
  }> = [
    {
      version: 1,
      warned: [
        "worker.adapter",
        "worker.allowProjectSettings",
        "permissions",
        "sandbox",
        "remote",
        "worktree.files",
        "worktree.ports",
        "worktree.env",
        "worktree.post_create",
        "worktree.maxSlots",
        "timeouts.permissionWaitSeconds",
        "prompt.budgets.contextItem",
        "prompt.budgets.inputsFile",
        "prompt.budgets.feedbackLogLines",
        "prompt.budgets.nudge",
      ],
      check: (config) => {
        expect(config.tiers.S.budgetTokens).toBe(250_000);
        expect(config.timeouts.workerStallMinutes).toBe(25);
        expect(config.base).toBe("main");
        expect(config.worktree).toEqual({ root: "../{repo}.trees" });
        expect(config.story.titleMax).toBe(90);
        expect(config.prompt.contractMax).toBe(11_000);
        expect(config.prompt.budgets.context).toEqual({ S: 1000, M: 2000, L: 3000, XL: 4000 });
        expect(config.polling.fetchSeconds).toBe(120);
      },
    },
    {
      version: 2,
      warned: ["worker.plugins"],
      check: (config) => expect(config.scripts).toEqual({ test: "bun test" }),
    },
    {
      version: 3,
      warned: ["mergeSlot.requiredChecks"],
      check: (config) => expect(config.story.slugMax).toBe(30),
    },
    { version: 4, warned: [], check: (config) => expect(config.story.criterionMin).toBe(12) },
    {
      version: 5,
      warned: [
        "mergeSlot.ciAttempts",
        "mergeSlot.conflictAttempts",
        "mergeSlot.autoMerge",
        "mergeSlot.holdLabels",
        "mergeSlot.checksWaitMinutes",
        "mergeSlot.requiredChecks",
      ],
      check: (config) => {
        expect(config.review.maxRounds).toBe(2);
        expect(config.caps).toEqual({ ciAttempts: 3, conflictAttempts: 4 });
        expect(config.merge).toEqual({
          autoMerge: false,
          holdLabels: ["hold"],
          checksWaitMinutes: 45,
        });
      },
    },
    {
      version: 6,
      warned: ["story.maintainerStepPhrases"],
      check: (config) => expect(config.story.outcomeMin).toBe(30),
    },
    {
      version: 7,
      warned: ["storyPr"],
      check: (config) => expect(config.polling.prStateSeconds).toBe(90),
    },
    {
      version: 8,
      warned: ["worker.web"],
      check: (config) => expect(config.timeouts.workerQuietMinutes).toBe(4),
    },
    {
      version: 9,
      warned: ["permissions"],
      check: (config) =>
        expect(config.box).toEqual({
          debian: "trixie",
          files: [{ path: ".env", noRealSecrets: true }],
        }),
    },
    {
      version: 10,
      warned: ["permissions"],
      check: (config) => expect(config.timeouts.questionWaitMinutes).toBe(20),
    },
    {
      version: 11,
      warned: [],
      check: (config) => {
        expect(config.story.securityPhrases).toEqual(["guard"]);
        expect(config.story.securityCriteriaPhrases).toEqual({
          ...OFFICE_DEFAULTS.story.securityCriteriaPhrases,
          failClosed: ["real path"],
        });
      },
    },
    { version: 12, warned: [], check: (config) => expect(config.box.localPorts).toEqual([5432]) },
    {
      version: 13,
      warned: ["mergeSlot.autoMerge", "worktree.maxSlots", "mergeSlot.requiredChecks"],
      check: (config) => {
        expect(config.scan.maxMinutes).toBe(7);
        expect(config.merge.autoMerge).toBe(false);
        expect(config.worktree.root).toBe("../{repo}.trees");
      },
    },
  ];

  it("has a fixture for every version from 1 to 13", () => {
    expect(cases.map((entry) => entry.version)).toEqual(
      Array.from({ length: OFFICE_CONFIG_VERSION - 1 }, (_, index) => index + 1),
    );
  });

  for (const entry of cases) {
    it(`migrates the version ${entry.version} fixture and names ${entry.warned.length === 0 ? "no key" : entry.warned.join(", ")}`, () => {
      const text = fixture(`office-v${entry.version}.yaml`);
      expect(text).toContain(`version: ${entry.version}\n`);
      const result = ok(resolveOfficeConfig({ office: text }));
      expect(result.warnings.map((warning) => warning.path).toSorted()).toEqual(
        [...entry.warned].toSorted(),
      );
      for (const warning of result.warnings) {
        expect(warning.file).toBe(".dipo/office.yaml");
        expect(warning.message).toStartWith(`.dipo/office.yaml: ${warning.path}: `);
        expect(warning.message).toContain("dipo config migrate");
      }
      entry.check(result.config);
    });
  }

  it("says why a dropped key is gone and where a moved key went", () => {
    const result = ok(resolveOfficeConfig({ office: fixture("office-v5.yaml") }));
    const byPath = new Map(result.warnings.map((warning) => [warning.path, warning.message]));
    expect(byPath.get("mergeSlot.ciAttempts")).toBe(
      ".dipo/office.yaml: mergeSlot.ciAttempts: read as caps.ciAttempts, its place since version 14; dipo config migrate moves it",
    );
    expect(byPath.get("mergeSlot.requiredChecks")).toBe(
      ".dipo/office.yaml: mergeSlot.requiredChecks: ignored; version 14 removed it, because the required checks are the ones GitHub requires on the base (0002). dipo config migrate deletes it",
    );
  });

  it("keeps a key set at its new place and drops the old one with a warning", () => {
    const result = ok(
      resolveOfficeConfig({
        office: "version: 13\nmergeSlot: { ciAttempts: 9 }\ncaps: { ciAttempts: 4 }\n",
      }),
    );
    expect(result.config.caps.ciAttempts).toBe(4);
    expect(result.warnings.map((warning) => warning.message)).toEqual([
      ".dipo/office.yaml: mergeSlot.ciAttempts: ignored; version 14 removed it, because caps.ciAttempts is set already. dipo config migrate deletes it",
    ]);
  });

  it("still refuses a wrong value of a key that stays", () => {
    const [error] = errors(
      resolveOfficeConfig({ office: "version: 9\ntimeouts: { workerQuietMinutes: 0 }\n" }),
    );
    expect(error?.path).toBe("timeouts.workerQuietMinutes");
  });

  it("migrates an older local file, drops its sandbox key and names it", () => {
    const result = ok(
      resolveOfficeConfig({
        office: fixture("office-v13.yaml"),
        local: fixture("office-local-v4.yaml"),
      }),
    );
    const local = result.warnings.filter((warning) => warning.file === ".dipo/office.local.yaml");
    expect(local.map((warning) => warning.path)).toEqual([
      "sandbox",
      "timeouts.permissionWaitSeconds",
    ]);
    expect(result.config.timeouts.workerStallMinutes).toBe(25);
    expect(result.config.privacy.keepRawEvents).toBe(true);
    expect(result.config.retention.shortDays).toBe(3);
    expect(result.localOverrideKeys).toEqual([
      "privacy.keepRawEvents",
      "retention.shortDays",
      "timeouts.workerStallMinutes",
    ]);
  });
});

function writeDipo(dir: string, files: Record<string, string>): void {
  mkdirSync(join(dir, ".dipo"), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, ".dipo", name), text);
}

describe("loadOfficeConfig", () => {
  it("uses the defaults when .dipo has no files", async () => {
    await withTempDir(async (dir) => {
      expect(ok(await loadOfficeConfig(dir)).config).toEqual(OFFICE_DEFAULTS);
    });
  });

  it("reads office.yaml, office.local.yaml and flags, and returns the warnings", async () => {
    await withTempDir(async (dir) => {
      writeDipo(dir, {
        "office.yaml": fixture("office-v7.yaml"),
        "office.local.yaml": "version: 14\ntimeouts: { workerQuietMinutes: 5 }\n",
      });
      const result = ok(await loadOfficeConfig(dir, { flags: { base: "develop" } }));
      expect(result.config.polling.prStateSeconds).toBe(90);
      expect(result.config.timeouts.workerQuietMinutes).toBe(5);
      expect(result.config.base).toBe("develop");
      expect(result.localOverrideKeys).toEqual(["timeouts.workerQuietMinutes"]);
      expect(result.warnings.map((warning) => warning.path)).toEqual(["storyPr"]);
    });
  });

  it("returns the error list for an invalid file and an unreadable file", async () => {
    await withTempDir(async (dir) => {
      writeDipo(dir, { "office.yaml": "version: 14\ntiers: [\n" });
      expect(errors(await loadOfficeConfig(dir))[0]?.file).toBe(".dipo/office.yaml");
    });
    await withTempDir(async (dir) => {
      mkdirSync(join(dir, ".dipo", "office.local.yaml"), { recursive: true });
      expect(errors(await loadOfficeConfig(dir))[0]?.message).toStartWith(
        ".dipo/office.local.yaml: (top level): cannot read the file",
      );
    });
  });
});
