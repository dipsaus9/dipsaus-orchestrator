// The web tools' check and count (0020 section 11b, DIPO-164). With `worker.web` the developer
// role may call WebSearch and WebFetch. Both run outside the Bash sandbox and a URL or query can
// carry data off the machine, so a `PreToolUse` hook relays each call whole (`dipo hook PreToolUse
// --gate`) and waits for the engine's answer within the relay's 2-second limit. This module
// answers it:
//
// - the URL or query holds a value from the env files dipo copied into the worktree (the `copy`
//   entries of `worktree.files`, read as `KEY=value` lines), as written or percent-encoded: deny,
//   naming the file and the key, never the value;
// - otherwise: allow (an empty reply, so the call proceeds under the run settings' rules).
//
// A value under `MIN_SECRET_CHARS` characters is not compared: "1" or "true" would refuse every
// call. Data that is not an env value is not caught (the follow-up story decides more).
//
// The module also counts the run's web calls by tool from the worker's own tool activity, a call
// the hook refused included (it shows in the worker output like any tool call): the counts are
// `runs.web_searches` and `runs.web_fetches`, and the run's outcome row copies them.
//
// Every failure is a deny: an env file that cannot be read, a call that cannot be checked. This
// module emits only the neutral `toolGate` op; the adapter's `encode` decides what its CLI prints.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import type { Clock, OfficeId, RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import { background } from "../platform/background";
import type { RunSteering } from "../run/control";
import { findRun } from "../run/records";
import type { HostOp, SteerOp, WorkerEvent } from "../workers/types";

import type { HookEvent } from "./types";

/** Values shorter than this are not compared (see the file comment). */
export const MIN_SECRET_CHARS = 4;
/** The most files read under a copied directory, and the largest file read: a bound, not a rule. */
export const MAX_ENV_FILES = 200;
export const MAX_ENV_FILE_BYTES = 256 * 1024;

/** Pure: the web calls among `events` by tool, from the worker's tool activity. */
export function webCallCounts(events: readonly WorkerEvent[]): {
  readonly WebSearch: number;
  readonly WebFetch: number;
} {
  const counts = { WebSearch: 0, WebFetch: 0 };
  for (const event of events) {
    if (event.t === "activity" && event.kind === "tool" && event.tool !== undefined) {
      if (event.tool === "WebSearch") counts.WebSearch += 1;
      else if (event.tool === "WebFetch") counts.WebFetch += 1;
    }
  }
  return counts;
}

/** One value of a copied env file, with where it came from. */
export interface EnvSecret {
  /** The file, relative to the worktree. */
  readonly file: string;
  readonly key: string;
  readonly value: string;
}

/** The first secret a target holds: its file and key, never the value. */
export interface SecretHit {
  readonly file: string;
  readonly key: string;
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/;

/** The `KEY=value` lines of one env file's text; quotes are removed, `#` comments are cut. */
export function parseEnvText(text: string): Array<{ key: string; value: string }> {
  const found: Array<{ key: string; value: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = LINE.exec(line);
    if (match === null) continue;
    const key = match[1] ?? "";
    let value = (match[2] ?? "").trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1);
      value = end === -1 ? value.slice(1) : value.slice(1, end);
    } else {
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment).trim();
    }
    if (value !== "") found.push({ key, value });
  }
  return found;
}

function safeDecode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/**
 * Pure: the first of `secrets` whose value `target` holds, as written, percent-encoded (the
 * encoded form of the value in the target, in either hex case) or after the target is
 * percent-decoded (a `+` read as a space too).
 */
export function findSecret(target: string, secrets: readonly EnvSecret[]): SecretHit | null {
  const decoded = [safeDecode(target), safeDecode(target.replaceAll("+", " "))].filter(
    (text): text is string => text !== null,
  );
  const lowerTarget = target.toLowerCase();
  for (const secret of secrets) {
    if (secret.value.length < MIN_SECRET_CHARS) continue;
    const written = [target, ...decoded].some((text) => text.includes(secret.value));
    const encoded = [
      encodeURIComponent(secret.value),
      encodeURI(secret.value),
      encodeURIComponent(secret.value).replaceAll("%20", "+"),
    ].some((form) => form !== secret.value && lowerTarget.includes(form.toLowerCase()));
    if (written || encoded) return { file: secret.file, key: secret.key };
  }
  return null;
}

/** Files of a `worktree.files` entry that exists in `worktree`: a file, or those under a directory. */
function filesOf(worktree: string, path: string): string[] {
  const out: string[] = [];
  const walk = (absolute: string): void => {
    if (out.length >= MAX_ENV_FILES) return;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      if (stat.size <= MAX_ENV_FILE_BYTES) out.push(absolute);
      return;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).toSorted()) walk(join(absolute, name));
    }
  };
  walk(join(worktree, path));
  return out;
}

