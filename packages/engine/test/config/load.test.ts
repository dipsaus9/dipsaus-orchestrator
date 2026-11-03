import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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
version: 16
tiers:            # 0008
  S: { model: haiku,  effort: low,    budgetTokens: 300000,  maxTurns: 90,  maxMinutes: 45,  loops: 3 }
  M: { model: sonnet, effort: medium, budgetTokens: 800000,  maxTurns: 200, maxMinutes: 90,  loops: 5 }
  L: { model: opus,   effort: high,   budgetTokens: 2000000, maxTurns: 300, maxMinutes: 180, loops: 8 }
review: { model: opus, effort: high, maxRounds: 3, maxTurns: 60, maxMinutes: 30, budgetTokens: 200000 }  # 0002
caps: { ciAttempts: 2, conflictAttempts: 2 }                       # 0002
merge: { autoMerge: true, waitLabels: [] }                         # 0002
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

describe("version 16", () => {
  it("is the version this binary knows", () => {
    expect(OFFICE_CONFIG_VERSION).toBe(16);
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
    expect(OFFICE_DEFAULTS.worktree).toEqual({
      root: "../{repo}.worktrees",
      rebuildable: ["node_modules/", ".DS_Store", ".tsbuild/", ".claude/.cc-writes/"],
    });
    expect(OFFICE_DEFAULTS.caps).toEqual({ ciAttempts: 2, conflictAttempts: 2 });
    expect(OFFICE_DEFAULTS.merge).toEqual({
      autoMerge: true,
      waitLabels: [],
      checksWaitMinutes: 30,
    });
  });

  it("gives every key a default: an empty file loads as the defaults", () => {
    const result = ok(resolveOfficeConfig({ office: "version: 16\n", local: "version: 16\n" }));
    expect(result.config).toEqual(OFFICE_DEFAULTS);
  });

  it("has timeouts.testIdleMinutes (DIPO-309) with its default and accepts it in both files", () => {
    expect(OFFICE_DEFAULTS.timeouts.testIdleMinutes).toBe(240);
    const office = "version: 16\ntimeouts: { testIdleMinutes: 30 }\n";
    expect(ok(resolveOfficeConfig({ office })).config.timeouts.testIdleMinutes).toBe(30);
    const local = "version: 16\ntimeouts: { testIdleMinutes: 45 }\n";
    expect(ok(resolveOfficeConfig({ local })).config.timeouts.testIdleMinutes).toBe(45);
  });

  it("reads the moved keys at their new place", () => {
    const office = [
      "version: 16",
      "caps: { ciAttempts: 5 }",
      "merge: { autoMerge: false, waitLabels: [hold], checksWaitMinutes: 10 }",
      "",
    ].join("\n");
    const result = ok(resolveOfficeConfig({ office }));
    expect(result.config.caps).toEqual({ ciAttempts: 5, conflictAttempts: 2 });
    expect(result.config.merge).toEqual({
      autoMerge: false,
      waitLabels: ["hold"],
      checksWaitMinutes: 10,
    });
  });
});

