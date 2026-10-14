// The code host behind the GitHub CLI (0010 section 2, 0008 section 2). This file is the only engine
// code that runs `gh`. The engine runs it outside the sandbox with the maintainer's own login;
// workers never get `gh` (0014). `gh` never prompts: prompts, update notices, colour and the pager
// are switched off, and a missing login is reported, not asked for.
//
// `gh --version` is checked against `MIN_GH_VERSION`, the oldest release with every subcommand and
// flag used here; an older `gh` is refused with the version it printed. Used here:
// `pr create --repo --base --head --title --body`, `pr list --head --state --json`, `pr list --state
// --limit --json` (DIPO-80), `pr view --json`,
// `pr edit --title --body`, `pr close --comment`, `pr merge --squash --match-head-commit --subject
// --body`, and `pr checks --required --json name,state,bucket`. The newest of these is
// `pr checks --json`, added in gh 2.50.0 (https://github.com/cli/cli/releases/tag/v2.50.0).

import type { Spawn } from "@dipsaus-orchestrator/contract";

/** The oldest `gh` with every subcommand and flag the engine uses. */
export const MIN_GH_VERSION = "2.50.0";

/** gh's exit code for "authentication required" (`gh help exit-codes`). */
const EXIT_AUTH = 4;
/** gh's exit code of `pr checks` while checks are pending. */
const EXIT_PENDING = 8;

export type CodeHostErrorCode = "missing" | "tooOld" | "unauthenticated" | "failed";

/** A `gh` call that failed; `code` says why. */
export class CodeHostError extends Error {
  constructor(
    readonly code: CodeHostErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CodeHostError";
  }
}

export type PrState = "open" | "closed" | "merged";

/** A pull request as the host reports it. */
export interface HostPr {
  readonly number: number;
  readonly url: string;
  readonly state: PrState;
  /** The head branch. */
  readonly head: string;
  /** The head commit. */
  readonly headSha: string;
  readonly base: string;
  readonly title: string;
  /** The merge commit once merged (a squash, rebase or merge commit), else null. */
  readonly mergeCommit: string | null;
}

export interface NewPr {
  readonly base: string;
  readonly head: string;
  readonly title: string;
  readonly body: string;
}

export type CheckBucket = "pass" | "fail" | "pending" | "skipping" | "cancel";

/** One required check of a pull request. */
export interface RequiredCheck {
  readonly name: string;
  readonly state: string;
  readonly bucket: CheckBucket;
}

/**
 * What the engine asks of the code host. `repo` is `[HOST/]OWNER/REPO`. Every method throws
 * `CodeHostError`.
 */
export interface CodeHost {
  /** Checks `gh --version` against `MIN_GH_VERSION`; returns the version. */
  checkVersion(): Promise<string>;
  /** The open pull request whose head is `branch`, or null. */
  findOpenPr(repo: string, branch: string): Promise<HostPr | null>;
  createPr(repo: string, pr: NewPr): Promise<HostPr>;
  updatePr(repo: string, number: number, change: { title: string; body: string }): Promise<void>;
  viewPr(repo: string, number: number): Promise<HostPr>;
  closePr(repo: string, number: number, comment: string): Promise<void>;
  /** Squash-merges only while the head is still `headSha`. */
  squashMerge(
    repo: string,
    number: number,
    merge: { headSha: string; subject: string },
  ): Promise<void>;
  /** The required checks and their states; empty when the base requires none. */
  requiredChecks(repo: string, number: number): Promise<RequiredCheck[]>;
}

/**
 * The PR state the Done detection reads (DIPO-58; 0010 section 7, "Merge and Done"). Kept apart
 * from `CodeHost` so a code host that only opens and merges PRs need not implement it.
 */
export interface PrStateHost {
  /** The newest merged pull request whose head is `branch`, or null. Throws `CodeHostError`. */
  findMergedPr(repo: string, branch: string): Promise<HostPr | null>;
}

