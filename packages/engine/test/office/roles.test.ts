// Role files on the base (DIPO-471; 0017): the roster is read from the base commit, never the
// checkout, and the poll reads it again; an invalid file leaves only its role out.

import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

import { buildRegistry } from "../../src/commands/registry";
import { createLogger } from "../../src/log/logger";
import { officeFeature } from "../../src/office/feature";
import { OfficeManager } from "../../src/office/manager";
import { localMounts } from "../db/helpers";
import { backlogLayout } from "../story-store/backlog";
import { executeRead } from "../../src/reads/execute";
import { nextRequestId } from "./helpers";
import { cursorAt } from "../../src/changelog/log";
import { replay } from "../../src/changelog/replay";
import { EngineGit } from "../../src/git";
import { storeGateDecision } from "../../src/gate-decisions/decisions";
import { rosterHash } from "../../src/gate/hash";
import { systemSpawn } from "../../src/platform/process";
import { latestGate } from "../../src/views/story";
import { keyOf as storyKeyOf } from "../views/helpers";
import { pass, task } from "../stories/helpers";
import { BACKLOG_FIXTURE, officeSetup, pingFeature, resultOf, send } from "./helpers";

const ROLE = (purpose: string, kind = "code") =>
  `---\nversion: 1\npurpose: ${purpose}\nkind: ${kind}\n---\nDo the work.\n`;

function writeRole(dir: string, name: string, text: string): void {
  mkdirSync(join(dir, ".dipo", "roles"), { recursive: true });
  writeFileSync(join(dir, ".dipo", "roles", `${name}.md`), text);
}

async function pushMain(repo: TempRepoWithRemote): Promise<void> {
  await repo.git("push", "--quiet", "-u", "origin", "main");
  await repo.git("remote", "set-head", "origin", "main");
}

