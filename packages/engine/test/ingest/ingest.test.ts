// Ingestion of worker events from stored offsets (DIPO-45): recordings through the real Claude
// parser, scripts through `ScriptedWorker`, all on the manual clock.

import { describe, expect, it } from "bun:test";
import { appendFileSync, readFileSync, renameSync, truncateSync, writeFileSync } from "node:fs";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  FILE_CHANGED_CODE,
  fileChangedRuns,
  type FileChangedReport,
  type IngestAdapter,
  Ingestor,
  type IngestedExit,
} from "../../src/ingest/ingestor";
import { toolLine } from "../../src/ingest/output";
import {
  type ClaudeParseState,
  currentTotals,
  initialState,
  interpret,
} from "../../src/workers/claude-cli/interpret";
import type { HostLine, ParseState, UsageTotalsByModel } from "../../src/workers/types";
import { loadRecording, plannedModel } from "../workers/replay";
import { SCRIPTS, scriptedWorker } from "../workers/scripts";
import { countRows } from "../commands/helpers";
import {
  appendLines,
  eventFileText,
  hostLines,
  type IngestFixture,
  ingestFixture,
  loggedEvents,
  storedOutput,
  target,
  totalsOf,
  typesOf,
} from "./helpers";

const claude: IngestAdapter = {
  interpret: (line, state) =>
    interpret(line, state as unknown as ReturnType<typeof initialState>) as unknown as {
      events: [];
      state: ParseState;
    },
};

type Json = Record<string, unknown>;

function stdoutObjects(name: string): Json[] {
  return loadRecording(name)
    .lines.filter((line) => line.ch === "stdout" && typeof line.data === "object")
    .map((line) => line.data as Json);
}

/** The last result's cumulative `modelUsage`, in adapter units. */
function finalModelUsage(name: string): UsageTotalsByModel {
  const results = stdoutObjects(name).filter((message) => message["type"] === "result");
  const last = results[results.length - 1] ?? {};
  const out: Record<string, UsageTotalsByModel[string]> = {};
  for (const [model, raw] of Object.entries((last["modelUsage"] ?? {}) as Record<string, Json>)) {
    out[model] = {
      input: raw["inputTokens"] as number,
      output: raw["outputTokens"] as number,
      cacheCreate: raw["cacheCreationInputTokens"] as number,
      cacheRead: raw["cacheReadInputTokens"] as number,
    };
  }
  return out;
}

function messageIds(name: string): Set<string> {
  return new Set(
    stdoutObjects(name)
      .filter((message) => message["type"] === "assistant")
      .map((message) => (message["message"] as Json)["id"] as string),
  );
}

function claudeState(name: string): ParseState {
  return initialState({ plannedModel: plannedModel(loadRecording(name)) }) as unknown as ParseState;
}

function expectTotalsMatch(f: IngestFixture, name: string): void {
  const expected = finalModelUsage(name);
  const rows = totalsOf(f.office, f.run);
  expect(rows.map((row) => row.model).toSorted()).toEqual(Object.keys(expected).toSorted());
  for (const row of rows) {
    const want = expected[row.model];
    expect({
      input: row.input,
      output: row.output,
      cacheCreate: row.cache_create,
      cacheRead: row.cache_read,
    }).toEqual(want ?? { input: -1, output: -1, cacheCreate: -1, cacheRead: -1 });
    // Budget tokens: input plus output plus cache creation; cache reads never count.
    expect(row.budget_used).toBe(row.input + row.output + row.cache_create);
  }
}

