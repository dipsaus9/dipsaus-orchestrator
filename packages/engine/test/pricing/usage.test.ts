// Estimated cost of stored usage and the cross-check against the CLI's own cost (DIPO-62,
// 0008 section 4). Recordings run through the real Claude parser and the ingestor.

import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { type IngestAdapter, Ingestor } from "../../src/ingest/ingestor";
import { recordUsageMessage } from "../../src/ingest/usage";
import type { Rates } from "../../src/pricing/catalog";
import type { PriceBook } from "../../src/pricing/estimate";
import { CATALOG_STALE_CODE, costGap, priceAgentUsage } from "../../src/pricing/usage";
import { initialState, interpret } from "../../src/workers/claude-cli/interpret";
import type { ParseState } from "../../src/workers/types";
import {
  eventFileText,
  type IngestFixture,
  ingestFixture,
  loggedEvents,
  target,
} from "../ingest/helpers";
import { loadRecording, plannedModel } from "../workers/replay";

const claude: IngestAdapter = {
  interpret: (line, state) =>
    interpret(line, state as unknown as ReturnType<typeof initialState>) as unknown as {
      events: [];
      state: ParseState;
    },
};

interface PricedRow {
  model: string;
  est_cost_micros: number | null;
  pricing_version: string | null;
  cli_cost_micros: number | null;
}

function pricedRows(f: IngestFixture): PricedRow[] {
  return f.office.all<PricedRow>(
    `select model, est_cost_micros, pricing_version, cli_cost_micros from usage_totals
     where office_id = $office_id and run_id = $run order by model`,
    { run: f.run },
  );
}

function notices(f: IngestFixture): { code: string; text: string }[] {
  return loggedEvents(f.office)
    .filter((event) => event.type === "engine.notice")
    .map((event) => event.data as { code: string; text: string });
}

async function replay(
  dir: string,
  name: string,
  pricing: (f: IngestFixture) => PriceBook | null = (f) => f.t.state.pricing,
  options: { readonly work?: boolean } = {},
): Promise<IngestFixture> {
  const f = await ingestFixture(dir);
  const recording = loadRecording(name);
  writeFileSync(f.eventFile, eventFileText(recording));
  const state = initialState({ plannedModel: plannedModel(recording) }) as unknown as ParseState;
  new Ingestor({ office: f.office, clock: f.t.clock, pricing: pricing(f) }).track(
    target(f, claude, state, options),
  );
  return f;
}

/** The shipped book with every Haiku 5.5 rate scaled, as a stale catalog would price. */
function scaled(book: PriceBook | null, factor: number): PriceBook {
  if (book === null) throw new Error("no catalog imported");
  const haiku = book.models.get("claude-haiku-5-5");
  if (haiku === undefined) throw new Error("no Haiku 5.5 rates");
  const rates: Rates = {
    input: Math.round(haiku.input * factor),
    output: Math.round(haiku.output * factor),
    cacheWrite5m: Math.round(haiku.cacheWrite5m * factor),
    cacheWrite1h: Math.round(haiku.cacheWrite1h * factor),
    cacheRead: Math.round(haiku.cacheRead * factor),
  };
  return { version: "test", models: new Map([["claude-haiku-5-5", rates]]) };
}

