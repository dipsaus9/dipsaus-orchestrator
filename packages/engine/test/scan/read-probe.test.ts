// Integration: `readProbe` over real temp repositories (under DIPO_TMP, isolated git env), then
// `detect` and `fingerprint` over what it read.

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { withTempRepo, type TempRepo } from "@dipsaus-orchestrator/testkit";

import { createRepoFiles, type RepoFiles } from "../../src/platform/repo-files";
import { detect, fingerprint, readProbe } from "../../src/scan/detect";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** The shape of this repository: Bun workspaces, a root `verify` script, no `dev`. */
const ORCHESTRATOR_SHAPE = {
  "package.json": json({
    name: "dipsaus-orchestrator",
    private: true,
    workspaces: ["packages/*"],
    type: "module",
    scripts: {
      "format:check": "oxfmt --check",
      "format:fix": "oxfmt",
      lint: "oxlint --deny-warnings",
      typecheck: "tsc -b",
      test: "bun test",
      verify: "bun run format:check && bun run lint && bun run typecheck && bun test",
    },
    engines: { bun: ">=1.4.2" },
  }),
  "bun.lock": '{ "lockfileVersion": 1 }\n',
  ".bun-version": "1.4.2\n",
  ".gitignore": "node_modules/\n.tsbuild/\n",
  "packages/engine/package.json": json({ name: "@dipsaus-orchestrator/engine", private: true }),
  "packages/engine/src/index.ts": "export {};\n",
  "packages/cli/package.json": json({ name: "@dipsaus-orchestrator/cli", private: true }),
  "packages/cli/node_modules/dep/package.json": json({ name: "dep" }),
  "docs/notes/package.json": json({ name: "not-a-workspace" }),
} as const;

const filesFor = (repo: TempRepo) => createRepoFiles(repo.dir, { env: repo.env });

describe("readProbe and detect over this repository's shape", () => {
  it("resolves verify from the root verify script", async () => {
    await withTempRepo(
      async (repo) => {
        await repo.commitAll("init");
        const probe = await readProbe(repo.dir, filesFor(repo));
        expect(probe.lockfiles).toEqual(["bun.lock"]);
        expect(probe.workspaceDirs).toEqual(["packages/cli", "packages/engine"]);

        const profile = detect(probe);
        expect(profile.capabilities.verify).toEqual({
          status: "resolved",
          value: { commands: [["bun", "run", "verify"]], cwd: "." },
          source: "standard",
          confidence: "high",
          evidence: "package.json scripts.verify",
        });
        expect(profile.runRefusal).toBeNull();
        expect(profile.toolchain.packageManager).toMatchObject({
          value: { name: "bun" },
          evidence: "bun.lock",
        });
        expect(profile.toolchain.workspaces).toEqual([
          { dir: "packages/cli", name: "@dipsaus-orchestrator/cli" },
          { dir: "packages/engine", name: "@dipsaus-orchestrator/engine" },
        ]);
        expect(profile.capabilities.install).toMatchObject({
          value: { commands: [["bun", "install", "--frozen-lockfile"]] },
        });
        // No `dev`: Partial until the maintainer marks it as having nothing to start.
        expect(profile.conformance.level).toBe("partial");
        expect(detect(probe, { nothingToStart: true }).conformance.level).toBe("conforming");
      },
      { fixture: ORCHESTRATOR_SHAPE },
    );
  });

  it("keeps the fingerprint when the lockfile changes and changes it when a script changes", async () => {
    await withTempRepo(
      async (repo) => {
        const first = fingerprint(await readProbe(repo.dir, filesFor(repo)));
        await Bun.write(
          join(repo.dir, "bun.lock"),
          '{ "lockfileVersion": 1, "packages": { "zod": [] } }\n',
        );
        expect(fingerprint(await readProbe(repo.dir, filesFor(repo)))).toBe(first);

        const manifest = JSON.parse(ORCHESTRATOR_SHAPE["package.json"]) as {
          scripts: Record<string, string>;
        };
        manifest.scripts["test"] = "bun test --bail";
        await Bun.write(join(repo.dir, "package.json"), json(manifest));
        expect(fingerprint(await readProbe(repo.dir, filesFor(repo)))).not.toBe(first);
      },
      { fixture: ORCHESTRATOR_SHAPE },
    );
  });
});

