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
  it("parses the 0017 sample, with a warning for its retired presentMinutes (DIPO-285)", () => {
    const result = ok(resolveOfficeConfig({ office: SAMPLE_0017 }));
    expect(result.config.scripts).toEqual({ verify: "bun run verify" });
    expect(result.config.tiers).toEqual(OFFICE_DEFAULTS.tiers);
    expect(result.config.permissions).toEqual({ ask: "when-present" });
    expect(result.localOverrideKeys).toEqual([]);
    expect(result.warnings.map((warning) => warning.path)).toEqual(["permissions.presentMinutes"]);
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
    const [error] = errors(resolveOfficeConfig({ office: "version: 12\nnewKey: true\n" }));
    expect(error?.path).toBe("version");
    expect(error?.message).toContain("upgrade dipo");
  });

  it("refuses a newer version in the local file too", () => {
    const [error] = errors(resolveOfficeConfig({ local: "version: 12\n" }));
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

  it("stores commands and prompts by default and turns each off in office.local.yaml (DIPO-135, DIPO-137)", () => {
    const none = ok(resolveOfficeConfig({}));
    expect(none.config.privacy).toEqual({
      storePrompts: true,
      storeCommandBodies: true,
      keepRawEvents: false,
    });
    const off = ok(
      resolveOfficeConfig({ local: "version: 1\nprivacy: { storeCommandBodies: false }\n" }),
    );
    expect(off.config.privacy.storeCommandBodies).toBe(false);
    const noPrompts = ok(
      resolveOfficeConfig({ local: "version: 1\nprivacy: { storePrompts: false }\n" }),
    );
    expect(noPrompts.config.privacy.storePrompts).toBe(false);
    expect(noPrompts.config.privacy.storeCommandBodies).toBe(true);
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
  it("loads a version 1 file migrated to version 5, the same as its version 2 form", () => {
    const v1 = ok(resolveOfficeConfig({ office: fixture("office-v1.yaml") }));
    const v2 = ok(resolveOfficeConfig({ office: fixture("office-v2.yaml") }));
    expect(v1.config.version).toBe(11);
    expect(v1.config.worker).toEqual({
      adapter: "claude-cli",
      allowProjectSettings: ["model"],
      plugins: [],
      web: true,
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
      expect(result.config.version).toBe(11);
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

// Version 4 (DIPO-172, 0017 amendment of 2026-10-18): office.local.yaml may set
// sandbox.toolchainReadPaths, whose entries add to the committed list (or the default).
const NVM = "~/.nvm/versions/node";

describe("office configuration version 4: local toolchain read paths", () => {
  it("adds the local entries to the committed list, each path once", () => {
    const result = ok(
      resolveOfficeConfig({
        office: "version: 3\nsandbox: { toolchainReadPaths: [~/.bun, /opt/tools] }\n",
        local: `version: 4\nsandbox: { toolchainReadPaths: [/opt/tools, ${NVM}, ${NVM}] }\n`,
      }),
    );
    expect(result.config.sandbox.toolchainReadPaths).toEqual(["~/.bun", "/opt/tools", NVM]);
    // The rest of sandbox keeps the layers below.
    expect(result.config.sandbox.installCachePaths).toEqual(
      OFFICE_DEFAULTS.sandbox.installCachePaths,
    );
  });

  it("adds the local entries to the default when office.yaml sets no list", () => {
    for (const office of [undefined, "version: 2\n"]) {
      const result = ok(
        resolveOfficeConfig({
          office,
          local: `version: 4\nsandbox: { toolchainReadPaths: [~/.npm, ${NVM}] }\n`,
        }),
      );
      expect(result.config.sandbox.toolchainReadPaths).toEqual([
        ...OFFICE_DEFAULTS.sandbox.toolchainReadPaths,
        NVM,
      ]);
    }
  });

  it("names sandbox.toolchainReadPaths in localOverrideKeys when the local file sets it", () => {
    const result = ok(
      resolveOfficeConfig({
        local: `version: 4\ntimeouts: { workerQuietMinutes: 4 }\nsandbox: { toolchainReadPaths: [${NVM}] }\n`,
      }),
    );
    expect(result.localOverrideKeys).toEqual([
      "sandbox.toolchainReadPaths",
      "timeouts.workerQuietMinutes",
    ]);
    const without = ok(resolveOfficeConfig({ local: "version: 4\nsandbox: {}\n" }));
    expect(without.localOverrideKeys).toEqual([]);
    expect(without.config.sandbox).toEqual(OFFICE_DEFAULTS.sandbox);
  });

  it("lets a command flag replace the merged list, as flags replace lists", () => {
    const result = ok(
      resolveOfficeConfig({
        local: `version: 4\nsandbox: { toolchainReadPaths: [${NVM}] }\n`,
        flags: { sandbox: { toolchainReadPaths: ["/opt/only"] } },
      }),
    );
    expect(result.config.sandbox.toolchainReadPaths).toEqual(["/opt/only"]);
  });

  it("refuses any other sandbox key in the local file and names the key", () => {
    for (const key of ["allowRead", "installCachePaths", "allowLocalBinding"]) {
      const value = key === "allowLocalBinding" ? "true" : "[~/.ssh]";
      const [error, ...rest] = errors(
        resolveOfficeConfig({ local: `version: 4\nsandbox: { ${key}: ${value} }\n` }),
      );
      expect(rest).toEqual([]);
      expect(error?.file).toBe(".dipo/office.local.yaml");
      expect(error?.path).toBe(`sandbox.${key}`);
      expect(error?.message).toBe(
        `.dipo/office.local.yaml: sandbox.${key}: unknown key; .dipo/office.local.yaml accepts only sandbox.toolchainReadPaths of the sandbox keys; set any other sandbox key in .dipo/office.yaml`,
      );
    }
  });

  it("refuses a local entry that is neither absolute nor under ~/", () => {
    const [error] = errors(
      resolveOfficeConfig({ local: "version: 4\nsandbox: { toolchainReadPaths: [node] }\n" }),
    );
    expect(error?.path).toBe("sandbox.toolchainReadPaths.0");
    expect(error?.message).toContain("must start with ~/ or /");
  });

  it("names sandbox.toolchainReadPaths among the local keys of version 4 only", () => {
    const [v4] = errors(resolveOfficeConfig({ local: "version: 4\ntiers: {}\n" }));
    expect(v4?.message).toBe(
      ".dipo/office.local.yaml: tiers: unknown key; .dipo/office.local.yaml accepts only version, timeouts.*, privacy.*, retention.*, sandbox.toolchainReadPaths",
    );
    const [v3] = errors(resolveOfficeConfig({ local: "version: 3\ntiers: {}\n" }));
    expect(v3?.message).toBe(
      ".dipo/office.local.yaml: tiers: unknown key; .dipo/office.local.yaml accepts only version, timeouts.*, privacy.*, retention.*",
    );
  });

  it("refuses sandbox in an older local file and says version 4 adds it", () => {
    const [error, ...rest] = errors(
      resolveOfficeConfig({ local: `version: 3\nsandbox: { toolchainReadPaths: [${NVM}] }\n` }),
    );
    expect(rest).toEqual([]);
    expect(error?.path).toBe("sandbox");
    expect(error?.message).toContain("unknown key in version 3");
    expect(error?.message).toContain(
      "Version 4 adds sandbox.toolchainReadPaths to .dipo/office.local.yaml: set version: 4 to use it",
    );
  });

  it("reads a version 4 office.yaml as its version 3 form", () => {
    const v3 = ok(resolveOfficeConfig({ office: fixture("office-v3.yaml") }));
    const v4 = ok(
      resolveOfficeConfig({
        office: fixture("office-v3.yaml").replace("version: 3", "version: 4"),
      }),
    );
    expect(v4.config).toEqual(v3.config);
    expect(v4.config.version).toBe(11);
  });
});

// Version 6 (DIPO-188): story.maintainerStepPhrases, with its default when the file does not set it.
describe("office configuration version 6", () => {
  it("gives a version 5 file the default step phrases", () => {
    const v5 = ok(resolveOfficeConfig({ office: "version: 5\n" }));
    expect(v5.config.version).toBe(11);
    expect(v5.config.story.maintainerStepPhrases).toEqual(
      OFFICE_DEFAULTS.story.maintainerStepPhrases,
    );
  });

  it("takes the step phrases of a version 6 file", () => {
    const result = ok(
      resolveOfficeConfig({
        office: "version: 6\nstory: { maintainerStepPhrases: [write the report] }\n",
      }),
    );
    expect(result.config.story.maintainerStepPhrases).toEqual(["write the report"]);
  });

  it("refuses the step phrases in a version 5 file, and a non-string phrase", () => {
    const old = resolveOfficeConfig({
      office: "version: 5\nstory: { maintainerStepPhrases: [write] }\n",
    });
    expect(old.ok).toBe(false);
    const message = errors(old)[0]?.message ?? "";
    expect(message).toContain(
      "Version 6 adds story.maintainerStepPhrases: set version: 6 to use it",
    );
    expect(
      resolveOfficeConfig({ office: "version: 6\nstory: { maintainerStepPhrases: [3] }\n" }).ok,
    ).toBe(false);
  });
});

// Version 7 (DIPO-210): storyPr.open, the office switch for the story PR (0019 amendment of
// 2026-10-19). It is committed with the repository: office.local.yaml does not take it.
describe("office configuration version 7", () => {
  it("migrates a version 6 file in memory and opens the story PR by default", () => {
    const v6 = ok(resolveOfficeConfig({ office: "version: 6\n" }));
    expect(v6.config.version).toBe(11);
    expect(v6.config.storyPr).toEqual({ open: true });
    expect(ok(resolveOfficeConfig({})).config.storyPr.open).toBe(true);
  });

  it("reads storyPr.open false from a version 7 file", () => {
    const result = ok(resolveOfficeConfig({ office: "version: 7\nstoryPr: { open: false }\n" }));
    expect(result.config.storyPr.open).toBe(false);
  });

  it("refuses storyPr in a version 6 file and says version 7 adds it", () => {
    const [error, ...rest] = errors(
      resolveOfficeConfig({ office: "version: 6\nstoryPr: { open: false }\n" }),
    );
    expect(rest).toEqual([]);
    expect(error?.path).toBe("storyPr");
    expect(error?.message).toContain("unknown key in version 6");
    expect(error?.message).toContain("Version 7 adds storyPr: set version: 7 to use it");
  });

  it("refuses a storyPr.open that is not a boolean", () => {
    const [error] = errors(resolveOfficeConfig({ office: "version: 7\nstoryPr: { open: no }\n" }));
    expect(error?.path).toBe("storyPr.open");
  });

  it("refuses storyPr in office.local.yaml", () => {
    for (const version of [6, 7]) {
      const [error, ...rest] = errors(
        resolveOfficeConfig({
          office: "version: 7\n",
          local: `version: ${version}\nstoryPr: { open: false }\n`,
        }),
      );
      expect(rest).toEqual([]);
      expect(error?.file).toBe(".dipo/office.local.yaml");
      expect(error?.path).toBe("storyPr");
      expect(error?.message).toBe(
        ".dipo/office.local.yaml: storyPr: unknown key; .dipo/office.local.yaml accepts only version, timeouts.*, privacy.*, retention.*, sandbox.toolchainReadPaths",
      );
    }
  });

  it("loads a version 4 office.local.yaml next to a version 7 office.yaml", () => {
    const result = ok(
      resolveOfficeConfig({
        office: "version: 7\nstoryPr: { open: false }\n",
        local: fixture("office-local-v4.yaml"),
      }),
    );
    expect(result.config.version).toBe(11);
    expect(result.config.storyPr.open).toBe(false);
    expect(result.config.timeouts.workerStallMinutes).toBe(25);
    expect(result.config.privacy.keepRawEvents).toBe(true);
    expect(result.config.retention.shortDays).toBe(3);
    expect(result.config.sandbox.toolchainReadPaths).toEqual([
      ...OFFICE_DEFAULTS.sandbox.toolchainReadPaths,
      NVM,
    ]);
    expect(result.localOverrideKeys).toEqual([
      "privacy.keepRawEvents",
      "retention.shortDays",
      "sandbox.toolchainReadPaths",
      "timeouts.workerStallMinutes",
    ]);
  });

  it("takes storyPr.open as a command flag override", () => {
    const result = ok(
      resolveOfficeConfig({
        office: "version: 7\nstoryPr: { open: false }\n",
        flags: { storyPr: { open: true } },
      }),
    );
    expect(result.config.storyPr.open).toBe(true);
  });
});

// Version 8 (DIPO-164): worker.web, the office switch for the developer role's web tools (0020
// section 11b). It is committed with the repository: office.local.yaml does not take it.
describe("office configuration version 8", () => {
  it("migrates a version 7 file in memory and gives the developer web tools by default", () => {
    const v7 = ok(resolveOfficeConfig({ office: "version: 7\nstoryPr: { open: false }\n" }));
    expect(v7.config.version).toBe(11);
    expect(v7.config.worker.web).toBe(true);
    expect(v7.config.storyPr.open).toBe(false);
    expect(ok(resolveOfficeConfig({})).config.worker.web).toBe(true);
  });

  it("reads worker.web false from a version 8 file", () => {
    const result = ok(resolveOfficeConfig({ office: "version: 8\nworker: { web: false }\n" }));
    expect(result.config.worker.web).toBe(false);
    expect(result.config.worker.adapter).toBe("claude-cli");
  });

  it("refuses worker.web in a version 7 file and says version 8 adds it", () => {
    const [error, ...rest] = errors(
      resolveOfficeConfig({ office: "version: 7\nworker: { web: false }\n" }),
    );
    expect(rest).toEqual([]);
    expect(error?.path).toBe("worker.web");
    expect(error?.message).toContain("unknown key in version 7");
    expect(error?.message).toContain("Version 8 adds worker.web: set version: 8 to use it");
  });

  it("refuses a worker.web that is not a boolean", () => {
    const [error] = errors(resolveOfficeConfig({ office: "version: 8\nworker: { web: no }\n" }));
    expect(error?.path).toBe("worker.web");
  });

  it("refuses worker.web in office.local.yaml", () => {
    const [error, ...rest] = errors(
      resolveOfficeConfig({
        office: "version: 8\n",
        local: "version: 8\nworker: { web: false }\n",
      }),
    );
    expect(rest).toEqual([]);
    expect(error?.file).toBe(".dipo/office.local.yaml");
    expect(error?.path).toBe("worker");
  });

  it("takes worker.web as a command flag override", () => {
    const result = ok(
      resolveOfficeConfig({
        office: "version: 8\nworker: { web: false }\n",
        flags: { worker: { web: true } },
      }),
    );
    expect(result.config.worker.web).toBe(true);
  });
});

// Version 5 (DIPO-139): the review block and the rest of mergeSlot, with their defaults.
describe("office configuration version 5", () => {
  it("migrates a version 3 file to version 5 and gives the new keys their defaults", () => {
    const v3 = ok(resolveOfficeConfig({ office: fixture("office-v3.yaml") }));
    expect(v3.config.version).toBe(11);
    expect(v3.config.review).toEqual({
      model: "opus",
      effort: "high",
      maxRounds: 3,
      maxTurns: 60,
      maxMinutes: 30,
      budgetTokens: 200_000,
    });
    expect(v3.config.mergeSlot).toEqual({
      requiredChecks: ["build", "Lint (ubuntu)"],
      autoMerge: true,
      conflictAttempts: 2,
      ciAttempts: 2,
      holdLabels: [],
      checksWaitMinutes: 30,
    });
  });

  it("gives an office without the new keys the defaults, as its version 4 form", () => {
    const v4 = ok(resolveOfficeConfig({ office: "version: 4\n" }));
    expect(v4.config.review.model).toBe("opus");
    expect(v4.config.mergeSlot.holdLabels).toEqual([]);
    expect(v4.config).toEqual(ok(resolveOfficeConfig({ office: "version: 5\n" })).config);
  });

  it("takes the review block and the mergeSlot keys from a version 5 file", () => {
    const result = ok(
      resolveOfficeConfig({
        office: [
          "version: 5",
          "review: { model: sonnet, maxRounds: 1 }",
          "mergeSlot: { autoMerge: false, holdLabels: [hold, wip], checksWaitMinutes: 5 }",
          "",
        ].join("\n"),
      }),
    );
    expect(result.config.review).toMatchObject({ model: "sonnet", effort: "high", maxRounds: 1 });
    expect(result.config.mergeSlot).toMatchObject({
      autoMerge: false,
      holdLabels: ["hold", "wip"],
      checksWaitMinutes: 5,
    });
  });

  it("refuses a review or mergeSlot key in a version 4 file and says version 5 adds it", () => {
    const [review] = errors(
      resolveOfficeConfig({ office: "version: 4\nreview: { maxRounds: 2 }\n" }),
    );
    expect(review?.path).toBe("review");
    expect(review?.message).toContain("Version 5 adds review: set version: 5 to use it");
    const [slot] = errors(
      resolveOfficeConfig({ office: "version: 4\nmergeSlot: { autoMerge: false }\n" }),
    );
    expect(slot?.path).toBe("mergeSlot.autoMerge");
    expect(slot?.message).toContain("Version 5 adds mergeSlot.autoMerge: set version: 5 to use it");
  });

  it.each([
    ["conflictAttempts", "1"],
    ["ciAttempts", "1"],
    ["holdLabels", "[hold]"],
    ["checksWaitMinutes", "1"],
  ])("refuses mergeSlot.%s in a version 4 file and says version 5 adds it", (key, value) => {
    const [error] = errors(
      resolveOfficeConfig({ office: `version: 4\nmergeSlot: { ${key}: ${value} }\n` }),
    );
    expect(error?.path).toBe(`mergeSlot.${key}`);
    expect(error?.message).toContain(`Version 5 adds mergeSlot.${key}: set version: 5 to use it`);
  });

  it.each([
    ["review", "maxRounds"],
    ["review", "maxTurns"],
    ["review", "maxMinutes"],
    ["review", "budgetTokens"],
    ["mergeSlot", "conflictAttempts"],
    ["mergeSlot", "ciAttempts"],
    ["mergeSlot", "checksWaitMinutes"],
  ])("refuses %s.%s 0 and names the key", (block, key) => {
    const [error] = errors(
      resolveOfficeConfig({ office: `version: 5\n${block}: { ${key}: 0 }\n` }),
    );
    expect(error?.path).toBe(`${block}.${key}`);
    expect(error?.message).toContain(`${block}.${key}`);
  });

  it("refuses a duplicate hold label and names the key", () => {
    const [error] = errors(
      resolveOfficeConfig({ office: "version: 5\nmergeSlot: { holdLabels: [hold, hold] }\n" }),
    );
    expect(error?.path).toBe("mergeSlot.holdLabels");
    expect(error?.message).toContain("mergeSlot.holdLabels");
  });

  it("takes review.model as a command flag override", () => {
    const result = ok(resolveOfficeConfig({ flags: { review: { model: "haiku" } } }));
    expect(result.config.review.model).toBe("haiku");
    expect(result.config.review.maxTurns).toBe(60);
  });
});

// The repository's own office file (DIPO-172 AC #3): no machine-specific node path, and the
// office.local.yaml lines its comment shows are valid and add the nvm node installs.
describe("this repository's .dipo/office.yaml", () => {
  const office = readFileSync(
    join(import.meta.dir, "..", "..", "..", "..", ".dipo", "office.yaml"),
    "utf8",
  );

  // dipo opens the story PR here again (0019 amendment of 2026-10-22): CI on it is the verify of a
  // box run. Worker web tools are on (the default) since the live web capture of 2026-10-19 showed
  // the fail-closed gate working against Claude Code (DIPO-164).
  it("is version 8, opens story PRs and leaves worker web tools on", () => {
    const result = ok(resolveOfficeConfig({ office }));
    expect(office.startsWith("version: 8\n")).toBe(true);
    expect(result.config.storyPr.open).toBe(true);
    expect(result.config.worker.web).toBe(true);
    expect(office).toContain("the verify of a box run");
  });

  it("does not list ~/.nvm/versions/node", () => {
    const result = ok(resolveOfficeConfig({ office }));
    expect(result.config.sandbox.toolchainReadPaths).not.toContain(NVM);
  });

  it("shows office.local.yaml lines that add ~/.nvm/versions/node", () => {
    const shown = office
      .split("\n")
      .filter((line) => line.startsWith("#   "))
      .map((line) => line.slice(4))
      .join("\n");
    expect(shown).toContain("toolchainReadPaths");
    const result = ok(resolveOfficeConfig({ office, local: `${shown}\n` }));
    expect(result.config.sandbox.toolchainReadPaths).toEqual([
      ...ok(resolveOfficeConfig({ office })).config.sandbox.toolchainReadPaths,
      NVM,
    ]);
    expect(result.localOverrideKeys).toEqual(["sandbox.toolchainReadPaths"]);
  });
});

// Version 9 (DIPO-266): the box block, read from the base branch; every key optional.
describe("office configuration version 9", () => {
  const BOX = `version: 9
box:
  debian: bookworm
  toolchain: { node: 24.22.1, bun: 1.4.2 }
  packages: [jq, ripgrep]
  claudeCode: 2.1.303
  files:
    - { path: .env.example, noRealSecrets: true }
`;

  it("reads a box block and leaves it empty when the file has none", () => {
    const result = ok(resolveOfficeConfig({ office: BOX }));
    expect(result.config.box).toEqual({
      debian: "bookworm",
      toolchain: { node: "24.22.1", bun: "1.4.2" },
      packages: ["jq", "ripgrep"],
      claudeCode: "2.1.303",
      files: [{ path: ".env.example", noRealSecrets: true }],
    });
    expect(ok(resolveOfficeConfig({ office: "version: 9\n" })).config.box).toEqual({});
    expect(ok(resolveOfficeConfig({})).config.box).toEqual({});
  });

  it("migrates a version 8 file to the newest version with no box block", () => {
    const result = ok(resolveOfficeConfig({ office: "version: 8\nworker: { web: false }\n" }));
    expect(result.config.version).toBe(11);
    expect(result.config.box).toEqual({});
  });

  it("refuses a file outside git without its noRealSecrets mark when the file is read", () => {
    for (const entry of ["{ path: .env.local }", "{ path: .env.local, noRealSecrets: false }"]) {
      const [error, ...rest] = errors(
        resolveOfficeConfig({ office: `version: 9\nbox:\n  files:\n    - ${entry}\n` }),
      );
      expect(rest).toEqual([]);
      expect(error?.path).toBe("box.files.0.noRealSecrets");
      expect(error?.expected).toBe("true");
    }
  });

  it("refuses box in a version 8 file and says version 9 adds it", () => {
    const [error, ...rest] = errors(
      resolveOfficeConfig({ office: "version: 8\nbox: { debian: trixie }\n" }),
    );
    expect(rest).toEqual([]);
    expect(error?.path).toBe("box");
    expect(error?.message).toContain("Version 9 adds box: set version: 9 to use it");
  });

  it("refuses box in office.local.yaml", () => {
    const [error, ...rest] = errors(
      resolveOfficeConfig({ office: "version: 9\n", local: "version: 9\nbox: {}\n" }),
    );
    expect(rest).toEqual([]);
    expect(error?.file).toBe(".dipo/office.local.yaml");
    expect(error?.path).toBe("box");
  });

  it("refuses box as a command flag override, so no flag can feed a build", () => {
    const [error, ...rest] = errors(
      resolveOfficeConfig({ office: "version: 9\n", flags: { box: { packages: ["nmap"] } } }),
    );
    expect(rest).toEqual([]);
    expect(error?.file).toBe("command flags");
    expect(error?.path).toBe("box");
  });
});

// Version 10 (DIPO-285): permissions.presentMinutes is retired. Nothing reads it since DIPO-279,
// so an older file that still sets it loads, and the load warns with the key's name.
describe("office configuration version 10", () => {
  const RETIRED = "permissions.presentMinutes";

  it("loads a version 9 file that sets presentMinutes, drops it and warns with its name", () => {
    const result = ok(
      resolveOfficeConfig({
        office: "version: 9\npermissions: { ask: never, presentMinutes: 15 }\n",
      }),
    );
    expect(result.config.version).toBe(11);
    expect(result.config.permissions).toEqual({ ask: "never" });
    expect(result.warnings).toEqual([
      {
        file: ".dipo/office.yaml",
        path: RETIRED,
        message: expect.stringContaining(`.dipo/office.yaml: ${RETIRED}: ignored`),
      },
    ]);
    const [warning] = result.warnings;
    expect(warning?.message).toContain("version 10 removed this key");
    expect(warning?.message).toContain("DIPO-279");
    expect(warning?.message).toContain("Delete it from the file");
  });

  it("hashes an older file with presentMinutes the same as one without it", () => {
    const withKey = ok(
      resolveOfficeConfig({ office: "version: 1\npermissions: { presentMinutes: 10 }\n" }),
    );
    const without = ok(resolveOfficeConfig({ office: "version: 1\n" }));
    expect(withKey.config).toEqual(without.config);
    expect(withKey.configHash).toBe(without.configHash);
    expect(withKey.warnings.map((warning) => warning.path)).toEqual([RETIRED]);
    expect(without.warnings).toEqual([]);
  });

  it("warns about nothing for a file without the key, or without files", () => {
    expect(ok(resolveOfficeConfig({ office: "version: 9\n" })).warnings).toEqual([]);
    expect(ok(resolveOfficeConfig({ office: "version: 10\n" })).warnings).toEqual([]);
    expect(ok(resolveOfficeConfig({})).warnings).toEqual([]);
  });

  it("still refuses a wrong presentMinutes in a version 9 file", () => {
    const [error] = errors(
      resolveOfficeConfig({ office: "version: 9\npermissions: { presentMinutes: soon }\n" }),
    );
    expect(error?.path).toBe(RETIRED);
  });

  it("refuses presentMinutes in a version 10 file and says why it is gone", () => {
    const [error, ...rest] = errors(
      resolveOfficeConfig({ office: "version: 10\npermissions: { presentMinutes: 10 }\n" }),
    );
    expect(rest).toEqual([]);
    expect(error?.path).toBe(RETIRED);
    expect(error?.message).toContain("version 10 removed it");
    expect(error?.message).toContain("DIPO-279");
  });

  it("refuses presentMinutes as a command flag override", () => {
    const [error] = errors(resolveOfficeConfig({ flags: { permissions: { presentMinutes: 10 } } }));
    expect(error?.file).toBe("command flags");
    expect(error?.path).toBe(RETIRED);
  });

  it("returns the warning from loadOfficeConfig", async () => {
    await withTempDir(async (dir) => {
      writeDipo(dir, { "office.yaml": "version: 8\npermissions: { presentMinutes: 10 }\n" });
      const result = ok(await loadOfficeConfig(dir));
      expect(result.warnings.map((warning) => warning.path)).toEqual([RETIRED]);
    });
  });
});

// Version 11 (DIPO-251, from DIPO-260): story.securityPhrases and story.securityCriteriaPhrases,
// the phrase lists of R30, with their defaults when the file does not set them.
describe("office configuration version 11", () => {
  it("gives a version 10 file and no file the default security phrases", () => {
    for (const result of [
      ok(resolveOfficeConfig({ office: "version: 10\n" })),
      ok(resolveOfficeConfig({})),
    ]) {
      expect(result.config.version).toBe(11);
      expect(result.config.story.securityPhrases).toEqual([
        "deny rule",
        "deny rules",
        "guard",
        "guards",
        "sandbox setting",
        "sandbox settings",
        "permission check",
        "permission checks",
      ]);
      expect(result.config.story.securityCriteriaPhrases).toEqual(
        OFFICE_DEFAULTS.story.securityCriteriaPhrases,
      );
    }
  });

  it("takes the phrases of a version 11 file, a part it leaves out keeps its default", () => {
    const result = ok(
      resolveOfficeConfig({
        office:
          "version: 11\nstory:\n  securityPhrases: [firewall rule]\n  securityCriteriaPhrases:\n    bypassForms: [escape]\n",
      }),
    );
    expect(result.config.story.securityPhrases).toEqual(["firewall rule"]);
    expect(result.config.story.securityCriteriaPhrases).toEqual({
      ...OFFICE_DEFAULTS.story.securityCriteriaPhrases,
      bypassForms: ["escape"],
    });
  });

  it("refuses the security phrases in a version 10 file and says version 11 adds them", () => {
    for (const key of ["securityPhrases: [x]", "securityCriteriaPhrases: { failClosed: [x] }"]) {
      const [error, ...rest] = errors(
        resolveOfficeConfig({ office: `version: 10\nstory: { ${key} }\n` }),
      );
      expect(rest).toEqual([]);
      expect(error?.message).toContain("Version 11 adds story.security");
      expect(error?.message).toContain("set version: 11 to use it");
    }
  });

  it("refuses an empty phrase and an unknown part", () => {
    expect(
      resolveOfficeConfig({ office: 'version: 11\nstory: { securityPhrases: [""] }\n' }).ok,
    ).toBe(false);
    expect(
      resolveOfficeConfig({
        office: "version: 11\nstory: { securityCriteriaPhrases: { other: [x] } }\n",
      }).ok,
    ).toBe(false);
  });
});
