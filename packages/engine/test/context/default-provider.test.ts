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
  isSecretPath,
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
      version: "2",
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

  it("summarises a directory: its file count and 15 files, in name order without history", async () => {
    const files: Record<string, string> = { "pkg/z.ts": "", "pkg/a/deep/x.ts": "", "pkg/b.ts": "" };
    for (let i = 0; i < 120; i += 1) files[`pkg/many/f${String(i).padStart(3, "0")}.ts`] = "";
    const pack = await gather(files, { scope: ["pkg/"] }, 1_000_000);
    const [item] = pack.items;
    expect(item?.path).toBe("pkg/");
    expect(item?.reason).toEqual({ kind: "scope-dir", scope: "pkg/", shown: 15, total: 123 });
    expect(item?.text.split("\n")).toEqual([
      "pkg/a/deep/x.ts",
      "pkg/b.ts",
      ...Array.from({ length: 13 }, (_, i) => `pkg/many/f${String(i).padStart(3, "0")}.ts`),
    ]);
  });

  it("orders a directory by the workspace's last commits, newest first, the rest by name", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i += 1) files[`pkg/f${String(i).padStart(2, "0")}.ts`] = "";
    const base = memoryWorkspace(files);
    const seen: unknown[] = [];
    const workspace = {
      ...base,
      filesByLastCommit: async (sha: string, dir: string) => {
        seen.push([sha, dir]);
        return ["pkg/f19.ts", "pkg/f03.ts", "pkg/gone.ts", "pkg/f07.ts"];
      },
    };
    const pack = await createDefaultProvider({ workspace }).gather(
      request({ scope: ["pkg/"], baseSha: "c".repeat(40) }),
      12_000,
    );
    expect(seen).toEqual([["c".repeat(40), "pkg"]]);
    expect(pack.items[0]?.text.split("\n")).toEqual([
      "pkg/f19.ts",
      "pkg/f03.ts",
      "pkg/f07.ts",
      ...Array.from({ length: 14 }, (_, i) => `pkg/f${String(i).padStart(2, "0")}.ts`).filter(
        (f) => f !== "pkg/f03.ts" && f !== "pkg/f07.ts",
      ),
    ]);
    expect(pack.items[0]?.reason).toMatchObject({ shown: 15, total: 20 });
  });

  it("gives no item for the decision records and recording data unless the story names a path in them", async () => {
    const files: Record<string, string> = {
      "docs/decisions/0001-a.md": "",
      "docs/decisions/0002-b.md": "",
      "packages/engine/test/recordings/claude-cli/r1.json": "",
      "tools/recordings/a.ts": "",
      "tools/recordings/b.ts": "",
    };
    const scope = [
      "docs/decisions/",
      "packages/engine/test/recordings/claude-cli/",
      "tools/recordings/",
    ];
    const unnamed = await gather(files, { scope });
    expect(kinds(unnamed.items)).toEqual(["scope-dir tools/recordings/"]);
    expect(unnamed.items[0]?.reason).toEqual({
      kind: "scope-dir",
      scope: "tools/recordings/",
      shown: 2,
      total: 2,
    });
    const named = await gather(files, {
      scope,
      outcome: "Record the change in docs/decisions/0002-b.md.",
      criteria: ["Read packages/engine/test/recordings/claude-cli/r1.json."],
    });
    expect(kinds(named.items)).toEqual([
      "scope-dir docs/decisions/",
      "scope-dir packages/engine/test/recordings/claude-cli/",
      "scope-dir tools/recordings/",
    ]);
    // Naming the directory itself is not naming a path inside it.
    const bare = await gather(files, { scope, outcome: "Slim docs/decisions/ down." });
    expect(kinds(bare.items)).toEqual(["scope-dir tools/recordings/"]);
  });

  it("shows a 10,000-character scope file as its head with the cut marker", async () => {
    const big = lines(250); // 10,000 characters
    const pack = await gather({ "src/big.ts": big }, { scope: ["src/big.ts"] });
    const [item] = pack.items;
    const to = item?.range?.to ?? 0;
    expect(to).toBeGreaterThan(0);
    expect(item?.text.length).toBeLessThanOrEqual(4_000);
    expect(item?.text).toBe(
      big.slice(0, to * 40) + truncationMarker(to * 40, 10_000, "src/big.ts", to + 1),
    );
    expect(item?.reason).toMatchObject({ kind: "scope-file", truncated: true });
  });

  it("marks a missing path new and summarises its nearest existing parent", async () => {
    const pack = await gather(
      { "src/x.ts": "", "src/sub/y.ts": "", "README.md": "" },
      { scope: ["src/context/new/file.ts"] },
    );
    expect(pack.items).toEqual([
      {
        path: "src/context/new/file.ts",
        text: "src/sub/y.ts\nsrc/x.ts",
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

const failing = (where: "status" | "prepare" | "gather"): ContextProvider => {
  const fake = backend(where === "prepare" ? "stale" : "ready");
  const boom = async (): Promise<never> => {
    throw new Error(`${where} broke`);
  };
  return {
    ...fake,
    ...(where === "status" ? { status: boom } : {}),
    ...(where === "prepare" ? { prepare: boom } : {}),
    ...(where === "gather" ? { gather: boom } : {}),
  };
};

describe("gatherContext: a backend that throws", () => {
  const files = { "src/a.ts": "a\n" };

  for (const where of ["status", "prepare", "gather"] as const) {
    it(`falls back to the default pack when ${where} throws`, async () => {
      const workspace = memoryWorkspace(files);
      const defaultProvider = createDefaultProvider({ workspace });
      const req = request({ scope: ["src/a.ts"] });
      const alone = await defaultProvider.gather(req, 12_000);
      const pack = await gatherContext({
        workspace,
        defaultProvider,
        backend: failing(where),
        request: req,
        budget: 12_000,
      });
      expect(pack).toEqual({
        ...alone,
        provenance: { ...alone.provenance, notes: [`backend fake skipped, error: ${where} broke`] },
      });
    });
  }
});

describe("default provider: secret files", () => {
  it("matches the 0008 secret names, and every path under a secret directory", () => {
    for (const path of [
      ".env",
      "app/.env.local",
      ".envrc",
      "a/.npmrc",
      ".netrc",
      ".git-credentials",
      "certs/server.pem",
      "keys/id_rsa",
      "keys/id_ed25519.pub",
      "docs/.env-guide/notes.md",
    ]) {
      expect(isSecretPath(path)).toBe(true);
    }
    for (const path of ["src/env.ts", "docs/env-guide/notes.md", "pem.ts", "src/id.ts"]) {
      expect(isSecretPath(path)).toBe(false);
    }
  });

  it("lists a secret scope or input file without reading it or recording a blob id", async () => {
    const workspace = memoryWorkspace({
      ".env": "TOKEN=scope-secret\n",
      "cfg/.env.local": "TOKEN=input-secret\n",
      "cfg/.npmrc": "//registry/:_authToken=npm-secret\n",
      "cfg/app.json": "{}\n",
      "cfg/server.pem": "-----BEGIN PRIVATE KEY-----\n",
    });
    const pack = await createDefaultProvider({ workspace }).gather(
      request({ scope: [".env"], inputs: ["cfg/"] }),
      12_000,
    );
    expect(workspace.reads.toSorted()).toEqual(["cfg/app.json"]);
    expect(pack.items).toEqual([
      {
        path: ".env",
        text: "",
        reason: { kind: "scope-file", scope: ".env", content: "secret", truncated: false },
      },
    ]);
    expect(
      pack.inputs.items.map((item) => [
        item.path,
        item.text,
        item.reason.kind,
        "content" in item.reason ? item.reason.content : "",
      ]),
    ).toEqual([
      ["cfg/.env.local", "", "input-file", "secret"],
      ["cfg/.npmrc", "", "input-file", "secret"],
      ["cfg/app.json", "{}\n", "input-file", "text"],
      ["cfg/server.pem", "", "input-file", "secret"],
    ]);
    expect(Object.keys(pack.blobIds)).toEqual(["cfg/app.json"]);
    expect(encodePack(pack).includes("secret\\n")).toBe(false);
  });
});

describe("default provider: component listing truncation", () => {
  it("cuts a long component file list with the listing marker", async () => {
    const files: Record<string, string> = {
      ".dipo/components.yaml": 'components:\n  engine: { paths: ["engine/**"] }\n',
    };
    for (let i = 0; i < 50; i += 1) {
      files[`engine/${"c".repeat(90)}${String(i).padStart(2, "0")}.ts`] = "";
    }
    const pack = await gather(files, { scope: ["engine/"] }, 1_000_000);
    const item = pack.items.find((i) => i.reason.kind === "component");
    expect(
      item?.text.endsWith(
        " listing; list the rest yourself only if the shown part is not enough.]",
      ),
    ).toBe(true);
    expect(item?.text.includes("the engine listing")).toBe(true);
    expect(item?.text.includes("from line")).toBe(false);
  });
});
