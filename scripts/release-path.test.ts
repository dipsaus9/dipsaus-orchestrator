// DIPO-321: the release path is hardened by settings in the workflows, CODEOWNERS and .gitignore.
// These tests read those files as they are in the repository and fail when a setting is dropped:
// the release build's Bun, the base-branch title check, the workflow linter in `ci-ok`, the code
// owners of the release path, the ignored secret files and the tracked end of each audit ignore.
import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const WORKFLOWS = join(ROOT, ".github/workflows");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

interface Job {
  needs?: string | string[];
  env?: Record<string, unknown>;
  strategy?: { matrix?: { include?: Array<Record<string, unknown>>; runner?: unknown } };
  steps?: Step[];
}

interface Workflow {
  on?: Record<string, unknown>;
  jobs: Record<string, Job>;
}

async function text(path: string): Promise<string> {
  return Bun.file(join(ROOT, path)).text();
}

async function workflow(name: string): Promise<Workflow> {
  return Bun.YAML.parse(await text(`.github/workflows/${name}`)) as Workflow;
}

function job(flow: Workflow, id: string): Job {
  const found = flow.jobs[id];
  if (found === undefined) throw new Error(`no job ${id}`);
  return found;
}

function steps(flow: Workflow, id: string): Step[] {
  return job(flow, id).steps ?? [];
}

const SHA256 = /^[0-9a-f]{64}$/;

