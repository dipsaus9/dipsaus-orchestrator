// The default context provider over an in-memory checkout (DIPO-46 AC #1, #3, #4, #6, #7, #8).

import { describe, expect, it } from "bun:test";

import {
  type ContextItem,
  type ContextPack,
  type ContextProvider,
  createDefaultProvider,
  encodePack,
  gatherContext,
  gitBlobId,
  packDigest,
  truncationMarker,
} from "../../src/context";
import { lines, memoryWorkspace, request } from "./helpers";

const gather = (
  files: Record<string, string | Uint8Array>,
  overrides: Parameters<typeof request>[0] = {},
  budget = 12_000,
) =>
  createDefaultProvider({ workspace: memoryWorkspace(files) }).gather(request(overrides), budget);

const kinds = (items: readonly ContextItem[]) => items.map((i) => `${i.reason.kind} ${i.path}`);

describe("default provider: scope", () => {
  it("includes a small scope file in full and records its blob id", async () => {
    const pack = await gather({ "src/a.ts": "export const a = 1;\n" }, { scope: ["src/a.ts"] });
    expect(pack.items).toEqual([
      {
        path: "src/a.ts",
        text: "export const a = 1;\n",
        reason: { kind: "scope-file", scope: "src/a.ts", content: "text", truncated: false },
      },
    ]);
    expect(pack.usedChars).toBe("src/a.ts".length + "export const a = 1;\n".length);
    expect(pack.truncated).toBe(false);
    expect(pack.blobIds).toEqual({
      // `printf 'export const a = 1;\n' | git hash-object --stdin`
      "src/a.ts": "cc798ff50da9473effe8bdb31c8c120fe42b61e3",
    });
    expect(gitBlobId(new Uint8Array())).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(pack.provenance).toEqual({
      provider: "default",
      version: "1",
      indexState: "ready",
      staleFiles: [],
      notes: [],
    });
  });

  it("gives a larger file as its head plus the marker naming path and line", async () => {
    const big = lines(400); // 16,000 characters
    const pack = await gather({ "src/big.ts": big }, { scope: ["src/big.ts"] });
    const [item] = pack.items;
    expect(item?.reason).toEqual({
      kind: "scope-file",
      scope: "src/big.ts",
      content: "text",
      truncated: true,
    });
    expect(item?.text.length).toBeLessThanOrEqual(4_000);
    const to = item?.range?.to ?? 0;
    expect(item?.range).toEqual({ from: 1, to });
    expect(item?.text).toBe(
      big.slice(0, to * 40) + truncationMarker(to * 40, 16_000, "src/big.ts", to + 1),
    );
    expect(pack.truncated).toBe(true);
  });

  it("lists a directory breadth first, at most 200 entries", async () => {
    const files: Record<string, string> = { "pkg/z.ts": "", "pkg/a/deep/x.ts": "", "pkg/b.ts": "" };
    for (let i = 0; i < 250; i += 1) files[`pkg/many/f${String(i).padStart(3, "0")}.ts`] = "";
    const pack = await gather(files, { scope: ["pkg/"] }, 1_000_000);
    const [item] = pack.items;
    const entries = item?.text.split("\n") ?? [];
    expect(item?.path).toBe("pkg/");
    expect(item?.reason).toEqual({ kind: "scope-dir", scope: "pkg/", shown: 200, total: 256 });
    // Level 1, then level 2 (a/deep/, many/f000..), never a file's contents.
    expect(entries.slice(0, 7)).toEqual([
      "pkg/a/",
      "pkg/b.ts",
      "pkg/many/",
      "pkg/z.ts",
      "pkg/a/deep/",
      "pkg/many/f000.ts",
      "pkg/many/f001.ts",
    ]);
  });

  it("marks a missing path new and lists its nearest existing parent", async () => {
    const pack = await gather(
      { "src/x.ts": "", "src/sub/y.ts": "", "README.md": "" },
      { scope: ["src/context/new/file.ts"] },
    );
    expect(pack.items).toEqual([
      {
        path: "src/context/new/file.ts",
        text: "src/sub/\nsrc/x.ts",
        reason: {
          kind: "scope-new",
          scope: "src/context/new/file.ts",
          parent: "src/",
          shown: 2,
          total: 2,
        },
      },
    ]);
  });

  it("lists tests next to scope files by name, never inlined", async () => {
    const pack = await gather(
      {
        "src/a.ts": "a",
        "src/a.test.ts": "test body",
        "src/a.ci.test.ts": "ci body",
        "src/ab.test.ts": "other",
        "src/new.spec.ts": "spec",
        "src/b.test.ts": "in scope",
        "src/b.ts": "b",
      },
      { scope: ["src/a.ts", "src/new.ts", "src/b.ts", "src/b.test.ts"] },
    );
    expect(kinds(pack.items)).toEqual([
      "scope-file src/a.ts",
      "scope-file src/b.test.ts",
      "scope-file src/b.ts",
      "scope-new src/new.ts",
      "test src/a.ci.test.ts",
      "test src/a.test.ts",
      "test src/new.spec.ts",
    ]);
    const tests = pack.items.filter((i) => i.reason.kind === "test");
    expect(tests.every((i) => i.text === "")).toBe(true);
    expect(tests.map((i) => i.reason)).toEqual([
      { kind: "test", of: "src/a.ts" },
      { kind: "test", of: "src/a.ts" },
      { kind: "test", of: "src/new.ts" },
    ]);
  });

  it("does not inline binary files", async () => {
    const pack = await gather(
      { "img.png": new Uint8Array([137, 80, 0, 1]) },
      { scope: ["img.png"] },
    );
    expect(pack.items[0]?.text).toBe("");
    expect(pack.items[0]?.reason).toMatchObject({ content: "binary" });
  });

  it("cuts the item that overflows the pack budget and drops what no longer fits", async () => {
    const pack = await gather(
      { "a.ts": lines(50), "b.ts": lines(50), "c.ts": lines(50) },
      { scope: ["a.ts", "b.ts", "c.ts"] },
      3_000,
    );
    expect(pack.usedChars).toBeLessThanOrEqual(3_000);
    expect(pack.truncated).toBe(true);
    expect(
      pack.items.map((i) => [i.path, i.reason.kind === "scope-file" && i.reason.truncated]),
    ).toEqual([
      ["a.ts", false],
      ["b.ts", true],
    ]);
    expect(pack.items[1]?.text).toContain("The rest is in b.ts from line");
  });
});

