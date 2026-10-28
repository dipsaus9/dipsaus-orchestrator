// `office.forget` (DIPO-27; 0005 section 4, 0007 section 3): it sets `forgotten_at`, keeps every
// row, emits `office.forgotten` and refuses with `office.busy` while an active-work check reports
// work; opening the repository again restores the office with its rows.

import { describe, expect, it } from "bun:test";
import { cpSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId, RunId, StoryKey } from "@dipsaus-orchestrator/contract";
import { withTempRepo } from "@dipsaus-orchestrator/testkit";

import { appendEntries } from "../../src/changelog/log";
import type { FeatureModule } from "../../src/commands/registry";
import { insertRun, WorkRun, type WorkRunDeps } from "../../src/run";
import { insertClaim } from "../../src/worktree/records";
import {
  BACKLOG_FIXTURE,
  errorOf,
  officeRows,
  officeSetup,
  resultOf,
  send,
  type OfficeSetup,
} from "./helpers";

async function openOffice(s: OfficeSetup, path: string): Promise<OfficeId> {
  return resultOf<{ office: OfficeId }>(await send(s, "office.open", { path })).office;
}

function changeLogRows(s: OfficeSetup, office: OfficeId): number {
  return (
    s.state.connection.get<{ n: number }>(
      "select count(*) as n from change_log where office_id = $office",
      { office },
    )?.n ?? 0
  );
}

/** A stub active-work check, as DIPO-48 registers the run check. */
function busyCheck(state: { busy: boolean; asked: OfficeId[] }): FeatureModule {
  return {
    name: "fixture/runs",
    register(registry) {
      registry.registerActiveWorkCheck("runs", (office) => {
        state.asked.push(office.officeId);
        return state.busy;
      });
    },
  };
}

