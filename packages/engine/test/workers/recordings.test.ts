// Every committed Claude recording replayed through the fake process and the real adapter
// (0017 section 2; DIPO-42 test plan): it parses with the adapter schema, it gives the outcome and
// proposed park its `meta.json` describes, and the usage arithmetic matches the numbers in it.

import { describe, expect, it } from "bun:test";

import { KNOWN_PARK_REASONS } from "@dipsaus-orchestrator/contract";
import type { Recording } from "@dipsaus-orchestrator/testkit";

import { budgetTokens, initialState, interpret } from "../../src/workers/claude-cli/interpret";
import { ClaudeWorkerEventSchema, schemaFor } from "../../src/workers/claude-cli/schema";
import type {
  ModelUsageTotals,
  UsageTotalsByModel,
  WorkerOutcome,
  WorkerResult,
} from "../../src/workers/types";
import { hostLines } from "../ingest/helpers";
import { loadRecording, recordingNames, replay } from "./replay";

type Expectation = readonly [outcome: WorkerOutcome, park: string | null];

/** The adapter's reading of each recording when no intent is recorded (0008 section 7). */
const EXPECTED: Readonly<Record<string, Expectation>> = {
  "budget-engine-cap": ["done", null],
  "crash-truncated": ["crashed", "worker-failed"],
  "crash-zeroed": ["crashed", "worker-failed"],
  "init-rejected": ["initRejected", "worker-failed"],
  "init-rejected-model": ["initRejected", "worker-failed"],
  interrupt: ["crashed", "worker-failed"],
  "max-turns": ["capped", "budget-exceeded"],
  "model-switch": ["done", null],
  "pause-now": ["blocked", "ambiguous-spec"],
  // Captured before DIPO-342: the report still holds the permission field the report no
  // longer has, so it is invalid: one correction turn, then worker-failed (as report-invalid).
  "permission-denied": ["blocked", "worker-failed"],
  // The worker reports the fixture question after the denied wait.
  "permission-wait": ["blocked", "ambiguous-spec"],
  "plan-limit-429": ["plan-limit", null],
  "plan-limit-rejected": ["plan-limit", null],
  "prompt-too-long": ["capped", "budget-exceeded"],
  // A report that does not parse or match the schema: one correction turn, then worker-failed.
  "report-invalid": ["blocked", "worker-failed"],
  "report-invalid-missing": ["blocked", "worker-failed"],
  resume: ["done", null],
  // DIPO-145: reviewer sessions (0019 sections 4 and 5), derived and live.
  "review-approved": ["done", null],
  "review-blocked": ["done", null],
  "review-invalid": ["blocked", "worker-failed"],
  "review-approved-live": ["done", null],
  "review-blocked-live": ["done", null],
  // Asked not to report, Haiku returned a valid approval anyway; review-invalid covers the case.
  "review-invalid-live": ["done", null],
  "safety-bash-prompts-none": ["blocked", "worker-failed"],
  "safety-gh-token": ["done", null],
  "safety-gitdir-write": ["done", null],
  "safety-main-git": ["done", null],
  // DIPO-108: every installed plugin switched off; only builtin plugins in system/init.
  "safety-plugin-off": ["done", null],
  // DIPO-108 diagnostic: the same switch-off with user settings loaded; synced plugin off too.
  "safety-plugin-off-user-settings": ["done", null],
  "safety-pointer-write": ["done", null],
  // DIPO-130: --disable-slash-commands; a steer "/x" expands no project skill, no hook runs.
  "safety-slash-skill": ["done", null],
  stall: ["done", null],
  "start-failed": ["startFailed", null],
  "start-failed-auth": ["startFailed", null],
  "start-failed-billing": ["startFailed", null],
  "success-single": ["done", null],
  "success-tools-subagent": ["done", null],
  terminated: ["crashed", "worker-failed"],
  // DIPO-164: the third call is refused and the worker reports blocked.
  web: ["blocked", "ambiguous-spec"],
  // DIPO-164: derived from the first turn of success-tools-subagent, whose report says blocked.
  "web-calls": ["blocked", "ambiguous-spec"],
  "worker-park-ambiguous": ["blocked", "ambiguous-spec"],
};