function git(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

async function owners(): Promise<Array<[string, string[]]>> {
  return (await text(".github/CODEOWNERS"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const [pattern = "", ...names] = line.split(/\s+/);
      return [pattern, names];
    });
}

/** Last match wins, as on GitHub. Supports only anchored files and directories. */
function ownersOf(rules: Array<[string, string[]]>, path: string): string[] {
  let found: string[] = [];
  for (const [pattern, names] of rules) {
    if (!pattern.startsWith("/") || /[*?[\]!]/.test(pattern)) {
      throw new Error(`unsupported pattern ${pattern}: extend this test first`);
    }
    const anchored = pattern.slice(1);
    const matches = anchored.endsWith("/") ? path.startsWith(anchored) : path === anchored;
    if (matches) found = names;
  }
  return found;
}

/** The `--ignore=` ids and, per id, its comment entry (`# - <id>: ...` up to the next entry). */
function ignores(source: string): { ids: string[]; entries: Map<string, string> } {
  const ids = [...source.matchAll(/--ignore=([A-Za-z0-9-]+)/g)].map((match) => match[1] ?? "");
  const entries = new Map<string, string>();
  let current: string | undefined;
  for (const line of source.split("\n")) {
    const comment = /^\s*#\s?(.*)$/.exec(line);
    if (comment === null) {
      current = undefined;
      continue;
    }
    const body = comment[1] ?? "";
    const start = /^- (GHSA-[a-z0-9-]+|CVE-[0-9-]+):/.exec(body);
    if (start !== null) {
      current = start[1] ?? "";
      entries.set(current, body);
    } else if (current !== undefined) {
      entries.set(current, `${entries.get(current) ?? ""} ${body.trim()}`);
    }
  }
  return { ids, entries };
}

function untracked(source: string): string[] {
  const { ids, entries } = ignores(source);
  return ids.filter((id) => {
    const entry = entries.get(id) ?? "";
    return !/Tracking story: DIPO-\d+\b/.test(entry) || !/Ends with: \S+ \S*\d/.test(entry);
  });
}

describe("darwin-arm64 only (0004, DIPO-358)", () => {
  const DARWIN_ARM64 = {
    target: "darwin-arm64",
    runner: "macos-26",
    file: "Mach-O 64-bit executable arm64",
  };

  it("builds and smoke-tests darwin-arm64 alone in CI and in the release", async () => {
    const ci = job(await workflow("ci.yml"), "smoke").strategy?.matrix?.include ?? [];
    expect(ci).toEqual([DARWIN_ARM64]);
    const release = job(await workflow("release.yml"), "build").strategy?.matrix?.include ?? [];
    expect(release).toHaveLength(1);
    expect(release[0]).toMatchObject(DARWIN_ARM64);
  });

  it("publishes one archive and checks the published install.sh on macOS only", async () => {
    const flow = await workflow("release.yml");
    const sums = steps(flow, "publish").find((step) => step.name === "Write SHA256SUMS");
    expect(sums?.run).toContain(`if [ "$#" -ne 1 ]`);
    expect(job(flow, "post-release").strategy?.matrix?.runner).toEqual(["macos-26"]);
  });

  it("has no Linux-only step left in the smoke action", async () => {
    const action = await text(".github/actions/smoke/action.yml");
    expect(action).not.toContain("GLIBC");
    expect(action).not.toContain("runner.os == 'Linux'");
  });
});

describe("release.yml build (AC #1)", () => {
  const BUN_ASSETS: Record<string, string> = {
    "darwin-arm64": "bun-darwin-aarch64",
  };

  it("uses neither setup-bun nor a cache anywhere in the release workflow", async () => {
    const flow = await workflow("release.yml");
    for (const id of Object.keys(flow.jobs)) {
      for (const step of steps(flow, id)) {
        expect(step.uses ?? "").not.toContain("setup-bun");
        expect(step.uses ?? "").not.toContain("actions/cache");
      }
    }
  });

  it("pins the Bun of .bun-version with a SHA-256 for the darwin-arm64 target", async () => {
    const flow = await workflow("release.yml");
    const build = job(flow, "build");
    expect(String(build.env?.["BUN_VERSION"])).toBe((await text(".bun-version")).trim());
    const include = build.strategy?.matrix?.include ?? [];
    expect(include.map((entry) => entry["target"]).toSorted()).toEqual(
      Object.keys(BUN_ASSETS).toSorted(),
    );
    for (const entry of include) {
      expect(entry["bun-asset"]).toBe(BUN_ASSETS[String(entry["target"])]);
      expect(String(entry["bun-sha256"])).toMatch(SHA256);
    }
    const sums = include.map((entry) => entry["bun-sha256"]);
    expect(new Set(sums).size).toBe(sums.length);
  });

  it("checks the download against the pinned SHA-256 before Bun runs", async () => {
    const flow = await workflow("release.yml");
    const all = steps(flow, "build");
    const install = all.findIndex((step) => step.run?.includes("$BUN_SHA256") === true);
    expect(install).toBeGreaterThan(-1);
    const step = all[install];
    expect(step?.env?.["BUN_SHA256"]).toBe("${{ matrix.bun-sha256 }}");
    const run = step?.run ?? "";
    expect(run).toContain(`[ "$actual" != "$BUN_SHA256" ]`);
    expect(run).toContain(`[ "$pinned" != "$BUN_VERSION" ]`);
    // The check comes before the downloaded Bun is first started.
    expect(run.indexOf("$BUN_SHA256")).toBeLessThan(run.indexOf(`"$dir/$BUN_ASSET/bun"`));
    const firstBun = all.findIndex((s) => /^bun /m.test(s.run ?? ""));
    expect(firstBun).toBeGreaterThan(install);
  });
});

describe("pr-title.yml (AC #4)", () => {
  it("checks out the base branch's commit, so check-pr-title.ts never comes from the PR head", async () => {
    const flow = await workflow("pr-title.yml");
    const all = steps(flow, "pr-title");
    const checkouts = all.filter((step) => step.uses?.startsWith("actions/checkout@") === true);
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]?.with?.["ref"]).toBe("${{ github.event.pull_request.base.sha }}");
    expect(checkouts[0]?.with?.["persist-credentials"]).toBe(false);
    const run = all.findIndex((step) => step.run?.includes("scripts/check-pr-title.ts") === true);
    expect(run).toBeGreaterThan(all.indexOf(checkouts[0]!));
  });

  it("no workflow runs on pull_request_target (0016 rule 1)", async () => {
    for (const name of readdirSync(WORKFLOWS)) {
      const flow = await workflow(name);
      expect(Object.keys(flow.on ?? {})).not.toContain("pull_request_target");
    }
  });
});

