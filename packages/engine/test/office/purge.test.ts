// `office.purge` (DIPO-76; 0007 section 3, 0005 amendment of 2026-10-12): it deletes every row
// with the office id and the office's `<git-common-dir>/dipo/` directory, `mcp.json` included,
// fails with `office.busy` while work is active, and is software-level for idempotency: a retry
// with the same `requestId` gets the stored reply although the office's own `requests` rows are
// gone.

import { describe, expect, it } from "bun:test";
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId, RunId, StoryKey } from "@dipsaus-orchestrator/contract";
import { withTempRepo } from "@dipsaus-orchestrator/testkit";

import { appendEntries, newLogState } from "../../src/changelog/log";
import { executeCommand } from "../../src/commands/execute";
import { SOFTWARE_TABLES } from "../../src/db/schema";
import type { FeatureModule } from "../../src/commands/registry";
import { markerPath, officeDirectory } from "../../src/office/marker";
import { deleteOrder, officeTables, purgeOfficeRows } from "../../src/office/purge";
import { insertRun } from "../../src/run";
import { insertClaim } from "../../src/worktree/records";
import {
  BACKLOG_FIXTURE,
  errorOf,
  nextRequestId,
  officeRows,
  officeSetup,
  resultOf,
  send,
  type OfficeSetup,
} from "./helpers";

async function openOffice(s: OfficeSetup, path: string): Promise<OfficeId> {
  return resultOf<{ office: OfficeId }>(await send(s, "office.open", { path })).office;
}

/** Rows with the office id in every office table and in `offices`, by table; empty tables left out. */
function rowsOf(s: OfficeSetup, office: OfficeId): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of [...officeTables(s.state.connection), "offices"]) {
    const n =
      s.state.connection.get<{ n: number }>(
        `select count(*) as n from "${table}" where office_id = $office`,
        { office },
      )?.n ?? 0;
    if (n > 0) counts[table] = n;
  }
  return counts;
}

/** A second office straight in the table, with one change-log entry, that purge must not touch. */
function otherOffice(s: OfficeSetup): OfficeId {
  const office = s.ids.next("off") as OfficeId;
  const log = newLogState();
  s.state.connection.immediate(() =>
    s.state.connection.run(
      `insert into offices (office_id, path, display_name, added_at, epoch, next_seq, replay_floor_seq)
       values ($office, '/repos/other', 'other', 0, $epoch, $next, $floor)`,
      { office, epoch: log.epoch, next: log.nextSeq, floor: log.replayFloorSeq },
    ),
  );
  note(s, office, "other");
  return office;
}

function note(s: OfficeSetup, office: OfficeId, text: string): void {
  const handle = s.state.office(office);
  handle.immediate(() =>
    appendEntries(handle, [{ type: "engine.notice", delta: { level: "info", code: "x", text } }], {
      at: s.clock.now(),
    }),
  );
}

/** A released claim and its run: rows in tables that reference each other. */
function addRun(s: OfficeSetup, office: OfficeId, worktree: string): void {
  const handle = s.state.office(office);
  const runId = RunId.parse(s.ids.next("run"));
  const key = StoryKey.parse(s.ids.next("sto"));
  handle.immediate(() => {
    insertClaim(handle, {
      runId,
      key,
      story: "TASK-1",
      branch: "TASK-1/a-story",
      worktree,
      base: "main",
      baseSha: "b".repeat(40),
      startSha: "a".repeat(40),
      claimSha: "c".repeat(40),
      reused: false,
      snapshot: { path: worktree, adminDir: "/x", commondir: "/x", gitdir: "/x", pointer: "/x" },
      firstFeedback: null,
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
      worktree,
      slot: null,
      budgetUnit: "tokens",
      budgetLimit: 300_000,
      loopCap: 3,
      reviewRoundCap: null,
      configHash: "hash",
      overrideKeys: null,
      runProfileId: null,
      startedAt: 0,
    });
    handle.run(
      "update claims set released_at = 1, release_reason = 'done' where office_id = $office_id",
    );
  });
}

function busyCheck(state: { busy: boolean }): FeatureModule {
  return {
    name: "fixture/runs",
    register(registry) {
      registry.registerActiveWorkCheck("runs", () => state.busy);
    },
  };
}