/** The recovery step proposed before the park, where 0008 section 7 asks for one. */
const RETRY: Readonly<Record<string, string>> = {
  "prompt-too-long": "handoff",
  "report-invalid": "report-feedback",
  "report-invalid-missing": "report-feedback",
  "review-invalid": "report-feedback",
  "permission-denied": "report-feedback",
  "safety-bash-prompts-none": "report-feedback",
};

/**
 * Live recordings the maintainer captures on a machine with Claude Code (DIPO-43 AC #8); the
 * table names them already, and the coverage check accepts them as missing until committed.
 */
const AWAITING_CAPTURE = new Set([
  "safety-gh-token",
  "safety-gitdir-write",
  "safety-pointer-write",
]);

/** Scenarios whose park in `meta.expected` the engine decides from its own caps, not the adapter. */
const ENGINE_DECIDED = new Set(["budget-engine-cap"]);

const OUTCOMES: readonly WorkerOutcome[] = [
  "done",
  "blocked",
  "capped",
  "plan-limit",
  "stopped",
  "reassigned",
  "crashed",
  "startFailed",
  "initRejected",
];

/** Park reasons `meta.expected` names as "park X" or "parks X". */
function namedParks(text: string): string[] {
  return [...text.matchAll(/parks? ([a-z-]+)/gi)]
    .map((match) => match[1] ?? "")
    .filter((word) => (KNOWN_PARK_REASONS as readonly string[]).includes(word));
}

/** Outcomes `meta.expected` names as "outcome X" or "outcome is X". */
function namedOutcomes(text: string): string[] {
  return [...text.matchAll(/outcome (?:is )?(\w+)/gi)]
    .map((match) => match[1] ?? "")
    .filter((word) => (OUTCOMES as readonly string[]).includes(word));
}

type Json = Record<string, unknown>;

function stdout(recording: Recording): Json[] {
  return recording.lines
    .filter((line) => line.ch === "stdout" && typeof line.data === "object")
    .map((line) => line.data as Json);
}

function modelUsage(message: Json): UsageTotalsByModel {
  const out: Record<string, ModelUsageTotals> = {};
  for (const [model, entry] of Object.entries(message["modelUsage"] as Record<string, Json>)) {
    out[model] = {
      input: entry["inputTokens"] as number,
      output: entry["outputTokens"] as number,
      cacheCreate: entry["cacheCreationInputTokens"] as number,
      cacheRead: entry["cacheReadInputTokens"] as number,
    };
  }
  return out;
}

