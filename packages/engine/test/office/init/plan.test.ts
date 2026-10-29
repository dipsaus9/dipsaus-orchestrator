// Office init's pure parts (DIPO-36): the `statuses:` line of `backlog/config.yml`, the status list
// step 1 writes (both lists while `To Do` is in use, the 0012 list alone after), the run refusal,
// the plan from what the base holds, and the `init` kind's steps on a directory without git.

import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import type { JournalEntry } from "../../../src/backlog/lane";
import {
  type BaseState,
  formatStatuses,
  initKind,
  LIFECYCLE_STATUSES,
  planInit,
  readStatuses,
  rewriteStatusesLine,
  settingValue,
  statusesRefusal,
  targetStatuses,
} from "../../../src/backlog/init";

import { fileBacklog, OLD_CONFIG } from "./helpers";

const OLD = ["To Do", "In Progress", "Done"];

describe("the statuses line", () => {
  it("reads the list and rewrites only its own line", () => {
    expect(readStatuses(OLD_CONFIG)).toEqual({ ok: true, statuses: OLD });
    expect(readStatuses("labels: []\n")).toMatchObject({ ok: false });
    const next = rewriteStatusesLine(OLD_CONFIG, ["To Do", ...LIFECYCLE_STATUSES]);
    const changed = (next ?? "")
      .split("\n")
      .filter((line, i) => line !== OLD_CONFIG.split("\n")[i]);
    expect(changed).toEqual([`statuses: ${formatStatuses(["To Do", ...LIFECYCLE_STATUSES])}`]);
    // A list over several lines is not rewritten.
    expect(rewriteStatusesLine("statuses:\n  - To Do\n", LIFECYCLE_STATUSES)).toBeNull();
  });

  it("keeps the old statuses until no task uses To Do, then sets the 0012 list alone", () => {
    expect(targetStatuses(OLD, { final: false, inUse: ["To Do"] })).toEqual([
      "To Do",
      ...LIFECYCLE_STATUSES,
    ]);
    // A list that holds every 0012 status is left as it is while To Do is in use.
    expect(targetStatuses(["To Do", ...LIFECYCLE_STATUSES], { final: false, inUse: [] })).toBe(
      null,
    );
    expect(targetStatuses(["To Do", ...LIFECYCLE_STATUSES], { final: true, inUse: [] })).toEqual([
      ...LIFECYCLE_STATUSES,
    ]);
    // A status outside 0012 a task still uses is kept.
    expect(
      targetStatuses(["To Do", "Blocked", ...LIFECYCLE_STATUSES], {
        final: true,
        inUse: ["Blocked"],
      }),
    ).toEqual(["Blocked", ...LIFECYCLE_STATUSES]);
    expect(targetStatuses(LIFECYCLE_STATUSES, { final: true, inUse: [] })).toBeNull();
  });

  it("refuses runs while In Review or Parked is missing, naming dipo office init", () => {
    expect(statusesRefusal(OLD)).toContain("`In Review` or `Parked`");
    expect(statusesRefusal(OLD)).toContain("run `dipo office init`");
    expect(statusesRefusal(["To Do", ...LIFECYCLE_STATUSES])).toBeNull();
  });
});

describe("planInit", () => {
  const base: BaseState = {
    statuses: { ok: true, list: OLD },
    settings: {
      defaultStatus: "To Do",
      checkActiveBranches: "true",
      remoteOperations: "false",
      autoCommit: "false",
    },
    tasks: [
      { id: "TASK-1", status: "To Do" },
      { id: "TASK-2", status: "To Do" },
      { id: "TASK-3", status: "Done" },
    ],
    branches: ["main", "task-2/rename-the-export-setting", "TASK-22/other"],
    gitignore: false,
  };

  it("plans every step that differs and records the values it changes", () => {
    expect(planInit(base)).toEqual({
      targets: [
        { step: "statuses", final: false, inUse: ["To Do"] },
        { step: "defaultStatus" },
        { step: "settings" },
        { step: "migrate", leave: ["TASK-2"] },
        { step: "gitignore" },
      ],
      previous: { statuses: OLD, defaultStatus: "To Do", remoteOperations: false },
      leftAlone: ["TASK-2"],
    });
  });

  it("plans nothing once everything is on the base", () => {
    expect(
      planInit({
        statuses: { ok: true, list: LIFECYCLE_STATUSES },
        settings: {
          defaultStatus: "Refined",
          checkActiveBranches: "true",
          remoteOperations: "true",
          autoCommit: "false",
        },
        tasks: [{ id: "TASK-1", status: "Refined" }],
        branches: [],
        gitignore: true,
      }),
    ).toEqual({ targets: [], previous: {}, leftAlone: [] });
  });

  it("reads printed settings as values", () => {
    expect([
      settingValue("true"),
      settingValue("false"),
      settingValue(""),
      settingValue("To Do"),
    ]).toEqual([true, false, null, "To Do"]);
  });
});

describe("the init kind without git", () => {
  const entry = {} as JournalEntry;

  it("adds .dipo/.gitignore only when absent, and drops a statuses step it cannot write", async () => {
    await withTempDir(async (dir) => {
      const { cli } = fileBacklog();
      const kind = initKind();
      const ctx = { cli, cwd: dir, story: "office", entry };
      expect(await kind.apply(ctx, { step: "gitignore" })).toEqual({ applies: true });
      expect(readFileSync(join(dir, ".dipo", ".gitignore"), "utf8")).toBe("office.local.yaml\n");
      writeFileSync(join(dir, ".dipo", ".gitignore"), "mine\n");
      expect(await kind.apply(ctx, { step: "gitignore" })).toEqual({ applies: true });
      expect(readFileSync(join(dir, ".dipo", ".gitignore"), "utf8")).toBe("mine\n");

      mkdirSync(join(dir, "backlog"));
      writeFileSync(join(dir, "backlog", "config.yml"), "statuses:\n  - To Do\n");
      expect(
        await kind.apply(ctx, { step: "statuses", final: false, inUse: ["To Do"] }),
      ).toMatchObject({ applies: false });
      expect(await kind.apply(ctx, { step: "bogus" })).toMatchObject({ applies: false });
    });
  });
});
