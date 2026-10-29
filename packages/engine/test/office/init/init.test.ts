// Office init end to end on a real repository without a remote (DIPO-36; 0010 sections 2, 6 and
// 11): `office.init` commits steps 1 to 5 on one engine branch, a second run adds no commit, the
// previous settings are recorded, `.dipo/office.yaml` is never written, `To Do` stories on their own
// branch are left alone and listed, and `officeStatusesReady` refuses until the branch is on the
// base; a later run once no task uses `To Do` sets the 0012 list alone. The Backlog CLI is the
// file-backed stand-in of `helpers.ts`; the same flow with the pinned CLI, a remote, the backlog PR
// and the merge slot runs in CI (init.ci.test.ts).

import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { type TempRepo, withTempRepo } from "@dipsaus-orchestrator/testkit";

import { EDIT_KIND, editKind, OfficeLane } from "../../../src/backlog/lane";
import { buildRegistry } from "../../../src/commands/registry";
import {
  formatStatuses,
  INIT_KIND,
  INIT_NOTICES,
  initKind,
  LIFECYCLE_STATUSES,
  OfficeInit,
  officeStatusesReady,
  previousSettings,
  STATUSES_STEP,
} from "../../../src/backlog/init";
import { BACKLOG_FIXTURE, laneSetup, notices, subjects } from "../../backlog/lane/helpers";

import { fileBacklog, oldOffice, oneOffice, setTaskStatus } from "./helpers";

const STEPS = [
  "backlog: init statuses",
  "backlog: init defaultStatus",
  "backlog: init settings",
  "backlog: init To Do tasks",
  "backlog: init .dipo/.gitignore",
];

/** The status list of a first init: the old statuses and the 0012 ones. */
const BOTH = ["To Do", ...LIFECYCLE_STATUSES];

/** The lane with the `init` kind and office init, on the file-backed CLI, base `main`. */
async function initSetup(repo: TempRepo) {
  const s = await laneSetup(repo);
  const officeId = s.office.officeId as OfficeId;
  const backlog = fileBacklog();
  const lane = new OfficeLane({
    officeId,
    office: s.office,
    git: s.git,
    cli: backlog.cli,
    clock: s.t.clock,
    kinds: new Map([
      [EDIT_KIND, editKind(EDIT_KIND)],
      [INIT_KIND, initKind()],
    ]),
  });
  const init = new OfficeInit({
    offices: oneOffice(s.office),
    lane: () => lane,
    git: () => s.git,
    cli: backlog.cli,
    clock: s.t.clock,
  });
  return { s, init, officeId };
}

