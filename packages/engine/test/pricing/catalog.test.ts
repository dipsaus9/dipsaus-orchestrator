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
    const book: PriceBook = { version: "1", models: new Map([["claude-sonnet-4-5", rates]]) };
    const tokens = { input: 10, output: 0, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0 };
    expect(estimateMicros(book, "claude-sonnet-4-5-20250929", tokens)).toBe(1);
    expect(estimateMicros(book, "claude-unknown-1", tokens)).toBeNull();
  });
});