describe("estimated cost of a recording", () => {
  it("success-tools-subagent: equals the hand-computed value, with the catalog version", () =>
    withTempDir(async (dir) => {
      const f = await replay(dir, "success-tools-subagent");
      // Final totals: input 12, output 1285, 5 minute writes 5354, 1 hour writes 9730, reads 20916.
      // Claude Haiku 5.5 per million: $0.10, $0.50, $0.125, $0.20, $0.01.
      // 1.2 + 642.5 + 669.25 + 1946 + 209.16 = 3468.11 micro-USD -> 3468.
      expect(pricedRows(f)).toEqual([
        {
          model: "claude-haiku-5-5",
          est_cost_micros: 3468,
          pricing_version: "1",
          // The CLI's costUSD 0.0034681100000000004.
          cli_cost_micros: 3468,
        },
      ]);
      const daily = f.office.get<{ est_cost_micros: number }>(
        "select est_cost_micros from usage_daily where office_id = $office_id",
      );
      expect(daily?.est_cost_micros).toBe(3468);
      expect(notices(f)).toEqual([]);
    }));

  it("is filled at each update, not only at the end", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      const book = f.t.state.pricing;
      const scope = target(f, claude, initialState() as unknown as ParseState);
      f.office.immediate(() => {
        f.office.run(
          `insert into agents (office_id, agent_id, run_id, role, model, started_at)
           values ($office_id, $agent, $run, 'developer', 'claude-haiku-5-5', 0)`,
          { agent: f.agent, run: f.run },
        );
        recordUsageMessage(
          f.office,
          scope,
          {
            messageId: "msg-1",
            model: "claude-haiku-5-5",
            input: 1000,
            output: 0,
            cacheCreate: 3000,
            cacheCreate5m: 1000,
            cacheCreate1h: 2000,
            cacheRead: 0,
          },
          0,
        );
        priceAgentUsage(f.office, book, f.run, f.agent);
      });
      // 1000 * 0.10 + 1000 * 0.125 + 2000 * 0.20 = 100 + 125 + 400: the 5 minute and 1 hour
      // parts are priced as stored, not as a split of cache_create.
      expect(pricedRows(f)[0]?.est_cost_micros).toBe(625);
    }));

  it("a model the catalog lacks keeps a null estimate and raises the stale-catalog notice", () =>
    withTempDir(async (dir) => {
      const f = await replay(dir, "success-single", () => ({ version: "9", models: new Map() }));
      expect(pricedRows(f)).toEqual([
        {
          model: "claude-haiku-5-5",
          est_cost_micros: null,
          pricing_version: null,
          cli_cost_micros: 447,
        },
      ]);
      const raised = notices(f);
      expect(raised.length).toBe(1);
      expect(raised[0]?.text).toContain("no rates for claude-haiku-5-5");
    }));

  it("without a catalog the estimate stays null and nothing is checked", () =>
    withTempDir(async (dir) => {
      const f = await replay(dir, "success-single", () => null);
      expect(pricedRows(f)[0]?.est_cost_micros).toBeNull();
      expect(notices(f)).toEqual([]);
    }));
});

describe("cross-check against the CLI's costUSD", () => {
  it("a gap above 10% raises one notice for the run, however many turns end", () =>
    withTempDir(async (dir) => {
      // Two turns; the stale catalog prices 20% high.
      const f = await replay(dir, "success-tools-subagent", (fx) =>
        scaled(fx.t.state.pricing, 1.2),
      );
      const row = pricedRows(f)[0];
      expect(costGap(row?.est_cost_micros ?? 0, row?.cli_cost_micros ?? 0)).toBeGreaterThan(0.1);
      const raised = notices(f);
      expect(raised.length).toBe(1);
      expect(raised[0]?.code).toBe(CATALOG_STALE_CODE);
      expect(raised[0]?.text).toContain("may be stale");
      const checks = f.office.all<{ run_id: string; pricing_version: string }>(
        "select run_id, pricing_version from pricing_checks where office_id = $office_id",
      );
      expect(checks).toEqual([{ run_id: f.run, pricing_version: "test" }]);
    }));

  it("a gap of 10% or less raises nothing (9% high)", () =>
    withTempDir(async (dir) => {
      const f = await replay(dir, "success-tools-subagent", (fx) =>
        scaled(fx.t.state.pricing, 1.09),
      );
      expect(notices(f)).toEqual([]);
    }));

  it("a session run raises the notice without a story key", () =>
    withTempDir(async (dir) => {
      const f = await replay(dir, "success-single", (fx) => scaled(fx.t.state.pricing, 2), {
        work: false,
      });
      const row = f.office.get<{ key: string | null; run: string | null }>(
        `select json_extract(delta, '$.code') as code, key, run_id as run from change_log
         where office_id = $office_id and type = 'engine.notice'`,
      );
      expect(row?.key ?? null).toBeNull();
      expect(row?.run).toBe(f.run);
    }));

  it("an aborted turn whose spend the CLI leaves out is not compared (pause-now)", () =>
    withTempDir(async (dir) => {
      // The CLI's next totals leave the aborted turn out; the run counts it, so the CLI's cost no
      // longer covers the run and is cleared instead of raising a false notice.
      const f = await replay(dir, "pause-now");
      const row = pricedRows(f)[0];
      expect(row?.est_cost_micros).toBeGreaterThan(0);
      expect(row?.cli_cost_micros).toBeNull();
      expect(notices(f)).toEqual([]);
    }));
});
