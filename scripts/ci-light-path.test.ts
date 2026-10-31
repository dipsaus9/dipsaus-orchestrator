// The light CI path of backlog-only PRs (0016, DIPO-341), read from ci.yml as it is in the
// repository. The `changes` step and the `ci-ok` step run here as written, with bash and jq: the
// changes job finds a PR that changes only regular Backlog files from GitHub's merge commit, and
// ci-ok passes that PR with its heavy jobs skipped, and fails a job that failed, or was skipped for
// any other reason.

import { describe, expect, it } from "bun:test";
import { chmodSync, readFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";

import { type TempRepo, withTempRepo } from "../packages/testkit/src/index";
import { SHARD_RUN } from "./test-shards";

const ROOT = resolve(import.meta.dir, "..");

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface Job {
  needs?: string | string[];
  if?: string;
  "runs-on"?: string;
  env?: Record<string, string>;
  strategy?: { "fail-fast"?: boolean; matrix?: { shard?: number[] } };
  steps?: Step[];
}

const flow = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")) as {
  jobs: Record<string, Job>;
};

function job(id: string): Job {
  const found = flow.jobs[id];
  if (found === undefined) throw new Error(`no job ${id}`);
  return found;
}

function needs(id: string): string[] {
  const list = job(id).needs ?? [];
  return Array.isArray(list) ? list : [list];
}

function script(jobId: string, match: (step: Step) => boolean): string {
  const run = job(jobId).steps?.find(match)?.run;
  if (run === undefined) throw new Error(`no such step in ${jobId}`);
  return run;
}

