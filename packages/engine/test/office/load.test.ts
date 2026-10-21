// Office loading (DIPO-27; 0006 decision 4, 0007 section 6): an office's engine instance loads on
// its first office-level command or read, refuses an office whose `office.json` names another id,
// and runs the load steps feature modules registered, in registration order; a failing step
// refuses the office with a notice naming it.

import { describe, expect, it } from "bun:test";
import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { withTempRepo } from "@dipsaus-orchestrator/testkit";

import {
  buildRegistry,
  DuplicateRegistrationError,
  type FeatureModule,
} from "../../src/commands/registry";
import { writeMarker } from "../../src/office/marker";
import type { LoadStep, OfficeLoadContext } from "../../src/office/steps";
import { BACKLOG_FIXTURE, errorOf, officeSetup, resultOf, send, type OfficeSetup } from "./helpers";

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
        expect(seen[0]?.config?.version).toBe(9);
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
