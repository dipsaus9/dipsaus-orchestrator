// The feature module names (DIPO-400): each module registers under the name of the directory it
// lives in under `src/`, so a registration error names the right place. The names are read from
// the source, where each module declares `name` directly above its `register`.

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const NAMED_MODULE = /^\s*name: "([^"]+)",\n\s*register\b/gm;

/** Every non-test source file under `src/`, as its path relative to `src/`. */
function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => file.split(sep).join("/"));
}

/** Each feature module declared in the source, with the file it is declared in. */
function featureModules(): { file: string; name: string }[] {
  return sourceFiles().flatMap((file) => {
    const text = readFileSync(join(SRC, file), "utf8");
    return [...text.matchAll(NAMED_MODULE)].map((match) => ({ file, name: match[1] ?? "" }));
  });
}

describe("feature module names", () => {
  it("finds the feature modules in the source", () => {
    expect(featureModules().length).toBeGreaterThan(30);
  });

  it("names every feature module after the directory it lives in", () => {
    const mismatches = featureModules()
      .map(({ file, name }) => ({ file, name, directory: dirname(file) }))
      .filter(({ name, directory }) => name !== directory)
      .map(({ file, name, directory }) => `${file} registers "${name}", not "${directory}"`);
    expect(mismatches).toEqual([]);
  });
});
