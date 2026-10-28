import { describe, expect, it } from "bun:test";

import {
  expandWorkspaces,
  parseManifest,
  parsePnpmWorkspacePackages,
  parseWorkflow,
} from "./manifest";

describe("parsePnpmWorkspacePackages", () => {
  it("reads the block form with comments and quotes, and stops at the next key", () => {
    const yaml = [
      "packages:",
      "  - apps/*",
      "  # tools are packages too",
      '  - "tooling/*" # trailing comment',
      "  - 'e2e'",
      "",
      "catalog:",
      "  - not-a-package",
    ].join("\n");
    expect(parsePnpmWorkspacePackages(yaml)).toEqual(["apps/*", "tooling/*", "e2e"]);
  });

  it("reads the flow form and an absent key", () => {
    expect(parsePnpmWorkspacePackages("packages: [apps/*, 'packages/*']\n")).toEqual([
      "apps/*",
      "packages/*",
    ]);
    expect(parsePnpmWorkspacePackages("onlyBuiltDependencies:\n  - esbuild\n")).toEqual([]);
  });
});

describe("expandWorkspaces", () => {
  it("matches globs and negations over package directories, never node_modules", () => {
    const dirs = [
      "",
      "apps/web",
      "apps/api",
      "packages/a/b",
      "e2e",
      "spikes/x",
      "apps/web/node_modules/x",
    ];
    expect(expandWorkspaces(["apps/*", "packages/**", "e2e", "!apps/api"], dirs)).toEqual([
      "apps/web",
      "e2e",
      "packages/a/b",
    ]);
  });
});

describe("parseManifest", () => {
  it("reads both workspaces forms and rejects non-objects", () => {
    expect(parseManifest(JSON.stringify({ workspaces: ["a/*"] }))?.workspaces).toEqual(["a/*"]);
    expect(
      parseManifest(JSON.stringify({ workspaces: { packages: ["b/*"] } }))?.workspaces,
    ).toEqual(["b/*"]);
    expect(parseManifest("[]")).toBeNull();
    expect(parseManifest("{")).toBeNull();
  });
});

describe("parseWorkflow", () => {
  it("reads install, verify and includeGitignored", () => {
    const workflow = parseWorkflow(
      JSON.stringify({
        worktree: { install: " bun install ", includeGitignored: [".env"] },
        verify: ["bun test", ""],
      }),
    );
    expect(workflow).toEqual({
      install: "bun install",
      verify: ["bun test"],
      includeGitignored: [".env"],
    });
  });
});