describe("office init without a remote", () => {
  it("commits steps 1 to 5 on one branch once, and runs are refused until it is on the base", async () => {
    await withTempRepo(
      async (repo) => {
        oldOffice(repo.dir);
        await repo.commitAll("an office from before dipo");
        // TASK-2 is in progress on its own branch.
        await repo.git("branch", "TASK-2/rename-the-export-setting");
        const { s, init, officeId } = await initSetup(repo);
        const show = (path: string, ref: string) => repo.git("show", `${ref}:${path}`);

        expect(await officeStatusesReady(s.git)).toContain("run `dipo office init`");

        const first = await init.init(officeId);
        expect(first.changed).toBe(true);
        const branch = first.result.branch as string;
        expect(branch).toMatch(/^dipo\/backlog-/);
        expect(first.result.pr).toBeUndefined();
        expect(first.result.waiting).toContain("no remote origin");
        expect(first.result.leftAlone).toEqual(["TASK-2"]);
        expect(await subjects(repo.dir, repo.home, branch, "main")).toEqual(STEPS);

        // Only the statuses line, the settings, TASK-1 and the new `.dipo/.gitignore` changed.
        const config = await show("backlog/config.yml", branch);
        expect(config).toContain(`statuses: ${formatStatuses(BOTH)}`);
        expect(config).toContain('default_status: "Refined"');
        expect(config).toContain("check_active_branches: true");
        expect(config).toContain("remote_operations: true");
        expect(config).toContain("auto_commit: false");
        expect(
          (await repo.git("diff", "--name-only", "main", branch)).trim().split("\n").toSorted(),
        ).toEqual(
          [
            ".dipo/.gitignore",
            "backlog/config.yml",
            "backlog/tasks/task-1 - Add-the-CSV-export-command.md",
          ].toSorted(),
        );
        expect(await show(".dipo/.gitignore", branch)).toBe("office.local.yaml\n");
        expect(
          await show("backlog/tasks/task-1 - Add-the-CSV-export-command.md", branch),
        ).toContain("status: Refined");
        // Init never writes `.dipo/office.yaml` (DIPO-15 D9).
        expect((await repo.git("ls-tree", "-r", "--name-only", branch, ".dipo")).trim()).toBe(
          ".dipo/.gitignore",
        );

        expect(previousSettings(s.office).map(({ setting, value }) => [setting, value])).toEqual([
          ["checkActiveBranches", false],
          ["defaultStatus", "To Do"],
          ["remoteOperations", false],
          ["statuses", ["To Do", "In Progress", "Done"]],
        ]);
        expect(notices(s.office).map((notice) => notice.code)).toContain(INIT_NOTICES.leftAlone);

        // A second run adds no commit and keeps the recorded values.
        const second = await init.init(officeId);
        expect(second.changed).toBe(false);
        expect(second.result.branch).toBe(branch);
        expect(await subjects(repo.dir, repo.home, branch, "main")).toEqual(STEPS);
        expect(previousSettings(s.office).find((p) => p.setting === "defaultStatus")?.value).toBe(
          "To Do",
        );
        expect(await officeStatusesReady(s.git)).toContain("`In Review` or `Parked`");

        // Once the branch is on the base, runs may start.
        await repo.git("merge", "--quiet", "--ff-only", branch);
        expect(await officeStatusesReady(s.git)).toBeNull();
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("sets the 0012 list alone once no task uses To Do, and migrates a story whose branch is gone", async () => {
    await withTempRepo(
      async (repo) => {
        // As after a first init: both lists, the settings set, TASK-1 still `To Do` because its
        // branch existed then; `.dipo/.gitignore` is there.
        oldOffice(repo.dir);
        const config = join(repo.dir, "backlog", "config.yml");
        writeFileSync(
          config,
          readFileSync(config, "utf8")
            .replace(/^statuses: .*$/m, `statuses: ${formatStatuses(BOTH)}`)
            .replace(/^default_status: .*$/m, 'default_status: "Refined"')
            .replace("remote_operations: false", "remote_operations: true")
            .replace("check_active_branches: false", "check_active_branches: true"),
        );
        setTaskStatus(repo.dir, "TASK-2", "Refined");
        mkdirSync(join(repo.dir, ".dipo"));
        writeFileSync(join(repo.dir, ".dipo", ".gitignore"), "office.local.yaml\n");
        await repo.commitAll("after a first init");
        const { s, init, officeId } = await initSetup(repo);

        const first = await init.init(officeId);
        expect(first.result.leftAlone).toBeUndefined();
        const branch = first.result.branch as string;
        expect(await subjects(repo.dir, repo.home, branch, "main")).toEqual([
          "backlog: init To Do tasks",
        ]);
        await repo.git("merge", "--quiet", "--ff-only", branch);

        s.t.clock.advance(1000);
        const second = await init.init(officeId);
        const last = second.result.branch as string;
        expect(await subjects(repo.dir, repo.home, last, "main")).toEqual([
          "backlog: init statuses",
        ]);
        expect(await repo.git("show", `${last}:backlog/config.yml`)).toContain(
          `statuses: ${formatStatuses(LIFECYCLE_STATUSES)}`,
        );
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("raises a notice at office load while the base lacks In Review or Parked", async () => {
    await withTempRepo(
      async (repo) => {
        oldOffice(repo.dir);
        await repo.commitAll("an office from before dipo");
        const s = await laneSetup(repo);
        const officeId = s.office.officeId as OfficeId;
        const init = new OfficeInit({
          offices: oneOffice(s.office),
          lane: () => undefined,
          git: () => s.git,
          cli: fileBacklog().cli,
          clock: s.t.clock,
        });
        const step = buildRegistry([init.feature])
          .loadSteps()
          .find((entry) => entry.name === STATUSES_STEP);
        const load = () =>
          step?.run({
            officeId,
            office: s.office,
            path: repo.dir,
            commonDir: `${repo.dir}/.git`,
            config: undefined,
            clock: s.t.clock,
            ids: s.t.ids,
          });

        expect(await load()).toEqual({ ok: true });
        const raised = notices(s.office).filter((n) => n.code === INIT_NOTICES.statusesMissing);
        expect(raised).toHaveLength(1);
        expect(raised[0]?.text).toContain("run `dipo office init`");
        expect(await init.officeStatusesReady(officeId)).toBe(raised[0]?.text ?? "");

        // The base gains the statuses: the next load raises nothing.
        const config = join(repo.dir, "backlog", "config.yml");
        writeFileSync(
          config,
          readFileSync(config, "utf8").replace(
            /^statuses: .*$/m,
            `statuses: ${formatStatuses(BOTH)}`,
          ),
        );
        await repo.commitAll("statuses by hand");
        await load();
        expect(
          notices(s.office).filter((n) => n.code === INIT_NOTICES.statusesMissing),
        ).toHaveLength(1);
        expect(await init.officeStatusesReady(officeId)).toBeNull();
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });
});