describe("office.forget", () => {
  it("hides the office, keeps its rows, and reopening restores it", async () => {
    await withTempRepo(
      async (repo) => {
        const s = await officeSetup(repo.root);
        const office = await openOffice(s, repo.dir);
        // Load it and give it some history.
        resultOf(await send(s, "fixture.ping", {}, office));
        const handle = s.state.office(office);
        handle.immediate(() =>
          appendEntries(
            handle,
            [{ type: "engine.notice", delta: { level: "info", code: "x", text: "history" } }],
            { at: s.clock.now() },
          ),
        );
        expect(s.manager.loadedOffices()).toEqual([office]);

        s.clock.advance(1000);
        const reply = await send(s, "office.forget", { office });
        expect(resultOf<object>(reply)).toEqual({ office, path: repo.dir });
        expect(reply.ok && reply.changed).toBe(true);
        expect(officeRows(s.state)[0]?.forgotten_at).toBe(s.clock.now());
        expect(changeLogRows(s, office)).toBe(1);
        expect(s.events.at(-1)).toMatchObject({ type: "office.forgotten", data: { office } });
        expect(s.manager.loadedOffices()).toEqual([]);
        expect(errorOf(await send(s, "fixture.ping", {}, office))).toBe("office.unknown");

        const again = await send(s, "office.forget", { office });
        expect(again.ok && again.changed).toBe(false);

        const reopened = await send(s, "office.open", { path: repo.dir });
        expect(resultOf<object>(reopened)).toEqual({ office, registered: false });
        expect(reopened.ok && reopened.changed).toBe(true);
        expect(officeRows(s.state)[0]?.forgotten_at).toBeNull();
        expect(changeLogRows(s, office)).toBe(1);
        expect(s.events.at(-1)).toMatchObject({ type: "office.registered", data: { office } });
        resultOf(await send(s, "fixture.ping", {}, office));
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("fails with office.busy while an active-work check reports work", async () => {
    await withTempRepo(
      async (repo) => {
        const runs = { busy: true, asked: [] as OfficeId[] };
        const s = await officeSetup(repo.root, { features: [busyCheck(runs)] });
        const office = await openOffice(s, repo.dir);

        const reply = await send(s, "office.forget", { office });
        expect(errorOf(reply)).toBe("office.busy");
        expect(!reply.ok && reply.error.details).toEqual({ office, check: "runs" });
        expect(runs.asked).toEqual([office]);
        expect(officeRows(s.state)[0]?.forgotten_at).toBeNull();
        expect(s.events.map((event) => event.type)).toEqual(["office.registered"]);

        runs.busy = false;
        resultOf(await send(s, "office.forget", { office }));
        expect(officeRows(s.state)[0]?.forgotten_at).not.toBeNull();
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("fails with office.unknown for an id that was never registered", async () => {
    await withTempRepo(async (repo) => {
      const s = await officeSetup(repo.root);
      const office = s.ids.next("off");
      expect(errorOf(await send(s, "office.forget", { office }))).toBe("office.unknown");
    });
  });
});

describe("the from path", () => {
  it("refuses forget and reloadConfig with office.unknown when from is not the registered path", async () => {
    await withTempRepo(
      async (repo) => {
        const s = await officeSetup(repo.root);
        const office = await openOffice(s, repo.dir);
        const copy = join(repo.root, "copy");
        cpSync(repo.dir, copy, { recursive: true });
        for (const name of ["office.forget", "office.reloadConfig"]) {
          const reply = await send(s, name, { office, from: copy });
          expect(errorOf(reply)).toBe("office.unknown");
          expect(!reply.ok && reply.error.details).toEqual({ office, from: copy, reason: "path" });
          expect(!reply.ok && reply.error.message).toBe(
            `${copy} is not office ${office}, which is registered at ${repo.dir}.`,
          );
        }
        expect(officeRows(s.state)[0]?.forgotten_at).toBeNull();
        expect(s.manager.loadedOffices()).toEqual([]);
        // Another spelling of the registered path is the same office.
        const via = join(repo.root, "via");
        symlinkSync(repo.dir, via);
        resultOf(await send(s, "office.reloadConfig", { office, from: via }));
        resultOf(await send(s, "office.forget", { office, from: repo.dir }));
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });
});

describe("office.forget and runs (DIPO-48)", () => {
  it("fails with office.busy while a story run with a live claim is active", async () => {
    await withTempRepo(
      async (repo) => {
        // Only the feature's registrations are used: the command and the active-run check.
        const s = await officeSetup(repo.root, {
          features: [new WorkRun({} as WorkRunDeps).feature],
        });
        const office = await openOffice(s, repo.dir);
        const handle = s.state.office(office);
        const runId = RunId.parse(s.ids.next("run"));
        const key = StoryKey.parse(s.ids.next("sto"));
        handle.immediate(() => {
          insertClaim(handle, {
            runId,
            key,
            story: "TASK-1",
            branch: "TASK-1/a-story",
            base: "main",
            baseSha: "b".repeat(40),
            startSha: "a".repeat(40),
            claimSha: "c".repeat(40),
            reused: false,
            claimedAt: 0,
          });
          insertRun(handle, {
            runId,
            kind: "story",
            key,
            story: "TASK-1",
            tier: "S",
            role: "developer",
            model: "haiku",
            startSha: "a".repeat(40),
            branch: "TASK-1/a-story",
            budgetUnit: "tokens",
            budgetLimit: 300_000,
            loopCap: 3,
            reviewRoundCap: null,
            configHash: "hash",
            overrideKeys: null,
            runProfileId: null,
            startedAt: 0,
          });
        });
        const reply = await send(s, "office.forget", { office });
        expect(errorOf(reply)).toBe("office.busy");
        expect(!reply.ok && reply.error.details).toEqual({ office, check: "runs" });

        // A released claim ends the run's activity.
        handle.immediate(() =>
          handle.run(
            "update claims set released_at = 1, release_reason = 'done' where office_id = $office_id",
          ),
        );
        resultOf(await send(s, "office.forget", { office }));
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });
});
