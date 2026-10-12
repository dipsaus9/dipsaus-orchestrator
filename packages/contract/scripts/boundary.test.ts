// `packages/contract` has no I/O and no dependency other than zod (0004, 0005).

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGE = join(import.meta.dir, "..");
const SRC = join(PACKAGE, "src");

const sources = readdirSync(SRC)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => ({ name, text: readFileSync(join(SRC, name), "utf8") }));

describe("contract boundary", () => {
  it("depends on zod only", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(["zod"]);
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
  });

  for (const { name, text } of sources) {
    it(`src/${name} imports only zod and its own modules`, () => {
      const specifiers = [...text.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s*\(\s*"([^"]+)"/g)].map(
        (match) => match[1] ?? match[2],
      );
      const foreign = specifiers.filter((s) => s !== "zod" && !s?.startsWith("./"));
      expect(foreign).toEqual([]);
    });

    it(`src/${name} uses no runtime I/O`, () => {
      const io = text.match(/\b(Bun|process|Deno|require|fetch|WebSocket|XMLHttpRequest)\s*[.(]/g);
      expect(io).toBeNull();
    });
  }
});