/** Deduplicated assistant usage per model, without output (a placeholder per message). */
function assistantUsage(messages: readonly Json[], subagentsOnly = false): UsageTotalsByModel {
  const seen = new Set<string>();
  const out: Record<string, ModelUsageTotals> = {};
  for (const message of messages) {
    if (message["type"] !== "assistant") continue;
    if (subagentsOnly && message["parent_tool_use_id"] === null) continue;
    const inner = message["message"] as Json;
    const id = inner["id"] as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const usage = inner["usage"] as Json;
    const model = inner["model"] as string;
    const before = out[model] ?? { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
    out[model] = {
      input: before.input + (usage["input_tokens"] as number),
      output: 0,
      cacheCreate: before.cacheCreate + (usage["cache_creation_input_tokens"] as number),
      cacheRead: before.cacheRead + (usage["cache_read_input_tokens"] as number),
    };
  }
  return out;
}

function results(recording: Recording): Json[] {
  return stdout(recording).filter((message) => message["type"] === "result");
}

function lastResult(recording: Recording): Json {
  const all = results(recording);
  const last = all[all.length - 1];
  if (last === undefined) throw new Error(`${recording.name}: no result`);
  return last;
}

const names = recordingNames();

describe("committed Claude recordings through the adapter", () => {
  it("cover every recording in the expectation table and nothing else", () => {
    const expected = Object.keys(EXPECTED).filter(
      (name) => names.includes(name) || !AWAITING_CAPTURE.has(name),
    );
    expect(names).toEqual(expected.toSorted());
  });

  for (const name of names) {
    describe(name, () => {
      const recording = loadRecording(name);

      it("(contract) parses with the adapter schema, and every event fits the event schema", async () => {
        for (const message of stdout(recording)) {
          const schema = schemaFor(message as { type: string; subtype?: unknown });
          if (schema !== null) expect(schema.safeParse(message).success).toBe(true);
        }
        const run = await replay(recording);
        expect(run.state.problems).toEqual([]);
        expect(run.state.unknownTypes).toEqual([]);
        for (const event of run.events) {
          expect(ClaudeWorkerEventSchema.safeParse(event).success).toBe(true);
        }
      });

      it("(unit) gives the expected outcome and proposed park", async () => {
        const [outcome, park] = EXPECTED[name] ?? ["?", null];
        const { result } = await replay(recording);
        expect<WorkerResult["outcome"]>(result.outcome).toBe(outcome as WorkerOutcome);
        expect(result.park?.reason ?? null).toBe(park);
        expect(result.sessionId).toBe("session-1");
        expect<string | null>(result.retry ?? null).toBe(RETRY[name] ?? null);

        // What meta.json names must agree with the table.
        const text = recording.meta.expected;
        for (const word of namedOutcomes(text)) expect(word).toBe(outcome);
        if (!ENGINE_DECIDED.has(name)) {
          for (const word of namedParks(text)) expect(word).toBe(park ?? "");
        }
      });
    });
  }
});

describe("usage arithmetic from the recordings", () => {
  it("emits one usage event per message id, and live numbers equal deduplicated messages", async () => {
    for (const name of names) {
      const recording = loadRecording(name);
      const ids = new Set(
        stdout(recording)
          .filter((message) => message["type"] === "assistant")
          .map((message) => (message["message"] as Json)["id"]),
      );
      const run = await replay(recording);
      const usage = run.events.filter((event) => event.t === "usage");
      expect(usage.length).toBe(ids.size);
    }
  });

  it("success-single: the result's modelUsage replaces the live numbers", async () => {
    const recording = loadRecording("success-single");
    const run = await replay(recording);
    expect(run.result.usage).toEqual(modelUsage(lastResult(recording)));
    const turn = run.events.find((event) => event.t === "turn");
    expect(turn?.t === "turn" && turn.totals).toEqual(modelUsage(lastResult(recording)));
  });

  it("success-tools-subagent: subagent usage carries parent_tool_use_id, totals include it", async () => {
    const recording = loadRecording("success-tools-subagent");
    const run = await replay(recording);
    const subagent = assistantUsage(stdout(recording), true);
    const [model = ""] = Object.keys(subagent);
    const fromEvents = run.events
      .filter((event) => event.t === "usage" && event.agentId !== undefined)
      .reduce((sum, event) => sum + (event.t === "usage" ? event.cacheCreate : 0), 0);
    expect(fromEvents).toBe(subagent[model]?.cacheCreate ?? -1);
    expect(fromEvents).toBeGreaterThan(0);
    expect(run.result.usage).toEqual(modelUsage(lastResult(recording)));
    // modelUsage includes the subagent: live main plus subagent equals the first turn's totals.
    const first = results(recording)[0];
    const live = assistantUsage(stdout(recording).slice(0, stdout(recording).indexOf(first ?? {})));
    expect(live[model]?.cacheCreate).toBe(modelUsage(first ?? {})[model]?.cacheCreate ?? -1);
  });

  it("resume: the second process adds only the change since the stored totals", async () => {
    const recording = loadRecording("resume");
    const [first, second] = results(recording);
    const run = await replay(recording);
    const turns = run.events.filter((event) => event.t === "turn");
    expect(turns.length).toBe(2);
    expect(turns[0]?.t === "turn" && turns[0].totals).toEqual(modelUsage(first ?? {}));
    // The resumed CLI totals include the restored spend, so they are the run totals as they are.
    expect(run.result.usage).toEqual(modelUsage(second ?? {}));
  });

  it("resume after a restart: a new run adds only the change since the stored CLI totals", async () => {
    const recording = loadRecording("resume");
    const [first, second] = results(recording);
    const stored = modelUsage(first ?? {});
    const now = modelUsage(second ?? {});
    // Replay only the second process, as a new run that resumes the stored session.
    const secondOnly: Recording = {
      ...recording,
      lines: recording.lines.slice(recording.lines.findIndex((line) => line.ch === "exit") + 1),
      meta: {
        ...recording.meta,
        steering: recording.meta.steering?.filter((steer) => steer.t > 6794) ?? [],
      },
    };
    const run = await replay(secondOnly, {
      state: initialState({ plannedModel: "haiku", baseline: stored }),
    });
    const [model = ""] = Object.keys(now);
    const change = (field: "input" | "output" | "cacheCreate" | "cacheRead") =>
      (now[model]?.[field] ?? 0) - (stored[model]?.[field] ?? 0);
    expect(run.result.usage).toEqual({
      [model]: {
        input: change("input"),
        output: change("output"),
        cacheCreate: change("cacheCreate"),
        cacheRead: change("cacheRead"),
      },
    });
    // Carrying the stored run totals as well gives the session's cumulative totals once.
    const carried = await replay(secondOnly, {
      state: initialState({ plannedModel: "haiku", totals: stored }),
    });
    expect(carried.result.usage).toEqual(now);
  });

  it("crash-zeroed and terminated: usage recovered from earlier assistant messages", async () => {
    for (const name of ["crash-zeroed", "terminated"]) {
      const recording = loadRecording(name);
      const run = await replay(recording);
      expect(run.result.usage).toEqual(assistantUsage(stdout(recording)));
      expect(budgetTokens(run.result.usage)).toBeGreaterThan(0);
    }
  });

  it("pause-now and interrupt: an aborted turn keeps its live usage", async () => {
    const pause = loadRecording("pause-now");
    const messages = stdout(pause);
    const aborted = messages.indexOf(results(pause)[0] ?? {});
    const abortedLive = assistantUsage(messages.slice(0, aborted));
    const run = await replay(pause);
    const last = modelUsage(lastResult(pause));
    const [model = ""] = Object.keys(last);
    expect(run.result.usage[model]).toEqual({
      input: (abortedLive[model]?.input ?? 0) + (last[model]?.input ?? 0),
      output: last[model]?.output ?? 0,
      cacheCreate: (abortedLive[model]?.cacheCreate ?? 0) + (last[model]?.cacheCreate ?? 0),
      cacheRead: (abortedLive[model]?.cacheRead ?? 0) + (last[model]?.cacheRead ?? 0),
    });

    const interrupt = loadRecording("interrupt");
    const interrupted = await replay(interrupt);
    expect(interrupted.result.usage).toEqual(assistantUsage(stdout(interrupt)));
  });

  it("budget-engine-cap: budget tokens pass the test tier budget", async () => {
    const recording = loadRecording("budget-engine-cap");
    const run = await replay(recording);
    const limit = recording.meta.testConfig?.["budgetTokens"];
    expect(typeof limit).toBe("number");
    expect(budgetTokens(run.result.usage)).toBeGreaterThan(limit as number);
  });
});

/**
 * Recordings whose result's `num_turns` the live count does not reach, and why (DIPO-296). Every
 * other recording's live turns at each result are that result's `num_turns`.
 */
const LIVE_TURNS_DIFFER: Readonly<Record<string, string>> = {
  // An account error comes as one assistant message, which the CLI does not count as a turn.
  "start-failed-auth": "start failure",
  "start-failed-billing": "start failure",
  // Derived: three web calls spliced into a turn whose result was copied from the live recording.
  "web-calls": "derived stream",
};

describe("the live turn count from the recordings (DIPO-296)", () => {
  for (const name of recordingNames()) {
    it(`${name}: the live turns at each result are its num_turns`, () => {
      let state = initialState();
      const atResults: { live: number; numTurns: number }[] = [];
      for (const line of hostLines(loadRecording(name))) {
        const live = state.liveTurns ?? 0;
        const step = interpret(line, state);
        for (const event of step.events) {
          if (event.t === "turn") atResults.push({ live, numTurns: event.numTurns });
        }
        state = step.state;
      }
      // Every process exit leaves no live numbers.
      expect(state.liveTurns).toBeUndefined();
      const differ = atResults.filter((turn) => turn.live !== turn.numTurns);
      if (name in LIVE_TURNS_DIFFER) expect(differ.length).toBeGreaterThan(0);
      else expect(differ).toEqual([]);
    });
  }
});