describe("default provider: inputs", () => {
  it("pre-fetches within the budget, lists the rest and URLs, and never cuts the path list", async () => {
    const pack = await gather(
      {
        "docs/a.md": lines(50), // 2,000
        "docs/b.md": lines(50),
        "docs/design/c.md": lines(100), // 4,000: over the room left
        "docs/design/d.md": "small\n",
      },
      {
        inputs: ["docs/a.md", "https://example.com/spec", "docs/b.md", "docs/design/", "gone.md"],
        inputsBudget: 4_100,
      },
    );
    expect(pack.inputs.paths).toEqual([
      "docs/a.md",
      "https://example.com/spec",
      "docs/b.md",
      "docs/design/",
      "gone.md",
    ]);
    expect(pack.inputs.items.map((i) => `${i.reason.kind} ${i.path}`)).toEqual([
      "input-file docs/a.md",
      "input-url https://example.com/spec",
      "input-file docs/b.md",
      "input-listed docs/design/c.md",
      "input-file docs/design/d.md",
      "input-missing gone.md",
    ]);
    expect(pack.inputs.usedChars).toBe(4_006);
    expect(pack.inputs.usedChars).toBeLessThanOrEqual(4_100);
    expect(pack.inputs.truncated).toBe(true);
    expect(pack.inputs.items[1]?.text).toBe("");
    expect(Object.keys(pack.blobIds)).toEqual([
      "docs/a.md",
      "docs/b.md",
      "docs/design/c.md",
      "docs/design/d.md",
    ]);
  });

  it("cuts an input file over the per-file cap with the marker", async () => {
    const pack = await gather(
      { "spec.md": lines(200) },
      { inputs: ["spec.md"], inputsBudget: 20_000 },
    );
    const [item] = pack.inputs.items;
    expect(item?.reason).toEqual({
      kind: "input-file",
      input: "spec.md",
      content: "text",
      truncated: true,
    });
    expect(item?.text.length).toBeLessThanOrEqual(4_000);
    expect(item?.text).toContain("The rest is in spec.md from line");
  });
});

