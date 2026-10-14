// Entry for `pty.ci.test.ts`: `runTui` on this process's real terminal over the fake session, as
// `dipo tui` runs it, so a PTY test can check that quitting gives the terminal back.

import { systemClock } from "@dipsaus-orchestrator/client/node";

import { runTui } from "../run";
import { FakeSession, OFFICES } from "./fake-session";

const code = await runTui(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  env: process.env,
  clock: systemClock,
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