/** How many open pull requests `listOpenPrs` reads at most. */
export const LIST_OPEN_LIMIT = 1000;

/**
 * Lists open PRs by head-branch prefix (DIPO-80): reconcile looks for the office's backlog PR
 * (`dipo/backlog-*`) after a lost database. Kept apart from `CodeHost`, like `PrStateHost`.
 */
export interface PrListHost {
  /**
   * The open pull requests of `repo` whose head branch starts with `prefix` and lives in `repo`
   * itself (not a fork), oldest first. Throws `CodeHostError`.
   */
  listOpenPrs(repo: string, prefix: string): Promise<HostPr[]>;
}

/** `major.minor.patch` compared numerically; negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Checks the output of `gh --version` (`gh version 2.50.0 (2024-05-29)`). Returns the version, or
 * throws `CodeHostError` `tooOld` naming it, or `failed` when no version is printed.
 */
export function checkGhVersion(output: string): string {
  const match = /^gh version (\d+\.\d+\.\d+)\b/m.exec(output);
  if (match?.[1] === undefined) {
    throw new CodeHostError(
      "failed",
      `\`gh --version\` printed ${JSON.stringify(output.trim().split("\n")[0] ?? "")}, not a version; dipo needs gh ${MIN_GH_VERSION} or newer.`,
    );
  }
  const version = match[1];
  if (compareVersions(version, MIN_GH_VERSION) < 0) {
    throw new CodeHostError(
      "tooOld",
      `gh ${version} is older than ${MIN_GH_VERSION}, the oldest gh with every command dipo uses; upgrade gh (https://cli.github.com).`,
    );
  }
  return version;
}

/**
 * The `[HOST/]OWNER/REPO` of a remote URL (`git@github.com:o/r.git`, `ssh://git@github.com/o/r`,
 * `https://github.com/o/r.git`), with the host left out for github.com; null for a local path or
 * any other URL.
 */
export function repoOfRemoteUrl(url: string): string | null {
  const text = url.trim();
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(text);
  const full = /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)$/.exec(text);
  if (full?.[1] !== undefined && full[2] !== undefined) {
    host = full[1];
    path = full[2];
  } else if (scp?.[1] !== undefined && scp[2] !== undefined && !text.includes("://")) {
    host = scp[1];
    path = scp[2];
  } else {
    return null;
  }
  // Trailing slashes by a loop: `/\/+$/` backtracks on many slashes.
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end--;
  const parts = path
    .slice(0, end)
    .replace(/\.git$/, "")
    .split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9._-]+$/.test(part))) return null;
  const repo = parts.join("/");
  return host.toLowerCase() === "github.com" ? repo : `${host}/${repo}`;
}

/** The environment `gh` runs with: the daemon's, without prompts, notices, colour or pager. */
function ghEnv(base: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) if (value !== undefined) env[name] = value;
  return {
    ...env,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    GH_PAGER: "cat",
    GH_SPINNER_DISABLED: "1",
    NO_COLOR: "1",
    CLICOLOR: "0",
  };
}

const PR_FIELDS = "number,url,state,headRefName,headRefOid,baseRefName,title,mergeCommit";

interface PrJson {
  number?: unknown;
  url?: unknown;
  state?: unknown;
  headRefName?: unknown;
  headRefOid?: unknown;
  baseRefName?: unknown;
  title?: unknown;
  mergeCommit?: unknown;
}

/** The `oid` of gh's `mergeCommit` object, or null. */
function mergeOid(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const oid = (value as { oid?: unknown }).oid;
  return typeof oid === "string" && oid !== "" ? oid : null;
}