/** Runs `run` as GitHub Actions runs a bash step. */
function bash(run: string, env: Record<string, string>, cwd = ROOT) {
  const result = Bun.spawnSync(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", run], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, out: `${result.stdout.toString()}${result.stderr.toString()}` };
}

const HEAVY = [
  "checks",
  "test-shards",
  "verify",
  "verify-macos",
  "shellcheck",
  "actionlint",
  "dependency-review",
  "smoke",
];

describe("ci.yml light path: the jobs", () => {
  it("skips every heavy job when the changes job finds a backlog-only PR", () => {
    for (const id of HEAVY) {
      expect(needs(id)).toContain("changes");
      expect(job(id).if ?? "").toContain("needs.changes.outputs.scope != 'backlog-only'");
    }
    expect(job("dependency-review").if).toBe(
      "github.event_name == 'pull_request' && needs.changes.outputs.scope != 'backlog-only'",
    );
  });

  it("leaves no other job to skip on the light path, and ci-ok needs ready-gate", () => {
    const others = Object.keys(flow.jobs).filter(
      (id) => !HEAVY.includes(id) && id !== "ci-ok" && id !== "changes",
    );
    expect(others).toEqual(["ready-gate"]);
    expect(job("ready-gate").if).toBeUndefined();
    expect(needs("ci-ok")).toEqual(expect.arrayContaining(["changes", "ready-gate", ...HEAVY]));
  });

  it("runs the Ready gate always and the structural check only on a backlog-only PR", () => {
    const steps = job("ready-gate").steps ?? [];
    const gate = steps.find((step) => step.run === "bun scripts/check-ready-gate.ts");
    expect(gate?.if).toBeUndefined();
    const structural = steps.find((step) =>
      step.run?.startsWith("bun scripts/check-backlog-pr.ts"),
    );
    expect(structural?.run).toBe("bun scripts/check-backlog-pr.ts HEAD^1 HEAD");
    expect(structural?.if).toBe("needs.changes.outputs.scope == 'backlog-only'");
  });

  it("checks out the base and the PR head next to the merge commit in both jobs", () => {
    for (const id of ["changes", "ready-gate"]) {
      const checkout = job(id).steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
      expect(checkout?.with).toEqual({ "persist-credentials": false, "fetch-depth": 2 });
    }
  });
});

describe("ci.yml test shards (DIPO-406)", () => {
  it("runs format, lint and typecheck once, in the checks job", () => {
    const runs = (job("checks").steps ?? []).map((step) => step.run).filter(Boolean);
    expect(runs).toEqual(["bun install --frozen-lockfile", "bun run check"]);
    expect(job("checks")["runs-on"]).toBe("ubuntu-24.04");
  });

  it("runs the coverage check in the test-shards job", () => {
    const runs = (job("test-shards").steps ?? []).map((step) => step.run).filter(Boolean);
    expect(runs).toEqual(["bun scripts/test-shards.ts check"]);
  });

  it("keeps verify and verify-macos as matrices of at least three shards that run only bun test", () => {
    for (const [id, runner] of [
      ["verify", "ubuntu-24.04"],
      ["verify-macos", "macos-26"],
    ] as const) {
      const sharded = job(id);
      expect(sharded["runs-on"]).toBe(runner);
      expect(sharded.strategy?.["fail-fast"]).toBe(false);
      const shards = sharded.strategy?.matrix?.shard ?? [];
      expect(shards.length).toBeGreaterThanOrEqual(3);
      expect(shards).toEqual(shards.map((_, i) => i + 1));
      expect(sharded.env).toEqual({ DIPO_TEST_CI: "1" });
      const runs = (sharded.steps ?? []).map((step) => step.run).filter(Boolean);
      expect(runs).toEqual([
        "bun install --frozen-lockfile",
        'echo "DIPO_TMP=$(mktemp -d /tmp/d.XXXXXX)" >> "$GITHUB_ENV"',
        SHARD_RUN,
      ]);
    }
  });
});

const CHANGES = script("changes", (step) => step.id === "scope");

/** Writes `text` to `path` in the work tree and stages it. */
async function put(repo: TempRepo, path: string, text = "changed\n"): Promise<void> {
  await Bun.write(join(repo.dir, path), text);
  await repo.git("add", "--", path);
}

/**
 * A repository with `main`, a PR branch on which `change` stages its changes, and GitHub's merge
 * commit of that branch checked out after `main` moved on. Returns the PR head.
 */
async function mergeCheckout(
  repo: TempRepo,
  change: (repo: TempRepo) => Promise<unknown>,
): Promise<string> {
  await put(repo, "backlog/config.yml", "project_name: x\n");
  await put(repo, "backlog/tasks/a.md", "a\n");
  await put(repo, "backlog/tasks/gone.md", "gone\n");
  await repo.git("commit", "--quiet", "-m", "base");
  await repo.git("switch", "--quiet", "-c", "pr");
  await change(repo);
  await repo.git("commit", "--quiet", "--allow-empty", "-m", "pr");
  const head = (await repo.git("rev-parse", "HEAD")).trim();
  await repo.git("switch", "--quiet", "main");
  await put(repo, "README.md", "main moved on\n");
  await repo.git("commit", "--quiet", "-m", "main moves");
  await repo.git("merge", "--quiet", "--no-ff", "-m", "merge", "pr");
  return head;
}

async function scope(repo: TempRepo, env: Record<string, string>) {
  const output = join(repo.root, "github-output");
  await Bun.write(output, "");
  const result = bash(CHANGES, { GITHUB_OUTPUT: output, RUNNER_TEMP: repo.root, ...env }, repo.dir);
  return { ...result, output: readFileSync(output, "utf8") };
}

async function prScope(change: (repo: TempRepo) => Promise<unknown>): Promise<string> {
  return withTempRepo(async (repo) => {
    const head = await mergeCheckout(repo, change);
    const result = await scope(repo, { EVENT: "pull_request", PR_HEAD: head });
    expect(result.code).toBe(0);
    return result.output;
  });
}

async function symlink(repo: TempRepo): Promise<void> {
  symlinkSync("../README.md", join(repo.dir, "backlog/tasks/link.md"));
  await repo.git("add", "--", "backlog/tasks/link.md");
}
async function executable(repo: TempRepo): Promise<void> {
  chmodSync(join(repo.dir, "backlog/tasks/a.md"), 0o755);
  await repo.git("add", "--", "backlog/tasks/a.md");
}
async function submodule(repo: TempRepo): Promise<void> {
  const sha = (await repo.git("rev-parse", "HEAD")).trim();
  await repo.git("update-index", "--add", "--cacheinfo", `160000,${sha},backlog/sub.md`);
}

describe("ci.yml light path: the changes job", () => {
  it("is decided in ci.yml with git and the shell, never by a script of the checkout", () => {
    expect(CHANGES).not.toMatch(/\bbun\b|scripts\//);
    expect(job("changes").steps?.some((step) => step.uses?.startsWith("oven-sh/"))).toBe(false);
  });

  it("finds a PR that changes only Backlog files, although the base changed more", async () => {
    const output = await prScope(async (repo) => {
      await put(repo, "backlog/tasks/a.md");
      await put(repo, "backlog/tasks/task-2 - With spaces.md");
      await put(repo, "backlog/tasks/odd\nname.md");
      await put(repo, "backlog/config.yml", "project_name: y\n");
      await repo.git("rm", "--quiet", "backlog/tasks/gone.md");
    });
    expect(output).toBe("scope=backlog-only\n");
  });

  it("runs everything for a PR that changes a path outside backlog/", async () => {
    expect(await prScope((repo) => put(repo, "scripts/x.ts"))).toBe("scope=full\n");
    // A newline in the path does not make it look like a backlog/ path.
    expect(await prScope((repo) => put(repo, "x\nbacklog/a.md"))).toBe("scope=full\n");
  });

  it("runs everything for a file under backlog/ that is not a .md file or backlog/config.yml", async () => {
    expect(await prScope((repo) => put(repo, "backlog/x.test.ts"))).toBe("scope=full\n");
    expect(await prScope((repo) => put(repo, "backlog/config.yaml"))).toBe("scope=full\n");
  });

  it("runs everything for a symlink, an executable or a submodule under backlog/", async () => {
    expect(await prScope(symlink)).toBe("scope=full\n");
    expect(await prScope(executable)).toBe("scope=full\n");
    expect(await prScope(submodule)).toBe("scope=full\n");
  });

  it("runs everything for a PR that changes nothing", async () => {
    expect(await prScope(async () => {})).toBe("scope=full\n");
  });

  it("runs everything on a push", async () => {
    await withTempRepo(async (repo) => {
      await mergeCheckout(repo, (r) => put(r, "backlog/tasks/a.md"));
      expect((await scope(repo, { EVENT: "push", PR_HEAD: "" })).output).toBe("scope=full\n");
    });
  });

  it("fails when the checkout is not the merge commit of the PR head", async () => {
    await withTempRepo(async (repo) => {
      await mergeCheckout(repo, (r) => put(r, "backlog/tasks/a.md"));
      const result = await scope(repo, { EVENT: "pull_request", PR_HEAD: "0".repeat(40) });
      expect(result.code).not.toBe(0);
      expect(result.output).toBe("");
    });
  });
});

const CI_OK = script("ci-ok", (step) => step.run?.includes("Not green") === true);

type Result = "success" | "failure" | "skipped" | "cancelled";

function needsJson(jobs: Record<string, Result>, scopeOut?: string): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(jobs).map(([key, result]) => [
        key,
        { result, outputs: key === "changes" && scopeOut !== undefined ? { scope: scopeOut } : {} },
      ]),
    ),
  );
}

