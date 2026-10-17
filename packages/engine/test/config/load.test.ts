import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  canonicalJson,
  configHash,
  loadOfficeConfig,
  mergeLayer,
  OFFICE_DEFAULTS,
  resolveOfficeConfig,
  type ConfigError,
  type OfficeConfigResult,
} from "../../src/config";

// The sample of 0017 section 5, unchanged.
const SAMPLE_0017 = `# yaml-language-server: $schema=https://<release-url>/office.schema.json
version: 1
tiers:                                          # caps from 0008 section 9; budgets in tokens
  S: { model: haiku,  effort: low,    budgetTokens: 300000,  maxTurns: 60,  maxMinutes: 30,  loops: 3 }
  M: { model: sonnet, effort: medium, budgetTokens: 800000,  maxTurns: 120, maxMinutes: 60,  loops: 5 }
  L: { model: opus,   effort: high,   budgetTokens: 2000000, maxTurns: 200, maxMinutes: 120, loops: 8 }
worker: { adapter: claude-cli }
permissions: { ask: when-present, presentMinutes: 10 }
timeouts: { workerStallMinutes: 20, workerQuietMinutes: 3, questionWaitMinutes: 15, permissionWaitSeconds: 300 }
scripts:
  verify: bun run verify                        # meaning from 0013
`;

// The worktree sample of 0010 section 8.
const SAMPLE_0010 = `version: 1
worktree:
  root: "../{repo}.worktrees"
  files:
    - { path: ".env", mode: "copy", required: false }
    - { path: "apps/server/.dev.vars", mode: "copy", required: true }
    - { path: ".cache/fixtures", mode: "link" }
  ports: { stride: 10, named: { PORT: 5173, API_PORT: 8787 } }
  env: { VITE_HMR_PORT: "{port:24678}" }
  post_create: [["bun", "run", "db:seed"]]
`;

function ok(result: OfficeConfigResult) {
  if (!result.ok) throw new Error(result.errors.map((error) => error.message).join("\n"));
  return result;
}

function errors(result: OfficeConfigResult): readonly ConfigError[] {
  if (result.ok) throw new Error("expected errors");
  return result.errors;
}

