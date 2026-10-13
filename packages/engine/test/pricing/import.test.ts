// Catalog import at daemon open (DIPO-62, 0007 section 4): versions the database lacks are
// imported after their checksum is verified, and an imported version is never edited.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import {
  CATALOGS,
  CatalogChecksumError,
  catalogChecksum,
  type ShippedCatalog,
} from "../../src/pricing/catalog";
import { localMounts, memoryLogger } from "../db/helpers";

const open = (dir: string, catalogs?: readonly ShippedCatalog[]) =>
  openStateDatabase({
    stateDir: join(dir, "state"),
    logger: memoryLogger(),
    readMounts: localMounts,
    clock: new ManualClock(),
    engineVersion: "0.0.0-test",
    ...(catalogs === undefined ? {} : { catalogs }),
  });

function variant(version: number, outputRate: number): ShippedCatalog {
  const catalog = structuredClone(CATALOGS[0]?.catalog) as {
    version: number;
    models: Record<string, Record<string, number>>;
  };
  catalog.version = version;
  const haiku = catalog.models["claude-haiku-5-5"];
  if (haiku !== undefined) haiku["output"] = outputRate;
  return { catalog, checksum: catalogChecksum(catalog) };
}

describe("catalog import at open", () => {
  it("imports every shipped version once, with its rates, and loads the newest", () =>
    withTempDir(async (dir) => {
      const first = await open(dir);
      try {
        const db = first.connection;
        const catalogs = db.all<{ version: number; checksum: string; source: string }>(
          "select version, checksum, source from pricing_catalogs order by version",
        );
        expect(catalogs.map((row) => row.version)).toEqual(CATALOGS.map((_, i) => i + 1));
        expect(catalogs[0]?.checksum).toBe(CATALOGS[0]?.checksum ?? "");
        const haiku = db.all<{ prompt_over: number; input: number; cache_write_1h: number }>(
          `select prompt_over, input, cache_write_1h from pricing_rates
           where version = 1 and model = 'claude-haiku-5-5' order by prompt_over`,
        );
        expect(haiku).toEqual([
          { prompt_over: 0, input: 100_000, cache_write_1h: 200_000 },
          { prompt_over: 100_000, input: 500_000, cache_write_1h: 1_000_000 },
        ]);
        expect(first.pricing?.version).toBe(String(CATALOGS.length));
        expect(first.pricing?.models.get("claude-haiku-5-5")?.cacheRead).toBe(10_000);
        // Every prompt_over set is loaded, not only the base rates (DIPO-78).
        const sets = db.all<{ model: string; prompt_over: number }>(
          "select model, prompt_over from pricing_rates where version = 1 and prompt_over > 0",
        );
        expect(sets.length).toBeGreaterThan(0);
        for (const set of sets) {
          expect(first.pricing?.longPrompt.get(set.model)?.map((rates) => rates.over)).toContain(
            set.prompt_over,
          );
        }
        expect(first.pricing?.longPrompt.get("claude-haiku-5-5")).toEqual([
          {
            over: 100_000,
            input: 500_000,
            output: 2_500_000,
            cacheWrite5m: 625_000,
            cacheWrite1h: 1_000_000,
            cacheRead: 50_000,
          },
        ]);
        expect(first.pricing?.longPrompt.has("claude-sonnet-5-5")).toBe(false);
      } finally {
        first.close();
      }
      // A second open imports nothing and changes nothing.
      const second = await open(dir);
      try {
        expect(
          second.connection.get<{ n: number }>("select count(*) as n from pricing_catalogs")?.n,
        ).toBe(CATALOGS.length);
      } finally {
        second.close();
      }
    }));

  it("imports a new version beside the old one and prices with the newest", () =>
    withTempDir(async (dir) => {
      (await open(dir)).close();
      const next = variant(CATALOGS.length + 1, 700_000);
      const state = await open(dir, [...CATALOGS, next]);
      try {
        expect(state.pricing?.version).toBe(String(CATALOGS.length + 1));
        expect(state.pricing?.models.get("claude-haiku-5-5")?.output).toBe(700_000);
        expect(
          state.connection.get<{ output: number }>(
            "select output from pricing_rates where version = 1 and model = 'claude-haiku-5-5' and prompt_over = 0",
          )?.output,
        ).toBe(500_000);
      } finally {
        state.close();
      }
    }));

  it("refuses to open with a shipped catalog that fails its checksum", () =>
    withTempDir(async (dir) => {
      const changed = variant(1, 600_000);
      const shipped = { catalog: changed.catalog, checksum: CATALOGS[0]?.checksum ?? "" };
      await expect(open(dir, [shipped])).rejects.toThrow(CatalogChecksumError);
    }));

  it("refuses a binary whose catalog differs from the version the database imported", () =>
    withTempDir(async (dir) => {
      (await open(dir)).close();
      await expect(open(dir, [variant(1, 600_000)])).rejects.toThrow(/was imported/);
    }));

  it("never edits an imported version: updates and deletes are refused", () =>
    withTempDir(async (dir) => {
      const state = await open(dir);
      const db = state.connection;
      try {
        for (const sql of [
          "update pricing_rates set output = 1 where version = 1",
          "delete from pricing_rates where version = 1",
          "update pricing_catalogs set checksum = 'x' where version = 1",
          "delete from pricing_catalogs where version = 1",
        ]) {
          expect(() => db.immediate(() => db.run(sql))).toThrow(/never edited/);
        }
      } finally {
        state.close();
      }
    }));
});
