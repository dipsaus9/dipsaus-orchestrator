// A run's web calls (0020): counted by tool from the worker's own tool activity, as
// `runs.web_searches` and `runs.web_fetches` (the run's outcome row copies them), and shown in the
// worker output as `[web] <tool> <query or URL>`. Before such a line is stored (`output_chunks`, and
// the `work.output` change-log entries read from it), every value of the office's env files is
// replaced by `[redacted]` (`env-secrets.ts`). The adapter's line holds the query or URL
// whole; it is cut to `INPUT_MAX_CHARS`, as other tool inputs, only after the redaction, so a value
// across the cut leaves no prefix. The raw `events.ndjson` of the run keeps the call as the worker
// wrote it, as it keeps every tool input (0007).

import type { OfficeId, RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import { oneLineInput } from "../ingest/output";
import { WEB_LINE_PREFIX, type WorkerEvent } from "../workers/types";
import {
  type EnvSecret,
  type EnvSecretsReader,
  officeEnvSecrets,
  REDACTED_TEXT,
  redactSecrets,
} from "./env-secrets";
import { countWebCalls, findRun } from "./records";

/** Pure: the web calls among `events`, from the web call the adapter names on each tool activity. */
export function webCallCounts(events: readonly WorkerEvent[]): {
  readonly searches: number;
  readonly fetches: number;
} {
  const counts = { searches: 0, fetches: 0 };
  for (const event of events) {
    if (event.t !== "activity" || event.kind !== "tool") continue;
    if (event.web === "search") counts.searches += 1;
    else if (event.web === "fetch") counts.fetches += 1;
  }
  return counts;
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

export interface WebCallsDeps {
  readonly offices: { config(office: OfficeId): OfficeConfig | undefined };
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
  /** The office's main checkout, where its env files are read; undefined when it is not known. */
  readonly checkout: (office: OfficeId) => string | undefined;
  /** Reads the secrets of a checkout; the env files by default. Tests replace it. */
  readonly secrets?: EnvSecretsReader;
}

/** Counts the run's web calls and redacts its stored web lines (file comment). */
export class WebCalls {
  readonly #deps: WebCallsDeps;

  constructor(deps: WebCallsDeps) {
    this.#deps = deps;
  }

  /** The events of one committed ingestion pass of `office`'s run `run` (`OfficeIngest`). */
  onWorkerEvents(
    office: OfficeHandle,
    run: string,
    _agent: string,
    events: readonly WorkerEvent[],
  ): void {
    const counts = webCallCounts(events);
    if (counts.searches === 0 && counts.fetches === 0) return;
    try {
      office.immediate(() => countWebCalls(office, run, counts));
    } catch (error) {
      this.#warn("the web calls could not be counted", run, error);
    }
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

  /** The env values of the run's office. Throws when they cannot be read. */
  #secrets(office: OfficeHandle, run: string): EnvSecret[] {
    const stored = findRun(office, run as RunId);
    const config = this.#deps.offices.config(office.officeId);
    if (stored === null || config === undefined) {
      throw new Error("the run or the office configuration is not known");
    }
    return officeEnvSecrets(
      this.#deps.checkout(office.officeId),
      config.box.files ?? [],
      this.#deps.secrets,
    );
  }

  #warn(message: string, run: string, error: unknown): void {
    this.#deps.warn?.(message, {
      run,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
