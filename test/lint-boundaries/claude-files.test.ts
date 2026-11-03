// Claude is named only where it is named today (0001): Claude-specific code lives in the adapter,
// the box model proxy and the box image, and a fixed list of other files, `claude-files.txt`, may
// name Claude or Anthropic. Every `.ts` and `.tsx` file under `packages/*/src`, `scripts` and
// `tools` is read whole, code and comments alike; tests (`packages/*/test` and `*.test.ts` files)
// are not. A file outside those places and the list fails, and so does a listed file that no
// longer names Claude, so the list only shrinks.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

const REPO = join(import.meta.dir, "..", "..");
const ROOTS = ["packages/*/src", "scripts", "tools"];
const LIST = "test/lint-boundaries/claude-files.txt";
const NAMES = /claude|anthropic/i;

/** The places of 0001 where Claude-specific code lives: a folder, or one file. */
const PLACES = [
  "packages/engine/src/workers/claude-cli/",
  "packages/engine/src/box/model-proxy.ts",
  "packages/engine/src/box/image.ts",
];

function inPlace(path: string): boolean {
  return PLACES.some((place) => (place.endsWith("/") ? path.startsWith(place) : path === place));
}

/** Every non-test source file under the roots, relative to the repository. */
function sources(): string[] {
  return ROOTS.flatMap((root) => [
    ...new Bun.Glob(`${root}/**/*.{ts,tsx}`).scanSync({ cwd: REPO, onlyFiles: true }),
  ])
    .filter((path) => !path.includes("node_modules/") && !/\.test\.tsx?$/.test(path))
    .toSorted();
}

function namesClaude(path: string): boolean {
  return NAMES.test(readFileSync(join(REPO, path), "utf8"));
}

/** The paths of `claude-files.txt`, in file order; `#` lines are comments. */
function listed(): string[] {
  return readFileSync(join(REPO, LIST), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

describe("files that name Claude (0001)", () => {
  it("reads the sources of every root, the adapter's among them", () => {
    const all = sources();
    const roots = ["packages/engine/src/", "packages/cli/src/", "scripts/", "tools/"];
    expect(roots.filter((root) => !all.some((path) => path.startsWith(root)))).toEqual([]);
    expect(all.filter((path) => inPlace(path) && namesClaude(path)).length).toBeGreaterThan(5);
  });

  it("keeps its list sorted, each file once", () => {
    const list = listed();
    expect(list).toEqual([...new Set(list)].toSorted());
  });

  it("names Claude nowhere but in the places of 0001 and the listed files", () => {
    const list = new Set(listed());
    const unlisted = sources()
      .filter((path) => !inPlace(path) && !list.has(path) && namesClaude(path))
      .map((path) => `${path}: names Claude; reach Claude through the worker adapter (0001)`);
    expect(unlisted).toEqual([]);
  });

  it("lists only files outside those places that still name Claude, so the list only shrinks", () => {
    const stale = listed()
      .filter((path) => inPlace(path) || !existsSync(join(REPO, path)) || !namesClaude(path))
      .map((path) => `${path}: remove it from ${LIST}`);
    expect(stale).toEqual([]);
  });
});
