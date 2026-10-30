// Entry for `colour.test.ts` (DIPO-320): `runTui` over a fake terminal and the fake session, with
// this process's environment and arguments, as `dipo tui` runs it. It walks every view that
// colours text (the overview, the live agent detail, the queue, the desk, the settings, the office
// switcher, a footer message and the offline header), quits, and prints everything the TUI wrote
// as one JSON string. The test starts it with `FORCE_COLOR=3`, so Ink colours whatever the TUI asks
// it to, and reads which colour codes the frames hold.

import { systemClock } from "@dipsaus-orchestrator/client/node";

import { runTui } from "../../src/run";
import { FakeSession, OFFICES } from "./fake-session";
import { fakeTerminal } from "./harness";

const terminal = fakeTerminal({ columns: 140, rows: 40 });
const session = new FakeSession();

const running = runTui(process.argv.slice(2), {
  stdin: terminal.stdin,
  stdout: terminal.stdout,
  env: process.env,
  clock: systemClock,
  writeError: (line) => process.stderr.write(`${line}\n`),
  connect: async () => session,
  currentOffice: async () => OFFICES.dipsaus,
  resolvePath: (path) => path,
  onSignal: () => () => undefined,
  clientInfo: { name: "colour-test", version: "0" },
});

await terminal.waitFor("daemon running", 5_000);
for (const key of ["enter", "escape", "2", "3", "1", "p", "escape", "o", "escape", "q"]) {
  await terminal.press(key);
}
session.setState("reconnecting");
await terminal.waitFor("OFFLINE", 5_000);
await terminal.press("q");
const code = await running;
process.stdout.write(JSON.stringify(terminal.raw()));
process.exitCode = code;
