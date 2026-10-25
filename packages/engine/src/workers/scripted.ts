// A Worker for engine tests that need no Claude detail (0017 section 2, option B): it plays a
// short list of Worker events through the Worker interface, so the engine reads them as it reads
// a real adapter. A script must never hold an event the real adapter could not produce, so the
// constructor requires that adapter's event schema and refuses a script that fails it; the
// contract test checks every registered script against the Claude CLI adapter's schema.
// `result` is a simplified reading of the script (done, blocked with its park, else crashed),
// not the adapter's 0008 section 7 table; pass `result` to set any other outcome.

import type {
  AdapterStatus,
  ExitRecord,
  HostLine,
  HostOp,
  LaunchPlan,
  ParseState,
  ResumeCheck,
  SteerOp,
  UsageTotalsByModel,
  WorkerAdapter,
  WorkerEvent,
  WorkerResult,
  WorkerSpec,
} from "./types";

/** Anything with a zod-like `safeParse`; keeps this file free of adapter imports. */
export interface EventSchema {
  safeParse(value: unknown): { readonly success: boolean };
}

export interface ScriptedWorkerOptions {
  readonly script: readonly WorkerEvent[];
  /** How the scripted process ends; default exit 0. */
  readonly exit?: ExitRecord;
  /** Default `session-scripted`. */
  readonly sessionId?: string;
  /** Fields that replace the result derived from the script. */
  readonly result?: Partial<WorkerResult>;
  /** The real adapter's event schema (`ClaudeWorkerEventSchema` in M0); every event must pass. */
  readonly schema: EventSchema;
}

export class ScriptError extends Error {
  override readonly name = "ScriptError";
}

/** Indexes and `t` of the script events the schema rejects. */
export function scriptProblems(script: readonly WorkerEvent[], schema: EventSchema): string[] {
  const problems: string[] = [];
  script.forEach((event, index) => {
    if (!schema.safeParse(event).success) problems.push(`event ${index} (${event.t})`);
  });
  return problems;
}

interface ScriptedState {
  readonly events: readonly WorkerEvent[];
  readonly [key: string]: unknown;
}

function asState(state: ParseState): ScriptedState {
  const events = state["events"];
  return { events: Array.isArray(events) ? (events as WorkerEvent[]) : [] };
}

export class ScriptedWorker implements WorkerAdapter {
  readonly id = "scripted";
  readonly script: readonly WorkerEvent[];
  readonly #exit: ExitRecord;
  readonly #sessionId: string;
  readonly #override: Partial<WorkerResult>;
  /** Steering ops the engine sent, in order. */
  readonly steered: SteerOp[] = [];

  constructor(options: ScriptedWorkerOptions) {
    const problems = scriptProblems(options.script, options.schema);
    if (problems.length > 0) {
      throw new ScriptError(
        `script holds events the adapter cannot produce: ${problems.join(", ")}`,
      );
    }
    this.script = options.script;
    this.#exit = options.exit ?? { code: 0, signal: null };
    this.#sessionId = options.sessionId ?? "session-scripted";
    this.#override = options.result ?? {};
  }

  probe(): Promise<AdapterStatus> {
    return Promise.resolve({ ok: true, version: "scripted", login: null, capabilities: [] });
  }

  plan(spec: WorkerSpec): LaunchPlan {
    return { argv: ["/usr/bin/true"], env: {}, cwd: spec.workdir, files: [], stdin: [] };
  }

  encode(op: SteerOp): HostOp[] {
    this.steered.push(op);
    return [];
  }

  /** The host lines a worker host would have written: one per event, then the exit. */
  lines(): HostLine[] {
    return [
      ...this.script.map((event, index) => ({
        t: index,
        ch: "stdout",
        data: JSON.stringify(event),
      })),
      { t: this.script.length, ch: "exit", data: JSON.stringify(this.#exit) },
    ];
  }

  /** The exit record the script ends with. */
  get exit(): ExitRecord {
    return this.#exit;
  }

  interpret(line: HostLine, state: ParseState): { events: WorkerEvent[]; state: ParseState } {
    const current = asState(state);
    if (line.ch !== "stdout") return { events: [], state: current };
    const event = JSON.parse(line.data) as WorkerEvent;
    return { events: [event], state: { events: [...current.events, event] } };
  }

  result(state: ParseState, exit: ExitRecord): WorkerResult {
    const events = asState(state).events;
    let usage: UsageTotalsByModel = {};
    let last: Extract<WorkerEvent, { t: "turn" }> | undefined;
    for (const event of events) {
      if (event.t === "turn") {
        last = event;
        usage = event.totals;
      }
    }
    const report = last?.report ?? null;
    const base: WorkerResult =
      exit.signal !== null || exit.code !== 0 || report === null
        ? {
            outcome: "crashed",
            report,
            usage,
            sessionId: this.#sessionId,
            resumable: true,
            park: { reason: "worker-failed", detail: "scripted crash" },
          }
        : report.status === "done"
          ? { outcome: "done", report, usage, sessionId: this.#sessionId, resumable: true }
          : {
              outcome: "blocked",
              report,
              usage,
              sessionId: this.#sessionId,
              resumable: true,
              park: { reason: "ambiguous-spec", detail: report.question ?? report.summary },
            };
    return { ...base, ...this.#override };
  }

  canResume(): ResumeCheck {
    return { ok: true };
  }
}
