// The merged PR of a merge commit (DIPO-468), through the real spawn path with a fake `gh`
// executable: the REST call it makes, the one PR that merged as the commit, and every other answer
// (a PR that only contains it, an open PR, a closed unmerged PR, none) read as no PR. A failing,
// hanging or logged-out gh throws `CodeHostError`.

import { describe, expect, it } from "bun:test";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { CodeHostError, GhHost } from "../../src/platform/host";
import { systemSpawn } from "../../src/platform/process";
import { fakeGh, type FakeGhMode, restPr } from "./fake-gh";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

function hostOn(dir: string, mode: FakeGhMode, deadlineMs?: number) {
  const gh = fakeGh(dir, mode);
  const host = new GhHost({
    spawn: systemSpawn,
    gh: gh.path,
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: dir },
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  });
  return { gh, host };
}

describe("the merged PR of a merge commit (DIPO-468)", () => {
  it("asks the commit's pulls and returns the PR that merged as the commit", () =>
    withTempDir(async (dir) => {
      const body = JSON.stringify([
        restPr({ number: 3, head: "TASK-2/other", merge: OTHER }),
        restPr({ number: 9, head: "TASK-1/add-csv", merge: SHA }),
      ]);
      const { gh, host } = hostOn(dir, { kind: "answer", body });
      expect(await host.mergedPrOfCommit("o/r", SHA)).toEqual({
        number: 9,
        url: "https://github.com/o/r/pull/9",
        state: "merged",
        head: "TASK-1/add-csv",
        headSha: "9".repeat(40),
        base: "main",
        title: "feat(TASK-1): x",
        mergeCommit: SHA,
      });
      expect(gh.calls()).toEqual([`api repos/o/r/commits/${SHA}/pulls`]);
    }));

  it("reads a PR that only contains the commit, an open PR and a closed unmerged PR as none", () =>
    withTempDir(async (dir) => {
      const body = JSON.stringify([
        restPr({ number: 3, head: "TASK-1/add-csv", merge: OTHER }),
        restPr({ number: 4, head: "TASK-1/add-csv", merge: SHA, merged: false, state: "open" }),
        restPr({ number: 5, head: "TASK-1/add-csv", merge: SHA, merged: false }),
      ]);
      const { host } = hostOn(dir, { kind: "answer", body });
      expect(await host.mergedPrOfCommit("o/r", SHA)).toBeNull();
    }));

  it("names another host with --hostname", () =>
    withTempDir(async (dir) => {
      const { gh, host } = hostOn(dir, { kind: "answer", body: "[]" });
      expect(await host.mergedPrOfCommit("ghe.example/o/r", SHA)).toBeNull();
      expect(gh.calls()).toEqual([`api --hostname ghe.example repos/o/r/commits/${SHA}/pulls`]);
    }));

  it("refuses an id that is not a full commit id without running gh", () =>
    withTempDir(async (dir) => {
      const { gh, host } = hostOn(dir, { kind: "answer", body: "[]" });
      for (const sha of ["abc123", `${SHA}/../../x`, "HEAD"]) {
        const error = await host.mergedPrOfCommit("o/r", sha).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(CodeHostError);
      }
      expect(gh.calls()).toEqual([]);
    }));

  it(
    "throws CodeHostError when gh fails, is logged out, prints no list, or hangs",
    () =>
      withTempDir(async (dir) => {
        const cases: [FakeGhMode, CodeHostError["code"]][] = [
          [{ kind: "fail", code: 1, stderr: "HTTP 502" }, "failed"],
          [{ kind: "fail", code: 4, stderr: "not logged in" }, "unauthenticated"],
          [{ kind: "answer", body: '{"message":"Not Found"}' }, "failed"],
          [{ kind: "answer", body: "<html>" }, "failed"],
          [{ kind: "hang" }, "timedOut"],
        ];
        for (const [mode, code] of cases) {
          const { host } = hostOn(dir, mode, 300);
          const error = await host.mergedPrOfCommit("o/r", SHA).catch((e: unknown) => e);
          expect(error).toBeInstanceOf(CodeHostError);
          expect((error as CodeHostError).code).toBe(code);
        }
      }),
    30_000,
  );
});
