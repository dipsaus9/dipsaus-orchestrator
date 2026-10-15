// The cost drift warning (DIPO-89): a finished agent whose estimate and CLI cost differ by more
// than 10% is logged as one warn line per model and day, naming the model, both numbers and the
// catalog version. Recordings run through the real Claude parser and the ingestor.

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { type IngestAdapter, Ingestor } from "../../src/ingest/ingestor";
import type { Rates } from "../../src/pricing/catalog";
import { CostDriftWarnings, type CostDrift } from "../../src/pricing/drift";
import type { PriceBook } from "../../src/pricing/estimate";
import { initialState, interpret } from "../../src/workers/claude-cli/interpret";
import type { ParseState } from "../../src/workers/types";
import { eventFileText, type IngestFixture, ingestFixture, target } from "../ingest/helpers";
import { loadRecording, plannedModel } from "../workers/replay";

const claude: IngestAdapter = {
  interpret: (line, state) =>
    interpret(line, state as unknown as ReturnType<typeof initialState>) as unknown as {
      events: [];
      state: ParseState;
    },
};

const DAY_MS = 24 * 60 * 60 * 1000;

interface Warned {
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/** The shipped book with every Haiku 5.5 rate scaled, as a stale catalog would price. */
function scaled(book: PriceBook | null, factor: number, version = "test"): PriceBook {
  const haiku = book?.models.get("claude-haiku-5-5");
  if (haiku === undefined) throw new Error("no Haiku 5.5 rates");
  const scale = (rates: Rates): Rates => ({
    input: Math.round(rates.input * factor),
    output: Math.round(rates.output * factor),
    cacheWrite5m: Math.round(rates.cacheWrite5m * factor),
    cacheWrite1h: Math.round(rates.cacheWrite1h * factor),
    cacheRead: Math.round(rates.cacheRead * factor),
  });
  return {
    version,
    models: new Map([["claude-haiku-5-5", scale(haiku)]]),
    longPrompt: new Map(),
  };
}

interface Replay {
  readonly f: IngestFixture;
  readonly warned: Warned[];
}

/** Replays a recording to its exit, with the given rate factor, shared warnings and day offset. */
async function replay(
  dir: string,
  name: string,
  options: {
    readonly factor?: number;
    readonly drift?: CostDriftWarnings;
    readonly laterMs?: number;
    readonly pricing?: (f: IngestFixture) => PriceBook | null;
  } = {},
): Promise<Replay> {
  mkdirSync(dir, { recursive: true });
  const f = await ingestFixture(dir);
  if (options.laterMs !== undefined) f.t.clock.advance(options.laterMs);
  const recording = loadRecording(name);
  writeFileSync(f.eventFile, eventFileText(recording));
  const warned: Warned[] = [];
  const pricing = options.pricing?.(f) ?? scaled(f.t.state.pricing, options.factor ?? 1, "test");
  new Ingestor({
    office: f.office,
    clock: f.t.clock,
    pricing,
    warn: (message, fields) => warned.push({ message, fields }),
    ...(options.drift === undefined ? {} : { costDrift: options.drift }),
  }).track(
    target(
      f,
      claude,
      initialState({ plannedModel: plannedModel(recording) }) as unknown as ParseState,
    ),
  );
  return { f, warned };
}

const driftLines = (warned: readonly Warned[]) =>
  warned.filter((line) => line.message.startsWith("estimated cost of "));

describe("cost drift warning at an agent's end", () => {
  it("logs one warn line naming the model, both numbers and the catalog version", () =>
    withTempDir(async (dir) => {
      // The stale catalog prices 20% high: 3468.11 * 1.2 is 4162 against the CLI's 3468.
      const { warned } = await replay(dir, "success-tools-subagent", { factor: 1.2 });
      const lines = driftLines(warned);
      expect(lines.length).toBe(1);
      expect(lines[0]?.message).toBe(
        "estimated cost of claude-haiku-5-5 ($0.0042, pricing catalog test) differs 20% from " +
          "the CLI cost ($0.0035)",
      );
      expect(lines[0]?.fields).toMatchObject({
        model: "claude-haiku-5-5",
        estimateUsd: 0.004162,
        cliUsd: 0.003468,
        catalogVersion: "test",
        gapPercent: 20,
      });
    }));

  it("warns once per model and day, across agents and offices, and again the next day", () =>
    withTempDir(async (dir) => {
      const drift = new CostDriftWarnings();
      const first = await replay(join(dir, "a"), "success-tools-subagent", {
        factor: 0.8,
        drift,
      });
      const second = await replay(join(dir, "b"), "success-single", { factor: 0.8, drift });
      const nextDay = await replay(join(dir, "c"), "success-single", {
        factor: 0.8,
        drift,
        laterMs: DAY_MS,
      });
      expect(driftLines(first.warned).length).toBe(1);
      expect(driftLines(second.warned)).toEqual([]);
      expect(driftLines(nextDay.warned).length).toBe(1);
    }));

  it("logs nothing for a gap of 10% or less", () =>
    withTempDir(async (dir) => {
      const { warned } = await replay(dir, "success-tools-subagent", { factor: 1.09 });
      expect(driftLines(warned)).toEqual([]);
    }));

  it("logs nothing with the shipped catalog, whose estimate matches the CLI cost", () =>
    withTempDir(async (dir) => {
      const { warned } = await replay(dir, "success-tools-subagent", {
        pricing: (f) => f.t.state.pricing,
      });
      expect(driftLines(warned)).toEqual([]);
    }));

  it("logs nothing when the agent has no CLI cost to compare (pause-now)", () =>
    withTempDir(async (dir) => {
      const { warned } = await replay(dir, "pause-now", { factor: 2 });
      expect(driftLines(warned)).toEqual([]);
    }));
});

const drift = (model: string): CostDrift => ({
  model,
  estimateMicros: 1_500_000,
  cliMicros: 1_000_000,
  catalogVersion: "2",
});

describe("CostDriftWarnings", () => {
  it("keeps one line per model per UTC day", () => {
    const warnings = new CostDriftWarnings();
    const lines: string[] = [];
    const warn = (message: string) => lines.push(message);
    const day = Date.UTC(2026, 9, 15, 10);
    expect(warnings.report([drift("a"), drift("b")], day, warn).length).toBe(2);
    expect(warnings.report([drift("a")], day + 13 * 60 * 60 * 1000, warn)).toEqual([]);
    expect(warnings.report([drift("a")], day + 14 * 60 * 60 * 1000, warn).length).toBe(1);
    expect(lines).toEqual([
      "estimated cost of a ($1.5000, pricing catalog 2) differs 50% from the CLI cost ($1.0000)",
      "estimated cost of b ($1.5000, pricing catalog 2) differs 50% from the CLI cost ($1.0000)",
      "estimated cost of a ($1.5000, pricing catalog 2) differs 50% from the CLI cost ($1.0000)",
    ]);
  });
});
