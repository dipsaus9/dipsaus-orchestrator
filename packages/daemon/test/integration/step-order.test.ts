// The order of the office load steps and of the recovery steps (DIPO-318): recorded from a daemon
// run in-process on the manual clock, so a change to the engine's wiring that reorders a step fails
// here. A new step is added to the list on purpose.

import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";

import { isolatedDaemonEnv, ManualClock, withDaemonTempDir } from "@dipsaus-orchestrator/testkit";

import { runForeground } from "../../src/foreground";

const LOAD_STEPS = [
  "backlog.version",
  "git.version",
  "worktree.claims",
  "worktree.teardown",
  "story-pr.poll",
  "backlog.lane.replay",
  "stories.index",
  "merge.watch",
  "prState.poll",
  "office.statuses",
  "scan.profile",
  "run-outcomes/redispatch",
  "expire open permission questions",
  "starts-paused/recover",
  "places/drain",
  "retention",
  "usage.alerts",
  "reconcile",
  "privacy.summary",
];

const RECOVERY_STEPS = [
  "migrations",
  "reconcile",
  "reattach",
  "run-temp-sweep",
  "tests-recover",
  "fix-rounds-recover",
];

type Message = { msg: string; step?: string; steps?: string[]; to?: string };

describe("the daemon's step order", () => {
  it("loads offices and recovers in the recorded order", () =>
    withDaemonTempDir(async (dir) => {
      const lines: string[] = [];
      let signal: ((name: string) => void) | null = null;
      const exited = runForeground(
        [],
        {
          writeLine: () => {},
          writeError: (line) => lines.push(line),
          env: isolatedDaemonEnv(dir),
          execArgv: [],
          version: "test",
          clock: new ManualClock(),
          onShutdownSignal: (handler) => {
            signal = handler;
            return () => {
              signal = null;
            };
          },
          uncaughtErrors: new EventEmitter(),
        },
        {},
      );
      const messages = () =>
        lines.flatMap((line) => {
          try {
            return [JSON.parse(line) as Message];
          } catch {
            return [];
          }
        });
      try {
        for (let i = 0; i < 400; i++) {
          if (messages().some((m) => m.msg === "daemon state" && m.to === "running")) break;
          await Bun.sleep(25);
        }
        const all = messages();
        expect(all.find((m) => m.msg === "office load steps")?.steps).toEqual(LOAD_STEPS);
        expect(all.filter((m) => m.msg === "recovery step").map((m) => m.step)).toEqual(
          RECOVERY_STEPS,
        );
      } finally {
        (signal as ((name: string) => void) | null)?.("SIGTERM");
        await exited;
      }
    }));
});
