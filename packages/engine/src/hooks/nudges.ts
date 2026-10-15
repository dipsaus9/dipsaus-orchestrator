// Conditional nudges through hooks (0014 section 8, DIPO-60). A worker's tool use and session start
// arrive as neutral `toolUsed` and `sessionStarted` hook events with the id the worker host holds
// the call under (the hook waits for it, within 2 s). Code checks the facts and answers each call:
//
// | Trigger                     | Fact checked by code                                | Nudge         |
// | tool use writing a file     | the path lies outside the run's declared scope      | `scope`       |
// | tool use writing a file     | the path was in the run's context pack              | `context`     |
// | any tool use                | budget tokens passed 80% of the run's budget limit  | `budget`      |
// | session start on a resume   | an input file changed on the base since the claim   | `input`       |
//
// Each fact has a signature; a signature is nudged at most once per session (the agents of a run
// that share a session id). A call with no new fact is released at once with an empty reply, so
// the hook prints nothing. The texts come from `prompts/feedback/nudge-*.md`; one reply holds the
// texts of as many facts as fit in 300 characters, the rest wait for the next call. Each nudged
// signature is a row of `prompt_parts` (`nudge.<trigger>:<subject>`, its text measured, `nudges`
// counting the sends), so nudges are counted per run like any other prompt part.
//
// This module emits only the neutral `nudge` op; the adapter's `encode` decides what its CLI
// prints (0008 amendment of 2026-10-12). Every failure is silent: the hook then prints nothing.

