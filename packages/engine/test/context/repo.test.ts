// The default provider on a real temporary repository (DIPO-46 AC #5, #6 and #8): git lists the
// files through the office's hardened queue, the component map gives the expected components and
// neighbours, and the pack is recorded in `context_packs` with the head sha and blob ids.

import { describe, expect, it } from "bun:test";
import { linkSync, mkdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import {
  ManualClock,
  withTempDir,
  withTempRepo,
  type TempRepo,
} from "@dipsaus-orchestrator/testkit";

import {
  contextPackOf,
  createDefaultProvider,
  encodePack,
  forgetContextPack,
  gitWorkspace,
  packDigest,
  recordContextPack,
  sizeClassOfWorkspace,
  type FileRefusal,
} from "../../src/context";
import { readInside } from "../../src/context/workspace";
import { openStateDatabase } from "../../src/db/database";
import { OfficeGit, spawnGitExec } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import { localMounts, memoryLogger } from "../db/helpers";
import { request } from "./helpers";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z00000046" as OfficeId;

const FIXTURE = {
  ".dipo/components.yaml": `components:
  contract: { paths: ["packages/contract/**"], purpose: "Shared types and messages." }
  engine: { paths: ["packages/engine/**"], depends_on: ["contract"], purpose: "The headless engine." }
  tui: { paths: ["packages/tui/**"], depends_on: ["engine"] }
  docs: { paths: ["docs/**", "site/**"] }
`,
  "packages/contract/src/index.ts": "export type Id = string;\n",
  "packages/engine/src/context/old.ts": "export const old = 1;\n",
  "packages/engine/src/context/old.test.ts": "test('old', () => {});\n",
  "packages/engine/src/index.ts": "export {};\n",
  "packages/tui/src/app.ts": "export {};\n",
  "docs/notes.md": "# Notes\n",
};

function textOf(read: Uint8Array | FileRefusal | undefined): string | FileRefusal | undefined {
  return read instanceof Uint8Array ? new TextDecoder().decode(read) : read;
}

function workspaceOf(repo: TempRepo) {
  const dir = realpathSync(repo.dir);
  const commonDir = join(dir, ".git");
  const git = new OfficeGit({
    officeId: OFFICE,
    mainWorktree: dir,
    commonDir,
    settings: { remote: "origin", base: "main" },
    runner: { exec: spawnGitExec(systemSpawn), env: repo.env, sleep: async () => {} },
    clock: new ManualClock(),
  });
  return gitWorkspace({
    git,
    location: { kind: "worktree", commonDir, gitDir: commonDir, workTree: dir },
  });
}

describe("default provider on a repository", () => {
  it("gives the matching components, their neighbours and the tests next to scope files", () =>
    withTempRepo(
      async (repo) => {
        const head = await repo.commitAll("first");
        // An untracked file the worker made is listed; a symbolic link is never read.
        writeFileSync(join(repo.dir, "packages/engine/src/context/draft.ts"), "draft\n");
        symlinkSync("/etc/hosts", join(repo.dir, "packages/engine/src/context/link.ts"));
        const ws = workspaceOf(repo);
        expect(await ws.headSha()).toBe(head);
        expect(await sizeClassOfWorkspace(ws)).toBe("S");

        const provider = createDefaultProvider({ workspace: ws });
        expect(await provider.status(ws)).toEqual({ state: "ready", reasons: [] });
        const req = request({
          scope: [
            "packages/engine/src/context/",
            "packages/engine/src/context/old.ts",
            "packages/engine/src/context/link.ts",
          ],
          inputs: ["docs/notes.md"],
        });
        const pack = await provider.gather({ ...req, baseSha: head }, 12_000);

        expect(pack.provenance.notes).toEqual([
          'component "docs": glob "site/**" matches no tracked file',
        ]);
        const components = pack.items.flatMap((item) =>
          item.reason.kind === "component" ? [item.reason] : [],
        );
        expect(components).toEqual([
          {
            kind: "component",
            name: "engine",
            purpose: "The headless engine.",
            via: "scope",
            shown: 3,
            total: 3,
          },
          {
            kind: "component",
            name: "contract",
            purpose: "Shared types and messages.",
            via: "depends-on",
            shown: 1,
            total: 1,
          },
          {
            kind: "component",
            name: "tui",
            purpose: null,
            via: "depended-on-by",
            shown: 1,
            total: 1,
          },
        ]);
        // Tracked files only: the untracked draft and link are not part of the component list.
        expect(pack.items.find((item) => item.path === "engine")?.text).toBe(
          [
            "packages/engine/src/context/old.test.ts",
            "packages/engine/src/context/old.ts",
            "packages/engine/src/index.ts",
          ].join("\n"),
        );
        expect(pack.items.map((item) => `${item.reason.kind} ${item.path}`)).toEqual([
          "scope-dir packages/engine/src/context/",
          "scope-file packages/engine/src/context/link.ts",
          "scope-file packages/engine/src/context/old.ts",
          "component engine",
          "component contract",
          "component tui",
          "test packages/engine/src/context/old.test.ts",
        ]);
        expect(pack.items[0]?.text).toBe(
          [
            "packages/engine/src/context/old.test.ts",
            "packages/engine/src/context/old.ts",
            "packages/engine/src/context/draft.ts",
            "packages/engine/src/context/link.ts",
          ].join("\n"),
        );
        expect(pack.items[1]?.text).toBe("");
        expect(pack.items[1]?.reason).toMatchObject({
          content: "refused",
          refusal: "symbolic link",
        });
        expect(pack.inputs.items[0]?.text).toBe("# Notes\n");

        const blobs = (
          await repo.git("ls-files", "-s", "packages/engine/src/context/old.ts", "docs/notes.md")
        )
          .trim()
          .split("\n")
          .map((line) => line.split(/\s+/));
        expect(pack.blobIds).toEqual(
          Object.fromEntries(blobs.map((fields) => [fields[3] as string, fields[1] as string])),
        );

        // Determinism: a second run over the same checkout gives the same bytes.
        const again = await createDefaultProvider({ workspace: ws }).gather(
          { ...req, baseSha: head },
          12_000,
        );
        expect(encodePack(again)).toBe(encodePack(pack));
      },
      { fixture: FIXTURE },
    ));

  it("orders a directory's files by their last commit on the base sha", () =>
    withTempRepo(
      async (repo) => {
        await repo.commitAll("first");
        writeFileSync(join(repo.dir, "src/b.ts"), "b2\n");
        writeFileSync(join(repo.dir, "src/sub/d.ts"), "d2\n");
        writeFileSync(join(repo.dir, "src/a.ts"), "a2\n");
        const second = await repo.commitAll("second");
        writeFileSync(join(repo.dir, "src/c.ts"), "c2\n");
        await repo.commitAll("third");
        // Later than the base sha: not seen when the base is `second`.
        const ws = workspaceOf(repo);
        expect(await ws.filesByLastCommit?.(second, "src")).toEqual([
          "src/a.ts",
          "src/b.ts",
          "src/sub/d.ts",
          "src/c.ts",
        ]);
        expect(await ws.filesByLastCommit?.("HEAD", "src")).toEqual([
          "src/c.ts",
          "src/a.ts",
          "src/b.ts",
          "src/sub/d.ts",
        ]);
        expect(await ws.filesByLastCommit?.("HEAD", "src/sub")).toEqual(["src/sub/d.ts"]);
        expect((await ws.filesByLastCommit?.("HEAD", ""))?.[0]).toBe("src/c.ts");
        writeFileSync(join(repo.dir, "src/new.ts"), "new\n");
        const pack = await createDefaultProvider({ workspace: ws }).gather(
          request({ scope: ["src/"], baseSha: second }),
          12_000,
        );
        expect(pack.items[0]?.text).toBe(
          ["src/a.ts", "src/b.ts", "src/sub/d.ts", "src/c.ts", "src/new.ts"].join("\n"),
        );
      },
      {
        fixture: {
          "src/a.ts": "a\n",
          "src/b.ts": "b\n",
          "src/c.ts": "c\n",
          "src/sub/d.ts": "d\n",
        },
      },
    ));

  it("reports an invalid map with a cycle and gives no components", () =>
    withTempRepo(
      async (repo) => {
        await repo.commitAll("first");
        const ws = workspaceOf(repo);
        const pack = await createDefaultProvider({ workspace: ws }).gather(
          request({ scope: ["packages/engine/src/index.ts"] }),
          12_000,
        );
        expect(pack.provenance.notes).toEqual([
          "component map not used: components depend on each other in a cycle: contract -> engine -> contract",
        ]);
        expect(pack.items.some((item) => item.reason.kind === "component")).toBe(false);
      },
      {
        fixture: {
          ".dipo/components.yaml": `components:
  contract: { paths: ["packages/contract/**"], depends_on: ["engine"] }
  engine: { paths: ["packages/engine/**"], depends_on: ["contract"] }
`,
          "packages/contract/src/index.ts": "",
          "packages/engine/src/index.ts": "",
        },
      },
    ));

  it("records the pack per worktree with head sha and blob ids", () =>
    withTempDir(async (dir) => {
      const clock = new ManualClock();
      const state = await openStateDatabase({
        stateDir: join(dir, "state"),
        logger: memoryLogger(),
        readMounts: localMounts,
        clock,
        engineVersion: "0.0.0-test",
      });
      try {
        state.connection.immediate(() =>
          state.connection.run(
            `insert into offices (office_id, path, display_name, added_at, epoch, next_seq, replay_floor_seq)
             values ($id, '/repo', 'repo', 0, 'e', 1, 0)`,
            { id: OFFICE },
          ),
        );
        const office = state.office(OFFICE);
        const pack = {
          items: [],
          usedChars: 0,
          truncated: false,
          provenance: {
            provider: "default",
            version: "1",
            indexState: "ready" as const,
            staleFiles: [],
            notes: [],
          },
          inputs: { paths: [], items: [], usedChars: 0, truncated: false },
          blobIds: { "b.ts": "2".repeat(40), "a.ts": "1".repeat(40) },
        };
        const head = "f".repeat(40);
        const record = recordContextPack(office, "DIPO-1/add-a-greeting", head, pack, clock);
        expect(contextPackOf(office, "DIPO-1/add-a-greeting")).toEqual(record);
        expect(record).toEqual({
          branch: "DIPO-1/add-a-greeting",
          headSha: head,
          blobIds: { "a.ts": "1".repeat(40), "b.ts": "2".repeat(40) },
          provider: "default",
          packSha256: packDigest(pack),
          builtAt: clock.now(),
        });
        clock.advance(1_000);
        const later = recordContextPack(office, "/wt/DIPO-1", "e".repeat(40), pack, clock);
        expect(contextPackOf(office, "/wt/DIPO-1")).toEqual(later);
        forgetContextPack(office, "/wt/DIPO-1");
        expect(contextPackOf(office, "/wt/DIPO-1")).toBeNull();
      } finally {
        state.close();
      }
    }));
});

describe("workspace reads on a repository", () => {
  it("never reads a tracked .env, as a scope file or under an input directory", () =>
    withTempRepo(
      async (repo) => {
        await repo.commitAll("first");
        expect((await repo.git("ls-files", ".env", "config/.env.production")).trim()).toBe(
          ".env\nconfig/.env.production",
        );
        const ws = workspaceOf(repo);
        expect(await ws.readFile(".env")).toEqual({ refused: "secret path" });
        expect(await ws.readFile("config/.env.production")).toEqual({ refused: "secret path" });
        const pack = await createDefaultProvider({ workspace: ws }).gather(
          request({ scope: [".env"], inputs: ["config/"] }),
          12_000,
        );
        expect(pack.items[0]).toEqual({
          path: ".env",
          text: "",
          reason: { kind: "scope-file", scope: ".env", content: "secret", truncated: false },
        });
        expect(
          pack.inputs.items.map((item) => [
            item.path,
            item.text,
            "content" in item.reason ? item.reason.content : "",
          ]),
        ).toEqual([
          ["config/.env.production", "", "secret"],
          ["config/app.json", "{}\n", "text"],
        ]);
        expect(Object.keys(pack.blobIds)).toEqual(["config/app.json"]);
        expect(encodePack(pack).includes("hunter2")).toBe(false);
      },
      {
        fixture: {
          ".env": "PASSWORD=hunter2\n",
          "config/.env.production": "PASSWORD=hunter2\n",
          "config/app.json": "{}\n",
        },
      },
    ));

  it("refuses a file whose directory was swapped for a link out of the work tree", () =>
    withTempDir(async (outside) =>
      withTempRepo(
        async (repo) => {
          await repo.commitAll("first");
          const ws = workspaceOf(repo);
          expect(textOf(await ws.readFile("src/a.ts"))).toBe("inside\n");
          mkdirSync(join(outside, "src"));
          writeFileSync(join(outside, "src/a.ts"), "outside\n");
          renameSync(join(repo.dir, "src"), join(repo.dir, "src-moved"));
          symlinkSync(join(outside, "src"), join(repo.dir, "src"));
          expect(await ws.readFile("src/a.ts")).toEqual({
            refused: "resolves outside the work tree",
          });
          const pack = await createDefaultProvider({ workspace: ws }).gather(
            request({ scope: ["src/a.ts"] }),
            12_000,
          );
          expect(pack.items[0]?.text).toBe("");
          expect(pack.items[0]?.reason).toMatchObject({
            content: "refused",
            refusal: "resolves outside the work tree",
          });
          expect(pack.blobIds).toEqual({});
        },
        { fixture: { "src/a.ts": "inside\n" } },
      ),
    ));

  it("refuses a hard link to a file outside the work tree", () =>
    withTempDir(async (outside) =>
      withTempRepo(async (repo) => {
        await repo.commitAll("first");
        writeFileSync(join(outside, "secret.txt"), "PASSWORD=hunter2\n");
        linkSync(join(outside, "secret.txt"), join(repo.dir, "notes.txt"));
        const ws = workspaceOf(repo);
        expect(await ws.readFile("notes.txt")).toEqual({ refused: "hard link" });
        const pack = await createDefaultProvider({ workspace: ws }).gather(
          request({ inputs: ["notes.txt"] }),
          12_000,
        );
        expect(pack.inputs.items[0]).toEqual({
          path: "notes.txt",
          text: "",
          reason: {
            kind: "input-file",
            input: "notes.txt",
            content: "refused",
            truncated: false,
            refusal: "hard link",
          },
        });
        expect(pack.blobIds).toEqual({});
        expect(encodePack(pack).includes("hunter2")).toBe(false);
      }),
    ));

  it("refuses a hard link to an in-tree .env under a harmless name", () =>
    withTempRepo(
      async (repo) => {
        await repo.commitAll("first");
        linkSync(join(repo.dir, ".env"), join(repo.dir, "src/config.ts"));
        const ws = workspaceOf(repo);
        expect(await ws.readFile("src/config.ts")).toEqual({ refused: "hard link" });
        const pack = await createDefaultProvider({ workspace: ws }).gather(
          request({ scope: ["src/config.ts"] }),
          12_000,
        );
        expect(pack.items[0]?.reason).toEqual({
          kind: "scope-file",
          scope: "src/config.ts",
          content: "refused",
          truncated: false,
          refusal: "hard link",
        });
        expect(encodePack(pack).includes("hunter2")).toBe(false);
      },
      { fixture: { ".env": "PASSWORD=hunter2\n", "src/a.ts": "a\n" } },
    ));

  it("refuses a file under a secret directory and a link that resolves to a secret", () =>
    withTempRepo(
      async (repo) => {
        await repo.commitAll("first");
        symlinkSync(".ssh", join(repo.dir, "keys"));
        const ws = workspaceOf(repo);
        expect(await ws.readFile(".ssh/config")).toEqual({ refused: "secret path" });
        expect(await ws.readFile("keys/config")).toEqual({ refused: "resolves to a secret path" });
      },
      { fixture: { ".ssh/config": "Host *\n", "src/a.ts": "a\n" } },
    ));

  it("refuses a file swapped for a link between the checks and the open", () =>
    withTempDir(async (outside) =>
      withTempRepo(
        async (repo) => {
          await repo.commitAll("first");
          const dir = realpathSync(repo.dir);
          writeFileSync(join(outside, "secret.txt"), "PASSWORD=hunter2\n");
          const swapped = await readInside(dir, "src/a.ts", {
            beforeOpen: async () => {
              renameSync(join(dir, "src/a.ts"), join(dir, "src/a.moved"));
              symlinkSync(join(outside, "secret.txt"), join(dir, "src/a.ts"));
            },
          });
          expect(swapped).toEqual({ refused: "symbolic link" });
          // A symbolic link found by lstat is refused before any open.
          expect(await readInside(dir, "src/a.ts")).toEqual({ refused: "symbolic link" });
        },
        { fixture: { "src/a.ts": "inside\n" } },
      ),
    ));

  it("refuses a file replaced by another regular file between the checks and the open", () =>
    withTempRepo(
      async (repo) => {
        await repo.commitAll("first");
        const dir = realpathSync(repo.dir);
        const swapped = await readInside(dir, "src/a.ts", {
          beforeOpen: async () => {
            writeFileSync(join(dir, "src/other.ts"), "other\n");
            renameSync(join(dir, "src/other.ts"), join(dir, "src/a.ts"));
          },
        });
        expect(swapped).toEqual({ refused: "changed while being read" });
        expect(textOf(await readInside(dir, "src/a.ts"))).toBe("other\n");
      },
      { fixture: { "src/a.ts": "inside\n" } },
    ));
});
