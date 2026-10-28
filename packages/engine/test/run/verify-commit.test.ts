// The end of a developer's turn (DIPO-49, DIPO-240): the pure rules that stay (gate changes for
// the review, dependency files), and a run without
// a box that reports done, which parks: dipo runs no verify, backstop or scope check of its own any
// more. The box run's done path, from the last part to In Review, is `verify-in-box.test.ts`.

import { describe, expect, it } from "bun:test";

import type { RunId, WorkRef } from "@dipsaus-orchestrator/contract";

import {
  type BackstopSnapshot,
  dependencyFiles,
  gateChanges,
  NO_BOX_AT_DONE,
  type StoredRun,
  type StoryGit,
  type TurnContext,
  VerifyCommit,
} from "../../src/run";
import type { OfficeHandle } from "../../src/db/office";
import { detect, type RunProfile } from "../../src/scan/detect";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

function profileOf(scripts: Record<string, string>): RunProfile {
  return detect({
    texts: {
      "package.json": JSON.stringify({ name: "p", packageManager: "bun@1.4.2", scripts }),
    },
    lockfiles: ["bun.lock"],
    workspaceDirs: [],
    configImports: {},
    envFiles: [],
  });
}

const SNAP: BackstopSnapshot = {
  head: "c".repeat(40),
  branch: "refs/heads/DIPO-1/add-a-greeting",
  stash: "",
  backlogStatus: "",
};

describe("rules", () => {
  it("lists the gate script and command changes the review is told about", () => {
    const base = profileOf({ verify: "bun test", test: "bun test" });
    const same = gateChanges({
      baseScripts: { verify: "bun test" },
      branchScripts: { verify: "bun test" },
      base,
      branch: base,
    });
    expect(same).toEqual([]);
    const branch = profileOf({ lint: "true", test: "true" });
    const changes = gateChanges({
      baseScripts: { verify: "bun test", test: "bun test" },
      branchScripts: { lint: "true", test: "true" },
      base,
      branch,
    });
    expect(changes).toContain('scripts.verify: "bun test" -> none');
    expect(changes).toContain('scripts.test: "bun test" -> "true"');
    expect(changes.some((line) => line.startsWith("verify: bun run verify -> "))).toBe(true);
  });

  it("finds manifests, lockfiles and requirements files anywhere in the tree (DIPO-84)", () => {
    expect(
      dependencyFiles([
        "src/greet.ts",
        "package.json",
        "packages/a/package.json",
        "bun.lock",
        "bun.lockb",
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "requirements.txt",
        "py/requirements-dev.txt",
        "pyproject.toml",
        "poetry.lock",
        "uv.lock",
        "docs/package.json.md",
        "requirements.md",
        "src/requirements.txt.bak",
      ]),
    ).toEqual([
      "bun.lock",
      "bun.lockb",
      "package-lock.json",
      "package.json",
      "packages/a/package.json",
      "pnpm-lock.yaml",
      "poetry.lock",
      "py/requirements-dev.txt",
      "pyproject.toml",
      "requirements.txt",
      "uv.lock",
      "yarn.lock",
    ]);
    expect(dependencyFiles(["src/greet.ts", "README.md"])).toEqual([]);
  });
});

/** A done turn of a story run; the story git refuses every call. */
function turn(box: boolean | undefined) {
  const calls: string[] = [];
  const story = new Proxy({} as StoryGit, {
    get: (_target, name) => () => {
      calls.push(String(name));
      throw new Error("no git may run for a run without a box");
    },
  });
  const finisher = new VerifyCommit({
    clock: new ManualClock(),
    story,
    profile: () => null,
    ...(box === undefined
      ? {}
      : {
          parts: {
            isBoxRun: () => box,
            finishLast: async () => {
              calls.push("finishLast");
              throw new Error("no part in this test");
            },
          },
        }),
  });
  const ctx = {
    office: { officeId: "off_1" } as unknown as OfficeHandle,
    run: {
      runId: "run_1" as RunId,
      kind: "story",
      worktree: "/w/DIPO-1",
      story: "DIPO-1",
    } as unknown as StoredRun,
    work: {} as WorkRef,
    report: { status: "done", criteria: [], summary: "", commitSubject: "x" },
    snapshot: SNAP,
    live: () => true,
    claimEnd: () => true,
    write: () => undefined,
    flushOutput: () => undefined,
  } as unknown as TurnContext;
  return { finisher, ctx, calls };
}

describe("a run without a box at done (DIPO-240)", () => {
  it("parks worker-failed with the reason, and runs no verify, scope check or git", async () => {
    for (const box of [false, undefined]) {
      const { finisher, ctx, calls } = turn(box);
      expect(await finisher.afterTurn(ctx)).toEqual({
        kind: "park",
        reason: "worker-failed",
        detail: NO_BOX_AT_DONE,
        endKind: "interrupted",
      });
      expect(calls).toEqual([]);
    }
  });

  it("lets a turn that is not done go on, box or not", async () => {
    const { finisher, ctx } = turn(false);
    expect(await finisher.afterTurn({ ...ctx, report: null })).toEqual({ kind: "continue" });
  });
});