describe("validation", () => {
  it("parses the 0017 sample", () => {
    const result = ok(resolveOfficeConfig({ office: SAMPLE_0017 }));
    expect(result.config.scripts).toEqual({ verify: "bun run verify" });
    expect(result.config.tiers).toEqual(OFFICE_DEFAULTS.tiers);
    expect(result.localOverrideKeys).toEqual([]);
  });

  it("parses the 0010 worktree sample and fills entry defaults", () => {
    const result = ok(resolveOfficeConfig({ office: SAMPLE_0010 }));
    expect(result.config.worktree.files[2]).toEqual({
      path: ".cache/fixtures",
      mode: "link",
      required: false,
    });
    expect(result.config.worktree.ports).toEqual({
      stride: 10,
      named: { PORT: 5173, API_PORT: 8787 },
    });
    expect(result.config.worktree.maxSlots).toBe(20);
  });

  it("names the file, key path and expected type of a typo key", () => {
    const [error, ...rest] = errors(
      resolveOfficeConfig({ office: "version: 1\ntimeouts: { workerStalMinutes: 5 }\n" }),
    );
    expect(rest).toEqual([]);
    expect(error?.file).toBe(".dipo/office.yaml");
    expect(error?.path).toBe("timeouts.workerStalMinutes");
    expect(error?.expected).toContain("workerStallMinutes");
    expect(error?.message).toStartWith(
      ".dipo/office.yaml: timeouts.workerStalMinutes: unknown key",
    );
  });

  it("names the expected type of a wrong type", () => {
    expect(
      errors(resolveOfficeConfig({ office: "version: 1\ntiers: { S: { budgetTokens: lots } }\n" })),
    ).toEqual([
      {
        file: ".dipo/office.yaml",
        path: "tiers.S.budgetTokens",
        expected: "integer",
        message: ".dipo/office.yaml: tiers.S.budgetTokens: expected integer, got string",
      },
    ]);
  });

  it("names the allowed values of an enum", () => {
    const [error] = errors(
      resolveOfficeConfig({ office: "version: 1\npermissions: { ask: always }\n" }),
    );
    expect(error?.path).toBe("permissions.ask");
    expect(error?.message).toBe(
      '.dipo/office.yaml: permissions.ask: expected one of "when-present" | "never", got "always"',
    );
  });

  it("refuses a missing version", () => {
    expect(errors(resolveOfficeConfig({ office: "remote: upstream\n" }))).toEqual([
      {
        file: ".dipo/office.yaml",
        path: "version",
        expected: "integer",
        message: ".dipo/office.yaml: version: expected integer, got nothing; version is required",
      },
    ]);
  });

  it("refuses an empty file for its missing version", () => {
    expect(errors(resolveOfficeConfig({ office: "# nothing yet\n" }))[0]?.path).toBe("version");
  });

  it("refuses a version that is not an integer", () => {
    expect(errors(resolveOfficeConfig({ office: "version: '1'\n" }))[0]?.message).toBe(
      ".dipo/office.yaml: version: expected integer, got string",
    );
  });

  it("refuses a file with two documents", () => {
    const [error] = errors(resolveOfficeConfig({ office: "version: 1\n---\nversion: 1\n" }));
    expect(error?.file).toBe(".dipo/office.yaml");
    expect(error?.message).toContain("more than one YAML document");
  });

  it("refuses a top level that is not a mapping", () => {
    expect(errors(resolveOfficeConfig({ office: "- version\n" }))[0]?.message).toBe(
      ".dipo/office.yaml: (top level): expected mapping, got list",
    );
  });

  it("refuses a newer version with a message to upgrade dipo", () => {
    const [error] = errors(resolveOfficeConfig({ office: "version: 4\nnewKey: true\n" }));
    expect(error?.path).toBe("version");
    expect(error?.message).toContain("upgrade dipo");
  });

  it("refuses a newer version in the local file too", () => {
    const [error] = errors(resolveOfficeConfig({ local: "version: 4\n" }));
    expect(error?.file).toBe(".dipo/office.local.yaml");
    expect(error?.message).toContain("upgrade dipo");
  });

  it("points privacy.* and retention.* in office.yaml to the local file", () => {
    const result = errors(
      resolveOfficeConfig({
        office: "version: 1\nprivacy: { x: true }\nretention: { shortDays: 3 }\n",
      }),
    );
    expect(result.map((error) => error.path)).toEqual(["privacy.x", "retention.shortDays"]);
    for (const error of result) {
      expect(error.file).toBe(".dipo/office.yaml");
      expect(error.message).toContain("accepted only in .dipo/office.local.yaml");
    }
  });

  it("refuses any local key outside timeouts.*, privacy.* and retention.*", () => {
    const [error, ...rest] = errors(
      resolveOfficeConfig({ local: "version: 1\ntiers: { S: { loops: 1 } }\n" }),
    );
    expect(rest).toEqual([]);
    expect(error?.file).toBe(".dipo/office.local.yaml");
    expect(error?.path).toBe("tiers");
    expect(error?.message).toContain("accepts only version, timeouts.*, privacy.*, retention.*");
  });

  // The wording comes from the contract's configIssueErrors, with only the office.local.yaml
  // top-level wording overridden (DIPO-69). These messages are pinned byte for byte.
  it("keeps the exact unknown-key messages", () => {
    expect(
      errors(resolveOfficeConfig({ office: "version: 1\ntiers: { S: { loopz: 1 } }\n" })),
    ).toEqual([
      {
        file: ".dipo/office.yaml",
        path: "tiers.S.loopz",
        expected: "one of the keys model, effort, budgetTokens, maxTurns, maxMinutes, loops",
        message:
          ".dipo/office.yaml: tiers.S.loopz: unknown key; expected one of the keys model, effort, budgetTokens, maxTurns, maxMinutes, loops",
      },
    ]);
    expect(errors(resolveOfficeConfig({ local: "version: 1\ntiers: {}\n" }))).toEqual([
      {
        file: ".dipo/office.local.yaml",
        path: "tiers",
        expected: "one of the keys version, timeouts, privacy, retention",
        message:
          ".dipo/office.local.yaml: tiers: unknown key; .dipo/office.local.yaml accepts only version, timeouts.*, privacy.*, retention.*",
      },
    ]);
    expect(errors(resolveOfficeConfig({ local: "version: 1\ntimeouts: { nope: 1 }\n" }))).toEqual([
      {
        file: ".dipo/office.local.yaml",
        path: "timeouts.nope",
        expected:
          "one of the keys workerStallMinutes, workerQuietMinutes, questionWaitMinutes, permissionWaitSeconds, scriptMinutes",
        message:
          ".dipo/office.local.yaml: timeouts.nope: unknown key; expected one of the keys workerStallMinutes, workerQuietMinutes, questionWaitMinutes, permissionWaitSeconds, scriptMinutes",
      },
    ]);
  });

  it("reports errors from every file at once", () => {
    const result = errors(
      resolveOfficeConfig({
        office: "version: 1\nremote: 7\n",
        local: "version: 1\nprivacy: { storePrompts: yes }\n",
        flags: { polling: { fetchSeconds: 0 } },
      }),
    );
    expect(result.map((error) => `${error.file} ${error.path}`)).toEqual([
      ".dipo/office.yaml remote",
      ".dipo/office.local.yaml privacy.storePrompts",
      "command flags polling.fetchSeconds",
    ]);
  });

  it("returns errors as values and throws nothing for bad input", () => {
    const bad = ["tiers: [\n", "\u0000\u0001", ":::", "version: 1\ntiers: 5\n", "version: 1e400\n"];
    for (const office of bad) {
      expect(() => resolveOfficeConfig({ office })).not.toThrow();
      expect(resolveOfficeConfig({ office }).ok).toBe(false);
    }
    expect(() => resolveOfficeConfig({ flags: "not a mapping" })).not.toThrow();
    expect(resolveOfficeConfig({ flags: "not a mapping" }).ok).toBe(false);
  });
});