describe("the roster from role files on the base", () => {
  it("holds the committed roles and not a file only in the checkout, and follows the poll", () =>
    withBareRemote(
      async (repo) => {
        writeRole(repo.dir, "developer", ROLE("Builds"));
        await repo.commitAll("add developer role");
        await pushMain(repo);
        // Only in the checkout: never committed.
        writeRole(repo.dir, "designer", ROLE("Designs"));

        const engineGit = new EngineGit({ spawn: systemSpawn, env: repo.env });
        const s = await officeSetup(repo.root, { features: [engineGit.feature] });
        const office = resultOf<{ office: OfficeId }>(
          await send(s, "office.open", { path: repo.dir }),
        ).office;
        resultOf(await send(s, "fixture.ping", {}, office));
        expect(s.manager.roster(office)).toEqual([{ name: "developer", code: true, kind: "code" }]);

        // Another clone adds a valid and an invalid role on the base.
        const clone = join(repo.root, "clone");
        await repo.run(["git", "clone", "--quiet", repo.remote, clone], repo.root);
        writeRole(clone, "tester", ROLE("Tests", "design"));
        writeRole(clone, "broken", "---\nversion: 1\n---\nBody\n");
        await repo.run(["git", "add", "--all"], clone);
        await repo.run(["git", "commit", "--quiet", "-m", "more roles"], clone);
        await repo.run(["git", "push", "--quiet", "origin", "main"], clone);

        const git = engineGit.forOffice(office);
        await git?.fetch();
        await s.manager.reloadIfChanged(office, git);
        expect(s.manager.roster(office).map((role) => role.name)).toEqual(["developer", "tester"]);
        const notices = () => {
          const result = replay(s.state.office(office), cursorAt(office, 0));
          if (!result.ok) throw new Error(result.error.message);
          return result.entries
            .filter((entry) => entry.type === "engine.notice")
            .map((entry) => entry.delta as { code: string; text: string })
            .filter((notice) => notice.code === "role.invalid");
        };
        expect(notices()).toHaveLength(1);
        expect(notices()[0]?.text).toContain(".dipo/roles/broken.md");

        // The same invalid file on the next poll raises no second notice.
        await s.manager.reloadIfChanged(office, git);
        expect(notices()).toHaveLength(1);

        // `office.roles` (DIPO-473): the two roles and the invalid file with its problem.
        const reply = await executeRead(s.deps, {
          requestId: nextRequestId(),
          name: "office.roles",
          args: { office },
        });
        if (!reply.ok) throw new Error(reply.error.message);
        const view = reply.result as {
          roles: { name: string; purpose: string; instructions: string; kind: string }[];
          invalid: { path: string; problem: string }[];
        };
        expect(view.roles).toEqual([
          { name: "developer", purpose: "Builds", instructions: "Do the work.", kind: "code" },
          { name: "tester", purpose: "Tests", instructions: "Do the work.", kind: "design" },
        ]);
        expect(view.invalid).toHaveLength(1);
        expect(view.invalid[0]?.path).toBe(".dipo/roles/broken.md");
        expect(view.invalid[0]?.problem).toContain("purpose");

        // The change put one `roles.changed` entry in the log, and the same files none more.
        const changes = () => {
          const result = replay(s.state.office(office), cursorAt(office, 0));
          if (!result.ok) throw new Error(result.error.message);
          return result.entries.filter((entry) => entry.type === "roles.changed").length;
        };
        expect(changes()).toBeGreaterThanOrEqual(1);
        const seen = changes();
        await s.manager.reloadIfChanged(office, git);
        expect(changes()).toBe(seen);
      },
      { fixture: BACKLOG_FIXTURE },
    ));

  it("shows a stored gate decision only while the roster it read is in force (DIPO-516)", () =>
    withBareRemote(
      async (repo) => {
        writeRole(repo.dir, "developer", ROLE("Builds"));
        await repo.commitAll("add developer role");
        await pushMain(repo);
        const engineGit = new EngineGit({ spawn: systemSpawn, env: repo.env });
        const s = await officeSetup(repo.root, { features: [engineGit.feature] });
        const office = resultOf<{ office: OfficeId }>(
          await send(s, "office.open", { path: repo.dir }),
        ).office;
        resultOf(await send(s, "fixture.ping", {}, office));
        const handle = s.state.office(office);
        pass(s as never, handle, [task("TASK-1"), task("TASK-2")]);
        const [one, two] = [storyKeyOf(handle, "TASK-1"), storyKeyOf(handle, "TASK-2")];
        const decide = (key: typeof one, passed: boolean, hash: string | null) => {
          handle.immediate(() =>
            storeGateDecision(handle, s.ids, {
              key,
              result: {
                mode: "ready",
                passed,
                failures: passed ? [] : [{ rule: "R17", message: "R17: no role designer" }],
              } as never,
              contentHash: "h",
              rosterHash: hash ?? "",
              at: s.clock.now(),
            }),
          );
          if (hash === null) {
            handle.run(
              "update gate_decisions set roster_hash = null where office_id = $office_id and roster_hash = ''",
            );
          }
        };
        decide(one, false, rosterHash(s.manager.roster(office)));
        decide(two, true, null);
        expect(latestGate(handle, one, "h")?.failures).toHaveLength(1);
        // A decision stored before the migration has no roster hash: no failures, no pass.
        expect(latestGate(handle, two, "h")).toBeNull();

        const git = engineGit.forOffice(office);
        const push = async (change: (dir: string) => void, message: string) => {
          const clone = join(repo.root, `clone-${message.replaceAll(" ", "-")}`);
          await repo.run(["git", "clone", "--quiet", repo.remote, clone], repo.root);
          change(clone);
          await repo.run(["git", "add", "--all"], clone);
          await repo.run(["git", "commit", "--quiet", "-m", message], clone);
          await repo.run(["git", "push", "--quiet", "origin", "main"], clone);
          await git?.fetch();
          await s.manager.reloadIfChanged(office, git);
        };

        // Only a role's instructions change: the decision keeps showing.
        await push(
          (dir) => writeRole(dir, "developer", ROLE("Builds").replace("Do the", "Do all the")),
          "edit text",
        );
        expect(latestGate(handle, one, "h")?.failures).toHaveLength(1);

        // A designer role lands: the old failure is not shown.
        await push((dir) => writeRole(dir, "designer", ROLE("Designs", "design")), "add designer");
        expect(latestGate(handle, one, "h")).toBeNull();

        // A decision stored with the new roster shows, as does one after a re-read of the same files.
        decide(two, true, rosterHash(s.manager.roster(office)));
        expect(latestGate(handle, two, "h")?.passed).toBe(true);
        await s.manager.reloadIfChanged(office, git);
        expect(latestGate(handle, two, "h")?.passed).toBe(true);

        // A daemon restart: a new manager loads the office over the same database and files.
        const restarted = new OfficeManager({
          stories: backlogLayout,
          database: () => s.state,
          registry: () => registry,
          software: s.software,
          clock: s.clock,
          ids: s.ids,
          git: { spawn: systemSpawn, env: repo.env },
          logger: createLogger({ clock: s.clock, sinks: [], component: "office", level: "error" }),
          readMounts: localMounts,
        });
        const registry = buildRegistry([officeFeature(restarted), pingFeature, engineGit.feature]);
        const loaded = await restarted.load(office);
        expect(loaded.ok).toBe(true);
        expect(restarted.roster(office).map((role) => role.name)).toEqual([
          "designer",
          "developer",
        ]);
        expect(latestGate(handle, one, "h")).toBeNull();
        expect(latestGate(handle, two, "h")?.passed).toBe(true);

        // The designer role is removed: the stored pass no longer shows.
        await push((dir) => rmSync(join(dir, ".dipo", "roles", "designer.md")), "remove designer");
        expect(latestGate(handle, two, "h")).toBeNull();
      },
      { fixture: BACKLOG_FIXTURE },
    ));
});
