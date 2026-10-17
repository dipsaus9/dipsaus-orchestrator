// The code host behind `gh` (DIPO-35): the minimum version, the arguments of each call, how a
// missing login is told apart, and remote URL parsing. `gh` is faked through the injected Spawn;
// no test reaches GitHub.

import { describe, expect, it } from "bun:test";

import type { ChildExit, ChildProcess, Spawn } from "@dipsaus-orchestrator/contract";

import {
  actionsJobOf,
  checkGhVersion,
  CodeHostError,
  compareVersions,
  GhHost,
  LIST_OPEN_LIMIT,
  LOG_TAIL_BYTES,
  MIN_GH_VERSION,
  repoOfRemoteUrl,
} from "../../src/platform/host";
import { scriptedSpawn, type ScriptedReply } from "../backlog/helpers";

const VERSION = `gh version ${MIN_GH_VERSION} (2024-05-29)\nhttps://github.com/cli/cli/releases/tag/v${MIN_GH_VERSION}\n`;

const JOB_LINK = "https://github.com/o/r/actions/runs/1/job/2";

const PR_JSON = {
  number: 7,
  url: "https://github.com/o/r/pull/7",
  state: "OPEN",
  headRefName: "dipo/backlog-20260101T000000",
  headRefOid: "a".repeat(40),
  baseRefName: "main",
  title: "chore(backlog): edit TASK-1",
};

function host(reply: (args: readonly string[]) => ScriptedReply) {
  const stub = scriptedSpawn(
    (args) => (args[0] === "--version" ? { stdout: VERSION } : reply(args)),
    ["gh"],
  );
  return { host: new GhHost({ spawn: stub.spawn, gh: "gh", env: { HOME: "/home/x" } }), stub };
}

describe("the gh version check", () => {
  it("accepts the minimum and newer, and refuses an older gh naming its version", () => {
    expect(checkGhVersion(VERSION)).toBe(MIN_GH_VERSION);
    expect(checkGhVersion("gh version 2.101.0 (2026-09-15)\n")).toBe("2.101.0");
    expect(() => checkGhVersion("gh version 2.49.2 (2024-05-13)\n")).toThrow(
      "gh 2.49.2 is older than 2.50.0",
    );
    expect(() => checkGhVersion("hello")).toThrow("not a version");
    expect(compareVersions("2.9.0", "2.50.0")).toBeLessThan(0);
  });

  it("refuses every call with an older gh and runs nothing else", async () => {
    const stub = scriptedSpawn(() => ({ stdout: "gh version 2.40.1 (2023-12-13)\n" }), ["gh"]);
    const gh = new GhHost({ spawn: stub.spawn, env: {} });
    const error = await gh.viewPr("o/r", 7).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CodeHostError);
    expect((error as CodeHostError).code).toBe("tooOld");
    expect((error as CodeHostError).message).toContain("gh 2.40.1");
    expect(stub.calls.map((call) => call.cmd.slice(1))).toEqual([["--version"]]);
  });

  it("reports a gh that cannot start as missing", async () => {
    const gh = new GhHost({
      spawn: () => {
        throw new Error("ENOENT");
      },
      env: {},
    });
    const error = await gh.checkVersion().catch((e: unknown) => e);
    expect((error as CodeHostError).code).toBe("missing");
  });
});