import type { Clock, RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import type { OfficeGit } from "../git/office";
import budgetTemplate from "../prompts/feedback/nudge-budget.md" with { type: "text" };
import contextTemplate from "../prompts/feedback/nudge-context.md" with { type: "text" };
import inputTemplate from "../prompts/feedback/nudge-input.md" with { type: "text" };
import scopeTemplate from "../prompts/feedback/nudge-scope.md" with { type: "text" };
import { measurePart } from "../prompts/parts";
import { renderTemplate } from "../prompts/templates";
import type { RunSteering } from "../run/control";
import { runTotals } from "../run/caps";
import { findRun, type StoredRun } from "../run/records";
import { DEFAULT_LOCKFILES, scopeCovers } from "../run/verify-commit";
import type { HostOp, NudgeOp, SteerOp, WorkerEvent } from "../workers/types";
import { findClaim } from "../worktree/records";

import type { HookEvent } from "./types";

/** The 0014 section 8 nudge templates, one per trigger. */
export const NUDGE_TEMPLATES = {
  scope: scopeTemplate,
  context: contextTemplate,
  budget: budgetTemplate,
  input: inputTemplate,
} as const;

export type NudgeTrigger = keyof typeof NUDGE_TEMPLATES;

/** One fact that makes a nudge relevant. */
export type NudgeFact =
  | { readonly trigger: "scope" | "context"; readonly path: string }
  | { readonly trigger: "budget" }
  | { readonly trigger: "input"; readonly path: string; readonly sha: string };

/** The longest nudge, in characters (0014 section 4). */
export const NUDGE_MAX_CHARS = 300;
/** The share of the run's budget tokens past which the budget nudge fires (0014 section 8). */
export const BUDGET_NUDGE_SHARE = 0.8;
/** Characters of a commit id in the input nudge. */
export const NUDGE_SHA_CHARS = 12;
/** How long the input check on a resume may take before the call is released without it. */
export const INPUT_CHECK_MS = 1_000;

/** `prompt_parts` name prefix of a nudge row. */
export const NUDGE_PART = "nudge.";
/** `prompt_parts` names of the run's context pack and input paths, one row per path. */
export const CONTEXT_PATH_PART = "task.context:";
export const INPUT_PATH_PART = "task.inputs:";

// ---- pure rules ----------------------------------------------------------------------------------

/** The fact's signature, also its `prompt_parts` name: the same fact is nudged once per session. */
export function nudgeSignature(fact: NudgeFact): string {
  switch (fact.trigger) {
    case "budget":
      return `${NUDGE_PART}budget`;
    case "input":
      return `${NUDGE_PART}input:${fact.path}@${fact.sha}`;
    default:
      return `${NUDGE_PART}${fact.trigger}:${fact.path}`;
  }
}

/** Cuts `text` to `max` characters, ending in an ellipsis when it was cut. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The nudge text of one fact, at most `NUDGE_MAX_CHARS` characters. */
export function nudgeText(fact: NudgeFact): string {
  const template = NUDGE_TEMPLATES[fact.trigger];
  const text =
    fact.trigger === "budget"
      ? renderTemplate(template, {})
      : fact.trigger === "input"
        ? renderTemplate(template, { path: fact.path, sha: fact.sha.slice(0, NUDGE_SHA_CHARS) })
        : renderTemplate(template, { path: fact.path });
  return clip(text, NUDGE_MAX_CHARS);
}

export interface ComposedNudge {
  /** The reply's text, at most `NUDGE_MAX_CHARS` characters; empty when no fact is given. */
  readonly text: string;
  /** The facts the text holds, in order; the others wait for a later call. */
  readonly facts: readonly NudgeFact[];
}

/** Pure: the texts of `facts`, in order, as many as fit in `NUDGE_MAX_CHARS`, one space apart. */
export function composeNudge(facts: readonly NudgeFact[]): ComposedNudge {
  const kept: NudgeFact[] = [];
  let text = "";
  for (const fact of facts) {
    const next = nudgeText(fact);
    const joined = text === "" ? next : `${text} ${next}`;
    if (joined.length > NUDGE_MAX_CHARS) continue;
    text = joined;
    kept.push(fact);
  }
  return { text, facts: kept };
}

/** macOS links `/tmp`, `/var` and `/etc` into `/private`; a path compares without that prefix. */
function unlinked(path: string): string {
  return path.replace(/^\/private(?=\/(?:tmp|var|etc)\/)/, "");
}

/**
 * The written path relative to `worktree`, or null when it lies outside the worktree (a temp file:
 * the scope check at `done` covers the worktree only, so no fact is about it).
 */
export function worktreePath(path: string, worktree: string | null): string | null {
  if (!path.startsWith("/")) return path.replace(/^\.\//, "");
  if (worktree === null) return null;
  const root = unlinked(worktree.endsWith("/") ? worktree : `${worktree}/`);
  const written = unlinked(path);
  return written.startsWith(root) ? written.slice(root.length) : null;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** True for the story's Backlog.md task file, `<id lowercased> - <title>.md`. */
function isTaskFile(path: string, story: string | null): boolean {
  const name = baseName(path);
  return story !== null && name.startsWith(`${story.toLowerCase()} - `) && name.endsWith(".md");
}

export interface WriteFactsInput {
  /** The written path, relative to the worktree. */
  readonly path: string;
  /** The run's declared scope; null for a run without one (a session run). */
  readonly scope: readonly string[] | null;
  /** The story id; its own task file is never a scope fact, as at `done`. */
  readonly story?: string | null;
  /** The paths of the run's context pack. */
  readonly contextPaths: ReadonlySet<string>;
}

/**
 * Pure: the facts of one written file. The story's task file and a lockfile are never scope facts,
 * as at `done`: the engine commits the task file itself and pairs a lockfile with
 * an in-scope manifest (0014 section 3), which the scope check there decides.
 */
export function writeFacts(input: WriteFactsInput): NudgeFact[] {
  const facts: NudgeFact[] = [];
  const { path, scope } = input;
  if (
    scope !== null &&
    !DEFAULT_LOCKFILES.includes(baseName(path)) &&
    !isTaskFile(path, input.story ?? null) &&
    !scope.some((entry) => scopeCovers(entry, path))
  ) {
    facts.push({ trigger: "scope", path });
  }
  if (input.contextPaths.has(path)) facts.push({ trigger: "context", path });
  return facts;
}

/** Pure: the budget fact when `used` budget tokens passed 80% of `limit`; null otherwise. */
export function budgetFact(used: number, limit: number): NudgeFact | null {
  return limit > 0 && used >= limit * BUDGET_NUDGE_SHARE ? { trigger: "budget" } : null;
}

/** One input file the base changed: the newest commit on the base that touched it. */
export interface InputChange {
  readonly path: string;
  readonly sha: string;
}

/**
 * Pure: `git log --format=%x00%H --name-only` output, newest first, as the newest commit per path,
 * in the order of `paths`.
 */
export function parseInputChanges(output: string, paths: readonly string[]): InputChange[] {
  const newest = new Map<string, string>();
  for (const block of output.split("\0")) {
    const [sha, ...files] = block.split("\n").map((line) => line.trim());
    if (sha === undefined || !/^[0-9a-f]{7,64}$/.test(sha)) continue;
    for (const file of files) if (file !== "" && !newest.has(file)) newest.set(file, sha);
  }
  return paths.flatMap((path) => {
    const sha = newest.get(path);
    return sha === undefined ? [] : [{ path, sha }];
  });
}

// ---- stored facts --------------------------------------------------------------------------------

export interface NudgeSources {
  /** The paths of the context pack items. */
  readonly context: readonly string[];
  /** The story's input paths. */
  readonly inputs: readonly string[];
}

/**
 * Stores the context pack and input paths of a run's session as `prompt_parts` rows (one per path,
 * its text measured), for the context and input nudges. Runs inside the caller's transaction.
 */
export function writeNudgeSources(
  office: OfficeHandle,
  run: string,
  agent: string,
  sources: NudgeSources,
  texts: Readonly<Record<string, string>>,
  at: number,
): void {
  const rows = [
    ...sources.context.map((path) => `${CONTEXT_PATH_PART}${path}`),
    ...sources.inputs.map((path) => `${INPUT_PATH_PART}${path}`),
  ];
  for (const name of new Set(rows)) {
    const path = name.slice(name.indexOf(":") + 1);
    insertPart(office, run, agent, measurePart(name, texts[path] ?? path), 0, at);
  }
}

function insertPart(
  office: OfficeHandle,
  run: string,
  agent: string,
  part: ReturnType<typeof measurePart>,
  nudges: number,
  at: number,
): void {
  office.run(
    `insert into prompt_parts (office_id, run_id, agent_id, part, sha256, bytes, est_tokens,
       nudges, recorded_at)
     values ($office_id, $run, $agent, $part, $sha, $bytes, $tokens, $nudges, $at)
     on conflict (office_id, run_id, agent_id, part) do update set
       nudges = prompt_parts.nudges + excluded.nudges, recorded_at = excluded.recorded_at`,
    {
      run,
      agent,
      part: part.name,
      sha: part.sha256,
      bytes: part.bytes,
      tokens: part.estTokens,
      nudges,
      at,
    },
  );
}

/** The stored paths of a run's `prefix` rows, over all its agents, sorted. */
function pathsOf(office: OfficeHandle, run: string, prefix: string): string[] {
  return office
    .all<{ part: string }>(
      `select distinct part from prompt_parts
       where office_id = $office_id and run_id = $run and substr(part, 1, length($prefix)) = $prefix
       order by part`,
      { run, prefix },
    )
    .map((row) => row.part.slice(prefix.length));
}

/** The run's context pack paths (`writeNudgeSources`). */
export function contextPathsOf(office: OfficeHandle, run: string): string[] {
  return pathsOf(office, run, CONTEXT_PATH_PART);
}

/** The run's input paths (`writeNudgeSources`). */
export function inputPathsOf(office: OfficeHandle, run: string): string[] {
  return pathsOf(office, run, INPUT_PATH_PART);
}

/** True when `signature` was nudged in `agent`'s session: by it or an agent with its session id. */
export function nudgedInSession(
  office: OfficeHandle,
  run: string,
  agent: string,
  signature: string,
): boolean {
  return (
    office.get<{ found: number }>(
      `select 1 as found from prompt_parts p
       where p.office_id = $office_id and p.run_id = $run and p.part = $part and p.nudges > 0
         and (p.agent_id = $agent or p.agent_id in (
           select a.agent_id from agents a join agents me
             on me.office_id = a.office_id and me.agent_id = $agent
           where a.office_id = $office_id and a.run_id = $run and a.session_id = me.session_id))
       limit 1`,
      { run, agent, part: signature },
    ) !== null
  );
}

/** The nudges sent in `run`, over all its agents (0014 section 8: counted per run). */
export function nudgeCount(office: OfficeHandle, run: string): number {
  return (
    office.get<{ count: number }>(
      `select coalesce(sum(nudges), 0) as count from prompt_parts
       where office_id = $office_id and run_id = $run
         and substr(part, 1, length($prefix)) = $prefix`,
      { run, prefix: NUDGE_PART },
    )?.count ?? 0
  );
}

// ---- the base check ------------------------------------------------------------------------------

/** Reads which input files the base changed after `since`; the newest commit per path. */
export type InputChangeReader = (
  office: OfficeHandle,
  run: StoredRun,
  since: string,
  paths: readonly string[],
) => Promise<InputChange[]>;

/** The input check on the office's base (`<remote>/<base>`) through the office's git queue. */
export function gitInputChanges(
  git: (office: OfficeHandle) => OfficeGit | undefined,
): InputChangeReader {
  return async (office, _run, since, paths) => {
    const officeGit = git(office);
    if (officeGit === undefined || paths.length === 0) return [];
    const base = await officeGit.resolveBase();
    const ref = `refs/remotes/${officeGit.settings.remote}/${base}`;
    const output = await officeGit.run((session) =>
      session.ok(session.repository, [
        "log",
        "--format=%x00%H",
        "--name-only",
        "--no-renames",
        `${since}..${ref}`,
        "--",
        ...paths,
      ]),
    );
    return parseInputChanges(output, paths);
  };
}

// ---- the listener --------------------------------------------------------------------------------

export interface NudgesDeps {
  readonly clock: Clock;
  /** Sends host ops to a run's worker host. */
  readonly steering: RunSteering;
  /** The worker adapter's pure `encode`, which turns the neutral op into host ops. */
  readonly encode: (op: SteerOp) => HostOp[];
  /** Which input files the base changed; without it a resume gets no input nudge. */
  readonly inputChanges?: InputChangeReader;
  /** True while a decision on the run (a cap, a park, a stop) is being carried out. */
  readonly ending?: (run: string) => boolean;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

type ToolUsed = Extract<HookEvent, { kind: "toolUsed" }>;
type SessionStarted = Extract<HookEvent, { kind: "sessionStarted" }>;

/** Answers tool-use and session-start hook calls with a nudge or an empty reply (file comment). */
export class Nudges {
  readonly #deps: NudgesDeps;
  /** Signatures being sent, per run, so one pass never sends the same fact twice. */
  readonly #pending = new Map<string, Set<string>>();
  readonly #inflight = new Set<Promise<unknown>>();

  constructor(deps: NudgesDeps) {
    this.#deps = deps;
  }

  /** The events of one committed ingestion pass of `office`'s run `run` (`OfficeIngest`). */
  onWorkerEvents(
    office: OfficeHandle,
    run: string,
    agent: string,
    events: readonly WorkerEvent[],
  ): void {
    for (const event of events) {
      if (event.t !== "hook" || !("id" in event.hook) || event.hook.id === null) continue;
      if (event.hook.kind === "toolUsed") this.#toolUsed(office, run, agent, event.hook);
      else if (event.hook.kind === "sessionStarted")
        this.#sessionStarted(office, run, agent, event.hook);
    }
  }

  /** The worker of `run` exited: nothing more is sent to it. */
  onEnded(_office: OfficeHandle, run: string): void {
    this.#pending.delete(run);
  }

  /** Resolves once every reply this module started has been sent. */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled(this.#inflight);
  }

  #toolUsed(office: OfficeHandle, run: string, agent: string, hook: ToolUsed): void {
    const call = hook.id ?? 0;
    let facts: NudgeFact[] = [];
    try {
      const stored = findRun(office, run as RunId);
      if (stored !== null && this.#deps.ending?.(run) !== true) {
        const written = hook.wrote === undefined ? null : worktreePath(hook.wrote, stored.worktree);
        if (written !== null) {
          facts = writeFacts({
            path: written,
            scope: stored.kind === "story" ? stored.scope : null,
            story: stored.story,
            contextPaths: new Set(contextPathsOf(office, run)),
          });
        }
        const now = this.#deps.clock.now();
        const budget = budgetFact(
          runTotals(office, stored.runId, stored.startedAt, now).budgetTokens,
          stored.budgetLimit,
        );
        if (budget !== null) facts.push(budget);
      }
    } catch (error) {
      this.#warn("the nudge facts could not be read", run, error);
      facts = [];
    }
    this.#track(this.#reply(office, run, agent, call, "toolUsed", facts));
  }

  #sessionStarted(office: OfficeHandle, run: string, agent: string, hook: SessionStarted): void {
    const call = hook.id ?? 0;
    this.#track(
      (async () => {
        const facts = hook.resumed === true ? await this.#inputFacts(office, run) : [];
        await this.#reply(office, run, agent, call, "sessionStarted", facts);
      })(),
    );
  }

  /** The input facts of a resume, or none when the check fails or takes over `INPUT_CHECK_MS`. */
  async #inputFacts(office: OfficeHandle, run: string): Promise<NudgeFact[]> {
    const reader = this.#deps.inputChanges;
    if (reader === undefined || this.#deps.ending?.(run) === true) return [];
    try {
      const stored = findRun(office, run as RunId);
      if (stored === null) return [];
      const since = findClaim(office, stored.runId)?.baseSha ?? stored.startSha;
      const paths = inputPathsOf(office, run);
      if (since === null || paths.length === 0) return [];
      const changes = await this.#within(reader(office, stored, since, paths), INPUT_CHECK_MS);
      return (changes ?? []).map((change) => ({ trigger: "input", ...change }));
    } catch (error) {
      this.#warn("the input check of a resume failed", run, error);
      return [];
    }
  }

  /** `work`'s result, or null once `ms` passed. */
  #within<T>(work: Promise<T>, ms: number): Promise<T | null> {
    const { clock } = this.#deps;
    return new Promise((resolve, reject) => {
      const timer = clock.setTimeout(() => resolve(null), ms);
      work.then(
        (value) => {
          clock.clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clock.clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  /** Sends the nudge of the facts not yet nudged in the session, or an empty reply. */
  async #reply(
    office: OfficeHandle,
    run: string,
    agent: string,
    call: number,
    on: NudgeOp["on"],
    facts: readonly NudgeFact[],
  ): Promise<void> {
    const pending = this.#pending.get(run) ?? new Set<string>();
    this.#pending.set(run, pending);
    let fresh: NudgeFact[] = [];
    try {
      fresh = facts.filter((fact) => {
        const signature = nudgeSignature(fact);
        return !pending.has(signature) && !nudgedInSession(office, run, agent, signature);
      });
    } catch (error) {
      this.#warn("the sent nudges could not be read", run, error);
    }
    const nudge = composeNudge(fresh);
    const signatures = nudge.facts.map(nudgeSignature);
    for (const signature of signatures) pending.add(signature);
    try {
      const op: SteerOp =
        nudge.text === ""
          ? { kind: "hookReply", reply: { hook: call, decision: null } }
          : { kind: "nudge", text: nudge.text, hook: call, on };
      const sent = await this.#deps.steering.send(office, run as RunId, this.#deps.encode(op));
      if (sent.ok && nudge.facts.length > 0) this.#record(office, run, agent, nudge.facts);
    } catch (error) {
      this.#warn("a nudge did not reach the worker host", run, error);
    } finally {
      for (const signature of signatures) pending.delete(signature);
    }
  }

  /** Stores one sent nudge per fact (`prompt_parts`, `nudges` counting the sends). */
  #record(office: OfficeHandle, run: string, agent: string, facts: readonly NudgeFact[]): void {
    const at = this.#deps.clock.now();
    office.immediate(() => {
      for (const fact of facts) {
        insertPart(office, run, agent, measurePart(nudgeSignature(fact), nudgeText(fact)), 1, at);
      }
    });
  }

  #track(job: Promise<void>): void {
    this.#inflight.add(job);
    void job.finally(() => this.#inflight.delete(job));
  }

  #warn(message: string, run: string, error: unknown): void {
    this.#deps.warn?.(message, {
      run,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
