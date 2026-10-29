// Office loading (DIPO-27; 0006 decision 4, 0007 section 6): an office's engine instance loads on
// its first office-level command or read, refuses an office whose `office.json` names another id,
// and runs the load steps feature modules registered, in registration order; a failing step
// refuses the office with a notice naming it. A loaded office reads its configuration again when
// `.dipo/office.yaml` changed on the base, after the story index poll's fetch (DIPO-303).

import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import {
  type TempRepoWithRemote,
  withBareRemote,
  withTempRepo,
} from "@dipsaus-orchestrator/testkit";

import { cursorAt, readLogState } from "../../src/changelog/log";
import { replay } from "../../src/changelog/replay";
import {
  buildRegistry,
  DuplicateRegistrationError,
  type FeatureModule,
} from "../../src/commands/registry";
import { OFFICE_DEFAULTS } from "../../src/config";
import { EngineGit } from "../../src/git";
import { writeMarker } from "../../src/office/marker";
import type { LoadStep, OfficeLoadContext } from "../../src/office/steps";
import { systemSpawn } from "../../src/platform/process";
import { StoryIndex } from "../../src/stories/feature";
import { BACKLOG_CLI } from "../backlog/helpers";
import { BACKLOG_FIXTURE, errorOf, officeSetup, resultOf, send, type OfficeSetup } from "./helpers";
import { backlogStoryStore } from "../../src/backlog/store";

async function openOffice(s: OfficeSetup, path: string): Promise<OfficeId> {
  return resultOf<{ office: OfficeId }>(await send(s, "office.open", { path })).office;
}

function checksFeature(name: string): FeatureModule {
  return { name, register: (registry) => registry.registerActiveWorkCheck("runs", () => false) };
}

function noticeText(event: { data: unknown } | undefined): string {
  return (event?.data as { text?: string } | undefined)?.text ?? "";
}

function stepsFeature(name: string, steps: Record<string, LoadStep>): FeatureModule {
  return {
    name,
    register(registry) {
      for (const [step, run] of Object.entries(steps)) registry.registerLoadStep(step, run);
    },
  };
}