describe("replaying success-tools-subagent", () => {
  const NAME = "success-tools-subagent";

  it("stores usage equal to the recording, final totals, a daily rollup and work events", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      writeFileSync(f.eventFile, eventFileText(loadRecording(NAME)));
      const ingestor = new Ingestor({
        office: f.office,
        clock: f.t.clock,
        pricing: f.t.state.pricing,
      });
      const result = ingestor.track(target(f, claude, claudeState(NAME)));
      expect(result.status).toBe("ended");
      expect(result.offset).toBe(readFileSync(f.eventFile).byteLength);

      expectTotalsMatch(f, NAME);
      expect(countRows(f.office, "usage_messages")).toBe(messageIds(NAME).size);
      const rows = totalsOf(f.office, f.run);
      expect(rows.every((row) => row.final === 1)).toBe(true);
      expect(rows.reduce((sum, row) => sum + row.turns, 0)).toBe(6); // num_turns 4 + 2

      const daily = f.office.all<{ input: number; runs: number; cache_read: number }>(
        "select input, runs, cache_read from usage_daily where office_id = $office_id",
      );
      expect(daily.map((row) => row.input)).toEqual(rows.map((row) => row.input));
      expect(daily.every((row) => row.runs === 1)).toBe(true);

      const agent = f.office.get<{
        session_id: string;
        model: string;
        ended_at: number;
        adapter_version: string;
      }>(
        "select session_id, model, ended_at, adapter_version from agents where office_id = $office_id",
      );
      expect(agent?.session_id).toBe("session-1");
      // The adapter's version under the neutral column (DIPO-101), from `system/init`.
      expect(agent?.adapter_version).toBe("2.1.296");
      expect(agent?.model).toBe("claude-haiku-5-5");
      expect(agent?.ended_at).toBe(f.t.clock.now());

      const events = loggedEvents(f.office);
      // Everything rendered through the contract; output first, then the final usage.
      expect(events.map((event) => event.type)).toEqual(["work.output", "usage.updated"]);
      const usage = events[1]?.data as {
        usage: { run: { inputTokens: number }; budget: { used: number } };
      };
      const sum = rows.reduce((total, row) => total + row.budget_used, 0);
      expect(usage.usage.budget.used).toBe(sum);
      const output = events[0]?.data as { from: number; to: number; text: string };
      expect(output.from).toBe(0);
      expect(output.text).toBe(storedOutput(f.office, f.run));
      ingestor.close();
    }));

  it("stores assistant text and one line per tool call, never tool inputs or results", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      writeFileSync(f.eventFile, eventFileText(loadRecording(NAME)));
      new Ingestor({ office: f.office, clock: f.t.clock, pricing: f.t.state.pricing }).track(
        target(f, claude, claudeState(NAME)),
      );
      const stored = storedOutput(f.office, f.run);

      const messages = stdoutObjects(NAME);
      const toolUses: { name: string; input: Json; parent: unknown }[] = [];
      const results: string[] = [];
      for (const message of messages) {
        const content = ((message["message"] as Json | undefined)?.["content"] ?? []) as Json[];
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block["type"] === "tool_use") {
            toolUses.push({
              name: block["name"] as string,
              input: block["input"] as Json,
              parent: message["parent_tool_use_id"],
            });
          }
          if (block["type"] === "tool_result") {
            const body = block["content"];
            results.push(typeof body === "string" ? body : JSON.stringify(body));
          }
        }
      }
      const mainCalls = toolUses.filter(
        (use) => use.parent === null && use.name !== "StructuredOutput",
      );
      expect(mainCalls.length).toBeGreaterThan(0);
      for (const call of mainCalls) {
        const path = call.input["file_path"] ?? call.input["path"];
        expect(stored).toContain(toolLine(call.name, typeof path === "string" ? path : undefined));
      }
      // No input value other than the target path, and no tool result, is stored.
      for (const call of toolUses) {
        for (const [field, value] of Object.entries(call.input)) {
          if (["file_path", "path", "notebook_path"].includes(field)) continue;
          const text = typeof value === "string" ? value : JSON.stringify(value);
          if (text.length >= 8) expect(stored).not.toContain(text);
        }
      }
      for (const result of results) {
        if (result.length >= 8) expect(stored).not.toContain(result);
      }
    }));

  it("stores message output and the 5 minute and 1 hour cache-creation split", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      writeFileSync(f.eventFile, eventFileText(loadRecording(NAME)));
      new Ingestor({ office: f.office, clock: f.t.clock, pricing: f.t.state.pricing }).track(
        target(f, claude, claudeState(NAME)),
      );
      // The first line per message id is the one counted (0008 section 4).
      const expected = new Map<string, Json>();
      for (const message of stdoutObjects(NAME)) {
        if (message["type"] !== "assistant") continue;
        const inner = message["message"] as Json;
        if (!expected.has(inner["id"] as string)) {
          expected.set(inner["id"] as string, inner["usage"] as Json);
        }
      }
      const rows = f.office.all<{
        message_id: string;
        output: number;
        cache_create: number;
        cache_create_5m: number;
        cache_create_1h: number;
      }>(
        `select message_id, output, cache_create, cache_create_5m, cache_create_1h
         from usage_messages where office_id = $office_id`,
      );
      expect(rows.length).toBe(expected.size);
      let oneHour = 0;
      for (const row of rows) {
        const usage = expected.get(row.message_id) ?? {};
        const split = (usage["cache_creation"] ?? {}) as Json;
        expect(row.output).toBe(usage["output_tokens"] as number);
        expect(row.cache_create_1h).toBe(split["ephemeral_1h_input_tokens"] as number);
        expect(row.cache_create_5m + row.cache_create_1h).toBe(row.cache_create);
        oneHour += row.cache_create_1h;
      }
      expect(oneHour).toBeGreaterThan(0);
      const totals = f.office.get<{ h: number }>(
        "select sum(cache_create_1h) as h from usage_totals where office_id = $office_id",
      );
      expect(totals?.h).toBe(oneHour);
      const daily = f.office.get<{ h: number }>(
        "select sum(cache_create_1h) as h from usage_daily where office_id = $office_id",
      );
      expect(daily?.h).toBe(oneHour);
    }));
});