describe("validation", () => {
  it("names the file, key path and 'may need a newer dipo' for an unknown key", () => {
    expect(
      errors(resolveOfficeConfig({ office: "version: 16\ntiers: { S: { loopz: 1 } }\n" })),
    ).toEqual([
      {
        file: ".dipo/office.yaml",
        path: "tiers.S.loopz",
        expected: "one of the keys model, effort, budgetTokens, maxTurns, maxMinutes, loops",
        message: `.dipo/office.yaml: tiers.S.loopz: unknown key; expected one of the keys model, effort, budgetTokens, maxTurns, maxMinutes, loops; ${NEWER_DIPO}`,
      },
    ]);
    const [top] = errors(resolveOfficeConfig({ office: "version: 16\nnewSection: {}\n" }));
    expect(top?.path).toBe("newSection");
    expect(top?.message).toEndWith(NEWER_DIPO);
  });

  it("refuses an older version with the version it found and the one it needs, in either file", () => {
    for (const version of [1, 14, 15]) {
      for (const sources of [
        { office: `version: ${version}\ntimeouts: { workerStallMinutes: 5 }\n` },
        { local: `version: ${version}\n` },
      ]) {
        const file = "office" in sources ? ".dipo/office.yaml" : ".dipo/office.local.yaml";
        expect(errors(resolveOfficeConfig(sources))).toEqual([
          {
            file,
            path: "version",
            expected: "16",
            message: `${file}: version: configuration version ${version} is older than this dipo reads (version 16), and this dipo has no upgrade from it: set version to 16, then fix the keys the next load names`,
          },
        ]);
      }
    }
  });

  it("refuses a key an earlier version retired as an unknown key", () => {
    for (const office of [
      "version: 16\nsandbox: { toolchainReadPaths: [~/.bun] }\n",
      "version: 16\nmergeSlot: {}\n",
      "version: 16\ntimeouts: { questionWaitMinutes: 5 }\n",
    ]) {
      const [error, ...rest] = errors(resolveOfficeConfig({ office }));
      expect(rest).toEqual([]);
      expect(error?.message).toEndWith(NEWER_DIPO);
    }
  });

  // Version 16 renamed the keys with no migration: a file that still sets one is refused with its
  // new name, so a label that should make a merge wait is never ignored without a word.
  it("refuses merge.holdLabels and box.claudeCode with the names version 16 gave them", () => {
    for (const sources of [
      { office: "version: 16\nmerge: { holdLabels: [hold] }\n" },
      { office: "version: 16\nbox: { claudeCode: 2.1.303 }\n" },
    ]) {
      const [error, ...rest] = errors(resolveOfficeConfig(sources));
      expect(rest).toEqual([]);
      expect(error?.message).toBe(
        sources.office.includes("holdLabels")
          ? ".dipo/office.yaml: merge.holdLabels: unknown key; version 16 renamed it to merge.waitLabels; set it there"
          : ".dipo/office.yaml: box.claudeCode: unknown key; version 16 renamed it to box.workerCli; set it there",
      );
    }
  });

  it("names the expected type of a wrong type", () => {
    expect(
      errors(
        resolveOfficeConfig({ office: "version: 16\ntiers: { S: { budgetTokens: lots } }\n" }),
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
    expect(errors(resolveOfficeConfig({ office: "version: '15'\n" }))[0]?.message).toBe(
      ".dipo/office.yaml: version: expected integer, got string",
    );
  });

  it("refuses a file with two documents and a top level that is not a mapping", () => {
    const [two] = errors(resolveOfficeConfig({ office: "version: 16\n---\nversion: 16\n" }));
    expect(two?.message).toContain("more than one YAML document");
    expect(errors(resolveOfficeConfig({ office: "- version\n" }))[0]?.message).toBe(
      ".dipo/office.yaml: (top level): expected mapping, got list",
    );
  });

  it("refuses a newer version with a message to upgrade dipo, in either file", () => {
    const [office] = errors(resolveOfficeConfig({ office: "version: 17\nnewKey: true\n" }));
    expect(office?.path).toBe("version");
    expect(office?.message).toContain("upgrade dipo");
    const [local] = errors(resolveOfficeConfig({ local: "version: 17\n" }));
    expect(local?.file).toBe(".dipo/office.local.yaml");
    expect(local?.message).toContain("upgrade dipo");
  });

  it("points privacy.* and retention.* in office.yaml to the local file", () => {
    const result = errors(
      resolveOfficeConfig({
        office: "version: 16\nprivacy: { x: true }\nretention: { days: 3 }\n",
      }),
    );
    expect(result.map((error) => error.path)).toEqual(["privacy.x", "retention.days"]);
    for (const error of result) {
      expect(error.message).toContain("accepted only in .dipo/office.local.yaml");
    }
  });

  it("refuses any local key outside timeouts.*, privacy.* and retention.*", () => {
    expect(errors(resolveOfficeConfig({ local: "version: 16\ntiers: {}\n" }))).toEqual([
      {
        file: ".dipo/office.local.yaml",
        path: "tiers",
        expected: "one of the keys version, timeouts, privacy, retention",
        message: `.dipo/office.local.yaml: tiers: unknown key; .dipo/office.local.yaml accepts only version, timeouts.*, privacy.*, retention.*; ${NEWER_DIPO}`,
      },
    ]);
    const [nested] = errors(resolveOfficeConfig({ local: "version: 16\ntimeouts: { nope: 1 }\n" }));
    expect(nested?.expected).toBe(
      "one of the keys workerStallMinutes, workerQuietMinutes, scriptMinutes, testIdleMinutes",
    );
  });

  it("refuses box as a command flag override, so no flag can feed a build", () => {
    const [error] = errors(resolveOfficeConfig({ flags: { box: { debian: "trixie" } } }));
    expect(error?.file).toBe("command flags");
    expect(error?.path).toBe("box");
  });

  it("refuses a box file without its noRealSecrets mark", () => {
    const [error] = errors(
      resolveOfficeConfig({ office: "version: 16\nbox: { files: [{ path: .env }] }\n" }),
    );
    expect(error?.path).toBe("box.files.0.noRealSecrets");
  });

  it("reports errors from every file at once", () => {
    const result = errors(
      resolveOfficeConfig({
        office: "version: 16\nbase: 7\n",
        local: "version: 16\nprivacy: { storePrompts: yes }\n",
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
      "version: 16\ntiers: 5\n",
      "version: 1e400\n",
    ];
    for (const office of bad) {
      expect(() => resolveOfficeConfig({ office })).not.toThrow();
      expect(resolveOfficeConfig({ office }).ok).toBe(false);
    }
    expect(resolveOfficeConfig({ flags: "not a mapping" }).ok).toBe(false);
  });
});

// DIPO-405: the reviewer's model and effort per story tier.
describe("review.tiers", () => {
  const PER_TIER = [
    "version: 16",
    "review:",
    "  effort: medium",
    "  tiers:",
    "    S: { model: sonnet }",
    "    M: { model: opus }",
    "    L: { model: opus }",
    "",
  ].join("\n");

  it("is empty by default, so every tier takes review.model and review.effort", () => {
    expect(ok(resolveOfficeConfig({})).config.review).toMatchObject({
      model: "opus",
      effort: "high",
      tiers: {},
    });
  });

  it("loads a model per tier and keeps the office-wide effort beside it", () => {
    const result = ok(resolveOfficeConfig({ office: PER_TIER }));
    expect(result.warnings).toEqual([]);
    expect(result.config.review).toEqual({
      ...OFFICE_DEFAULTS.review,
      effort: "medium",
      tiers: { S: { model: "sonnet" }, M: { model: "opus" }, L: { model: "opus" } },
    });
  });

  it("refuses a tier that is no story tier and a key a tier cannot set", () => {
    expect(
      errors(
        resolveOfficeConfig({
          office: "version: 16\nreview: { tiers: { XL: { model: opus } } }\n",
        }),
      ).map((error) => error.path),
    ).toEqual(["review.tiers.XL"]);
    expect(
      errors(
        resolveOfficeConfig({ office: "version: 16\nreview: { tiers: { S: { maxTurns: 9 } } }\n" }),
      ).map((error) => error.path),
    ).toEqual(["review.tiers.S.maxTurns"]);
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
        office: "version: 16\ntimeouts: { workerStallMinutes: 30, workerQuietMinutes: 4 }\n",
        local: "version: 16\ntimeouts: { workerStallMinutes: 40, testIdleMinutes: 5 }\n",
        flags: { timeouts: { testIdleMinutes: 6 } },
      }),
    );
    expect(result.config.timeouts).toEqual({
      ...OFFICE_DEFAULTS.timeouts,
      workerStallMinutes: 40,
      workerQuietMinutes: 4,
      testIdleMinutes: 6,
    });
  });

  it("takes privacy.* and retention.* from the local file only", () => {
    const result = ok(
      resolveOfficeConfig({
        local: "version: 16\nprivacy: { keepRawEvents: true }\nretention: { days: 10 }\n",
      }),
    );
    expect(result.config.privacy).toEqual({ ...OFFICE_DEFAULTS.privacy, keepRawEvents: true });
    expect(result.config.retention).toEqual({ days: 10 });
    expect(resolveOfficeConfig({ flags: { privacy: { keepRawEvents: true } } }).ok).toBe(false);
  });

  it("merges objects and records per key and replaces lists and scalars", () => {
    const result = ok(
      resolveOfficeConfig({
        office: [
          "version: 16",
          "tiers: { L: { model: opus-4 } }",
          "story: { types: [feature, spike] }",
          "scripts: { verify: bun run check }",
          "",
        ].join("\n"),
        local: "version: 16\ntimeouts: { scriptMinutes: { verify: 45 } }\n",
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
        office: "version: 16\ntimeouts: { workerQuietMinutes: 4 }\n",
        local: [
          "version: 16",
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
        office: "version: 16\npolling: { fetchSeconds: 9, prStateSeconds: 8 }\n",
      }),
    );
    const b = ok(
      resolveOfficeConfig({
        office: "polling: { prStateSeconds: 8, fetchSeconds: 9 }\nversion: 16\n",
      }),
    );
    expect(a.configHash).toBe(b.configHash);
    const changed = ok(
      resolveOfficeConfig({ local: "version: 16\nretention: { days: 8 }\n" }),
    ).configHash;
    expect(changed).not.toBe(ok(resolveOfficeConfig({})).configHash);
    expect(configHash({ list: [1, 2] })).not.toBe(configHash({ list: [2, 1] }));
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

  it("reads office.yaml, office.local.yaml and flags, with no warning", async () => {
    await withTempDir(async (dir) => {
      writeDipo(dir, {
        "office.yaml": "version: 16\npolling: { prStateSeconds: 90 }\n",
        "office.local.yaml": "version: 16\ntimeouts: { workerQuietMinutes: 5 }\n",
      });
      const result = ok(await loadOfficeConfig(dir, { flags: { base: "develop" } }));
      expect(result.config.polling.prStateSeconds).toBe(90);
      expect(result.config.timeouts.workerQuietMinutes).toBe(5);
      expect(result.config.base).toBe("develop");
      expect(result.localOverrideKeys).toEqual(["timeouts.workerQuietMinutes"]);
      expect(result.warnings).toEqual([]);
    });
  });

  it("returns the error list for an invalid file and an unreadable file", async () => {
    await withTempDir(async (dir) => {
      writeDipo(dir, { "office.yaml": "version: 16\ntiers: [\n" });
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