describe("office.purge", () => {
  it("deletes every row of the office and its .git/dipo directory, and nothing else", async () => {
    await withTempRepo(
      async (repo) => {
        const s = await officeSetup(repo.root);
        const office = await openOffice(s, repo.dir);
        // Loaded, with a request record, history, a run and its claim, and an mcp.json.
        resultOf(await send(s, "fixture.ping", {}, office));
        note(s, office, "history");
        addRun(s, office, join(repo.root, "trees", "TASK-1"));
        const commonDir = join(repo.dir, ".git");
        writeFileSync(join(officeDirectory(commonDir), "mcp.json"), "{}\n");
        const other = otherOffice(s);
        const before = rowsOf(s, office);
        expect(Object.keys(before).toSorted()).toEqual(
          expect.arrayContaining(["change_log", "claims", "offices", "requests", "runs"]),
        );
        const otherBefore = rowsOf(s, other);

        const reply = await send(s, "office.purge", { office });

        const rows = Object.values(before).reduce((sum, n) => sum + n, 0);
        expect(resultOf<object>(reply)).toEqual({
          office,
          path: repo.dir,
          rows,
          directory: officeDirectory(commonDir),
        });
        expect(reply.ok && reply.changed).toBe(true);
        expect(rowsOf(s, office)).toEqual({});
        expect(rowsOf(s, other)).toEqual(otherBefore);
        expect(existsSync(officeDirectory(commonDir))).toBe(false);
        expect(s.manager.loadedOffices()).toEqual([]);
        expect(s.events.at(-1)).toMatchObject({ type: "office.forgotten", data: { office } });
        expect(errorOf(await send(s, "fixture.ping", {}, office))).toBe("office.unknown");
        // Another purge is a new request for an office that no longer exists.
        expect(errorOf(await send(s, "office.purge", { office }))).toBe("office.unknown");
        // Opening the repository again makes a new office.
        const reopened = await openOffice(s, repo.dir);
        expect(reopened).not.toBe(office);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("answers a retry with the same requestId from the daemon's memory", async () => {
    await withTempRepo(
      async (repo) => {
        const s = await officeSetup(repo.root);
        const office = await openOffice(s, repo.dir);
        const request = {
          requestId: nextRequestId(),
          name: "office.purge",
          args: { office },
          origin: "cli" as const,
          confirmed: false,
        };
        const first = await executeCommand(s.deps, request);
        expect(first.ok).toBe(true);
        expect(officeRows(s.state)).toEqual([]);
        const again = await executeCommand(s.deps, request);
        expect(again).toEqual(first);
        expect(s.deps.softwareRequests.find(request.requestId)?.reply).toEqual(first);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("fails with office.busy while an active-work check reports work, and keeps everything", async () => {
    await withTempRepo(
      async (repo) => {
        const runs = { busy: true };
        const s = await officeSetup(repo.root, { features: [busyCheck(runs)] });
        const office = await openOffice(s, repo.dir);
        const before = rowsOf(s, office);

        const reply = await send(s, "office.purge", { office });
        expect(errorOf(reply)).toBe("office.busy");
        expect(!reply.ok && reply.error.details).toEqual({ office, check: "runs" });
        expect(rowsOf(s, office)).toEqual(before);
        expect(officeRows(s.state)[0]?.forgotten_at).toBeNull();
        expect(existsSync(markerPath(join(repo.dir, ".git")))).toBe(true);

        runs.busy = false;
        resultOf(await send(s, "office.purge", { office }));
        expect(officeRows(s.state)).toEqual([]);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("purges a forgotten office and one whose path is missing, without a directory", async () => {
    await withTempRepo(
      async (repo) => {
        const s = await officeSetup(repo.root);
        const office = await openOffice(s, repo.dir);
        resultOf(await send(s, "office.forget", { office }));
        rmSync(repo.dir, { recursive: true, force: true });

        const reply = await send(s, "office.purge", { office });
        const result = resultOf<{ directory?: string; rows: number }>(reply);
        expect(result.directory).toBeUndefined();
        expect(result.rows).toBeGreaterThanOrEqual(1);
        expect(officeRows(s.state)).toEqual([]);
        // A forgotten office was already off the list: no second office.forgotten.
        expect(s.events.filter((event) => event.type === "office.forgotten")).toHaveLength(1);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("finishes a purge that stopped halfway", async () => {
    await withTempRepo(
      async (repo) => {
        const s = await officeSetup(repo.root);
        const office = await openOffice(s, repo.dir);
        resultOf(await send(s, "fixture.ping", {}, office));
        for (let i = 0; i < 3; i++) note(s, office, `entry ${i}`);
        addRun(s, office, join(repo.root, "trees", "TASK-1"));
        // As a first purge leaves it when it stops: forgotten, .git/dipo gone, some tables empty.
        const handle = s.state.office(office);
        handle.immediate(() => {
          handle.run("delete from change_log where office_id = $office_id");
          handle.run("delete from claims where office_id = $office_id");
        });
        s.state.connection.immediate(() =>
          s.state.connection.run("update offices set forgotten_at = 1 where office_id = $office", {
            office,
          }),
        );
        rmSync(officeDirectory(join(repo.dir, ".git")), { recursive: true, force: true });
        const left = rowsOf(s, office);
        expect(left["offices"]).toBe(1);
        expect(left["runs"]).toBe(1);
        expect(left["change_log"]).toBeUndefined();

        const result = resultOf<{ rows: number; directory?: string }>(
          await send(s, "office.purge", { office }),
        );

        expect(result.directory).toBeUndefined();
        expect(result.rows).toBe(Object.values(left).reduce((sum, n) => sum + n, 0));
        expect(rowsOf(s, office)).toEqual({});
        expect(officeRows(s.state)).toEqual([]);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("leaves a .git/dipo directory whose marker names another office", async () => {
    await withTempRepo(
      async (repo) => {
        const s = await officeSetup(repo.root);
        const office = await openOffice(s, repo.dir);
        // The repository was re-registered under another id; the old row still names its path.
        const marker = markerPath(join(repo.dir, ".git"));
        writeFileSync(
          marker,
          JSON.stringify({ officeId: s.ids.next("off"), createdAt: new Date(0).toISOString() }),
        );
        const result = resultOf<{ directory?: string }>(await send(s, "office.purge", { office }));
        expect(result.directory).toBeUndefined();
        expect(existsSync(marker)).toBe(true);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });
});

describe("office.purge from (0005 amendment of 2026-10-14)", () => {
  it("purges with a matching from and refuses a copy or another repository with office.unknown", async () => {
    await withTempRepo(
      async (repo) => {
        const s = await officeSetup(repo.root);
        const office = await openOffice(s, repo.dir);
        const copy = join(repo.root, "copy");
        cpSync(repo.dir, copy, { recursive: true });
        const before = rowsOf(s, office);

        const fromCopy = await send(s, "office.purge", { office, from: copy });
        expect(errorOf(fromCopy)).toBe("office.unknown");
        expect(!fromCopy.ok && fromCopy.error.details).toEqual({
          office,
          from: copy,
          reason: "path",
        });
        expect(rowsOf(s, office)).toEqual(before);
        expect(existsSync(markerPath(join(repo.dir, ".git")))).toBe(true);
        expect(existsSync(markerPath(join(copy, ".git")))).toBe(true);

        // A forgotten office named by id from another repository is refused the same way.
        resultOf(await send(s, "office.forget", { office }));
        expect(errorOf(await send(s, "office.purge", { office, from: copy }))).toBe(
          "office.unknown",
        );
        expect(rowsOf(s, office)["offices"]).toBe(1);

        const purged = resultOf<{ directory?: string }>(
          await send(s, "office.purge", { office, from: repo.dir }),
        );
        expect(purged.directory).toBe(officeDirectory(join(repo.dir, ".git")));
        expect(rowsOf(s, office)).toEqual({});
        // The copy's directory is left alone.
        expect(existsSync(markerPath(join(copy, ".git")))).toBe(true);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });
});

describe("purge rows", () => {
  it("orders every office table before the tables it references", async () => {
    await withTempRepo(async (repo) => {
      const s = await officeSetup(repo.root);
      const tables = officeTables(s.state.connection);
      const order = deleteOrder(s.state.connection, tables);
      expect(order.toSorted()).toEqual(tables.toSorted());
      // Every table but the software ones holds office rows, so purge reaches each of them.
      const all = s.state.connection
        .all<{ name: string }>(
          "select name from sqlite_schema where type = 'table' and name not like 'sqlite_%'",
        )
        .map((row) => row.name)
        .filter((name) => !SOFTWARE_TABLES.has(name));
      expect(tables.toSorted()).toEqual(all.toSorted());
      expect(tables.length).toBeGreaterThan(20);
      for (const table of tables) {
        const parents = s.state.connection
          .all<{ table: string }>('select "table" from pragma_foreign_key_list($table)', { table })
          .map((key) => key.table)
          .filter((parent) => parent !== table && tables.includes(parent));
        for (const parent of parents) {
          expect(order.indexOf(table), `${table} before ${parent}`).toBeLessThan(
            order.indexOf(parent),
          );
        }
      }
    });
  });

  it("deletes a large office in batches", async () => {
    await withTempRepo(
      async (repo) => {
        const s = await officeSetup(repo.root);
        const office = await openOffice(s, repo.dir);
        for (let i = 0; i < 25; i++) note(s, office, `entry ${i}`);
        const report = await purgeOfficeRows({
          connection: s.state.connection,
          office,
          clock: s.clock,
          maxBatch: 4,
          pause: async () => {},
        });
        expect(report.deleted).toEqual({ change_log: 25, offices: 1 });
        expect(report.rows).toBe(26);
        expect(rowsOf(s, office)).toEqual({});
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });
});