/**
 * The values of the env files dipo copied into `worktree`: the `copy` entries of `worktree.files`
 * (a directory entry contributes the files under it), read as `KEY=value` lines. An entry that is
 * absent from the worktree (an optional file) contributes nothing; any other failure throws, so the
 * caller denies.
 */
export function readEnvSecrets(
  worktree: string,
  files: OfficeConfig["worktree"]["files"],
): EnvSecret[] {
  const secrets: EnvSecret[] = [];
  for (const entry of files) {
    if (entry.mode !== "copy") continue;
    let found: string[];
    try {
      found = filesOf(worktree, entry.path.replace(/\/$/, ""));
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") continue;
      throw error;
    }
    for (const absolute of found) {
      const text = readFileSync(absolute, "utf8");
      for (const { key, value } of parseEnvText(text)) {
        secrets.push({ file: relative(worktree, absolute), key, value });
      }
    }
  }
  return secrets;
}

/** What the worker is told when a call holds an env value: the file and key, never the value. */
export function refusalText(tool: string, hit: SecretHit): string {
  const what = tool === "WebSearch" ? "query" : "URL";
  return `The ${what} contains a value from ${hit.file} (${hit.key}); never send env values in a web call. Remove it and try again.`;
}

/** The reply when the call could not be checked (an env file could not be read). */
export const UNCHECKED_TEXT =
  "dipo could not check this web call for env values, so it was refused; try again.";

export interface WebGuardDeps {
  readonly clock: Clock;
  readonly offices: { config(office: OfficeId): OfficeConfig | undefined };
  /** Sends host ops to a run's worker host. */
  readonly steering: RunSteering;
  /** The worker adapter's pure `encode`, which turns the neutral reply into host ops. */
  readonly encode: (op: SteerOp) => HostOp[];
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
  /** Reads the secrets of a worktree; the env files by default. Tests replace it. */
  readonly secrets?: (worktree: string, files: OfficeConfig["worktree"]["files"]) => EnvSecret[];
}

type WebCall = Extract<HookEvent, { kind: "webCall" }>;

/** Answers `PreToolUse` web calls and counts the run's web calls (file comment). */
export class WebGuard {
  readonly #deps: WebGuardDeps;
  readonly #inflight = new Set<Promise<unknown>>();

  constructor(deps: WebGuardDeps) {
    this.#deps = deps;
  }

  /** The events of one committed ingestion pass of `office`'s run `run` (`OfficeIngest`). */
  onWorkerEvents(
    office: OfficeHandle,
    run: string,
    _agent: string,
    events: readonly WorkerEvent[],
  ): void {
    for (const event of events) {
      if (event.t === "hook" && event.hook.kind === "webCall" && event.hook.id !== null) {
        this.#check(office, run, event.hook);
      }
    }
    this.#count(office, run, webCallCounts(events));
  }

  /** Resolves once every reply this module started has been sent. */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled(this.#inflight);
  }

  #count(office: OfficeHandle, run: string, counts: ReturnType<typeof webCallCounts>): void {
    if (counts.WebSearch === 0 && counts.WebFetch === 0) return;
    try {
      office.immediate(() =>
        office.run(
          `update runs set web_searches = web_searches + $searches,
             web_fetches = web_fetches + $fetches
           where office_id = $office_id and run_id = $run`,
          { run, searches: counts.WebSearch, fetches: counts.WebFetch },
        ),
      );
    } catch (error) {
      this.#warn("the web calls could not be counted", run, error);
    }
  }

  #check(office: OfficeHandle, run: string, call: WebCall): void {
    const id = call.id ?? 0;
    let reason: string | undefined;
    try {
      reason = this.#refusal(office, run, call);
    } catch (error) {
      this.#warn("a web call could not be checked", run, error);
      reason = UNCHECKED_TEXT;
    }
    const reply =
      reason === undefined
        ? { hook: id, decision: null }
        : { hook: id, decision: "deny" as const, reason };
    background(
      async () => {
        const sent = await this.#deps.steering.send(
          office,
          run as RunId,
          this.#deps.encode({ kind: "toolGate", reply }),
        );
        if (!sent.ok) this.#warn("a web check did not reach the worker host", run, sent.reason);
      },
      {
        failed: "a web check reply failed",
        fields: { run },
        log: this.#deps.warn,
        inflight: this.#inflight,
      },
    );
  }

  /** Why the call is refused, or undefined to let it proceed. Throws when it cannot be checked. */
  #refusal(office: OfficeHandle, run: string, call: WebCall): string | undefined {
    const stored = findRun(office, run as RunId);
    const config = this.#deps.offices.config(office.officeId);
    if (stored === null || config === undefined || stored.worktree === null) {
      throw new Error("the run's worktree or the office configuration is not known");
    }
    const read = this.#deps.secrets ?? readEnvSecrets;
    const hit = findSecret(call.target, read(stored.worktree, config.worktree.files));
    return hit === null ? undefined : refusalText(call.tool, hit);
  }

  #warn(message: string, run: string, error: unknown): void {
    this.#deps.warn?.(message, {
      run,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