describe("cache-creation parts add up to the total", () => {
  for (const name of ["success-tools-subagent", "pause-now"]) {
    it(`${name}: in usage_messages, usage_totals and usage_daily after replay`, () =>
      withTempDir(async (dir) => {
        const f = await ingestFixture(dir);
        writeFileSync(f.eventFile, eventFileText(loadRecording(name)));
        expect(
          new Ingestor({ office: f.office, clock: f.t.clock, pricing: f.t.state.pricing }).track(
            target(f, claude, claudeState(name)),
          ).status,
        ).toBe("ended");
        for (const table of ["usage_messages", "usage_totals", "usage_daily"]) {
          const rows = f.office.all<{ c: number; m5: number; h1: number }>(
            `select cache_create as c, cache_create_5m as m5, cache_create_1h as h1
             from ${table} where office_id = $office_id`,
          );
          expect(rows.length).toBeGreaterThan(0);
          for (const row of rows) {
            expect(row.m5 + row.h1).toBe(row.c);
            expect(Math.min(row.m5, row.h1)).toBeGreaterThanOrEqual(0);
          }
        }
        // The adapter's own run totals (pause-now keeps the aborted turn's spend, DIPO-42).
        let state = claudeState(name) as unknown as ClaudeParseState;
        for (const line of hostLines(loadRecording(name))) state = interpret(line, state).state;
        const want = currentTotals(state);
        for (const row of totalsOf(f.office, f.run)) {
          expect(row.cache_create).toBe(want[row.model]?.cacheCreate ?? -1);
          expect(row.input).toBe(want[row.model]?.input ?? -1);
        }
      }));
  }

  it("the database refuses a totals row whose parts do not add up", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      writeFileSync(f.eventFile, eventFileText(loadRecording("success-single")));
      new Ingestor({ office: f.office, clock: f.t.clock, pricing: f.t.state.pricing }).track(
        target(f, claude, claudeState("success-single")),
      );
      expect(() =>
        f.office.run(
          "update usage_totals set cache_create = cache_create + 1 where office_id = $office_id",
        ),
      ).toThrow("CHECK constraint failed");
    }));
});

