// The code host behind the GitHub CLI (0010 section 2, 0008 section 2). This file is the only engine
// code that runs `gh`. The engine runs it outside the sandbox with the maintainer's own login;
// workers never get `gh` (0014). `gh` never prompts: prompts, update notices, colour and the pager
// are switched off, and a missing login is reported, not asked for.
//
// `gh --version` is checked against `MIN_GH_VERSION`, the oldest release with every subcommand and
// flag used here; an older `gh` is refused with the version it printed. Used here:
// `pr create --repo --base --head --title --body`, `pr list --head --state --json`, `pr list --state
// --limit --json` (DIPO-80), `pr view --json`,
// `pr edit --title --body`, `pr close --comment`, and `pr checks --required --json name,state,bucket`.
// The auto-merge (0002) adds `pr merge --auto --squash --match-head-commit --subject --body`,
// `pr merge --disable-auto`, `pr view --json mergeable,autoMergeRequest` and, for the base's
// required checks, `api repos/<repo>/branches/<base>` and `api repos/<repo>/rules/branches/<base>`.
// dipo never passes `--admin`. The review reads and comments
// (DIPO-141) add `pr view --json labels`, `pr checks --json name,state,bucket,link,workflow`,
// `run view --repo --job --log-failed` and `pr comment --repo --body-file -`. The newest of these is
// `pr checks --json`, added in gh 2.50.0 (https://github.com/cli/cli/releases/tag/v2.50.0).
//
// Every `gh` call has a deadline on the engine clock (DIPO-314; `CALL_DEADLINE_MS`, 60 s, by
// default): `gh` starts in its own process group, and past the deadline the group is killed and
// the call throws `CodeHostError` with code `timedOut`, naming the command and the deadline. A
// failed-job log read (`#tailRun`) keeps its own, longer deadline (`LOG_TIMEOUT_MS`).

import type { ChildProcess, Clock, Spawn } from "@dipsaus-orchestrator/contract";

import { systemClock } from "./clock";
import {
  CALL_DEADLINE_MS,
  killChildGroup,
  timedOutText,
  trackEngineCall,
  withDeadline,
} from "./deadline";

/** The oldest `gh` with every subcommand and flag the engine uses. */
export const MIN_GH_VERSION = "2.50.0";

/** gh's exit code for "authentication required" (`gh help exit-codes`). */
const EXIT_AUTH = 4;
/** gh's exit code of `pr checks` while checks are pending. */
const EXIT_PENDING = 8;

export type CodeHostErrorCode = "missing" | "tooOld" | "unauthenticated" | "failed" | "timedOut";

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
  /**
   * Whether GitHub can merge the PR: `conflicting` when the base conflicts with it, `unknown` while
   * GitHub computes it. Read by `viewPr` only; absent where a host does not report it.
   */
  readonly mergeable?: Mergeable;
  /** True while auto-merge is on for the PR. Read by `viewPr` only. */
  readonly autoMerge?: boolean;
}

export type Mergeable = "mergeable" | "conflicting" | "unknown";

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

/**
 * GitHub's auto-merge and the base's required checks (0002). Kept apart from `CodeHost`, like
 * `PrStateHost`. Nothing here bypasses a rule of the base: no `--admin`.
 */
