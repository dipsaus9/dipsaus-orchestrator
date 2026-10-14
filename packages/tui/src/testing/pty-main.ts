// Entry for `pty.ci.test.ts`: `runTui` on this process's real terminal over the fake session, as
// `dipo tui` runs it, so a PTY test can check that quitting gives the terminal back.

import type { Clock, TimerHandle } from "@dipsaus-orchestrator/contract";

import { runTui } from "../run";
import { FakeSession, OFFICES } from "./fake-session";

const clock: Clock = {
  now: () => performance.timeOrigin + performance.now(),
  setTimeout: () => {
    throw new Error("no timers");
  },
  clearTimeout: () => undefined as unknown as TimerHandle,
};

const code = await runTui(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  env: process.env,
  clock,
  writeError: (line) => process.stderr.write(`${line}\n`),
  connect: async () => new FakeSession(),
  currentOffice: async () => OFFICES.dipsaus,
  resolvePath: (path) => path,
  onSignal: (signal, handler) => {
    process.on(signal, handler);
    return () => process.off(signal, handler);
  },
  clientInfo: { name: "pty-test", version: "0" },
});
process.stdin.unref();
process.exitCode = code;