describe("readProbe and env files", () => {
  it("records env files by path, presence and ignore status, and never reads them", async () => {
    await withTempRepo(
      async (repo) => {
        await repo.commitAll("init");
        const real = filesFor(repo);
        const read: string[] = [];
        const recording: RepoFiles = {
          listFiles: () => real.listFiles(),
          exists: (path) => real.exists(path),
          ignored: (paths) => real.ignored(paths),
          readText: (path) => {
            read.push(path);
            return real.readText(path);
          },
        };
        const probe = await readProbe(repo.dir, recording);
        expect(probe.envFiles).toEqual([
          { example: ".env.example", path: ".env", present: true, ignored: true },
          {
            example: "apps/server/.dev.vars.example",
            path: "apps/server/.dev.vars",
            present: false,
            ignored: true,
          },
          { example: null, path: "certs/dev.pem", present: true, ignored: true },
          { example: "config.example.json", path: "config.json", present: true, ignored: false },
          { example: "wrangler.example.toml", path: "wrangler.toml", present: true, ignored: true },
        ]);
        const envPaths = probe.envFiles.flatMap((file) => [file.path, file.example ?? file.path]);
        expect(read.filter((path) => envPaths.includes(path))).toEqual([]);
        expect(Object.keys(probe.texts).filter((path) => envPaths.includes(path))).toEqual([]);
        const serialized = JSON.stringify(detect(probe));
        for (const secret of ["SECRET_VALUE", "EXAMPLE_VALUE"])
          expect(serialized).not.toContain(secret);

        const profile = detect(probe);
        expect(profile.conformance.deviations.map((d) => d.code)).toEqual(
          expect.arrayContaining([
            "env-file-missing:apps/server/.dev.vars",
            "env-file-not-ignored:config.json",
          ]),
        );
      },
      {
        fixture: {
          "package.json": json({ name: "app", scripts: { test: "bun test" } }),
          "bun.lock": "{}\n",
          ".gitignore": ".env\n.dev.vars\ncerts/\nwrangler.toml\n",
          ".env.example": "TOKEN=EXAMPLE_VALUE\n",
          ".env": "TOKEN=SECRET_VALUE\n",
          "apps/server/.dev.vars.example": "KEY=EXAMPLE_VALUE\n",
          "config.example.json": '{ "token": "EXAMPLE_VALUE" }\n',
          "config.json": '{ "token": "SECRET_VALUE" }\n',
          "wrangler.example.toml": 'vars = { KEY = "EXAMPLE_VALUE" }\n',
          "wrangler.toml": 'vars = { KEY = "SECRET_VALUE" }\n',
          "certs/dev.pem": "SECRET_VALUE\n",
          ".claude/backlog-workflow.json": json({
            worktree: { includeGitignored: ["certs/dev.pem"] },
          }),
        },
      },
    );
  });
});

describe("readProbe runs no repository script", () => {
  it("leaves every script and the fsmonitor hook unrun", async () => {
    await withTempRepo(
      async (repo) => {
        const marker = (name: string) => join(repo.root, `ran-${name}`);
        const scripts = Object.fromEntries(
          [
            "preinstall",
            "install",
            "postinstall",
            "prepare",
            "setup",
            "dev",
            "test",
            "lint",
            "typecheck",
            "verify",
            "build",
          ].map((name) => [name, `touch ${marker(name)}`]),
        );
        await Bun.write(join(repo.dir, "package.json"), json({ name: "app", scripts }));
        await Bun.write(join(repo.dir, "hook.sh"), `#!/bin/sh\ntouch ${marker("fsmonitor")}\n`);
        await repo.run(["chmod", "+x", "hook.sh"]);
        await repo.git("config", "core.fsmonitor", join(repo.dir, "hook.sh"));

        const profile = detect(await readProbe(repo.dir, filesFor(repo)));
        expect(profile.capabilities.verify.status).toBe("resolved");
        for (const name of [...Object.keys(scripts), "fsmonitor"])
          expect(existsSync(marker(name))).toBe(false);
      },
      { fixture: { "bun.lock": "{}\n" } },
    );
  });
});

describe("readProbe and dev server configs", () => {
  it("follows a vite config import into a workspace config module to find fixed ports", async () => {
    await withTempRepo(
      async (repo) => {
        const probe = await readProbe(repo.dir, filesFor(repo));
        expect(probe.configImports).toEqual({
          "apps/host/vite.config.ts": ["packages/config/vite/index.ts"],
        });
        const profile = detect(probe);
        expect(profile.devPorts).toEqual([
          expect.objectContaining({
            dir: "apps/host",
            port: 5174,
            fixedInCode: true,
            evidence: "apps/host/vite.config.ts (devPorts.host from packages/config/vite/index.ts)",
          }),
        ]);
        expect(profile.conformance.level).toBe("partial");
      },
      {
        fixture: {
          "package.json": json({
            name: "cc",
            packageManager: "pnpm@11.27.0",
            scripts: {
              dev: "pnpm -r --parallel run dev",
              test: "pnpm -r run test",
              lint: "oxlint",
            },
          }),
          "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
          "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
          "apps/host/package.json": json({ name: "@cc/host", scripts: { dev: "vite" } }),
          "apps/host/vite.config.ts":
            'import { defineAppConfig, devPorts } from "@cc/config/vite";\nexport default defineAppConfig({ port: devPorts.host });\n',
          "packages/config/package.json": json({
            name: "@cc/config",
            exports: { "./*": "./*/index.ts" },
          }),
          "packages/config/vite/index.ts":
            "export const devPorts = { server: 5173, host: 5174 } as const;\n",
        },
      },
    );
  });
});