describe("default provider: determinism", () => {
  it("gives the same pack bytes for the same inputs, whatever the request order", async () => {
    const files = {
      ".dipo/components.yaml": 'components:\n  core: { paths: ["src/**"] }\n',
      "src/a.ts": lines(30),
      "src/a.test.ts": "t",
      "src/dir/x.ts": "x",
      "docs/in.md": "input\r\nwith crlf\r\n",
    };
    const first = await gather(files, {
      scope: ["src/a.ts", "src/dir/", "src/new.ts"],
      inputs: ["docs/in.md"],
    });
    const second = await gather(files, {
      scope: ["src/new.ts", "./src/dir", "src/a.ts"],
      inputs: ["docs/in.md"],
    });
    expect(encodePack(second)).toBe(encodePack(first));
    expect(packDigest(second)).toBe(packDigest(first));
    expect(first.inputs.items[0]?.text).toBe("input\nwith crlf\n");
  });

  it("returns items only: every text is file content, a path list or empty", async () => {
    const pack = await gather(
      { "src/a.ts": "code\n", "src/b/c.ts": "" },
      { scope: ["src/a.ts", "src/b/", "src/n.ts"] },
    );
    for (const item of pack.items) {
      expect(item.text.includes("You ")).toBe(false);
    }
  });
});

const backend = (state: "ready" | "stale", items: ContextItem[] = []): ContextProvider => ({
  id: "fake",
  status: async () => ({ state, reasons: state === "ready" ? [] : ["pending changes"] }),
  gather: async (): Promise<ContextPack> => ({
    items,
    usedChars: 0,
    truncated: false,
    provenance: {
      provider: "fake",
      version: "9",
      indexState: state,
      staleFiles: [],
      notes: [],
    },
    inputs: { paths: [], items: [], usedChars: 0, truncated: false },
    blobIds: {},
  }),
});

describe("gatherContext", () => {
  const files = { "src/a.ts": "a\n" };

  it("runs the default first and skips a backend that is not ready, saying why", async () => {
    const workspace = memoryWorkspace(files);
    const pack = await gatherContext({
      workspace,
      defaultProvider: createDefaultProvider({ workspace }),
      backend: backend("stale"),
      request: request({ scope: ["src/a.ts"] }),
      budget: 12_000,
    });
    expect(kinds(pack.items)).toEqual(["scope-file src/a.ts"]);
    expect(pack.provenance.notes).toEqual(["backend fake skipped, stale: pending changes"]);
  });

  it("lets a ready backend fill the rest of the budget", async () => {
    const workspace = memoryWorkspace(files);
    const extra: ContextItem = {
      path: "src/other.ts",
      text: "x".repeat(50),
      reason: { kind: "test", of: "src/a.ts" },
    };
    const pack = await gatherContext({
      workspace,
      defaultProvider: createDefaultProvider({ workspace }),
      backend: backend("ready", [extra, { ...extra, path: "src/a.ts" }]),
      request: request({ scope: ["src/a.ts"] }),
      budget: 12_000,
    });
    expect(kinds(pack.items)).toEqual(["scope-file src/a.ts", "test src/other.ts"]);
    expect(pack.provenance.provider).toBe("default");
    expect(pack.provenance.notes).toEqual(["backend fake 9, ready"]);
  });
});
