// Role files on the base (DIPO-471; 0017): the roster is read from the base commit, never the
// checkout, and the poll reads it again; an invalid file leaves only its role out.

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

import { executeRead } from "../../src/reads/execute";
import { nextRequestId } from "./helpers";
import { cursorAt } from "../../src/changelog/log";
import { replay } from "../../src/changelog/replay";
import { EngineGit } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import { BACKLOG_FIXTURE, officeSetup, resultOf, send } from "./helpers";

const ROLE = (purpose: string) => `---\nversion: 1\npurpose: ${purpose}\n---\nDo the work.\n`;

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
        expect(s.manager.roster(office)).toEqual([{ name: "developer", code: true }]);

        // Another clone adds a valid and an invalid role on the base.
        const clone = join(repo.root, "clone");
        await repo.run(["git", "clone", "--quiet", repo.remote, clone], repo.root);
        writeRole(clone, "tester", ROLE("Tests"));
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
          roles: { name: string; purpose: string; instructions: string }[];
          invalid: { path: string; problem: string }[];
        };
        expect(view.roles).toEqual([
          { name: "developer", purpose: "Builds", instructions: "Do the work." },
          { name: "tester", purpose: "Tests", instructions: "Do the work." },
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
});