describe("ci.yml actionlint (AC #5)", () => {
  it("downloads a pinned actionlint, checks its SHA-256 and lints the workflows", async () => {
    const flow = await workflow("ci.yml");
    const lint = job(flow, "actionlint");
    expect(String(lint.env?.["ACTIONLINT_VERSION"])).toMatch(/^\d+\.\d+\.\d+$/);
    expect(String(lint.env?.["ACTIONLINT_SHA256"])).toMatch(SHA256);
    const runs = (lint.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(runs).toContain(
      "https://github.com/rhysd/actionlint/releases/download/v$ACTIONLINT_VERSION/$archive",
    );
    expect(runs).toContain(`echo "$ACTIONLINT_SHA256  $RUNNER_TEMP/$archive" | sha256sum --check`);
    expect(runs).toMatch(/^\s*"\$RUNNER_TEMP\/actionlint"(?! -version)/m);
  });

  it("is part of ci-ok, which needs every other job in ci.yml", async () => {
    const flow = await workflow("ci.yml");
    const needs = job(flow, "ci-ok").needs;
    expect(Array.isArray(needs) ? needs.toSorted() : [needs]).toEqual(
      Object.keys(flow.jobs)
        .filter((id) => id !== "ci-ok")
        .toSorted(),
    );
  });
});

describe("CODEOWNERS (AC #3)", () => {
  const RELEASE_PATH = [
    ".github/workflows/release.yml",
    ".github/workflows/ci.yml",
    ".github/workflows/pr-title.yml",
    ".github/workflows/audit.yml",
    ".github/actions/smoke/action.yml",
    ".github/CODEOWNERS",
    "install.sh",
    "release-please-config.json",
    ".release-please-manifest.json",
    "renovate.json",
  ];

  it("gives every file of the release path to the maintainer", async () => {
    const rules = await owners();
    for (const path of RELEASE_PATH) expect(ownersOf(rules, path)).toEqual(["@dipsaus9"]);
    for (const path of git(["ls-files", "-z", ".github"]).split("\0").filter(Boolean)) {
      expect(ownersOf(rules, path)).toEqual(["@dipsaus9"]);
    }
  });

  it("leaves story code without a code owner", async () => {
    const rules = await owners();
    expect(ownersOf(rules, "packages/engine/src/index.ts")).toEqual([]);
    expect(ownersOf(rules, "bun.lock")).toEqual([]);
  });
});

describe(".gitignore (AC #7)", () => {
  const SECRETS = [
    ".env",
    ".env.local",
    "packages/daemon/.env.production",
    "dipo-release.2026-10-10.private-key.pem",
    "server.key",
    "AuthKey_ABC123.p8",
    "client.p12",
    "client.pfx",
    "certs/server.crt",
    "certs/server.cer",
    "certs/server.der",
    "release.jks",
    "release.keystore",
    "id_rsa",
    "id_ed25519",
    ".npmrc",
    "packages/tui/.npmrc",
    ".yarnrc",
    ".yarnrc.yml",
  ];

  it("ignores env files, private keys, certificates and npm credential files", () => {
    for (const path of SECRETS) {
      const result = Bun.spawnSync(["git", "check-ignore", "--no-index", "-q", path], {
        cwd: ROOT,
      });
      expect({ path, ignored: result.exitCode === 0 }).toEqual({ path, ignored: true });
    }
  });

  it("does not ignore ordinary repository files", () => {
    for (const path of ["package.json", "install.sh", "docs/release.md", "env.ts", "key.ts"]) {
      const result = Bun.spawnSync(["git", "check-ignore", "--no-index", "-q", path], {
        cwd: ROOT,
      });
      expect({ path, ignored: result.exitCode === 0 }).toEqual({ path, ignored: false });
    }
  });

  it("has no tracked file that an ignore pattern matches", () => {
    expect(git(["ls-files", "--cached", "--ignored", "--exclude-standard"])).toBe("");
  });
});

describe("audit.yml advisory ignores (AC #8)", () => {
  it("names the tracking story and the ending dependency version of every ignore", async () => {
    const source = await text(".github/workflows/audit.yml");
    expect(untracked(source)).toEqual([]);
  });

  it("fails for an ignore without a tracked end", () => {
    // A stand-in entry, since audit.yml may ignore nothing (DIPO-343).
    const source = [
      "      # - GHSA-zzzz-yyyy-xxxx: some-package <=1.0.0.",
      "      #   Tracking story: DIPO-1. Ends with: some-package >1.0.0 in bun.lock.",
      "      run: bun audit --audit-level=high --ignore=GHSA-zzzz-yyyy-xxxx",
    ].join("\n");
    expect(untracked(source)).toEqual([]);
    const added = source.replace("--ignore=", "--ignore=GHSA-aaaa-bbbb-cccc --ignore=");
    expect(untracked(added)).toEqual(["GHSA-aaaa-bbbb-cccc"]);
    const noStory = source.replace(/Tracking story: DIPO-\d+/, "Tracking story: none");
    expect(untracked(noStory)).not.toEqual([]);
    const noEnd = source.replace(/Ends with: \S+ \S+/, "Ends with: later");
    expect(untracked(noEnd)).not.toEqual([]);
  });
});
