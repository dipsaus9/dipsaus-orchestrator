import { describe, expect, it } from "bun:test";

import { fingerprint } from "./fingerprint";
import type { Probe } from "./types";

const base: Probe = {
  texts: {
    "package.json": JSON.stringify({
      name: "repo",
      packageManager: "bun@1.4.2",
      scripts: { test: "bun test", verify: "bun run test" },
      dependencies: { zod: "^4.0.0" },
    }),
    "pnpm-workspace.yaml": "packages:\n  - apps/*\ncatalog:\n  vite: ^8.0.0\n",
    "apps/web/package.json": JSON.stringify({ name: "web", scripts: { dev: "vite" } }),
    "apps/web/vite.config.ts": "export default {};\n",
    "packages/config/vite/index.ts": "export const devPorts = { web: 5173 };\n",
    ".nvmrc": "24\n",
    ".claude/backlog-workflow.json": JSON.stringify({ verify: [] }),
  },
  lockfiles: ["bun.lock"],
  workspaceDirs: ["apps/web"],
  configImports: { "apps/web/vite.config.ts": ["packages/config/vite/index.ts"] },
  envFiles: [{ example: ".env.example", path: ".env", present: true, ignored: true }],
};

const withText = (path: string, text: string): Probe => ({
  ...base,
  texts: { ...base.texts, [path]: text },
});
const withManifest = (change: Record<string, unknown>) =>
  withText(
    "package.json",
    JSON.stringify({ ...JSON.parse(base.texts["package.json"] ?? "{}"), ...change }),
  );

describe("fingerprint", () => {
  const original = fingerprint(base);

  it("is a sha256 that is stable for the same inputs", () => {
    expect(original).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fingerprint(structuredClone(base))).toBe(original);
  });

  it("changes when a root or workspace script changes", () => {
    expect(
      fingerprint(withManifest({ scripts: { test: "bun test --bail", verify: "bun run test" } })),
    ).not.toBe(original);
    expect(
      fingerprint(
        withText(
          "apps/web/package.json",
          JSON.stringify({ name: "web", scripts: { dev: "vite --host" } }),
        ),
      ),
    ).not.toBe(original);
  });

  it("changes with packageManager, engines, workspaces, runtime files, configs, the workflow file and env names", () => {
    const changed = [
      withManifest({ packageManager: "bun@1.5.0" }),
      withManifest({ engines: { node: ">=24" } }),
      withManifest({ workspaces: ["apps/*"] }),
      withText("pnpm-workspace.yaml", "packages:\n  - apps/*\n  - tools/*\n"),
      withText(".nvmrc", "22\n"),
      withText(".node-version", "24\n"),
      withText("apps/web/vite.config.ts", "export default { server: { port: 4000 } };\n"),
      withText(".claude/backlog-workflow.json", JSON.stringify({ verify: ["bun test"] })),
      { ...base, lockfiles: ["pnpm-lock.yaml"] },
      {
        ...base,
        envFiles: [
          ...base.envFiles,
          { example: "config.example.json", path: "config.json", present: false, ignored: true },
        ],
      },
    ];
    for (const probe of changed) expect(fingerprint(probe)).not.toBe(original);
  });

  it("ignores lockfile contents, dependencies, the pnpm catalog, env presence and other files", () => {
    const unchanged = [
      // A probe holds lockfile names only; the same name with other contents gives the same probe.
      { ...base, lockfiles: ["bun.lock"] },
      withManifest({ dependencies: { zod: "^4.1.0" }, version: "1.2.3" }),
      withText("pnpm-workspace.yaml", "packages:\n  - apps/*\ncatalog:\n  vite: ^9.0.0\n"),
      {
        ...base,
        envFiles: [{ example: ".env.example", path: ".env", present: false, ignored: false }],
      },
      withText("packages/config/vite/index.ts", "export const devPorts = { web: 6000 };\n"),
      withText("README.md", "# readme\n"),
      withText(
        "package.json",
        JSON.stringify({
          scripts: { verify: "bun run test", test: "bun test" },
          name: "repo",
          packageManager: "bun@1.4.2",
        }),
      ),
    ];
    for (const probe of unchanged) expect(fingerprint(probe)).toBe(original);
  });
});
