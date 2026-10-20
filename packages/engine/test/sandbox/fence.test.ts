// The worker's read fence for an engine step (DIPO-183): everything under home is blocked except the
// kept paths and the directories on the way to them, so `sandbox-exec` never sees a deny over the
// worktree. In a step, only a request with `readFence` gets the extra denies.

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ChildProcess } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  fenceDenyRead,
  listDirOnDisk,
  type ListDir,
  workerReadPaths,
} from "../../src/sandbox/fence";
import { coveringDenies } from "../../src/sandbox/policy";
import type { SrtSettings } from "../../src/sandbox/policy";
import { runSandboxedStep, type SandboxHost, type StepRequest } from "../../src/sandbox/step";

const HOME = "/home/m";
const TREE: Record<string, string[]> = {
  [HOME]: [".bun", ".cache", ".claude", ".gitconfig", ".ssh", "Documents", "Projects"],
  [`${HOME}/Projects`]: ["Personal", "Work"],
  [`${HOME}/Projects/Personal`]: ["p", "p.worktrees", "other"],
  [`${HOME}/Projects/Personal/p`]: [".git", "src", "node_modules"],
  [`${HOME}/Projects/Personal/p.worktrees`]: ["P-1", "P-2"],
};
const list: ListDir = async (dir) => {
  const names = TREE[dir];
  if (names === undefined) throw new Error(`unexpected listing of ${dir}`);
  return names;
};

const WORKTREE = `${HOME}/Projects/Personal/p.worktrees/P-1`;
const MAIN = `${HOME}/Projects/Personal/p`;

describe("fenceDenyRead", () => {
  it("blocks every child of home that is on no path to a kept path, and descends into the others", async () => {
    const denied = await fenceDenyRead({
      home: HOME,
      keep: [WORKTREE, `${MAIN}/.git`, `${HOME}/.bun`, `${HOME}/.gitconfig`, "/tmp/dipo-s-1"],
      list,
    });
    expect(denied).toEqual([
      `${HOME}/.cache`,
      `${HOME}/.claude`,
      `${HOME}/.ssh`,
      `${HOME}/Documents`,
      `${HOME}/Projects/Personal/other`,
      `${HOME}/Projects/Personal/p.worktrees/P-2`,
      `${HOME}/Projects/Personal/p/node_modules`,
      `${HOME}/Projects/Personal/p/src`,
      `${HOME}/Projects/Work`,
    ]);
  });

  it("never denies a path that covers a kept path", async () => {
    const keep = [WORKTREE, `${MAIN}/.git`, `${HOME}/.bun`];
    const denied = await fenceDenyRead({ home: HOME, keep, list });
    expect(
      coveringDenies(
        denied,
        keep.map((path) => ({ label: "kept path", spellings: [path] })),
      ),
    ).toEqual([]);
  });

  it("blocks the home directory itself when nothing under it is kept", async () => {
    expect(await fenceDenyRead({ home: HOME, keep: ["/tmp/x", "/usr/local"], list })).toEqual([
      HOME,
    ]);
  });

  it("blocks nothing when a kept path is home or above it", async () => {
    expect(await fenceDenyRead({ home: HOME, keep: [HOME], list })).toEqual([]);
    expect(await fenceDenyRead({ home: HOME, keep: ["/home"], list })).toEqual([]);
  });

  it("reads real directories", async () => {
    await withTempDir(async (dir) => {
      mkdirSync(join(dir, "a/work"), { recursive: true });
      mkdirSync(join(dir, "a/secret"));
      mkdirSync(join(dir, "b"));
      writeFileSync(join(dir, "note.txt"), "x");
      expect(
        await fenceDenyRead({ home: dir, keep: [join(dir, "a/work")], list: listDirOnDisk }),
      ).toEqual([join(dir, "a/secret"), join(dir, "b"), join(dir, "note.txt")]);
    });
  });
});

describe("workerReadPaths", () => {
  it("adds the worktree, temp root, main .git and git configuration to the configured paths", () => {
    expect(
      workerReadPaths({
        home: HOME,
        worktree: WORKTREE,
        mainCheckout: MAIN,
        tempRoot: "/tmp/dipo-s-1",
        configured: ["~/.bun", "/opt/node", "~/.bun"],
      }),
    ).toEqual([
      WORKTREE,
      "/tmp/dipo-s-1",
      `${MAIN}/.git`,
      `${HOME}/.gitconfig`,
      `${HOME}/.config/git`,
      `${HOME}/.bun`,
      "/opt/node",
    ]);
  });
});

function recordingHost(policies: SrtSettings[]): SandboxHost {
  const child: ChildProcess = {
    pid: 1,
    stdin: null,
    stdout: new ReadableStream({ start: (c) => c.close() }),
    stderr: new ReadableStream({ start: (c) => c.close() }),
    exited: Promise.resolve({ code: 0, signal: null }),
    kill: () => undefined,
  };
  return {
    dipoDirs: async () => [`${HOME}/.local/state/dipo`],
    resolveTools: async () => ({ rg: "/usr/bin/rg", bwrap: null, socat: null }),
    trustCheck: async () => [],
    probe: async () => ({ ok: true }),
    readRefusal: async () => null,
    createTempRoot: async () => "/tmp/dipo-s-test01",
    removeTempRoot: async () => undefined,
    writePolicy: async (root, settings) => {
      policies.push(settings);
      return `${root}.policy.json`;
    },
    start: () => child,
  };
}

const REQUEST: StepRequest = {
  kind: "verify",
  script: "verify",
  command: ["bun", "run", "verify"],
  worktree: WORKTREE,
  mainCheckout: MAIN,
  home: HOME,
  uid: 501,
  sandbox: { installCachePaths: [], registryHosts: [] },
  scriptMinutes: { verify: 20 },
  env: { PATH: "/usr/bin:/bin", HOME },
};

describe("a step under the read fence", () => {
  it("adds the fence's denies to the policy, and only when the request asks for it", async () => {
    const policies: SrtSettings[] = [];
    const deps = {
      clock: new ManualClock(),
      platform: "darwin" as const,
      host: recordingHost(policies),
      listDir: list,
    };
    await runSandboxedStep(deps, REQUEST);
    await runSandboxedStep(deps, { ...REQUEST, readFence: { readPaths: ["~/.bun", "~/.cache"] } });

    const [plain, fenced] = policies.map((p) => p.filesystem.denyRead);
    expect(plain).not.toContain(`${HOME}/Documents`);
    expect(fenced).toEqual(expect.arrayContaining([`${HOME}/Documents`, `${HOME}/Projects/Work`]));
    expect(fenced).not.toContain(`${HOME}/.bun`);
    expect(fenced).not.toContain(`${HOME}/.cache`);
    expect(fenced).not.toContain(WORKTREE);
    // The usual denies stay.
    for (const path of plain ?? []) expect(fenced).toContain(path);
  });

  it("returns startFailed when the fence cannot be built", async () => {
    const policies: SrtSettings[] = [];
    const result = await runSandboxedStep(
      {
        clock: new ManualClock(),
        platform: "darwin",
        host: recordingHost(policies),
        listDir: async () => {
          throw new Error("EACCES");
        },
      },
      { ...REQUEST, readFence: { readPaths: [] } },
    );
    expect(result).toEqual({
      outcome: "startFailed",
      reason: "could not build the worker read fence: EACCES",
    });
    expect(policies).toEqual([]);
  });
});