describe("offsets", () => {
  const NAME = "success-tools-subagent";

  it("stopping mid-file and restarting gives no duplicate usage and the same totals", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      const text = eventFileText(loadRecording(NAME));
      const bytes = Buffer.from(text);
      const half = Math.floor(bytes.byteLength / 2);
      writeFileSync(f.eventFile, bytes.subarray(0, half)); // ends inside a line

      const first = new Ingestor({
        office: f.office,
        clock: f.t.clock,
        pricing: f.t.state.pricing,
      });
      const partial = first.track(target(f, claude, claudeState(NAME)));
      expect(partial.status).toBe("ingested");
      expect(partial.offset).toBeLessThan(half);
      expect(bytes[partial.offset - 1]).toBe(0x0a); // a partial last line waits
      first.close();

      appendFileSync(f.eventFile, bytes.subarray(half));
      const second = new Ingestor({
        office: f.office,
        clock: f.t.clock,
        pricing: f.t.state.pricing,
      });
      expect(second.track(target(f, claude, claudeState(NAME))).status).toBe("ended");
      expectTotalsMatch(f, NAME);
      expect(countRows(f.office, "usage_messages")).toBe(messageIds(NAME).size);
      // The output range continues where the first ingestor stopped: no gap, no repeat.
      const outputs = loggedEvents(f.office)
        .filter((event) => event.type === "work.output")
        .map((event) => event.data as { from: number; to: number; text: string });
      expect(outputs.map((o) => o.text).join("")).toBe(storedOutput(f.office, f.run));
      for (let i = 1; i < outputs.length; i++) {
        expect(outputs[i]?.from).toBe(outputs[i - 1]?.to ?? -1);
      }
      second.close();
    }));

  it("a crash inside a pass commits nothing, and the next pass neither skips nor repeats", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      writeFileSync(f.eventFile, eventFileText(loadRecording(NAME)));
      let calls = 0;
      const crashing: IngestAdapter = {
        interpret: (line, state) => {
          calls += 1;
          if (calls === 60) throw new Error("daemon died");
          return claude.interpret(line, state);
        },
      };
      const ingestor = new Ingestor({
        office: f.office,
        clock: f.t.clock,
        pricing: f.t.state.pricing,
      });
      expect(() => ingestor.track(target(f, crashing, claudeState(NAME)))).toThrow("daemon died");
      expect(countRows(f.office, "usage_messages")).toBe(0);
      expect(countRows(f.office, "output_chunks")).toBe(0);
      expect(
        f.office.get<{ processed_offset: number }>(
          "select processed_offset from worker_hosts where office_id = $office_id",
        )?.processed_offset,
      ).toBe(0);
      expect(ingestor.pass(f.run, f.agent).status).toBe("ended");
      expectTotalsMatch(f, NAME);
      expect(countRows(f.office, "usage_messages")).toBe(messageIds(NAME).size);
    }));
});