describe("precedence and merge", () => {
  it("uses the built-in defaults without files", () => {
    const result = ok(resolveOfficeConfig({}));
    expect(result.config).toEqual(OFFICE_DEFAULTS);
    expect(result.localOverrideKeys).toEqual([]);
  });

  it("orders defaults < office.yaml < local keys < command flags", () => {
    const result = ok(
      resolveOfficeConfig({
        office: "version: 1\ntimeouts: { workerStallMinutes: 30, workerQuietMinutes: 4 }\n",
        local: "version: 1\ntimeouts: { workerStallMinutes: 40, questionWaitMinutes: 5 }\n",
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
        local: "version: 1\nprivacy: { keepRawEvents: true }\nretention: { stateDays: 30 }\n",
      }),
    );
    expect(result.config.privacy).toEqual({ ...OFFICE_DEFAULTS.privacy, keepRawEvents: true });
    expect(result.config.retention).toEqual({ shortDays: 7, stateDays: 30 });
    expect(resolveOfficeConfig({ flags: { privacy: { keepRawEvents: true } } }).ok).toBe(false);
  });

  it("merges objects per key and replaces lists and scalars", () => {
    const result = ok(
      resolveOfficeConfig({
        office: [
          "version: 1",
          "tiers: { L: { model: opus-4 } }",
          "story: { types: [feature, spike] }",
          "scripts: { verify: bun run check }",
          "remote: upstream",
          "",
        ].join("\n"),
        flags: { story: { bannedPhrases: ["maybe"] }, scripts: { test: "bun test" } },
      }),
    );
    expect(result.config.tiers.L).toEqual({ ...OFFICE_DEFAULTS.tiers.L, model: "opus-4" });
    expect(result.config.tiers.S).toEqual(OFFICE_DEFAULTS.tiers.S);
    expect(result.config.story.types).toEqual(["feature", "spike"]);
    expect(result.config.story.bannedPhrases).toEqual(["maybe"]);
    expect(result.config.story.titleMax).toBe(100);
    expect(result.config.scripts).toEqual({ verify: "bun run check", test: "bun test" });
    expect(result.config.remote).toBe("upstream");
  });

  it("merges records per key", () => {
    const result = ok(
      resolveOfficeConfig({ local: "version: 1\ntimeouts: { scriptMinutes: { verify: 45 } }\n" }),
    );
    expect(result.config.timeouts.scriptMinutes).toEqual({
      install: 15,
      setup: 10,
      post_create: 10,
      verify: 45,
    });
  });

  it("keeps the default port stride when only named ports are set", () => {
    const result = ok(
      resolveOfficeConfig({
        office: "version: 1\nworktree: { ports: { named: { PORT: 3000 } } }\n",
      }),
    );
    expect(result.config.worktree.ports).toEqual({ stride: 10, named: { PORT: 3000 } });
  });

  for (const key of ["toolchainReadPaths", "installCachePaths"]) {
    it(`refuses a ${key} entry that is neither absolute nor under ~/`, () => {
      const [error, ...rest] = errors(
        resolveOfficeConfig({
          office: `version: 1\nsandbox: { ${key}: [~/.bun, /opt/tools, .cache] }\n`,
        }),
      );
      expect(rest).toEqual([]);
      expect(error?.path).toBe(`sandbox.${key}.2`);
      expect(error?.message).toContain("must start with ~/ or /");
    });
  }

  it("refuses the old single toolchainPaths key", () => {
    const [error] = errors(
      resolveOfficeConfig({ office: "version: 1\nsandbox: { toolchainPaths: [~/.bun] }\n" }),
    );
    expect(error?.path).toBe("sandbox.toolchainPaths");
    expect(error?.expected).toContain("toolchainReadPaths, installCachePaths");
  });

  it("sets base only when a file names it", () => {
    expect(ok(resolveOfficeConfig({})).config.base).toBeUndefined();
    expect(ok(resolveOfficeConfig({ office: "version: 1\nbase: develop\n" })).config.base).toBe(
      "develop",
    );
  });

  it("returns the active local override keys", () => {
    const result = ok(
      resolveOfficeConfig({
        office: "version: 1\ntimeouts: { workerQuietMinutes: 4 }\n",
        local: [
          "version: 1",
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
    expect(result.configHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across key order", () => {
    const a = ok(
      resolveOfficeConfig({
        office: "version: 1\nremote: up\npolling: { fetchSeconds: 9, prStateSeconds: 8 }\n",
      }),
    );
    const b = ok(
      resolveOfficeConfig({
        office: "polling: { prStateSeconds: 8, fetchSeconds: 9 }\nremote: up\nversion: 1\n",
      }),
    );
    expect(a.configHash).toBe(b.configHash);
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("changes with any value", () => {
    const base = ok(resolveOfficeConfig({})).configHash;
    const changed = ok(
      resolveOfficeConfig({ local: "version: 1\nretention: { shortDays: 8 }\n" }),
    ).configHash;
    expect(changed).not.toBe(base);
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
      const result = ok(await loadOfficeConfig(dir));
      expect(result.config).toEqual(OFFICE_DEFAULTS);
    });
  });

  it("reads office.yaml, office.local.yaml and flags", async () => {
    await withTempDir(async (dir) => {
      writeDipo(dir, {
        "office.yaml": SAMPLE_0017,
        "office.local.yaml": "version: 1\ntimeouts: { workerQuietMinutes: 5 }\n",
      });
      const result = ok(await loadOfficeConfig(dir, { flags: { remote: "fork" } }));
      expect(result.config.scripts).toEqual({ verify: "bun run verify" });
      expect(result.config.timeouts.workerQuietMinutes).toBe(5);
      expect(result.config.remote).toBe("fork");
      expect(result.localOverrideKeys).toEqual(["timeouts.workerQuietMinutes"]);
    });
  });

  it("returns the error list for an invalid file and throws nothing", async () => {
    await withTempDir(async (dir) => {
      writeDipo(dir, { "office.yaml": "version: 1\ntiers: [\n" });
      const result = await loadOfficeConfig(dir);
      expect(result.ok).toBe(false);
      expect(errors(result)[0]?.file).toBe(".dipo/office.yaml");
    });
  });

  it("returns an unreadable file as an error", async () => {
    await withTempDir(async (dir) => {
      mkdirSync(join(dir, ".dipo", "office.local.yaml"), { recursive: true });
      const result = await loadOfficeConfig(dir);
      expect(errors(result)[0]?.message).toStartWith(
        ".dipo/office.local.yaml: (top level): cannot read the file",
      );
    });
  });
});

// Version 2 (DIPO-108, 0017 amendment of 2026-10-12): `worker.plugins`, identity migration from 1.
function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
}

describe("office configuration version 2", () => {
  it("loads a version 1 file migrated to version 3, the same as its version 2 form", () => {
    const v1 = ok(resolveOfficeConfig({ office: fixture("office-v1.yaml") }));
    const v2 = ok(resolveOfficeConfig({ office: fixture("office-v2.yaml") }));
    expect(v1.config.version).toBe(3);
    expect(v1.config.worker).toEqual({
      adapter: "claude-cli",
      allowProjectSettings: ["model"],
      plugins: [],
    });
    expect(v1.config.remote).toBe("upstream");
    expect(v1.config.tiers.S.budgetTokens).toBe(250_000);
    expect(v1.config).toEqual(v2.config);
    expect(v1.configHash).toBe(v2.configHash);
  });

  it("takes worker.plugins from a version 2 file", () => {
    const result = ok(
      resolveOfficeConfig({
        office: "version: 2\nworker: { plugins: [warp@claude-code-warp] }\n",
      }),
    );
    expect(result.config.worker.plugins).toEqual(["warp@claude-code-warp"]);
    expect(result.config.worker.adapter).toBe("claude-cli");
  });

  it("refuses worker.plugins in a version 1 file and says version 2 adds it", () => {
    const [error] = errors(
      resolveOfficeConfig({ office: "version: 1\nworker: { plugins: [warp@claude-code-warp] }\n" }),
    );
    expect(error?.path).toBe("worker.plugins");
    expect(error?.message).toContain("Version 2 adds worker.plugins: set version: 2");
  });

  it("refuses a plugin that is not <plugin>@<marketplace>", () => {
    const [error] = errors(
      resolveOfficeConfig({ office: "version: 2\nworker: { plugins: [warp] }\n" }),
    );
    expect(error?.path).toBe("worker.plugins.0");
    expect(error?.message).toContain("<plugin>@<marketplace>");
  });

  it("accepts an older local file next to either office file", () => {
    for (const [office, local] of [
      ["version: 1\n", "version: 2\nretention: { shortDays: 3 }\n"],
      ["version: 2\n", "version: 1\nretention: { shortDays: 3 }\n"],
      ["version: 3\n", "version: 2\nretention: { shortDays: 3 }\n"],
    ] as const) {
      const result = ok(resolveOfficeConfig({ office, local }));
      expect(result.config.version).toBe(3);
      expect(result.config.retention.shortDays).toBe(3);
    }
  });

  it("takes worker.plugins as a command flag override", () => {
    const result = ok(resolveOfficeConfig({ flags: { worker: { plugins: ["a@b"] } } }));
    expect(result.config.worker.plugins).toEqual(["a@b"]);
  });

  it("takes mergeSlot.requiredChecks from a version 3 file", () => {
    const result = ok(
      resolveOfficeConfig({
        office: "version: 3\nmergeSlot: { requiredChecks: [build, Lint (ubuntu)] }\n",
      }),
    );
    expect(result.config.mergeSlot.requiredChecks).toEqual(["build", "Lint (ubuntu)"]);
  });

  it("migrates the version 2 fixture to the version 3 fixture, except mergeSlot", () => {
    const v2 = ok(resolveOfficeConfig({ office: fixture("office-v2.yaml") }));
    const v3 = ok(resolveOfficeConfig({ office: fixture("office-v3.yaml") }));
    expect(v2.config.mergeSlot.requiredChecks).toEqual(["ci-ok", "pr-title"]);
    expect(v3.config.mergeSlot.requiredChecks).toEqual(["build", "Lint (ubuntu)"]);
    const { mergeSlot: _v2Slot, ...v2Rest } = v2.config;
    const { mergeSlot: _v3Slot, ...v3Rest } = v3.config;
    expect(v2Rest).toEqual(v3Rest);
  });

  it("refuses mergeSlot in a version 2 file and says version 3 adds it", () => {
    const [error] = errors(
      resolveOfficeConfig({ office: "version: 2\nmergeSlot: { requiredChecks: [build] }\n" }),
    );
    expect(error?.path).toBe("mergeSlot");
    expect(error?.message).toContain("unknown key in version 2");
    expect(error?.message).toContain("Version 3 adds mergeSlot: set version: 3 to use it");
  });

  it("gives a version 2 file the default check names, as the migration does", () => {
    const result = ok(resolveOfficeConfig({ office: "version: 2\nremote: upstream\n" }));
    expect(result.config.mergeSlot.requiredChecks).toEqual(["ci-ok", "pr-title"]);
  });

  it("takes mergeSlot.requiredChecks as a command flag override", () => {
    const result = ok(resolveOfficeConfig({ flags: { mergeSlot: { requiredChecks: ["x"] } } }));
    expect(result.config.mergeSlot.requiredChecks).toEqual(["x"]);
  });

  it("refuses an empty mergeSlot.requiredChecks and names the key", () => {
    const [error] = errors(
      resolveOfficeConfig({ office: "version: 3\nmergeSlot: { requiredChecks: [] }\n" }),
    );
    expect(error?.path).toBe("mergeSlot.requiredChecks");
    expect(error?.message).toContain("mergeSlot.requiredChecks");
    expect(error?.message).toContain("at least one check");
  });

  it("refuses a check name twice in mergeSlot.requiredChecks and names the key", () => {
    const [error] = errors(
      resolveOfficeConfig({
        office: "version: 3\nmergeSlot: { requiredChecks: [ci-ok, pr-title, ci-ok] }\n",
      }),
    );
    expect(error?.path).toBe("mergeSlot.requiredChecks");
    expect(error?.message).toContain("mergeSlot.requiredChecks");
    expect(error?.message).toContain("twice");
  });
});

describe("the version 1 hint for worker.plugins", () => {
  it("names version 2 only for worker.plugins, not for another unknown worker key", () => {
    const result = errors(
      resolveOfficeConfig({ office: "version: 1\nworker: { plugin: [a@b], plugins: [a@b] }\n" }),
    );
    const byPath = Object.fromEntries(result.map((error) => [error.path, error.message]));
    expect(byPath["worker.plugins"]).toContain("Version 2 adds worker.plugins");
    expect(byPath["worker.plugin"]).toContain("unknown key");
    expect(byPath["worker.plugin"]).not.toContain("Version 2");
  });

  it("gives no version hint in the local file, which accepts mergeSlot in no version", () => {
    const [error] = errors(
      resolveOfficeConfig({ local: "version: 2\nmergeSlot: { requiredChecks: [build] }\n" }),
    );
    expect(error?.path).toBe("mergeSlot");
    expect(error?.message).toContain("accepts only version");
    expect(error?.message).not.toContain("Version 3");
  });
});