function prOf(json: PrJson): HostPr {
  const state = String(json.state ?? "").toLowerCase();
  if (
    typeof json.number !== "number" ||
    typeof json.url !== "string" ||
    (state !== "open" && state !== "closed" && state !== "merged")
  ) {
    throw new CodeHostError(
      "failed",
      `gh printed a pull request dipo cannot read: ${JSON.stringify(json)}`,
    );
  }
  return {
    number: json.number,
    url: json.url,
    state,
    head: String(json.headRefName ?? ""),
    headSha: String(json.headRefOid ?? ""),
    base: String(json.baseRefName ?? ""),
    title: String(json.title ?? ""),
    mergeCommit: mergeOid(json.mergeCommit),
  };
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CodeHostError(
      "failed",
      `gh printed ${what} that is not JSON: ${text.trim().slice(0, 200)}`,
    );
  }
}

const BUCKETS: ReadonlySet<string> = new Set(["pass", "fail", "pending", "skipping", "cancel"]);

export interface GhHostOptions {
  readonly spawn: Spawn;
  /** The resolved `gh`; `gh` on `PATH` by default. */
  readonly gh?: string;
  /** The environment `gh` starts from; this process's by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface GhResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The `CodeHost` that runs `gh`. */
export class GhHost implements CodeHost, PrStateHost, PrListHost {
  readonly #spawn: Spawn;
  readonly #gh: string;
  readonly #env: Record<string, string>;
  #version: string | null = null;

  constructor(options: GhHostOptions) {
    this.#spawn = options.spawn;
    this.#gh = options.gh ?? "gh";
    this.#env = ghEnv(options.env ?? process.env);
  }

  async checkVersion(): Promise<string> {
    if (this.#version !== null) return this.#version;
    const result = await this.#raw(["--version"]);
    if (result.code !== 0) {
      throw new CodeHostError(
        "failed",
        `\`gh --version\` exited ${result.code}: ${result.stderr.trim()}`,
      );
    }
    this.#version = checkGhVersion(result.stdout);
    return this.#version;
  }

  async findOpenPr(repo: string, branch: string): Promise<HostPr | null> {
    const out = await this.#ok([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      PR_FIELDS,
    ]);
    const list = parseJson(out, "a pull request list");
    if (!Array.isArray(list)) throw new CodeHostError("failed", "gh printed no pull request list");
    const first = list.map((item) => prOf(item as PrJson)).find((pr) => pr.head === branch);
    return first ?? null;
  }

