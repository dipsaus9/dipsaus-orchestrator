// The engine commits an office base has after the daemon's build commit (DIPO-198): only commits
// that change files under `packages/` count, and an office whose repository lacks the build commit
// gets no count.

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ManualClock, withBareRemote } from "@dipsaus-orchestrator/testkit";

import {
  buildCommitSha,
  ENGINE_READ_TIMEOUT_MS,
  engineCommitsAfter,
  type GitCall,
  type GitResult,
  OfficeGit,
  readEngineCommitsAfter,
} from "../../src/git";

import { OFFICE, officeGit, published } from "./helpers";

function writeIn(dir: string, file: string): void {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), `${file}\n`);
}

/** An office git over a fake executor, for the failure paths real git does not reach. */
function fakeOffice(exec: (call: GitCall) => Promise<GitResult>, clock = new ManualClock()) {
  return new OfficeGit({
    officeId: OFFICE,
    mainWorktree: "/repo",
    commonDir: "/repo/.git",
    settings: { remote: "origin", base: "main" },
    runner: { exec, env: {}, sleep: async () => {} },
    clock,
  });
}

const SHA = "1a2b3c4d5e6f";
const ok = (stdout = ""): GitResult => ({ code: 0, stdout, stderr: "" });

describe("engineCommitsAfter", () => {
  it("counts the base commits after the build commit that change packages/", async () => {
    await withBareRemote(async (repo) => {
      const build = await published(repo);
      writeIn(repo.dir, "packages/engine/prompt.md");
      await repo.commitAll("engine change");
      writeIn(repo.dir, "docs/notes.md");
      await repo.commitAll("docs only");
      await repo.git("push", "--quiet", "origin", "main");
      const office = officeGit(repo);
      await office.fetch();

      expect(await engineCommitsAfter(office, build)).toBe(1);
      expect(await engineCommitsAfter(office, `${build}-dirty`)).toBe(1);
      expect(await engineCommitsAfter(office, build.slice(0, 12))).toBe(1);
    });
  });

  it("counts the base as fetched, not the checkout's HEAD", async () => {
    await withBareRemote(async (repo) => {
      const build = await published(repo);
      writeIn(repo.dir, "packages/engine/prompt.md");
      await repo.commitAll("engine change");
      await repo.git("push", "--quiet", "origin", "main");
      const office = officeGit(repo);
      await office.fetch();
      // A local engine commit that is never pushed: HEAD is two engine commits past the build.
      writeIn(repo.dir, "packages/engine/local.md");
      await repo.commitAll("local engine change");

      expect(await engineCommitsAfter(office, build)).toBe(1);
    });
  });

  it("gives no count when the base's remote-tracking ref is missing", async () => {
    await withBareRemote(async (repo) => {
      const build = await published(repo);
      const office = officeGit(repo);
      await office.fetch();
      await repo.git("update-ref", "-d", "refs/remotes/origin/main");

      expect(await readEngineCommitsAfter(office, build)).toEqual({ kind: "none" });
      expect(await engineCommitsAfter(office, build)).toBeNull();
    });
  });

  it("gives no count when the office has no base branch", async () => {
    await withBareRemote(async (repo) => {
      const build = await published(repo);
      const office = officeGit(repo, { base: undefined });
      await office.fetch();
      await repo.git("symbolic-ref", "-d", "refs/remotes/origin/HEAD").catch(() => "");

      expect(await readEngineCommitsAfter(office, build)).toEqual({ kind: "none" });
    });
  });

  it("gives no count to an office whose repository lacks the build commit", async () => {
    await withBareRemote(async (repo) => {
      await published(repo);
      const office = officeGit(repo);
      await office.fetch();
      expect(await engineCommitsAfter(office, "0123456789ab")).toBeNull();
      expect(await engineCommitsAfter(office, "not-a-commit")).toBeNull();
    });
  });

  it("reads the commit out of a stamp", () => {
    expect(buildCommitSha("1a2b3c4d5e6f-dirty")).toBe("1a2b3c4d5e6f");
    expect(buildCommitSha("--upload-pack=x")).toBeNull();
  });
});

describe("readEngineCommitsAfter", () => {
  it("reports a failed read when the repository holds the commit and rev-list fails", async () => {
    const office = fakeOffice(async (call) => {
      if (call.args.includes("rev-list")) return { code: 128, stdout: "", stderr: "fatal: bad" };
      return ok(call.args.includes("rev-parse") ? "ffffffffffff\n" : "");
    });
    expect(await readEngineCommitsAfter(office, SHA)).toEqual({
      kind: "failed",
      detail: "fatal: bad",
    });
    expect(await engineCommitsAfter(office, SHA)).toBeNull();
  });

  it("kills a git read that does not finish within the step timeout", async () => {
    const clock = new ManualClock();
    const office = fakeOffice(() => new Promise<GitResult>(() => {}), clock);
    const read = readEngineCommitsAfter(office, SHA);
    // Let the queue item reach its first step, which hangs, then let its timeout fall due.
    for (let i = 0; i < 10 && clock.pendingTimers === 0; i += 1) await Promise.resolve();
    expect(clock.pendingTimers).toBe(1);
    clock.advance(ENGINE_READ_TIMEOUT_MS);
    const result = await read;
    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" && result.detail).toContain("was killed");
  });

  it("reads nothing when the stamp is no commit", async () => {
    const office = fakeOffice(async () => {
      throw new Error("no git step expected");
    });
    expect(await readEngineCommitsAfter(office, "dev")).toEqual({ kind: "none" });
  });
});