describe("gh calls", () => {
  it("creates a PR with the repo, base, head, title and body, and reads it back", async () => {
    const { host: gh, stub } = host((args) =>
      args[1] === "create"
        ? { stdout: "https://github.com/o/r/pull/7\n" }
        : { stdout: JSON.stringify(PR_JSON) },
    );
    const pr = await gh.createPr("o/r", {
      base: "main",
      head: PR_JSON.headRefName,
      title: PR_JSON.title,
      body: "--body text",
    });
    expect(pr).toEqual({
      number: 7,
      url: PR_JSON.url,
      state: "open",
      head: PR_JSON.headRefName,
      headSha: PR_JSON.headRefOid,
      base: "main",
      title: PR_JSON.title,
      mergeCommit: null,
    });
    const calls = stub.calls.map((call) => call.cmd.slice(1));
    expect(calls[1]).toEqual([
      "pr",
      "create",
      "--repo",
      "o/r",
      "--base",
      "main",
      "--head",
      PR_JSON.headRefName,
      "--title",
      PR_JSON.title,
      "--body",
      "--body text",
    ]);
    expect(calls[2]?.slice(0, 5)).toEqual(["pr", "view", "7", "--repo", "o/r"]);
    // gh never prompts, and the daemon's environment is kept.
    expect(stub.calls[1]?.env).toMatchObject({ HOME: "/home/x", GH_PROMPT_DISABLED: "1" });
  });

  it("edits, closes and squash-merges with the expected flags", async () => {
    const { host: gh, stub } = host(() => ({ stdout: "" }));
    await gh.updatePr("o/r", 7, { title: "t", body: "b" });
    await gh.closePr("o/r", 7, "replaced");
    await gh.squashMerge("o/r", 7, { headSha: "abc", subject: "chore(backlog): x" });
    const calls = stub.calls.map((call) => call.cmd.slice(1)).filter((c) => c[0] === "pr");
    expect(calls).toEqual([
      ["pr", "edit", "7", "--repo", "o/r", "--title", "t", "--body", "b"],
      ["pr", "close", "7", "--repo", "o/r", "--comment", "replaced"],
      [
        "pr",
        "merge",
        "7",
        "--repo",
        "o/r",
        "--squash",
        "--match-head-commit",
        "abc",
        "--subject",
        "chore(backlog): x",
        "--body",
        "",
      ],
    ]);
  });

  it("finds the open PR of a branch, or none", async () => {
    const { host: gh } = host((args) => ({
      stdout: JSON.stringify(args.includes("dipo/none") ? [] : [PR_JSON]),
    }));
    expect((await gh.findOpenPr("o/r", PR_JSON.headRefName))?.number).toBe(7);
    expect(await gh.findOpenPr("o/r", "dipo/none")).toBeNull();
  });

  it("lists the open PRs whose head starts with a prefix, oldest first, without forks (DIPO-80)", async () => {
    const { host: gh, stub } = host(() => ({
      stdout: JSON.stringify([
        { ...PR_JSON, number: 9, headRefName: "dipo/backlog-20260102T000000" },
        { ...PR_JSON, number: 8, headRefName: "TASK-1/x" },
        { ...PR_JSON, number: 6, headRefName: "dipo/backlog-fork", isCrossRepository: true },
        { ...PR_JSON, isCrossRepository: false },
      ]),
    }));
    const prs = await gh.listOpenPrs("o/r", "dipo/backlog-");
    expect(prs.map((pr) => pr.number)).toEqual([7, 9]);
    expect(prs[0]).toMatchObject({ state: "open", head: PR_JSON.headRefName, base: "main" });
    const args = stub.calls.at(-1)?.cmd.slice(1);
    expect(args).toEqual([
      "pr",
      "list",
      "--repo",
      "o/r",
      "--state",
      "open",
      "--limit",
      "1000",
      "--json",
      "number,url,state,headRefName,headRefOid,baseRefName,title,mergeCommit,isCrossRepository",
    ]);
  });

  it("warns when the open PR list reaches its limit, and not below it", async () => {
    const full = Array.from({ length: LIST_OPEN_LIMIT }, (_, i) => ({
      ...PR_JSON,
      number: i + 1,
      headRefName: `TASK-${i + 1}/x`,
    }));
    let answer = full;
    const stub = scriptedSpawn(
      (args) =>
        args[0] === "--version" ? { stdout: VERSION } : { stdout: JSON.stringify(answer) },
      ["gh"],
    );
    const warnings: string[] = [];
    const gh = new GhHost({
      spawn: stub.spawn,
      env: {},
      logger: { warn: (message) => warnings.push(message) },
    });
    expect(await gh.listOpenPrs("o/r", "dipo/backlog-")).toEqual([]);
    expect(warnings).toEqual([
      "the open pull request list reached its limit; later PRs were not read",
    ]);
    answer = full.slice(1);
    await gh.listOpenPrs("o/r", "dipo/backlog-");
    expect(warnings).toHaveLength(1);
  });

  it("finds the newest merged PR of a branch with its merge commit, or none (DIPO-58)", async () => {
    const merged = {
      ...PR_JSON,
      state: "MERGED",
      headRefName: "TASK-1/x",
      mergeCommit: { oid: "b".repeat(40) },
    };
    const { host: gh, stub } = host((args) => ({
      stdout: JSON.stringify(args.includes("TASK-2/y") ? [] : [merged, { ...merged, number: 3 }]),
    }));
    const pr = await gh.findMergedPr("o/r", "TASK-1/x");
    expect(pr).toMatchObject({ number: 7, state: "merged", mergeCommit: "b".repeat(40) });
    expect(await gh.findMergedPr("o/r", "TASK-2/y")).toBeNull();
    expect(stub.calls.at(-1)?.cmd).toEqual(
      expect.arrayContaining(["pr", "list", "--head", "TASK-2/y", "--state", "merged"]),
    );
  });

  it("reads required checks while pending or failed, and none when the base requires none", async () => {
    const checks = [
      { name: "ci-ok", state: "IN_PROGRESS", bucket: "pending" as const },
      { name: "pr-title", state: "SUCCESS", bucket: "pass" as const },
    ];
    const pending = host(() => ({ stdout: JSON.stringify(checks), code: 8 }));
    expect(await pending.host.requiredChecks("o/r", 7)).toEqual(checks);
    const none = host(() => ({ stderr: "no required checks reported on the 'x' branch", code: 1 }));
    expect(await none.host.requiredChecks("o/r", 7)).toEqual([]);
  });

  it("tells a missing login apart from other failures", async () => {
    const auth = host(() => ({
      stderr: "To get started with GitHub CLI, please run:  gh auth login",
      code: 4,
    }));
    const error = await auth.host.viewPr("o/r", 7).catch((e: unknown) => e);
    expect((error as CodeHostError).code).toBe("unauthenticated");
    const other = host(() => ({ stderr: "GraphQL: Could not resolve to a PullRequest", code: 1 }));
    const failed = await other.host.viewPr("o/r", 7).catch((e: unknown) => e);
    expect((failed as CodeHostError).code).toBe("failed");
    expect((failed as CodeHostError).message).toContain("Could not resolve");
  });
});

