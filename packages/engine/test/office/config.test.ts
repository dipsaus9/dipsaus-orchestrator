// Office configuration at load and on `office.reloadConfig` (DIPO-27; 0017 section 5): an invalid
// file keeps the previous configuration for running work, puts an `engine.notice` with the errors
// on the office stream, and `configBlocksRuns` returns the errors until a valid reload.

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ConfigError, OfficeId } from "@dipsaus-orchestrator/contract";
import { withTempRepo } from "@dipsaus-orchestrator/testkit";

import { replay } from "../../src/changelog/replay";
import { cursorAt, readLogState } from "../../src/changelog/log";
import { EngineGit } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import { BACKLOG_FIXTURE, officeSetup, resultOf, send, type OfficeSetup } from "./helpers";

interface Reloaded {
  readonly office: OfficeId;
  readonly valid: boolean;
  readonly errors: ConfigError[];
  readonly configHash?: string;
}

const VALID = "version: 1\nscripts:\n  verify: bun run verify\n";
const VALID_2 = "version: 1\nscripts:\n  verify: bun test\n";
const INVALID = "version: 1\ntimeouts:\n  workerStallMinutes: soon\n";

function writeOfficeYaml(dir: string, text: string): void {
  mkdirSync(join(dir, ".dipo"), { recursive: true });
  writeFileSync(join(dir, ".dipo", "office.yaml"), text);
}

async function reload(
  s: OfficeSetup,
  office: OfficeId,
): Promise<{ r: Reloaded; changed: boolean }> {
  const reply = await send(s, "office.reloadConfig", { office });
  return { r: resultOf<Reloaded>(reply), changed: reply.ok && reply.changed };
}

function notices(s: OfficeSetup, office: OfficeId): unknown[] {
  const handle = s.state.office(office);
  const { epoch } = readLogState(handle);
  const result = replay(handle, cursorAt(office, epoch, 0));
  if (!result.ok) throw new Error(result.error.message);
  return result.entries
    .filter((entry) => entry.type === "engine.notice")
    .map((entry) => entry.delta);
}

describe("office configuration", () => {
  it("keeps the previous configuration through an invalid reload and blocks runs until a valid one", async () => {
    await withTempRepo(
      async (repo) => {
        writeOfficeYaml(repo.dir, VALID);
        const s = await officeSetup(repo.root);
        const office = resultOf<{ office: OfficeId }>(
          await send(s, "office.open", { path: repo.dir }),
        ).office;

        // The first reload loads the office, which reads the configuration.
        const loaded = await reload(s, office);
        expect(loaded.r.valid).toBe(true);
        expect(loaded.r.errors).toEqual([]);
        expect(loaded.r.configHash).toMatch(/^[0-9a-f]{64}$/);
        expect(loaded.changed).toBe(false);
        expect(s.manager.configBlocksRuns(office)).toEqual([]);
        expect(s.manager.config(office)?.scripts).toEqual({ verify: "bun run verify" });

        writeOfficeYaml(repo.dir, INVALID);
        const invalid = await reload(s, office);
        expect(invalid.r.valid).toBe(false);
        expect(invalid.r.errors.map((error) => error.path)).toEqual([
          "timeouts.workerStallMinutes",
        ]);
        expect(invalid.r.configHash).toBe(loaded.r.configHash);
        expect(invalid.changed).toBe(true);
        expect(s.manager.config(office)?.scripts).toEqual({ verify: "bun run verify" });
        expect(s.manager.configBlocksRuns(office)).toEqual(invalid.r.errors);
        const [notice] = notices(s, office) as { level: string; code: string; text: string }[];
        expect(notice).toMatchObject({ level: "error", code: "config.invalid" });
        expect(notice?.text).toContain("running work keeps the previous configuration");
        expect(notice?.text).toContain(invalid.r.errors[0]?.message ?? "?");
        expect(s.changed).toEqual([office]);

        writeOfficeYaml(repo.dir, VALID_2);
        const fixed = await reload(s, office);
        expect(fixed.r.valid).toBe(true);
        expect(fixed.r.errors).toEqual([]);
        expect(fixed.r.configHash).not.toBe(loaded.r.configHash);
        expect(fixed.changed).toBe(true);
        expect(s.manager.configBlocksRuns(office)).toEqual([]);
        expect(s.manager.config(office)?.scripts).toEqual({ verify: "bun test" });

        const same = await reload(s, office);
        expect(same.changed).toBe(false);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("loads an office with an invalid configuration, without one in force, and blocks runs", async () => {
    await withTempRepo(
      async (repo) => {
        writeOfficeYaml(repo.dir, INVALID);
        const s = await officeSetup(repo.root);
        const office = resultOf<{ office: OfficeId }>(
          await send(s, "office.open", { path: repo.dir }),
        ).office;
        resultOf(await send(s, "fixture.ping", {}, office));
        expect(s.manager.loadedOffices()).toEqual([office]);
        expect(s.manager.config(office)).toBeUndefined();
        expect(s.manager.configBlocksRuns(office).map((error) => error.path)).toEqual([
          "timeouts.workerStallMinutes",
        ]);
        const [notice] = notices(s, office) as { text: string }[];
        expect(notice?.text).toContain("the office has no valid configuration yet");

        const r = (await reload(s, office)).r;
        expect(r.valid).toBe(false);
        expect(r.configHash).toBeUndefined();
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("reports office.unknown for a forgotten office", async () => {
    await withTempRepo(
      async (repo) => {
        const s = await officeSetup(repo.root);
        const office = resultOf<{ office: OfficeId }>(
          await send(s, "office.open", { path: repo.dir }),
        ).office;
        resultOf(await send(s, "office.forget", { office }));
        const reply = await send(s, "office.reloadConfig", { office });
        expect(!reply.ok && reply.error.code).toBe("office.unknown");
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });
});

describe("office.reloadConfig and the office's git (DIPO-48)", () => {
  it("passes a new base and worktree root to the office's git on reload", async () => {
    await withTempRepo(
      async (repo) => {
        writeOfficeYaml(repo.dir, "version: 1\nbase: main\n");
        const engineGit = new EngineGit({ spawn: systemSpawn, env: repo.env });
        const s = await officeSetup(repo.root, { features: [engineGit.feature] });
        const office = resultOf<{ office: OfficeId }>(
          await send(s, "office.open", { path: repo.dir }),
        ).office;
        await reload(s, office);
        const git = engineGit.forOffice(office);
        expect(git?.settings.base).toBe("main");

        const root = join(repo.root, "trees");
        writeOfficeYaml(repo.dir, `version: 1\nbase: develop\nworktree:\n  root: ${root}\n`);
        const { r } = await reload(s, office);
        expect(r.valid).toBe(true);
        // The same OfficeGit, configured again without a new load.
        expect(engineGit.forOffice(office)).toBe(git);
        expect(git?.settings.base).toBe("develop");
        expect(git?.worktreeRoot()).toBe(root);

        // An invalid file keeps the settings in force.
        writeOfficeYaml(repo.dir, INVALID);
        expect((await reload(s, office)).r.valid).toBe(false);
        expect(git?.settings.base).toBe("develop");
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });
});
