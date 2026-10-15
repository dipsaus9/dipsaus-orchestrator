// The hook command run from source (DIPO-59 review): Claude runs hooks in the worktree, outside the
// sandbox, and Bun loads `bunfig.toml` (with `preload`) and `.env` from its working directory. A
// worker can write both in its worktree, so the hook command must load neither. This runs the
// planned `Stop` hook command through `sh` in a worktree with both files planted, with a stand-in
// entry script that prints what it saw.

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config";
import { plan, SETTINGS_FILE } from "../../src/workers/claude-cli/plan";
import { WORKER_REPORT_JSON_SCHEMA } from "../../src/workers/claude-cli/report-schema";

describe("the hook command from source", () => {
  it("loads no bunfig.toml preload and no .env the worker planted in the worktree", () =>
    withTempDir(async (dir) => {
      const main = join(dir, "main");
      const workdir = join(dir, "main.worktrees", "story");
      const runDir = join(main, ".git", "dipo", "runs", "run-0001");
      const source = join(dir, "dipo-src");
      for (const path of [workdir, runDir, source]) mkdirSync(path, { recursive: true });
      writeFileSync(join(workdir, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
      writeFileSync(join(workdir, "evil.ts"), 'console.log("EVIL");\n');
      writeFileSync(join(workdir, ".env"), "PLANTED=from-the-worktree\n");
      const entry = join(source, "main.ts");
      writeFileSync(
        entry,
        "console.log(JSON.stringify({ planted: process.env.PLANTED ?? null, args: process.argv.slice(2), cwd: process.cwd() }));\n",
      );

      const launch = plan(
        {
          run: "run-0001",
          agent: "agt-0001",
          kind: "implement",
          workdir,
          model: "haiku",
          effort: "low",
          caps: { budgetTokens: 1000, maxTurns: 5, maxMinutes: 5 },
          systemFile: join(runDir, "system.md"),
          taskMessage: "task",
          tools: { allow: ["Read"], deny: [] },
          session: { id: "0e6f3f4c-5b8d-4c1e-9a2b-3c4d5e6f7a8b", resume: false },
          reportSchema: WORKER_REPORT_JSON_SCHEMA,
          hookRelay: true,
        },
        {
          claudePath: "/usr/local/bin/claude",
          home: join(dir, "home"),
          env: {},
          toolVariables: [],
          mainCheckout: main,
          runDir,
          hostSocket: join(dir, "h.sock"),
          tmpDir: join(dir, "tmp"),
          sandbox: OFFICE_DEFAULTS.sandbox,
          hookCommand: [process.execPath, entry],
        },
      );
      // The host writes the plan's files, the empty Bun config among them.
      for (const file of launch.files) writeFileSync(join(runDir, file.name), file.content);
      const settings = launch.files.find((file) => file.name === SETTINGS_FILE);
      const hooks = JSON.parse(settings?.content ?? "{}").hooks as Record<
        string,
        { hooks: { command: string }[] }[]
      >;
      const command = hooks["Stop"]?.[0]?.hooks[0]?.command ?? "";

      const proc = Bun.spawn(["/bin/sh", "-c", command], {
        cwd: workdir,
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(out).not.toContain("EVIL");
      expect(JSON.parse(out)).toEqual({ planted: null, args: ["hook", "Stop"], cwd: runDir });
    }));
});