describe("debounce on the manual clock", () => {
  const script = SCRIPTS["output-and-usage"] ?? [];
  const lines = (): HostLine[] => scriptedWorker({ script }).lines();
  const scripted = () => scriptedWorker({ script });

  it("work.output after 250 ms, usage.updated at most once per second, 16 KiB at once", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      const all = lines();
      const ingestor = new Ingestor({
        office: f.office,
        clock: f.t.clock,
        pricing: f.t.state.pricing,
      });
      appendLines(f.eventFile, all.slice(0, 3)); // started, text activity, small output
      ingestor.track(target(f, scripted(), { events: [] }));
      expect(typesOf(f.office)).toEqual([]);
      f.t.clock.advance(249);
      expect(typesOf(f.office)).toEqual([]);
      f.t.clock.advance(1);
      expect(typesOf(f.office)).toEqual(["work.output"]);

      appendLines(f.eventFile, all.slice(3, 4)); // first usage: sent at once
      ingestor.announce(f.run, f.agent);
      expect(typesOf(f.office)).toEqual(["work.output", "usage.updated"]);

      f.t.clock.advance(100);
      appendLines(f.eventFile, all.slice(4, 5)); // second usage within the second: held
      ingestor.announce(f.run, f.agent);
      expect(typesOf(f.office)).toEqual(["work.output", "usage.updated"]);
      f.t.clock.advance(899);
      expect(typesOf(f.office)).toEqual(["work.output", "usage.updated"]);
      f.t.clock.advance(1);
      expect(typesOf(f.office)).toEqual(["work.output", "usage.updated", "usage.updated"]);
      const last = loggedEvents(f.office)[2]?.data as {
        usage: {
          agent: { inputTokens: number; cacheReadTokens: number };
          budget: { used: number };
        };
      };
      expect(last.usage.agent.inputTokens).toBe(5);
      expect(last.usage.agent.cacheReadTokens).toBe(110);
      expect(last.usage.budget.used).toBe(5 + 110); // cache reads are not counted

      appendLines(f.eventFile, all.slice(5, 7)); // more than 16 KiB of output: flushed at once
      ingestor.announce(f.run, f.agent);
      expect(typesOf(f.office).at(-1)).toBe("work.output");
      const big = loggedEvents(f.office).at(-1)?.data as { from: number; to: number };
      expect(big.to - big.from).toBeGreaterThanOrEqual(16 * 1024);
      ingestor.close();
    }));

  it("a usage.updated whose transaction rolled back is sent again", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      const all = lines();
      const ingestor = new Ingestor({
        office: f.office,
        clock: f.t.clock,
        pricing: f.t.state.pricing,
      });
      appendLines(f.eventFile, all.slice(0, 4));
      ingestor.track(target(f, scripted(), { events: [] }));
      f.t.clock.advance(250);
      expect(typesOf(f.office)).toEqual(["usage.updated", "work.output"]);
      f.t.clock.advance(100);
      appendLines(f.eventFile, all.slice(4, 5)); // held for the interval
      ingestor.announce(f.run, f.agent);

      // The timer's transaction fails: no entry is stored, and the update stays pending.
      const connection = f.t.state.connection;
      connection.immediate(() =>
        connection.exec("alter table change_log rename to change_log_off"),
      );
      expect(() => f.t.clock.advance(900)).toThrow();
      connection.immediate(() =>
        connection.exec("alter table change_log_off rename to change_log"),
      );
      expect(typesOf(f.office)).toEqual(["usage.updated", "work.output"]);

      appendLines(f.eventFile, all.slice(5, 6)); // a line with no usage
      ingestor.announce(f.run, f.agent);
      expect(typesOf(f.office)).toEqual(["usage.updated", "work.output", "usage.updated"]);
      ingestor.close();
    }));

  it("a state change flushes pending output first", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      const ingestor = new Ingestor({
        office: f.office,
        clock: f.t.clock,
        pricing: f.t.state.pricing,
      });
      appendLines(f.eventFile, lines().slice(0, 3));
      ingestor.track(target(f, scripted(), { events: [] }));
      expect(typesOf(f.office)).toEqual([]);
      const cursor = ingestor.flushOutput(f.run);
      expect(cursor?.seq).toBe(1);
      expect(typesOf(f.office)).toEqual(["work.output"]);
      f.t.clock.advance(1000); // the cancelled timer adds nothing
      expect(typesOf(f.office)).toEqual(["work.output"]);
      ingestor.close();
    }));

  it("a session run stores output and usage but writes no work event", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      appendLines(f.eventFile, lines());
      const ingestor = new Ingestor({
        office: f.office,
        clock: f.t.clock,
        pricing: f.t.state.pricing,
      });
      expect(ingestor.track(target(f, scripted(), { events: [] }, { work: false })).status).toBe(
        "ended",
      );
      expect(countRows(f.office, "usage_messages")).toBe(2);
      expect(storedOutput(f.office, f.run)).toContain("Reading the greeter.");
      expect(typesOf(f.office)).toEqual([]);
    }));
});

describe("triggers", () => {
  it("without an advanced announcement, the 1 s stat poll picks up appended lines", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      const all = scriptedWorker({ script: SCRIPTS["done"] ?? [] }).lines();
      const ingestor = new Ingestor({
        office: f.office,
        clock: f.t.clock,
        pricing: f.t.state.pricing,
      });
      ingestor.track(target(f, scriptedWorker({ script: SCRIPTS["done"] ?? [] }), { events: [] }));
      appendLines(f.eventFile, all.slice(0, 3));
      f.t.clock.advance(999);
      expect(countRows(f.office, "usage_messages")).toBe(0);
      f.t.clock.advance(1);
      expect(countRows(f.office, "usage_messages")).toBe(1);
      appendLines(f.eventFile, all.slice(3));
      f.t.clock.advance(1000);
      expect(
        f.office.get<{ ended_at: number | null }>(
          "select ended_at from ingest_cursors where office_id = $office_id",
        )?.ended_at,
      ).not.toBeNull();
      expect(f.t.clock.pendingTimers).toBe(0); // the poll stops once the worker exited
    }));

  it("an advanced announcement from the host socket starts a pass at once", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      const all = scriptedWorker({ script: SCRIPTS["done"] ?? [] }).lines();
      const ingestor = new Ingestor({
        office: f.office,
        clock: f.t.clock,
        pricing: f.t.state.pricing,
      });
      ingestor.track(target(f, scriptedWorker({ script: SCRIPTS["done"] ?? [] }), { events: [] }));
      const listeners: ((offset: number) => void)[] = [];
      await ingestor.watch(f.run, f.agent, {
        watch: (listener) => {
          listeners.push(listener);
          return Promise.resolve(0);
        },
      });
      appendLines(f.eventFile, all.slice(0, 3));
      for (const listener of listeners) listener(readFileSync(f.eventFile).byteLength);
      expect(countRows(f.office, "usage_messages")).toBe(1);
      ingestor.close();
    }));
});

