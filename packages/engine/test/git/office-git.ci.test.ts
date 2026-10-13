// CI only (0017 section 1): planted hooks and fsmonitor never run in engine git calls against a
// real temporary repository with a bare remote (DIPO-31), through fetches, a push from a second
// clone and calls in the `_base` worktree; moved out of the local suite for its time budget
// (DIPO-79). The fast local version, the same plant against queue calls on the repository without a
// remote, is in office-git.test.ts; the hardening flags themselves are checked in unit.test.ts.

import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withBareRemote } from "@dipsaus-orchestrator/testkit";

import { officeGit, published, pushFromElsewhere } from "./helpers";

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("hardened engine git calls", () => {
    it("never run a planted core.hooksPath or core.fsmonitor", async () => {
      await withBareRemote(async (repo) => {
        await published(repo);
        const marker = join(repo.root, "ran");
        const hooks = join(repo.root, "hooks");
        mkdirSync(hooks);
        const script = `#!/bin/sh\necho "$0" >> "${marker}"\n`;
        for (const hook of ["post-checkout", "reference-transaction", "post-index-change"]) {
          writeFileSync(join(hooks, hook), script);
          chmodSync(join(hooks, hook), 0o755);
        }
        const fsmonitor = join(repo.root, "fsmonitor.sh");
        writeFileSync(fsmonitor, script);
        chmodSync(fsmonitor, 0o755);
        await repo.git("config", "core.hooksPath", hooks);
        await repo.git("config", "core.fsmonitor", fsmonitor);

        // The plant works for plain git.
        await repo.git("update-ref", "refs/dipo-control", "HEAD");
        await repo.git("status", "--porcelain");
        expect(readFileSync(marker, "utf8")).toContain("reference-transaction");
        expect(readFileSync(marker, "utf8")).toContain("fsmonitor.sh");
        rmSync(marker);

        const office = officeGit(repo);
        expect((await office.fetch()).ok).toBe(true);
        await pushFromElsewhere(repo, "second.txt");
        expect(await office.fetch()).toMatchObject({ ok: true, moved: true });
        const base = office.baseWorktreePath();
        await office.run(async (session) => {
          const location = office.worktreeLocation(base);
          await session.ok(location, ["status", "--porcelain"]);
          await session.ok(location, ["update-index", "--refresh"]);
          await session.ok(session.repository, ["update-ref", "refs/dipo-engine", "HEAD"]);
        });
        expect(existsSync(marker)).toBe(false);
      });
    });
  });
}
