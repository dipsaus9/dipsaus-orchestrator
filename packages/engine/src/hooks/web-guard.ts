// The web tools' check and count (0020 section 11b, DIPO-164). With `worker.web` the developer
// role may call WebSearch and WebFetch. Both run outside the Bash sandbox and a URL or query can
// carry data off the machine, so a `PreToolUse` hook relays each call whole (`dipo hook PreToolUse
// --gate`) and waits for the engine's answer within the relay's 2-second limit. This module
// answers it:
//
// - the URL or query holds a value from the env files dipo copied into the worktree (the `copy`
//   entries of `worktree.files`, read as `KEY=value` lines), as written or percent-encoded: deny,
//   naming the file and the key, never the value;
// - otherwise: let it on (a reply with no decision; the adapter encodes a marker the gate prints
//   as nothing, so Claude's permission rules decide the call).
//
// A value under `MIN_SECRET_CHARS` characters is not compared: "1" or "true" would refuse every
// call. Data that is not an env value is not caught (the follow-up story decides more).
//
// The module also counts the run's web calls by tool from the worker's own tool activity, a call
// the hook refused included (it shows in the worker output like any tool call): the counts are
// `runs.web_searches` and `runs.web_fetches`, and the run's outcome row copies them.
//
// Each web call shows in the worker output as `[web] <tool> <query or URL>`. Before that line is
// stored (`output_chunks`, and the `work.output` change-log entries read from it), every env value
// in it is replaced by `[redacted]`, as 0008 does for review comments; the refusal still names the
// file and key. The adapter's line holds the query or URL whole; it is cut to `INPUT_MAX_CHARS`,
// as other tool inputs, only after the redaction, so a value across the cut leaves no prefix. The
// raw `events.ndjson` of the run keeps the call as Claude wrote it, as it keeps every tool input
// (0007 sections 7 and 8).
//
// Every failure is a deny: an env file that cannot be read, a call that cannot be checked. This
// module emits only the neutral `toolGate` op; the adapter's `encode` decides what its CLI prints.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import type { Clock, OfficeId, RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import { oneLineInput } from "../ingest/output";
import { background } from "../platform/background";
import type { RunSteering } from "../run/control";
import { findRun } from "../run/records";
import { type HostOp, type SteerOp, WEB_LINE_PREFIX, type WorkerEvent } from "../workers/types";

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

/** A run of `%XX` escapes. A `%` not followed by two hex digits is not part of one. */
const ESCAPE_RUN = /(?:%[0-9A-Fa-f]{2})+/g;

/**
 * Pure: `text` percent-decoded leniently. Each run of `%XX` escapes is decoded on its own as UTF-8;
 * a run that is not valid UTF-8 (`%C0`) has its ASCII escapes decoded and its other escapes kept as
 * written; a stray `%` stays as it is. `decodeURIComponent` throws on either, which would skip the
 * decoded comparison for the whole target.
 */
export function lenientDecode(text: string): string {
  return text.replace(ESCAPE_RUN, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%[0-7][0-9A-Fa-f]/g, (escape) => decodeURIComponent(escape));
    }
  });
}

/** How often a target is decoded again, for a value encoded more than once (`%2561` is `%61`). */
export const MAX_DECODE_ROUNDS = 3;

/**
 * Pure: the forms of `target` a secret is looked for in: as written and each round of lenient
 * percent-decoding until nothing changes, each also with `+` read as a space first.
 */
export function decodedForms(target: string): string[] {
  const forms = new Set<string>([target]);
  for (const start of [target, target.replaceAll("+", " ")]) {
    let text = start;
    for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
      const next = lenientDecode(text);
      if (next === text) break;
      forms.add(next);
      text = next;
    }
  }
  return [...forms];
}

/**
 * Pure: the first of `secrets` whose value `target` holds, as written, percent-encoded (the
 * encoded form of the value in the target, in either hex case) or after the target is
 * percent-decoded leniently, up to `MAX_DECODE_ROUNDS` times (a `+` read as a space too).
 */
export function findSecret(target: string, secrets: readonly EnvSecret[]): SecretHit | null {
  const decoded = decodedForms(target);
  const lowerTarget = target.toLowerCase();
  for (const secret of secrets) {
    if (secret.value.length < MIN_SECRET_CHARS) continue;
    const written = decoded.some((text) => text.includes(secret.value));
    const encoded = encodedForms(secret.value).some((form) =>
      lowerTarget.includes(form.toLowerCase()),
    );
    if (written || encoded) return { file: secret.file, key: secret.key };
  }
  return null;
}