function results(base: Result, overrides: Record<string, Result> = {}): Record<string, Result> {
  return {
    changes: "success",
    "ready-gate": "success",
    ...Object.fromEntries(HEAVY.map((id) => [id, base])),
    ...overrides,
  };
}

function ciOk(event: string, jobs: Record<string, Result>, scopeOut?: string): number | null {
  return bash(CI_OK, { EVENT: event, NEEDS: needsJson(jobs, scopeOut) }).code;
}

describe("ci.yml light path: ci-ok", () => {
  it("passes a backlog-only PR whose heavy jobs were skipped by the changes job", () => {
    expect(ciOk("pull_request", results("skipped"), "backlog-only")).toBe(0);
  });

  it("passes a full PR and a push to main, with dependency-review skipped on the push", () => {
    expect(ciOk("pull_request", results("success"), "full")).toBe(0);
    expect(ciOk("push", results("success", { "dependency-review": "skipped" }), "full")).toBe(0);
  });

  it("fails a backlog-only PR whose ready-gate or changes job did not succeed", () => {
    for (const result of ["failure", "skipped", "cancelled"] as const) {
      expect(
        ciOk("pull_request", results("skipped", { "ready-gate": result }), "backlog-only"),
      ).toBe(1);
      expect(ciOk("pull_request", results("skipped", { changes: result }), "backlog-only")).toBe(1);
    }
  });

  it("fails a backlog-only PR whose heavy job failed or was cancelled", () => {
    for (const id of HEAVY) {
      expect(ciOk("pull_request", results("skipped", { [id]: "failure" }), "backlog-only")).toBe(1);
      expect(ciOk("pull_request", results("skipped", { [id]: "cancelled" }), "backlog-only")).toBe(
        1,
      );
    }
  });

  it("fails a full PR and a push when one shard of verify or verify-macos failed", () => {
    // A matrix job's result in needs is failure when any of its shards failed.
    for (const id of ["verify", "verify-macos"]) {
      expect(ciOk("pull_request", results("success", { [id]: "failure" }), "full")).toBe(1);
      expect(
        ciOk(
          "push",
          results("success", { [id]: "failure", "dependency-review": "skipped" }),
          "full",
        ),
      ).toBe(1);
    }
  });

  it("fails a full PR and a push when one shard of verify or verify-macos was cancelled", () => {
    for (const id of ["verify", "verify-macos"]) {
      expect(ciOk("pull_request", results("success", { [id]: "cancelled" }), "full")).toBe(1);
      expect(
        ciOk(
          "push",
          results("success", { [id]: "cancelled", "dependency-review": "skipped" }),
          "full",
        ),
      ).toBe(1);
    }
  });

  it("fails a full PR whose checks or test-shards job failed, and passes the light path without them", () => {
    for (const id of ["checks", "test-shards"]) {
      for (const result of ["failure", "cancelled", "skipped"] as const) {
        expect(ciOk("pull_request", results("success", { [id]: result }), "full")).toBe(1);
      }
    }
    expect(ciOk("pull_request", results("skipped"), "backlog-only")).toBe(0);
  });

  it("fails a heavy job skipped for any other reason", () => {
    for (const id of HEAVY) {
      // A full PR, or a changes job that failed or gave no scope.
      expect(ciOk("pull_request", results("success", { [id]: "skipped" }), "full")).toBe(1);
      expect(ciOk("pull_request", results("skipped", { changes: "failure" }), "backlog-only")).toBe(
        1,
      );
      expect(ciOk("pull_request", results("success", { [id]: "skipped" }))).toBe(1);
    }
    // On a push nothing but dependency-review may skip, whatever the scope says.
    for (const id of HEAVY.filter((name) => name !== "dependency-review")) {
      expect(ciOk("push", results("success", { [id]: "skipped" }), "backlog-only")).toBe(1);
    }
  });
});
