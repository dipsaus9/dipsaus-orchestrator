// Entry for `pty.ci.test.ts`: `runTui` on this process's real terminal over the fake session, as
// `dipo tui` runs it, so a PTY test can check that quitting gives the terminal back.
//
// A test that times out, or a worktree removed under a run, must not leave this process behind
// (DIPO-94): it exits within a second when its terminal goes away (SIGHUP, stdin EOF or a read or
// write error such as EIO) or when the process that started it is gone.

import { systemClock } from "@dipsaus-orchestrator/client/node";

import { runTui } from "../run";
import { FakeSession, OFFICES } from "./fake-session";

/** Exit code of a hang-up, as a shell reports SIGHUP (128 + 1). */
const HANG_UP_CODE = 129;
/** Time `runTui` gets to unmount after a hang-up before the process exits regardless. */
const HANG_UP_GRACE_MS = 300;
const PARENT_POLL_MS = 200;

const parent = process.ppid;
let hungUp = false;
function hangUp() {
  if (hungUp) return;
  hungUp = true;
  // `runTui` handles SIGHUP itself, but unmounting can block on a terminal that is gone.
  systemClock.setTimeout(() => process.exit(HANG_UP_CODE), HANG_UP_GRACE_MS);
}

function parentGone(): boolean {
  if (process.ppid !== parent) return true;
  try {
    process.kill(parent, 0);
    return false;
  } catch {
    return true;
  }
}

process.on("SIGHUP", hangUp);
process.stdin.on("end", hangUp);
process.stdin.on("close", hangUp);
process.stdin.on("error", hangUp);
process.stdout.on("error", hangUp);
// Re-armed until `runTui` returns, so it never keeps a finished run alive.
let watching = true;
function watchParent() {
  if (!watching) return;
  if (parentGone()) hangUp();
  else parentTimer = systemClock.setTimeout(watchParent, PARENT_POLL_MS);
}
let parentTimer = systemClock.setTimeout(watchParent, PARENT_POLL_MS);

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
watching = false;
systemClock.clearTimeout(parentTimer);
process.stdin.unref();
process.exitCode = code;
