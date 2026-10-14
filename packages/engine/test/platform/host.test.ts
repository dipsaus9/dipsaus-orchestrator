// The code host behind `gh` (DIPO-35): the minimum version, the arguments of each call, how a
// missing login is told apart, and remote URL parsing. `gh` is faked through the injected Spawn;
// no test reaches GitHub.

import { describe, expect, it } from "bun:test";

import {
  checkGhVersion,
  CodeHostError,
  compareVersions,
  GhHost,
  MIN_GH_VERSION,
  repoOfRemoteUrl,
} from "../../src/platform/host";
import { scriptedSpawn, type ScriptedReply } from "../backlog/helpers";

const VERSION = `gh version ${MIN_GH_VERSION} (2024-05-29)\nhttps://github.com/cli/cli/releases/tag/v${MIN_GH_VERSION}\n`;

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