async function ingestHalf(dir: string) {
  const f = await ingestFixture(dir);
  const all = scriptedWorker({ script: SCRIPTS["done"] ?? [] }).lines();
  const reports: FileChangedReport[] = [];
  const ingestor = new Ingestor({
    office: f.office,
    clock: f.t.clock,
    pricing: f.t.state.pricing,
    hooks: { onFileChanged: (report) => reports.push(report) },
  });
  appendLines(f.eventFile, all.slice(0, 4));
  ingestor.track(target(f, scriptedWorker({ script: SCRIPTS["done"] ?? [] }), { events: [] }));
  return { f, all, reports, ingestor };
}

describe("a changed host event file", () => {
  it("a truncated file reports ingest.fileChanged and ingests nothing more for that run", () =>
    withTempDir(async (dir) => {
      const { f, all, reports, ingestor } = await ingestHalf(dir);
      const before = countRows(f.office, "usage_messages");
      truncateSync(f.eventFile, 10);
      f.t.clock.advance(1000);
      expect(reports).toEqual([
        {
          run: f.run,
          agent: f.agent,
          path: f.eventFile,
          detail: expect.stringContaining("below the processed offset") as unknown as string,
        },
      ]);
      const notice = loggedEvents(f.office).find((event) => event.type === "engine.notice");
      expect(notice?.data).toMatchObject({ level: "warn", code: FILE_CHANGED_CODE });
      // Pending output went out before the notice (a state change flushes output first).
      expect(typesOf(f.office).indexOf("work.output")).toBeLessThan(
        typesOf(f.office).indexOf("engine.notice"),
      );
      expect(fileChangedRuns(f.office).map((report) => report.run)).toEqual([f.run]);

      appendLines(f.eventFile, all);
      f.t.clock.advance(5000);
      expect(ingestor.pass(f.run, f.agent).status).toBe("stopped");
      expect(countRows(f.office, "usage_messages")).toBe(before);
      expect(reports.length).toBe(1);

      // A new ingestor after a restart does not resume it either.
      const again = new Ingestor({
        office: f.office,
        clock: f.t.clock,
        pricing: f.t.state.pricing,
      });
      expect(
        again.track(target(f, scriptedWorker({ script: SCRIPTS["done"] ?? [] }), { events: [] }))
          .status,
      ).toBe("stopped");
      expect(countRows(f.office, "usage_messages")).toBe(before);
    }));

  it("a file with another identity reports ingest.fileChanged", () =>
    withTempDir(async (dir) => {
      const { f, reports } = await ingestHalf(dir);
      const copy = `${f.eventFile}.new`;
      writeFileSync(copy, `${readFileSync(f.eventFile, "utf8")}\n`);
      renameSync(copy, f.eventFile);
      f.t.clock.advance(1000);
      expect(reports.map((report) => report.detail)).toEqual(["event file replaced"]);
    }));

  it("a file rewritten in place before the offset reports ingest.fileChanged", () =>
    withTempDir(async (dir) => {
      const { f, reports } = await ingestHalf(dir);
      const text = readFileSync(f.eventFile, "utf8");
      // Same size and inode, but the last processed line no longer matches its hash.
      const at = text.lastIndexOf('{"t":') + 5;
      writeFileSync(f.eventFile, `${text.slice(0, at)}9${text.slice(at + 1)}`);
      f.t.clock.advance(1000);
      expect(reports.map((report) => report.detail)).toEqual([
        "event file rewritten before the processed offset",
      ]);
    }));

  it("a file replaced before its first complete line reports ingest.fileChanged", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      writeFileSync(f.eventFile, '{"t":0,"ch":"stdout"'); // a partial first line
      const reports: FileChangedReport[] = [];
      const ingestor = new Ingestor({
        office: f.office,
        clock: f.t.clock,
        pricing: f.t.state.pricing,
        hooks: { onFileChanged: (report) => reports.push(report) },
      });
      const worker = scriptedWorker({ script: SCRIPTS["done"] ?? [] });
      expect(ingestor.track(target(f, worker, { events: [] })).status).toBe("idle");
      const copy = `${f.eventFile}.new`;
      writeFileSync(copy, "");
      appendLines(copy, worker.lines());
      renameSync(copy, f.eventFile);
      f.t.clock.advance(1000);
      expect(reports.map((report) => report.detail)).toEqual(["event file replaced"]);
      expect(countRows(f.office, "usage_messages")).toBe(0);
    }));
});