describe("the review reads and comment (DIPO-141)", () => {
  const checks = [
    { name: "ci-ok", state: "SUCCESS", bucket: "pass" as const, link: JOB_LINK, workflow: "CI" },
    { name: "external", state: "FAILURE", bucket: "fail" as const, link: "", workflow: "" },
  ];

  it("reads the labels of a PR, and every check of its head with link and workflow", async () => {
    const { host: gh, stub } = host((args) => {
      if (args[0] === "pr" && args[1] === "view") {
        return { stdout: JSON.stringify({ labels: [{ name: "autorelease: pending" }] }) };
      }
      return { stdout: JSON.stringify(checks) };
    });
    expect(await gh.prLabels("o/r", 7)).toEqual(["autorelease: pending"]);
    expect(await gh.prChecks("o/r", 7)).toEqual(checks);
    const calls = stub.calls.map((call) => call.cmd.slice(1));
    expect(calls[1]).toEqual(["pr", "view", "7", "--repo", "o/r", "--json", "labels"]);
    expect(calls[2]).toEqual([
      "pr",
      "checks",
      "7",
      "--repo",
      "o/r",
      "--json",
      "name,state,bucket,link,workflow",
    ]);
  });

  it("reads no checks when the PR has none", async () => {
    const { host: gh } = host(() => ({
      stderr: "no checks reported on the 'x' branch",
      code: 1,
    }));
    expect(await gh.prChecks("o/r", 7)).toEqual([]);
  });

  it("returns the URL a posted comment has", async () => {
    const { host: gh, stub } = host(() => ({
      stdout: "https://github.com/o/r/pull/7#issuecomment-123\n",
    }));
    expect(await gh.commentPr("o/r", 7, "Review: approved")).toBe(
      "https://github.com/o/r/pull/7#issuecomment-123",
    );
    expect(stub.calls.at(-1)?.cmd.slice(1)).toEqual([
      "pr",
      "comment",
      "7",
      "--repo",
      "o/r",
      "--body",
      "Review: approved",
    ]);
  });

  it("reads the failed-job log of an Actions job link, with the job id", async () => {
    const { host: gh, stub } = host(() => ({ stdout: "step failed\n" }));
    expect(await gh.failedJobLog("o/r", JOB_LINK)).toBe("step failed\n");
    expect(stub.calls.at(-1)?.cmd.slice(1)).toEqual([
      "run",
      "view",
      "--repo",
      "o/r",
      "--job",
      "2",
      "--log-failed",
    ]);
  });

  it("reads no log for a link that is not an Actions job, and runs nothing", async () => {
    const { host: gh, stub } = host(() => ({ stdout: "" }));
    expect(await gh.failedJobLog("o/r", "https://ci.example.com/build/9")).toBeNull();
    expect(await gh.failedJobLog("o/r", "https://github.com/o/r/actions/runs/1")).toBeNull();
    expect(actionsJobOf(JOB_LINK)).toBe("2");
    expect(stub.calls).toEqual([]);
  });

  it("keeps only the last 1 MiB of a failed-job log", async () => {
    const encoder = new TextEncoder();
    const parts = [
      encoder.encode("a".repeat(LOG_TAIL_BYTES + 512 * 1024)),
      encoder.encode("x".repeat(100 * 1024)),
      encoder.encode("END"),
    ];
    const stub = byteSpawn(parts);
    const gh = new GhHost({ spawn: stub, env: {} });
    const log = await gh.failedJobLog("o/r", JOB_LINK);
    expect(log).toHaveLength(LOG_TAIL_BYTES);
    expect(log?.endsWith("x".repeat(100 * 1024) + "END")).toBe(true);
  });

  it("stops a failed-job log read that runs past its timeout", async () => {
    const kills: string[] = [];
    const spawn: Spawn = (options) => {
      if (options.cmd[1] === "--version") return textChild(VERSION);
      // Neither output ends nor does the child exit: only the timeout ends this read.
      return {
        pid: 4242,
        stdin: null,
        stdout: new ReadableStream<Uint8Array>(),
        stderr: new ReadableStream<Uint8Array>(),
        exited: new Promise<ChildExit>(() => {}),
        kill: (signal) => kills.push(signal ?? "SIGTERM"),
      };
    };
    const gh = new GhHost({ spawn, env: {}, logTimeoutMs: 20 });
    const error = await gh.failedJobLog("o/r", JOB_LINK).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CodeHostError);
    expect((error as CodeHostError).code).toBe("failed");
    expect((error as CodeHostError).message).toContain("did not finish within 0.02 seconds");
    expect(kills).toEqual(["SIGKILL"]);
  });

  it("never builds a gh command that names deployments or environments", async () => {
    const { host: gh, stub } = host((args) => {
      if (args[0] === "run") return { stdout: "log\n" };
      if (args[1] === "comment")
        return { stdout: "https://github.com/o/r/pull/7#issuecomment-1\n" };
      if (args[1] === "checks") return { stdout: JSON.stringify(checks) };
      return { stdout: JSON.stringify({ labels: [{ name: "autorelease: pending" }] }) };
    });
    await gh.prLabels("o/r", 7);
    await gh.prChecks("o/r", 7);
    await gh.failedJobLog("o/r", JOB_LINK);
    await gh.commentPr("o/r", 7, "Review: approved");
    const argvs = stub.calls.map((call) => call.cmd.slice(1));
    expect(argvs.map((argv) => argv.slice(0, 2).join(" "))).toEqual([
      "--version",
      "pr view",
      "pr checks",
      "run view",
      "pr comment",
    ]);
    for (const argv of argvs) {
      expect(argv.join(" ")).not.toMatch(/deployment|environment/i);
    }
  });
});

