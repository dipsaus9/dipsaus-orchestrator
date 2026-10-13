// The default provider on a real temporary repository (DIPO-46 AC #5, #6 and #8): git lists the
// files through the office's hardened queue, the component map gives the expected components and
// neighbours, and the pack is recorded in `context_packs` with the head sha and blob ids.

import { describe, expect, it } from "bun:test";
import { mkdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
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
} from "../../src/context";
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
        const pack = await provider.gather(req, 12_000);

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
            "packages/engine/src/context/draft.ts",
            "packages/engine/src/context/link.ts",
            "packages/engine/src/context/old.test.ts",
            "packages/engine/src/context/old.ts",
          ].join("\n"),
        );
        expect(pack.items[1]?.text).toBe("");
        expect(pack.items[1]?.reason).toMatchObject({ content: "unreadable" });
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
        const again = await createDefaultProvider({ workspace: ws }).gather(req, 12_000);
        expect(encodePack(again)).toBe(encodePack(pack));
      },
      { fixture: FIXTURE },
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
        const record = recordContextPack(office, "/wt/DIPO-1", head, pack, clock);
        expect(contextPackOf(office, "/wt/DIPO-1")).toEqual(record);
        expect(record).toEqual({
          worktree: "/wt/DIPO-1",
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
        expect(await ws.readFile(".env")).toBeUndefined();
        expect(await ws.readFile("config/.env.production")).toBeUndefined();
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
          expect(new TextDecoder().decode(await ws.readFile("src/a.ts"))).toBe("inside\n");
          mkdirSync(join(outside, "src"));
          writeFileSync(join(outside, "src/a.ts"), "outside\n");
          renameSync(join(repo.dir, "src"), join(repo.dir, "src-moved"));
          symlinkSync(join(outside, "src"), join(repo.dir, "src"));
          expect(await ws.readFile("src/a.ts")).toBeUndefined();
          const pack = await createDefaultProvider({ workspace: ws }).gather(
            request({ scope: ["src/a.ts"] }),
            12_000,
          );
          expect(pack.items[0]?.text).toBe("");
          expect(pack.items[0]?.reason).toMatchObject({ content: "unreadable" });
          expect(pack.blobIds).toEqual({});
        },
        { fixture: { "src/a.ts": "inside\n" } },
      ),
    ));
});