describe("init rejection", () => {
  it("records the reason on the agent and reports it so the worker is stopped at once", () =>
    withTempDir(async (dir) => {
      const NAME = "init-rejected";
      const f = await ingestFixture(dir);
      writeFileSync(f.eventFile, eventFileText(loadRecording(NAME)));
      const rejected: string[] = [];
      const ingestor = new Ingestor({
        office: f.office,
        clock: f.t.clock,
        pricing: f.t.state.pricing,
        hooks: { onInitRejected: (_run, _agent, reason) => rejected.push(reason) },
      });
      ingestor.track(target(f, claude, claudeState(NAME)));
      expect(rejected.length).toBe(1);
      expect(
        f.office.get<{ init_rejected: string }>(
          "select init_rejected from agents where office_id = $office_id",
        )?.init_rejected,
      ).toBe(rejected[0] ?? "");
      expect(hostLines(loadRecording(NAME)).length).toBeGreaterThan(0);
    }));
});

/** The exit columns of the fixture host's row (DIPO-88). */
function hostExit(f: Awaited<ReturnType<typeof ingestFixture>>) {
  return f.office.get<{
    exit_code: number | null;
    exit_signal: string | null;
    exit_signal_inferred: number;
  }>(
    `select exit_code, exit_signal, exit_signal_inferred from worker_hosts
      where office_id = $office_id and run_id = $run`,
    { run: f.run },
  );
}

describe("exit signal (DIPO-88)", () => {
  it("copies an inferred SIGTERM from the exit line to worker_hosts with its mark", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      const ended: IngestedExit[] = [];
      const worker = scriptedWorker({
        script: SCRIPTS["done"] ?? [],
        exit: { code: 143, signal: "SIGTERM", signalInferred: true },
      });
      appendLines(f.eventFile, worker.lines());
      const ingestor = new Ingestor({
        office: f.office,
        clock: f.t.clock,
        pricing: f.t.state.pricing,
        hooks: { onEnded: (_run, _agent, end) => ended.push(end) },
      });
      expect(ingestor.track(target(f, worker, { events: [] })).status).toBe("ended");
      expect(hostExit(f)).toEqual({
        exit_code: 143,
        exit_signal: "SIGTERM",
        exit_signal_inferred: 1,
      });
      expect(ended.map((end) => end.exit)).toEqual([
        { code: 143, signal: "SIGTERM", signalInferred: true },
      ]);
    }));

  it("keeps exit_signal null for a worker that exits on its own", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      const worker = scriptedWorker({ script: SCRIPTS["done"] ?? [] });
      appendLines(f.eventFile, worker.lines());
      const ingestor = new Ingestor({
        office: f.office,
        clock: f.t.clock,
        pricing: f.t.state.pricing,
      });
      expect(ingestor.track(target(f, worker, { events: [] })).status).toBe("ended");
      expect(hostExit(f)).toEqual({ exit_code: 0, exit_signal: null, exit_signal_inferred: 0 });
    }));
});
