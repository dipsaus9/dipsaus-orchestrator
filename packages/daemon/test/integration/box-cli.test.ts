// A test daemon never runs the real Apple `container` CLI (DIPO-423): with a logging stand-in
// `container` first on the caller's PATH, a daemon started through `daemonTestEnv` reaches
// `running` past its start step and never calls the stand-in. The stand-in is a shell script in
// the test's temp directory, so a call would leave its log there.

import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { delimiter, join } from "node:path";

import { daemonTestEnv, ManualClock, withDaemonTempDir } from "@dipsaus-orchestrator/testkit";

import { runForeground } from "../../src/foreground";

type Message = { msg: string; to?: string };

describe("a test daemon and the container CLI", () => {
  it("never calls a container CLI on the caller's PATH (DIPO-423)", () =>
    withDaemonTempDir(async (dir) => {
      const bin = join(dir, "bin");
      const called = join(dir, "container-called");
      mkdirSync(bin);
      writeFileSync(join(bin, "container"), `#!/bin/sh\necho called >> "${called}"\nexit 1\n`);
      chmodSync(join(bin, "container"), 0o755);
      const env = daemonTestEnv(dir, {
        ...process.env,
        PATH: [bin, process.env["PATH"] ?? "/usr/bin:/bin"].join(delimiter),
        DIPO_TEST_BOX: undefined,
      });
      expect(env["PATH"]?.split(delimiter)).not.toContain(bin);

      const lines: string[] = [];
      let signal: ((name: string) => void) | null = null;
      const exited = runForeground(
        [],
        {
          writeLine: () => {},
          writeError: (line) => lines.push(line),
          env,
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
        expect(messages().some((m) => m.msg === "daemon state" && m.to === "running")).toBe(true);
        expect(existsSync(called)).toBe(false);
      } finally {
        (signal as ((name: string) => void) | null)?.("SIGTERM");
        await exited;
      }
    }));
});
