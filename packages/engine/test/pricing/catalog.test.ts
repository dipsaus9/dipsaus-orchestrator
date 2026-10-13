// The shipped pricing catalogs (DIPO-62, 0008 section 4): shape, released checksums, and the
// arithmetic of an estimate.

import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import {
  CATALOGS,
  CatalogChecksumError,
  CatalogSchema,
  catalogChecksum,
  verifyCatalog,
} from "../../src/pricing/catalog";
import {
  canonicalModel,
  costMicros,
  estimateMicros,
  longPromptRates,
  messagesCostMicros,
  ratesFor,
  type PriceBook,
} from "../../src/pricing/estimate";

const PRICING_DIR = join(import.meta.dir, "..", "..", "src", "pricing");

/** A deep copy with one change, as an edited catalog file would parse. */
function edited(change: (catalog: Record<string, unknown>) => void): unknown {
  const copy = structuredClone(CATALOGS[0]?.catalog) as Record<string, unknown>;
  change(copy);
  return copy;
}

describe("shipped catalogs", () => {
  it("ship one catalog-<n>.json per version, numbered 1, 2, 3 in order", () => {
    const files = readdirSync(PRICING_DIR).filter((name) => /^catalog-\d+\.json$/.test(name));
    expect(files.length).toBe(CATALOGS.length);
    CATALOGS.forEach((shipped, index) => {
      const catalog = CatalogSchema.parse(shipped.catalog);
      expect(catalog.version).toBe(index + 1);
      expect(files).toContain(`catalog-${catalog.version}.json`);
    });
  });

  it("list the five rates per model id, with effective date and source URL", () => {
    for (const shipped of CATALOGS) {
      const catalog = verifyCatalog(shipped);
      expect(catalog.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(catalog.source).toBe("https://platform.claude.com/docs/en/about-claude/pricing");
      expect(Object.keys(catalog.models).length).toBeGreaterThan(0);
      for (const rates of Object.values(catalog.models)) {
        expect(Object.keys(rates).toSorted()).toEqual(
          expect.arrayContaining(["cacheRead", "cacheWrite1h", "cacheWrite5m", "input", "output"]),
        );
      }
    }
  });

  it("match their released checksums", () => {
    for (const shipped of CATALOGS) {
      expect(catalogChecksum(shipped.catalog)).toBe(shipped.checksum);
    }
  });

  it("a changed catalog file fails the checksum", () => {
    const released = CATALOGS[0];
    if (released === undefined) throw new Error("no catalog shipped");
    const changed = edited((catalog) => {
      const models = catalog["models"] as Record<string, Record<string, number>>;
      const haiku = models["claude-haiku-5-5"];
      if (haiku !== undefined) haiku["output"] = 600_000;
    });
    expect(() => verifyCatalog({ catalog: changed, checksum: released.checksum })).toThrow(
      CatalogChecksumError,
    );
    const renamed = edited((catalog) => {
      catalog["effectiveDate"] = "2026-10-14";
    });
    expect(() => verifyCatalog({ catalog: renamed, checksum: released.checksum })).toThrow(
      /not the released/,
    );
  });

  it("a catalog without a rate fails its schema", () => {
    const missing = edited((catalog) => {
      const models = catalog["models"] as Record<string, Record<string, number>>;
      delete models["claude-haiku-5-5"]?.["cacheWrite1h"];
    });
    expect(() => verifyCatalog({ catalog: missing, checksum: catalogChecksum(missing) })).toThrow();
  });
});

describe("estimate arithmetic", () => {
  const rates = {
    input: 100_000,
    output: 500_000,
    cacheWrite5m: 125_000,
    cacheWrite1h: 200_000,
    cacheRead: 10_000,
  };

  it("sums tokens times per-million rates and rounds half up once", () => {
    // 12 * 0.10 + 1285 * 0.50 + 5354 * 0.125 + 9730 * 0.20 + 20916 * 0.01
    // = 1.2 + 642.5 + 669.25 + 1946 + 209.16 = 3468.11 micro-USD
    expect(
      costMicros(
        { input: 12, output: 1285, cacheCreate5m: 5354, cacheCreate1h: 9730, cacheRead: 20916 },
        rates,
      ),
    ).toBe(3468);
    // 5 * 0.10 = 0.5 rounds up; 4 * 0.10 = 0.4 rounds down.
    const none = { output: 0, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0 };
    expect(costMicros({ ...none, input: 5 }, rates)).toBe(1);
    expect(costMicros({ ...none, input: 4 }, rates)).toBe(0);
  });

  it("stays exact for counts whose products pass 2^53", () => {
    const big = {
      input: 10_000_000_000,
      output: 0,
      cacheCreate5m: 0,
      cacheCreate1h: 0,
      cacheRead: 0,
    };
    expect(costMicros(big, { ...rates, input: 75_000_000 })).toBe(750_000_000_000);
  });

  it("prices a dated or context-marked id under its canonical id, and an unknown one as null", () => {
    expect(canonicalModel("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
    expect(canonicalModel("claude-opus-4-7[1m]")).toBe("claude-opus-4-7");
    expect(canonicalModel("claude-haiku-5-5")).toBe("claude-haiku-5-5");
    const book: PriceBook = {
      version: "1",
      models: new Map([["claude-sonnet-4-5", rates]]),
      longPrompt: new Map(),
    };
    const tokens = { input: 10, output: 0, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0 };
    expect(estimateMicros(book, "claude-sonnet-4-5-20250929", tokens)).toBe(1);
    expect(estimateMicros(book, "claude-unknown-1", tokens)).toBeNull();
  });
});

describe("long-prompt rates (DIPO-78)", () => {
  const base = {
    input: 100_000,
    output: 500_000,
    cacheWrite5m: 125_000,
    cacheWrite1h: 200_000,
    cacheRead: 10_000,
  };
  const long = { ...base, input: 500_000, output: 2_500_000, over: 100_000 };
  const longer = { ...base, input: 900_000, over: 200_000 };
  const book: PriceBook = {
    version: "1",
    models: new Map([
      ["claude-haiku-5-5", base],
      ["claude-sonnet-5-5", base],
    ]),
    longPrompt: new Map([["claude-haiku-5-5", [long, longer]]]),
  };
  const none = { input: 0, output: 0, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0 };

  it("select the set with the highest threshold below the prompt size", () => {
    expect(ratesFor(book, "claude-haiku-5-5", 100_000)).toBe(base);
    expect(ratesFor(book, "claude-haiku-5-5", 100_001)).toBe(long);
    expect(ratesFor(book, "claude-haiku-5-5", 200_001)).toBe(longer);
    expect(ratesFor(book, "claude-haiku-5-5-20261001", 150_000)).toBe(long);
    expect(ratesFor(book, "claude-haiku-5-5")).toBe(base);
    expect(ratesFor(book, "claude-sonnet-5-5", 500_000)).toBe(base);
    expect(longPromptRates(book, "claude-sonnet-5-5")).toEqual([]);
    expect(ratesFor(book, "claude-unknown-1", 500_000)).toBeNull();
  });

  it("sum per-band costs, pricing tokens beyond the bands at base rates, rounding once", () => {
    // Band at base: input 3 -> 0.3. Band at long: input 3 -> 1.5. Totals hold 4 more input,
    // priced at base: 0.4. 0.3 + 1.5 + 0.4 = 2.2 -> 2; rounding each part would give 0 + 2 + 0.
    const bands = [
      { tokens: { ...none, input: 3 }, rates: base },
      { tokens: { ...none, input: 3 }, rates: long },
    ];
    expect(messagesCostMicros(bands, { ...none, input: 10 }, base)).toBe(2);
  });

  it("scale a field down to the totals when the messages hold more of it", () => {
    // Messages report output 10 at base (5 micros) and 10 at long (25); totals hold output 4,
    // so the 30 micros are scaled by 4/20: 6.
    const bands = [
      { tokens: { ...none, output: 10 }, rates: base },
      { tokens: { ...none, output: 10 }, rates: long },
    ];
    expect(messagesCostMicros(bands, { ...none, output: 4 }, base)).toBe(6);
    expect(messagesCostMicros(bands, none, base)).toBe(0);
  });

  it("equal costMicros of the totals for one band at base rates", () => {
    const totals = {
      input: 12,
      output: 1285,
      cacheCreate5m: 5354,
      cacheCreate1h: 9730,
      cacheRead: 20916,
    };
    const part = { ...totals, output: 300, cacheRead: 916 };
    expect(messagesCostMicros([{ tokens: part, rates: base }], totals, base)).toBe(
      costMicros(totals, base),
    );
  });
});
