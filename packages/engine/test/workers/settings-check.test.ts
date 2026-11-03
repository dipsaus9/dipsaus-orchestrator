// The project settings check (DIPO-43 AC #2 and #3, 0008): fixture files with `hooks`,
// `env`, `enabledPlugins`, `sandbox` and an allowlisted key, the office allowlist, and a key the
// local file never allows.

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  checkProjectSettings,
  checkSettings,
  LOCAL_REFUSED_KEYS,
} from "../../src/workers/claude-cli/settings-check";

const FILE = "/w/.claude/settings.json";
const LOCAL = "/w/.claude/settings.local.json";

function keys(failures: { key?: string }[]): (string | undefined)[] {
  return failures.map((failure) => failure.key);
}

describe("(unit) project settings check", () => {
  it("refuses hooks, env, enabledPlugins and sandbox, and passes an allowlisted key", () => {
    const failures = checkSettings(
      FILE,
      {
        $schema: "https://json.schemastore.org/claude-code-settings.json",
        hooks: {},
        env: { FOO: "1" },
        enabledPlugins: { "x@y": true },
        sandbox: { enabled: false },
        permissions: { deny: ["Read(./.env)"], allow: ["Bash"] },
        includeCoAuthoredBy: false,
      },
      false,
    );
    expect(keys(failures)).toEqual([
      "hooks",
      "env",
      "enabledPlugins",
      "sandbox",
      "permissions.allow",
    ]);
    for (const failure of failures) expect(failure.file).toBe(FILE);
    const hooks = failures.find((failure) => failure.key === "hooks");
    expect(hooks?.fix).toBe('Remove "hooks" from the file.');
    expect(failures.find((failure) => failure.key === "sandbox")?.fix).toBeUndefined();
  });

  it("fails closed on unknown keys and on a file that is not an object", () => {
    expect(keys(checkSettings(FILE, { someFutureKey: 1 }, false))).toEqual(["someFutureKey"]);
    expect(checkSettings(FILE, ["hooks"], false)).toHaveLength(1);
    expect(keys(checkSettings(FILE, { permissions: "all" }, false))).toEqual(["permissions"]);
  });

  it("refuses in the local file the keys that widen permissions or load MCP servers", () => {
    const failures = checkSettings(
      LOCAL,
      { permissions: { allow: ["Bash"], deny: [] }, enabledMcpjsonServers: [] },
      true,
    );
    expect(keys(failures)).toEqual(["permissions.allow", "enabledMcpjsonServers"]);
    for (const failure of failures) {
      expect(failure.detail).toBe("the key is never allowed in the local settings file; remove it");
    }
    expect(LOCAL_REFUSED_KEYS).toContain("permissions.additionalDirectories");
    expect(
      checkSettings(LOCAL, { permissions: { deny: ["z"] }, includeCoAuthoredBy: false }, true),
    ).toEqual([]);
  });

  it("reads both files of a worktree; missing files pass, bad JSON refuses", async () => {
    await withTempDir(async (dir) => {
      expect(await checkProjectSettings(dir)).toEqual([]);
      mkdirSync(join(dir, ".claude"));
      writeFileSync(join(dir, ".claude", "settings.json"), '{"hooks":{}}');
      writeFileSync(join(dir, ".claude", "settings.local.json"), "{not json");
      const failures = await checkProjectSettings(dir);
      expect(failures).toEqual([
        expect.objectContaining({ key: "hooks", file: join(dir, ".claude", "settings.json") }),
        expect.objectContaining({
          detail: "the file is not valid JSON",
          file: join(dir, ".claude", "settings.local.json"),
        }),
      ]);
    });
  });
});