/** The percent-encoded forms of `value` that differ from it. */
function encodedForms(value: string): string[] {
  return [
    encodeURIComponent(value),
    encodeURI(value),
    encodeURIComponent(value).replaceAll("%20", "+"),
  ].filter((form) => form !== value);
}

/** What stored output holds in place of an env value (as 0008 redacts review comments). */
export const REDACTED_TEXT = "[redacted]";

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pure: `line` with every env value of `secrets` replaced by `[redacted]`: as written and
 * percent-encoded (either hex case), then each whitespace-separated word that still holds one
 * (encoded part by part, or encoded twice) whole. A line that still holds one after that is
 * `[redacted]` whole.
 */
export function redactSecrets(line: string, secrets: readonly EnvSecret[]): string {
  const live = secrets.filter((secret) => secret.value.length >= MIN_SECRET_CHARS);
  if (live.length === 0) return line;
  let out = line;
  for (const secret of live) {
    out = out.split(secret.value).join(REDACTED_TEXT);
    for (const form of encodedForms(secret.value)) {
      out = out.replaceAll(new RegExp(escapeRegExp(form), "gi"), REDACTED_TEXT);
    }
  }
  out = out
    .split(/(\s+)/)
    .map((word) => (findSecret(word, live) === null ? word : REDACTED_TEXT))
    .join("");
  return findSecret(out, live) === null ? out : REDACTED_TEXT;
}

/** Pure: a web output line with its query or URL replaced by `[redacted]`, its tool kept. */
export function redactWebTarget(line: string): string {
  const rest = line.slice(WEB_LINE_PREFIX.length);
  const space = rest.indexOf(" ");
  return space === -1 ? line : `${WEB_LINE_PREFIX}${rest.slice(0, space)} ${REDACTED_TEXT}`;
}

/**
 * Pure: a web output line with its query or URL cut to `INPUT_MAX_CHARS`, as other tool inputs.
 * Run it only on a line already redacted: a value across the cut would leave its prefix otherwise.
 */
export function cutWebLine(line: string): string {
  if (!line.startsWith(WEB_LINE_PREFIX)) return line;
  const rest = line.slice(WEB_LINE_PREFIX.length);
  const space = rest.indexOf(" ");
  if (space === -1) return line;
  return `${WEB_LINE_PREFIX}${rest.slice(0, space)} ${oneLineInput(rest.slice(space + 1))}`;
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

  /**
   * The output text of one ingestion pass of `office`'s run `run`, with every env value in its web
   * lines replaced by `[redacted]` before it is stored (file comment), and each web line's query or
   * URL then cut to `INPUT_MAX_CHARS`. The env files are read only when the text holds a web line;
   * when they cannot be read, each web line's query or URL is redacted whole. Other lines are
   * returned as they are.
   */
  redactOutput(office: OfficeHandle, run: string, text: string): string {
    if (!text.includes(WEB_LINE_PREFIX)) return text;
    let secrets: EnvSecret[] | null;
    try {
      secrets = this.#secrets(office, run);
    } catch (error) {
      this.#warn("the web output could not be checked for env values", run, error);
      secrets = null;
    }
    return text
      .split("\n")
      .map((line) => {
        if (!line.startsWith(WEB_LINE_PREFIX)) return line;
        // Redact the whole line first, then cut: never the other way round.
        return cutWebLine(secrets === null ? redactWebTarget(line) : redactSecrets(line, secrets));
      })
      .join("\n");
  }

  /** Why the call is refused, or undefined to let it proceed. Throws when it cannot be checked. */
  #refusal(office: OfficeHandle, run: string, call: WebCall): string | undefined {
    const hit = findSecret(call.target, this.#secrets(office, run));
    return hit === null ? undefined : refusalText(call.tool, hit);
  }

  /** The env values of the run's worktree. Throws when they cannot be read. */
  #secrets(office: OfficeHandle, run: string): EnvSecret[] {
    const stored = findRun(office, run as RunId);
    const config = this.#deps.offices.config(office.officeId);
    if (stored === null || config === undefined || stored.worktree === null) {
      throw new Error("the run's worktree or the office configuration is not known");
    }
    const read = this.#deps.secrets ?? readEnvSecrets;
    return read(stored.worktree, config.worktree.files);
  }

  #warn(message: string, run: string, error: unknown): void {
    this.#deps.warn?.(message, {
      run,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