export interface AutoMergeHost {
  /**
   * `gh pr merge --auto --squash --match-head-commit <headSha>`: GitHub squash-merges the PR, with
   * `subject` and an empty body, once the base's required checks pass on exactly that head.
   * Throws `CodeHostError`.
   */
  enableAutoMerge(
    repo: string,
    number: number,
    merge: { readonly headSha: string; readonly subject: string },
  ): Promise<void>;
  /** `gh pr merge --disable-auto`. Throws `CodeHostError`. */
  disableAutoMerge(repo: string, number: number): Promise<void>;
  /**
   * The names of the checks the base branch requires, from its branch protection and its rulesets,
   * sorted and without duplicates; empty when it requires none. Throws `CodeHostError`.
   */
  requiredCheckNames(repo: string, base: string): Promise<string[]>;
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

/** The most output of a failed job's log that is kept: its last 1 MiB (DIPO-141). */
export const LOG_TAIL_BYTES = 1024 * 1024;
/** How long `gh run view --log-failed` may run before it is stopped (DIPO-141). */
export const LOG_TIMEOUT_MS = 60_000;

/** One check of a pull request's head, with the link and workflow `gh` reports for it. */
export interface PrCheck extends RequiredCheck {
  /** The check's link: an Actions job page, another URL, or "" when there is none. */
  readonly link: string;
  /** The workflow's name, or "" for a check that is not a workflow run. */
  readonly workflow: string;
}

/**
 * What the review loop and the autorelease guard read and write on a Pull request (DIPO-141;
 * 0019 section 7 and fact 3). Kept apart from `CodeHost`, like `PrStateHost`, so the `CodeHost`
 * fakes stay as they are. It has no call to deployments or environments.
 */
export interface PrReviewHost {
  /** The label names of a pull request. Throws `CodeHostError`. */
  prLabels(repo: string, number: number): Promise<string[]>;
  /** Every check of the pull request's head, required or not. Throws `CodeHostError`. */
  prChecks(repo: string, number: number): Promise<PrCheck[]>;
  /**
   * The last `LOG_TAIL_BYTES` of the failed-step log of a GitHub Actions job of `repo`, read from
   * its check `link`; null for any other link, which is not read. Throws `CodeHostError`, also when `gh`
   * runs past `LOG_TIMEOUT_MS`.
   */
  failedJobLog(repo: string, link: string): Promise<string | null>;
  /** Posts `body` as a comment on a pull request and returns the comment's URL. Throws `CodeHostError`. */
  commentPr(repo: string, number: number, body: string): Promise<string>;
}

/**
 * The job id of a GitHub Actions job link of `repo`
 * (`https://github.com/OWNER/REPO/actions/runs/RUN/job/JOB`, then nothing or `/`, `?` or `#`),
 * or null. `OWNER/REPO` must equal `repo`, compared case-insensitively; any other host, scheme,
 * path or repository gives null, so `gh` never reads a link it was not meant to.
 */
export function actionsJobOf(repo: string, link: string): string | null {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/actions\/runs\/\d+\/job\/(\d+)(?:[/?#]|$)/.exec(
      link.trim(),
    );
  if (match?.[1] === undefined || match[1].toLowerCase() !== repo.toLowerCase()) return null;
  return match[2] ?? null;
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
/** What `viewPr` reads besides `PR_FIELDS`: the merge state and auto-merge (0002). */
const VIEW_FIELDS = `${PR_FIELDS},mergeable,autoMergeRequest`;

interface PrJson {
  number?: unknown;
  url?: unknown;
  state?: unknown;
  headRefName?: unknown;
  headRefOid?: unknown;
  baseRefName?: unknown;
  title?: unknown;
  mergeCommit?: unknown;
  mergeable?: unknown;
  autoMergeRequest?: unknown;
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
    ...("mergeable" in json ? { mergeable: mergeableOf(json.mergeable) } : {}),
    ...("autoMergeRequest" in json
      ? { autoMerge: typeof json.autoMergeRequest === "object" && json.autoMergeRequest !== null }
      : {}),
  };
}

/** gh's `mergeable` (`MERGEABLE`, `CONFLICTING`, `UNKNOWN`). */
function mergeableOf(value: unknown): Mergeable {
  const text = String(value ?? "").toLowerCase();
  return text === "mergeable" || text === "conflicting" ? text : "unknown";
}

/** `--hostname` for a `[HOST/]OWNER/REPO` on another host than github.com, and the `OWNER/REPO`. */
function apiTarget(repo: string): { readonly flags: string[]; readonly path: string } {
  const parts = repo.split("/");
  return parts.length === 3
    ? { flags: ["--hostname", parts[0] as string], path: parts.slice(1).join("/") }
    : { flags: [], path: repo };
}

/** The check names a branch's protection requires (`GET /repos/{o}/{r}/branches/{b}`). */
function protectionChecks(json: unknown): string[] {
  const checks = (json as { protection?: { required_status_checks?: unknown } } | null)?.protection
    ?.required_status_checks as { contexts?: unknown; checks?: unknown } | undefined;
  const contexts = Array.isArray(checks?.contexts) ? checks.contexts.map(String) : [];
  const named = Array.isArray(checks?.checks)
    ? checks.checks.map((check) => String((check as { context?: unknown }).context ?? ""))
    : [];
  return [...contexts, ...named];
}

/** The check names a branch's rulesets require (`GET /repos/{o}/{r}/rules/branches/{b}`). */
function rulesetChecks(json: unknown): string[] {
  if (!Array.isArray(json)) throw new CodeHostError("failed", "gh printed no rule list");
  return json.flatMap((rule) => {
    const typed = rule as { type?: unknown; parameters?: { required_status_checks?: unknown } };
    if (typed.type !== "required_status_checks") return [];
    const list = typed.parameters?.required_status_checks;
    return Array.isArray(list)
      ? list.map((check) => String((check as { context?: unknown }).context ?? ""))
      : [];
  });
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

/** One row of `gh pr checks --json`. */
type CheckJson = Record<string, unknown>;

function checkOf(row: CheckJson): RequiredCheck {
  const bucket = String(row.bucket ?? "");
  return {
    name: String(row.name ?? ""),
    state: String(row.state ?? ""),
    bucket: (BUCKETS.has(bucket) ? bucket : "pending") as CheckBucket,
  };
}

/** The last `limit` bytes a stream yields, decoded; older chunks are dropped as they pass. */
async function readTail(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    size += chunk.byteLength;
    while (chunks.length > 1 && size - (chunks[0]?.byteLength ?? 0) >= limit) {
      size -= chunks.shift()?.byteLength ?? 0;
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let start = Math.max(0, size - limit);
  // A cut inside a multi-byte character leaves its continuation bytes (0b10xxxxxx); skip them.
  if (start > 0) while (start < size && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(bytes.subarray(start));
}

/** The most stderr of a failed-job log read that is kept: its last 64 KiB. */
const STDERR_TAIL_BYTES = 64 * 1024;

export interface GhHostOptions {
  readonly spawn: Spawn;
  /** The resolved `gh`; `gh` on `PATH` by default. */
  readonly gh?: string;
  /** The environment `gh` starts from; this process's by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Gets warnings, such as a PR list cut off at `LIST_OPEN_LIMIT`; none by default. */
  readonly logger?: { warn(message: string, fields?: Readonly<Record<string, unknown>>): void };
  /** How long a failed-job log read may run; `LOG_TIMEOUT_MS` by default. */
  readonly logTimeoutMs?: number;
  /** The engine clock each call's deadline runs on; the system clock when absent. */
  readonly clock?: Clock;
  /** How long any other call may run before it is killed (DIPO-314); `CALL_DEADLINE_MS` by default. */
  readonly deadlineMs?: number;
}

interface GhResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The `CodeHost` that runs `gh`. */
export class GhHost implements CodeHost, PrStateHost, PrListHost, PrReviewHost, AutoMergeHost {
  readonly #spawn: Spawn;
  readonly #gh: string;
  readonly #env: Record<string, string>;
  readonly #logger: GhHostOptions["logger"];
  readonly #logTimeoutMs: number;
  readonly #clock: Clock;
  readonly #deadlineMs: number;
  #version: string | null = null;

  constructor(options: GhHostOptions) {
    this.#spawn = options.spawn;
    this.#gh = options.gh ?? "gh";
    this.#env = ghEnv(options.env ?? process.env);
    this.#logger = options.logger;
    this.#logTimeoutMs = options.logTimeoutMs ?? LOG_TIMEOUT_MS;
    this.#clock = options.clock ?? systemClock;
    this.#deadlineMs = options.deadlineMs ?? CALL_DEADLINE_MS;
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
    if (list.length >= LIST_OPEN_LIMIT) {
      // `gh pr list` stops at the limit: an open PR beyond it is not seen. The prefix filter stays
      // client-side, since `--search head:` matches words, not a branch prefix.
      this.#logger?.warn("the open pull request list reached its limit; later PRs were not read", {
        repo,
        prefix,
        limit: LIST_OPEN_LIMIT,
      });
    }
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
    const out = await this.#ok([
      "pr",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      VIEW_FIELDS,
    ]);
    return prOf(parseJson(out, "a pull request") as PrJson);
  }

  async closePr(repo: string, number: number, comment: string): Promise<void> {
    await this.#ok(["pr", "close", String(number), "--repo", repo, "--comment", comment]);
  }

  async enableAutoMerge(
    repo: string,
    number: number,
    merge: { readonly headSha: string; readonly subject: string },
  ): Promise<void> {
    await this.#ok([
      "pr",
      "merge",
      String(number),
      "--repo",
      repo,
      "--auto",
      "--squash",
      "--match-head-commit",
      merge.headSha,
      "--subject",
      merge.subject,
      "--body",
      "",
    ]);
  }

  async disableAutoMerge(repo: string, number: number): Promise<void> {
    await this.#ok(["pr", "merge", String(number), "--repo", repo, "--disable-auto"]);
  }

  async requiredCheckNames(repo: string, base: string): Promise<string[]> {
    const { flags, path } = apiTarget(repo);
    const branch = encodeURIComponent(base);
    const protection = await this.#ok(["api", ...flags, `repos/${path}/branches/${branch}`]);
    const rules = await this.#ok(["api", ...flags, `repos/${path}/rules/branches/${branch}`]);
    const names = [
      ...protectionChecks(parseJson(protection, "a branch")),
      ...rulesetChecks(parseJson(rules, "a rule list")),
    ].filter((name) => name !== "");
    return [...new Set(names)].toSorted();
  }

  async requiredChecks(repo: string, number: number): Promise<RequiredCheck[]> {
    const rows = await this.#checkRows([
      "pr",
      "checks",
      String(number),
      "--repo",
      repo,
      "--required",
      "--json",
      "name,state,bucket",
    ]);
    return rows.map(checkOf);
  }

  async prLabels(repo: string, number: number): Promise<string[]> {
    const out = await this.#ok(["pr", "view", String(number), "--repo", repo, "--json", "labels"]);
    const json = parseJson(out, "a pull request's labels") as { labels?: unknown };
    if (!Array.isArray(json.labels)) throw new CodeHostError("failed", "gh printed no label list");
    return json.labels.map((label) => String((label as { name?: unknown }).name ?? ""));
  }

  async prChecks(repo: string, number: number): Promise<PrCheck[]> {
    const rows = await this.#checkRows([
      "pr",
      "checks",
      String(number),
      "--repo",
      repo,
      "--json",
      "name,state,bucket,link,workflow",
    ]);
    return rows.map((row) => ({
      ...checkOf(row),
      link: String(row.link ?? ""),
      workflow: String(row.workflow ?? ""),
    }));
  }

  async failedJobLog(repo: string, link: string): Promise<string | null> {
    const job = actionsJobOf(repo, link);
    if (job === null) return null;
    await this.checkVersion();
    const result = await this.#tailRun([
      "run",
      "view",
      "--repo",
      repo,
      "--job",
      job,
      "--log-failed",
    ]);
    this.#assertAuth(result);
    if (result.code !== 0) throw this.#failure(["run", "view"], result);
    return result.stdout;
  }

  async commentPr(repo: string, number: number, body: string): Promise<string> {
    // The body goes on stdin: a long body as one argument can pass the system's argument limit.
    const out = await this.#ok(
      ["pr", "comment", String(number), "--repo", repo, "--body-file", "-"],
      body,
    );
    // `gh pr comment` prints the comment's URL as its last line.
    const url = out
      .split("\n")
      .map((line) => line.trim())
      .findLast((line) => /^https?:\/\/\S+$/.test(line));
    if (url === undefined) {
      throw new CodeHostError("failed", `\`gh pr comment\` printed no comment URL: ${out.trim()}`);
    }
    return url;
  }

  // ---- running gh ------------------------------------------------------------------------------

  /**
   * The rows of `gh pr checks`. gh exits 1 when a check failed and 8 while one is pending, and
   * still prints the rows; with no checks it says so on stderr.
   */
  async #checkRows(args: readonly string[]): Promise<CheckJson[]> {
    await this.checkVersion();
    const result = await this.#raw(args);
    this.#assertAuth(result);
    if (result.stdout.trim().startsWith("[")) {
      const list = parseJson(result.stdout, "a check list");
      if (!Array.isArray(list)) throw new CodeHostError("failed", "gh printed no check list");
      return list as CheckJson[];
    }
    if (/no (required )?checks reported/i.test(result.stderr)) return [];
    if (result.code === 0 || result.code === EXIT_PENDING) return [];
    throw this.#failure(["pr", "checks"], result);
  }

  /**
   * Runs `gh <args>` and keeps only the last `LOG_TAIL_BYTES` of stdout and the last
   * `STDERR_TAIL_BYTES` of stderr. The child is killed, and the call throws `CodeHostError`, once `#logTimeoutMs` has passed.
   */
  async #tailRun(args: readonly string[]): Promise<GhResult> {
    const child = this.#spawnGh(args);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        killChildGroup(child);
        reject(
          new CodeHostError(
            "failed",
            `\`gh ${args.join(" ")}\` did not finish within ${this.#logTimeoutMs / 1000} seconds; it was stopped.`,
          ),
        );
      }, this.#logTimeoutMs);
    });
    try {
      const [stdout, stderr, exit] = await Promise.race([
        Promise.all([
          readTail(child.stdout, LOG_TAIL_BYTES),
          readTail(child.stderr, STDERR_TAIL_BYTES),
          child.exited,
        ]),
        timeout,
      ]);
      return { code: exit.code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Runs `gh <args>` after the version check, with `input` on stdin when given; a non-zero exit
   * throws. Returns stdout.
   */
  async #ok(args: readonly string[], input?: string): Promise<string> {
    await this.checkVersion();
    const result = await this.#raw(args, input);
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

  /** Starts `gh <args>`; with `input`, writes it to the child's stdin and closes it. */
  #spawnGh(args: readonly string[], input?: string): ChildProcess {
    let child: ChildProcess;
    try {
      child =
        input === undefined
          ? this.#spawn({ cmd: [this.#gh, ...args], env: this.#env, detached: true })
          : this.#spawn({
              cmd: [this.#gh, ...args],
              env: this.#env,
              stdin: "pipe",
              detached: true,
            });
    } catch (error) {
      throw new CodeHostError(
        "missing",
        `gh could not start (${error instanceof Error ? error.message : String(error)}); install gh ${MIN_GH_VERSION} or newer (https://cli.github.com).`,
      );
    }
    trackEngineCall(child);
    if (input !== undefined) {
      if (child.stdin === null) {
        child.kill("SIGKILL");
        throw new CodeHostError("failed", `\`gh ${args.slice(0, 2).join(" ")}\` got no stdin.`);
      }
      child.stdin.write(input);
      child.stdin.end();
    }
    return child;
  }

  /** Runs `gh <args>` to its end, killed and failed with `timedOut` at the call's deadline. */
  async #raw(args: readonly string[], input?: string): Promise<GhResult> {
    const child = this.#spawnGh(args, input);
    const deadlineMs = this.#deadlineMs;
    const [stdout, stderr, exit] = await withDeadline(
      child,
      Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]),
      {
        clock: this.#clock,
        deadlineMs,
        timedOut: () =>
          new CodeHostError("timedOut", `${timedOutText(["gh", ...args], deadlineMs)}.`),
      },
    );
    return { code: exit.code, stdout, stderr };
  }
}