  async findMergedPr(repo: string, branch: string): Promise<HostPr | null> {
    const out = await this.#ok([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branch,
      "--state",
      "merged",
      "--json",
      PR_FIELDS,
    ]);
    const list = parseJson(out, "a pull request list");
    if (!Array.isArray(list)) throw new CodeHostError("failed", "gh printed no pull request list");
    // gh lists the newest first.
    const first = list.map((item) => prOf(item as PrJson)).find((pr) => pr.head === branch);
    return first ?? null;
  }

  async listOpenPrs(repo: string, prefix: string): Promise<HostPr[]> {
    const out = await this.#ok([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      String(LIST_OPEN_LIMIT),
      "--json",
      `${PR_FIELDS},isCrossRepository`,
    ]);
    const list = parseJson(out, "a pull request list");
    if (!Array.isArray(list)) throw new CodeHostError("failed", "gh printed no pull request list");
    return list
      .filter((item) => (item as { isCrossRepository?: unknown }).isCrossRepository !== true)
      .map((item) => prOf(item as PrJson))
      .filter((pr) => pr.state === "open" && pr.head.startsWith(prefix))
      .toSorted((a, b) => a.number - b.number);
  }

  async createPr(repo: string, pr: NewPr): Promise<HostPr> {
    const out = await this.#ok([
      "pr",
      "create",
      "--repo",
      repo,
      "--base",
      pr.base,
      "--head",
      pr.head,
      "--title",
      pr.title,
      "--body",
      pr.body,
    ]);
    const url = out
      .split("\n")
      .map((line) => line.trim())
      .findLast((line) => /\/pull\/\d+$/.test(line));
    const number = Number(/\/pull\/(\d+)$/.exec(url ?? "")?.[1]);
    if (!Number.isInteger(number) || number <= 0) {
      throw new CodeHostError(
        "failed",
        `\`gh pr create\` printed no pull request URL: ${out.trim()}`,
      );
    }
    return this.viewPr(repo, number);
  }

  async updatePr(
    repo: string,
    number: number,
    change: { title: string; body: string },
  ): Promise<void> {
    await this.#ok([
      "pr",
      "edit",
      String(number),
      "--repo",
      repo,
      "--title",
      change.title,
      "--body",
      change.body,
    ]);
  }

  async viewPr(repo: string, number: number): Promise<HostPr> {
    const out = await this.#ok(["pr", "view", String(number), "--repo", repo, "--json", PR_FIELDS]);
    return prOf(parseJson(out, "a pull request") as PrJson);
  }

  async closePr(repo: string, number: number, comment: string): Promise<void> {
    await this.#ok(["pr", "close", String(number), "--repo", repo, "--comment", comment]);
  }

  async squashMerge(
    repo: string,
    number: number,
    merge: { headSha: string; subject: string },
  ): Promise<void> {
    await this.#ok([
      "pr",
      "merge",
      String(number),
      "--repo",
      repo,
      "--squash",
      "--match-head-commit",
      merge.headSha,
      "--subject",
      merge.subject,
      "--body",
      "",
    ]);
  }

  async requiredChecks(repo: string, number: number): Promise<RequiredCheck[]> {
    await this.checkVersion();
    const result = await this.#raw([
      "pr",
      "checks",
      String(number),
      "--repo",
      repo,
      "--required",
      "--json",
      "name,state,bucket",
    ]);
    this.#assertAuth(result);
    // `pr checks` exits 1 when a check failed and 8 while one is pending, and still prints them.
    if (result.stdout.trim().startsWith("[")) {
      const list = parseJson(result.stdout, "a check list");
      if (!Array.isArray(list)) throw new CodeHostError("failed", "gh printed no check list");
      return list.map((item) => {
        const check = item as { name?: unknown; state?: unknown; bucket?: unknown };
        const bucket = String(check.bucket ?? "");
        return {
          name: String(check.name ?? ""),
          state: String(check.state ?? ""),
          bucket: (BUCKETS.has(bucket) ? bucket : "pending") as CheckBucket,
        };
      });
    }
    if (/no (required )?checks reported/i.test(result.stderr)) return [];
    if (result.code === 0 || result.code === EXIT_PENDING) return [];
    throw this.#failure(["pr", "checks"], result);
  }

  // ---- running gh ------------------------------------------------------------------------------

  /** Runs `gh <args>` after the version check; a non-zero exit throws. Returns stdout. */
  async #ok(args: readonly string[]): Promise<string> {
    await this.checkVersion();
    const result = await this.#raw(args);
    this.#assertAuth(result);
    if (result.code !== 0) throw this.#failure(args.slice(0, 2), result);
    return result.stdout;
  }

  #assertAuth(result: GhResult): void {
    if (
      result.code === EXIT_AUTH ||
      /gh auth login|not logged in|authentication required/i.test(result.stderr)
    ) {
      throw new CodeHostError(
        "unauthenticated",
        "gh is not logged in; run `gh auth login` so dipo can open the backlog PR.",
      );
    }
  }

  #failure(args: readonly string[], result: GhResult): CodeHostError {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    return new CodeHostError("failed", `\`gh ${args.join(" ")}\` failed: ${detail}`);
  }

  async #raw(args: readonly string[]): Promise<GhResult> {
    let child;
    try {
      child = this.#spawn({ cmd: [this.#gh, ...args], env: this.#env });
    } catch (error) {
      throw new CodeHostError(
        "missing",
        `gh could not start (${error instanceof Error ? error.message : String(error)}); install gh ${MIN_GH_VERSION} or newer (https://cli.github.com).`,
      );
    }
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code: exit.code, stdout, stderr };
  }
}