describe("lazy office loading", () => {
  it("loads an office on its first office-level command, once", async () => {
    await withTempRepo(
      async (repo) => {
        const seen: OfficeLoadContext[] = [];
        const s = await officeSetup(repo.root, {
          features: [stepsFeature("fixture/a", { record: (ctx) => void seen.push(ctx) })],
        });
        const office = await openOffice(s, repo.dir);
        expect(s.manager.loadedOffices()).toEqual([]);
        expect(s.manager.get(office)).toBeUndefined();

        await Promise.all([
          send(s, "fixture.ping", {}, office),
          send(s, "fixture.ping", {}, office),
        ]);
        resultOf(await send(s, "fixture.ping", {}, office));
        expect(s.manager.loadedOffices()).toEqual([office]);
        expect(s.manager.get(office)?.officeId).toBe(office);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
          officeId: office,
          path: repo.dir,
          commonDir: join(repo.dir, ".git"),
        });
        expect(seen[0]?.config?.version).toBe(13);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("refuses an office whose office.json names another id", async () => {
    await withTempRepo(
      async (repo) => {
        const s = await officeSetup(repo.root);
        const office = await openOffice(s, repo.dir);
        writeMarker(join(repo.dir, ".git"), {
          officeId: s.ids.next("off") as OfficeId,
          createdAt: new Date(s.clock.now()).toISOString(),
        });
        const reply = await send(s, "fixture.ping", {}, office);
        expect(errorOf(reply)).toBe("office.refused");
        expect(!reply.ok && reply.error.details).toMatchObject({ office, step: "marker" });
        expect(s.manager.loadedOffices()).toEqual([]);
        const notice = s.events.at(-1);
        expect(notice?.type).toBe("engine.notice");
        expect(notice?.data).toMatchObject({ level: "error", code: "office.refused" });
        expect(noticeText(notice)).toContain("office.json names office");
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("refuses an office whose path is gone with the missing-path notice", async () => {
    await withTempRepo(
      async (repo) => {
        const s = await officeSetup(repo.root);
        const office = await openOffice(s, repo.dir);
        renameSync(repo.dir, join(repo.root, "elsewhere"));
        const reply = await send(s, "fixture.ping", {}, office);
        expect(errorOf(reply)).toBe("office.pathMissing");
        expect(noticeText(s.events.at(-1))).toContain(
          "path missing; `dipo office open` the new path, or `dipo office purge`",
        );
        rmSync(join(repo.root, "elsewhere"), { recursive: true });
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });
});

describe("office load steps", () => {
  it("run in registration order across modules", async () => {
    await withTempRepo(
      async (repo) => {
        const order: string[] = [];
        const step =
          (name: string): LoadStep =>
          async () => {
            order.push(name);
          };
        const s = await officeSetup(repo.root, {
          features: [
            stepsFeature("fixture/a", { "backlog.version": step("backlog.version") }),
            stepsFeature("fixture/b", { "stories.index": step("stories.index") }),
            stepsFeature("fixture/c", { scan: step("scan"), journal: step("journal") }),
          ],
        });
        expect(s.registry.loadSteps().map((entry) => [entry.module, entry.name])).toEqual([
          ["fixture/a", "backlog.version"],
          ["fixture/b", "stories.index"],
          ["fixture/c", "scan"],
          ["fixture/c", "journal"],
        ]);
        const office = await openOffice(s, repo.dir);
        resultOf(await send(s, "fixture.ping", {}, office));
        expect(order).toEqual(["backlog.version", "stories.index", "scan", "journal"]);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("refuse the office with a notice naming a failing step, and stop there", async () => {
    await withTempRepo(
      async (repo) => {
        const order: string[] = [];
        let failing = true;
        const s = await officeSetup(repo.root, {
          features: [
            stepsFeature("fixture/a", {
              first: () => void order.push("first"),
              "backlog.version": () => {
                order.push("backlog.version");
                if (failing) throw new Error("Backlog.md 1.40.0 is older than 1.53.0");
              },
              refusing: () => {
                order.push("refusing");
                return failing ? { ok: true } : { ok: false, reason: "not today" };
              },
              last: () => void order.push("last"),
            }),
          ],
        });
        const office = await openOffice(s, repo.dir);

        const reply = await send(s, "fixture.ping", {}, office);
        expect(errorOf(reply)).toBe("office.refused");
        expect(!reply.ok && reply.error.details).toMatchObject({ step: "backlog.version" });
        expect(order).toEqual(["first", "backlog.version"]);
        expect(s.manager.loadedOffices()).toEqual([]);
        expect(s.events.at(-1)?.data).toEqual({
          level: "error",
          code: "office.refused",
          text: `Office ${office} at ${repo.dir} was not loaded: load step backlog.version failed: Backlog.md 1.40.0 is older than 1.53.0`,
        });

        // A step may also refuse by value; the next attempt runs the steps again.
        failing = false;
        order.length = 0;
        const second = await send(s, "fixture.ping", {}, office);
        expect(!second.ok && second.error.details).toMatchObject({ step: "refusing" });
        expect(order).toEqual(["first", "backlog.version", "refusing"]);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("reject two modules registering the same step name", () => {
    const a = stepsFeature("fixture/a", { scan: () => undefined });
    const b = stepsFeature("fixture/b", { scan: () => undefined });
    expect(() => buildRegistry([a, b])).toThrow(DuplicateRegistrationError);
    expect(() => buildRegistry([checksFeature("x"), checksFeature("y")])).toThrow(
      "The active-work check runs is registered by both x and y",
    );
  });
});

const OFFICE_YAML = join(".dipo", "office.yaml");
const CLOSED = "version: 10\nstoryPr:\n  open: false\n";
// Version 11 (DIPO-251) adds the R30 story phrases; the version 10 files take their defaults.
const OPEN = "version: 11\nstoryPr:\n  open: true\nstory:\n  securityPhrases: [firewall rule]\n";
const INVALID = "version: 10\ntimeouts:\n  workerStallMinutes: soon\n";

interface Polled {
  readonly repo: TempRepoWithRemote;
  readonly s: OfficeSetup;
  readonly officeId: OfficeId;
  /** Runs one story index poll on the manual clock and waits for it, its reload included. */
  poll(): Promise<void>;
}

/**
 * `office.yaml` set to `text` on `origin/main` only: committed on top of `origin/main` and pushed,
 * then the main checkout goes back to the commit it was at, so only the base has the new file, as
 * after a merge on the host that the maintainer has not pulled.
 */
async function pushToBaseOnly(repo: TempRepoWithRemote, text: string): Promise<void> {
  const checkout = (await repo.git("rev-parse", "HEAD")).trim();
  await repo.git("reset", "--quiet", "--hard", "origin/main");
  mkdirSync(join(repo.dir, ".dipo"), { recursive: true });
  writeFileSync(join(repo.dir, OFFICE_YAML), text);
  await repo.commitAll("office.yaml on the base");
  await repo.git("push", "--quiet", "origin", "main");
  await repo.git("reset", "--quiet", "--hard", checkout);
}

/** The Backlog fixture with `CLOSED` pushed to a bare `origin`, loaded with the story index. */
function withPolledOffice(fn: (o: Polled) => Promise<void>): Promise<void> {
  return withBareRemote(
    async (repo) => {
      mkdirSync(join(repo.dir, ".dipo"), { recursive: true });
      writeFileSync(join(repo.dir, OFFICE_YAML), CLOSED);
      await repo.commitAll("fixture");
      await repo.git("push", "--quiet", "-u", "origin", "main");
      await repo.git("remote", "set-head", "origin", "main");

      const engineGit = new EngineGit({ spawn: systemSpawn, env: repo.env });
      let setup: OfficeSetup | undefined;
      // Wired as createEngine wires it (packages/engine/src/create/stories.ts).
      const index = new StoryIndex({
        git: engineGit,
        stories: backlogStoryStore({ spawn: systemSpawn, command: BACKLOG_CLI, env: repo.env }),
        offices: {
          get: (office) => setup?.manager.get(office),
          config: (office) => setup?.manager.config(office),
        },
        reloadConfig: async (office) =>
          setup?.manager.reloadIfChanged(office, engineGit.forOffice(office)),
      });
      const s = await officeSetup(repo.root, { features: [engineGit.feature, index.feature] });
      setup = s;
      try {
        const officeId = await openOffice(s, repo.dir);
        const access = await s.manager.load(officeId);
        if (!access.ok) throw new Error(`${access.error.code}: ${access.error.message}`);
        await fn({
          repo,
          s,
          officeId,
          poll: async () => {
            s.clock.advance(OFFICE_DEFAULTS.polling.fetchSeconds * 1000);
            await index.whenIdle(officeId);
          },
        });
      } finally {
        index.stop();
        s.state.close();
      }
    },
    { fixture: BACKLOG_FIXTURE },
  );
}

function officeNotices(s: OfficeSetup, office: OfficeId, code: string): unknown[] {
  const handle = s.state.office(office);
  const result = replay(handle, cursorAt(office, readLogState(handle).epoch, 0));
  if (!result.ok) throw new Error(result.error.message);
  return result.entries
    .filter((entry) => entry.type === "engine.notice")
    .map((entry) => entry.delta)
    .filter((delta) => (delta as { code?: string }).code === code);
}

describe("a changed office.yaml on the base (DIPO-303)", () => {
  it("is in force after the next poll, while the checkout still has the old file", () =>
    withPolledOffice(async ({ repo, s, officeId, poll }) => {
      expect(s.manager.config(officeId)?.storyPr.open).toBe(false);
      expect(s.manager.config(officeId)?.story.securityPhrases).toEqual(
        OFFICE_DEFAULTS.story.securityPhrases,
      );
      const hash = s.manager.configHash(officeId);

      await pushToBaseOnly(repo, OPEN);
      expect(readFileSync(join(repo.dir, OFFICE_YAML), "utf8")).toBe(CLOSED);
      expect(s.manager.config(officeId)?.storyPr.open).toBe(false);
      await poll();
      expect(s.manager.config(officeId)?.storyPr.open).toBe(true);
      expect(s.manager.config(officeId)?.story.securityPhrases).toEqual(["firewall rule"]);
      expect(s.manager.config(officeId)?.story.securityCriteriaPhrases).toEqual(
        OFFICE_DEFAULTS.story.securityCriteriaPhrases,
      );
      expect(s.manager.configHash(officeId)).not.toBe(hash);
      expect(s.manager.configBlocksRuns(officeId)).toEqual([]);

      // The base did not change again: the next poll keeps the configuration in force.
      const reloaded = s.manager.configHash(officeId);
      await poll();
      expect(s.manager.configHash(officeId)).toBe(reloaded);
    }));

  it("keeps the configuration in force when refused, with one config.invalid notice", () =>
    withPolledOffice(async ({ repo, s, officeId, poll }) => {
      const hash = s.manager.configHash(officeId);
      await pushToBaseOnly(repo, INVALID);
      await poll();
      expect(s.manager.configHash(officeId)).toBe(hash);
      expect(s.manager.config(officeId)?.storyPr.open).toBe(false);
      expect(s.manager.configBlocksRuns(officeId).map((error) => error.path)).toEqual([
        "timeouts.workerStallMinutes",
      ]);
      const invalid = officeNotices(s, officeId, "config.invalid");
      expect(invalid).toHaveLength(1);
      expect(invalid[0]).toMatchObject({ level: "error" });
      expect((invalid[0] as { text: string }).text).toContain(
        "running work keeps the previous configuration",
      );

      // The same refused file at the next poll raises no second notice.
      await poll();
      expect(officeNotices(s, officeId, "config.invalid")).toHaveLength(1);

      // A valid file on the base lifts the refusal at the poll after it.
      await pushToBaseOnly(repo, OPEN);
      await poll();
      expect(s.manager.configBlocksRuns(officeId)).toEqual([]);
      expect(s.manager.config(officeId)?.storyPr.open).toBe(true);
    }));
});