/** A child whose stdout yields `parts` as they are, then ends; it exits 0. */
function byteSpawn(parts: readonly Uint8Array[]): Spawn {
  return (options) => {
    if (options.cmd[1] === "--version") return textChild(VERSION);
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    });
    return {
      pid: 4242,
      stdin: null,
      stdout,
      stderr: new Response("").body ?? new ReadableStream<Uint8Array>(),
      exited: Promise.resolve({ code: 0, signal: null }),
      kill: () => {},
    };
  };
}

function textChild(stdout: string): ChildProcess {
  return {
    pid: 4242,
    stdin: null,
    stdout: new Response(stdout).body ?? new ReadableStream<Uint8Array>(),
    stderr: new Response("").body ?? new ReadableStream<Uint8Array>(),
    exited: Promise.resolve({ code: 0, signal: null }),
    kill: () => {},
  };
}

describe("repoOfRemoteUrl", () => {
  it("reads GitHub remotes in every form and refuses local paths", () => {
    expect(repoOfRemoteUrl("git@github.com:o/r.git")).toBe("o/r");
    expect(repoOfRemoteUrl("https://github.com/o/r.git")).toBe("o/r");
    expect(repoOfRemoteUrl("https://github.com/o/r")).toBe("o/r");
    expect(repoOfRemoteUrl("ssh://git@github.com/o/r.git")).toBe("o/r");
    expect(repoOfRemoteUrl("https://ghe.example.com/o/r.git")).toBe("ghe.example.com/o/r");
    expect(repoOfRemoteUrl("/tmp/remote.git")).toBeNull();
    expect(repoOfRemoteUrl("file:///tmp/remote.git")).toBeNull();
  });
});
