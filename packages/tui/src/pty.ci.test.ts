// CI only (0017 section 1; 0009 section 1 checks 2 and 4): `runTui` on a real PTY. Quitting with q
// twice, Ctrl+C and SIGTERM leave the alternate screen and give the shell its cooked terminal back
// (ICANON and ECHO), and the process ends on its own. Piped stdin exits non-zero with one line.
// No run leaves a process behind (DIPO-94): `inPty` kills its child on every way out, and the child
// exits by itself when its terminal closes.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { NO_TTY_MESSAGE } from "./run";

const MAIN = join(import.meta.dir, "..", "test", "support", "pty-main.ts");
const ICANON = process.platform === "darwin" ? 0x100 : 0o2;
const ECHO = 0o10;
const TIMEOUT_MS = 30_000;
const FRAME_LIMIT_MS = 10_000;
/** Time the child gets to end after SIGTERM before it is killed with SIGKILL. */
const KILL_GRACE_MS = 500;

interface Pty {
  readonly terminal: Bun.Terminal;
  readonly proc: Bun.Subprocess;
  readonly text: () => string;
}

interface PtyOptions {
  /** When the child is ready for `body`; by default the office frame in raw mode. */
  readonly ready?: (text: string, terminal: Bun.Terminal) => boolean;
  readonly limitMs?: number;
  readonly onSpawn?: (proc: Bun.Subprocess) => void;
}

// The office frame, and raw mode: a frame can come before Ink's raw-mode effect.
function officeInRawMode(text: string, terminal: Bun.Terminal): boolean {
  return text.includes("dipsaus-orchestrator") && (terminal.localFlags & ICANON) === 0;
}

function ended(proc: Bun.Subprocess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

/** Resolves true when `proc` ends within `ms`, false when it is still running. */
function endsWithin(proc: Bun.Subprocess, ms: number): Promise<boolean> {
  return Promise.race([proc.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
}

/** SIGTERM, then SIGKILL after a short grace; resolves once the child is gone. */
async function stop(proc: Bun.Subprocess): Promise<void> {
  if (ended(proc)) return;
  proc.kill("SIGTERM");
  if (await endsWithin(proc, KILL_GRACE_MS)) return;
  proc.kill("SIGKILL");
  await proc.exited;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Runs `pty-main.ts` in a real terminal; the child is gone when this settles, however it ends. */
async function inPty<T>(body: (pty: Pty) => Promise<T>, options: PtyOptions = {}): Promise<T> {
  const ready = options.ready ?? officeInRawMode;
  let text = "";
  const terminal = new Bun.Terminal({
    cols: 100,
    rows: 30,
    data: (_terminal, data) => {
      text += new TextDecoder().decode(data);
    },
  });
  let proc: Bun.Subprocess | null = null;
  try {
    proc = Bun.spawn([process.execPath, MAIN], { terminal });
    options.onSpawn?.(proc);
    const limit = performance.now() + (options.limitMs ?? FRAME_LIMIT_MS);
    while (!ready(text, terminal)) {
      if (performance.now() > limit) throw new Error(`not ready in time:\n${text}`);
      await Bun.sleep(20);
    }
    return await body({ terminal, proc, text: () => text });
  } finally {
    if (proc !== null) await stop(proc);
    if (!terminal.closed) terminal.close();
  }
}

async function quitAndRead(
  { terminal, proc, text }: Pty,
  quit: (terminal: Bun.Terminal, proc: Bun.Subprocess) => void,
) {
  const raw = (terminal.localFlags & ICANON) === 0;
  quit(terminal, proc);
  const code = await proc.exited;
  await Bun.sleep(50);
  return {
    raw,
    code,
    text: text(),
    cooked: (terminal.localFlags & ICANON) !== 0 && (terminal.localFlags & ECHO) !== 0,
  };
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("dipo tui on a real terminal", () => {
    for (const [name, quit, expected] of [
      [
        "q twice",
        (t: Bun.Terminal) => {
          t.write("q");
          // Two keys in one read reach Ink as one input; a person types them apart.
          void Bun.sleep(100).then(() => t.write("q"));
        },
        0,
      ],
      ["Ctrl+C", (t: Bun.Terminal) => t.write("\u0003"), 0],
      ["SIGTERM", (_t: Bun.Terminal, p: Bun.Subprocess) => p.kill("SIGTERM"), 143],
    ] as const) {
      it(
        `gives the terminal back after ${name}`,
        async () => {
          const result = await inPty((pty) => quitAndRead(pty, quit));
          expect(result.raw).toBe(true);
          expect(result.code).toBe(expected);
          expect(result.text).toContain("\u001b[?1049h");
          expect(result.text.lastIndexOf("\u001b[?1049l")).toBeGreaterThan(
            result.text.lastIndexOf("\u001b[?1049h"),
          );
          expect(result.cooked).toBe(true);
        },
        TIMEOUT_MS,
      );
    }

    it(
      "exits by itself within 2 s when its terminal closes",
      async () => {
        const result = await inPty(async ({ terminal, proc }) => {
          terminal.close();
          const gone = await endsWithin(proc, 2_000);
          return { gone, pid: proc.pid };
        });
        expect(result.gone).toBe(true);
        expect(alive(result.pid)).toBe(false);
      },
      TIMEOUT_MS,
    );

    it(
      "kills the child when the wait for a frame fails",
      async () => {
        let spawned: Bun.Subprocess | null = null;
        const run = inPty(async () => "unreachable", {
          ready: () => false,
          limitMs: 1_000,
          onSpawn: (proc) => {
            spawned = proc;
          },
        });
        await expect(run).rejects.toThrow("not ready in time");
        const proc = spawned as Bun.Subprocess | null;
        expect(proc).not.toBeNull();
        expect(ended(proc!)).toBe(true);
        expect(alive(proc!.pid)).toBe(false);
      },
      TIMEOUT_MS,
    );

    it(
      "exits non-zero with one line when stdin is piped",
      async () => {
        const proc = Bun.spawn([process.execPath, MAIN], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        await proc.stdin.end();
        const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
        expect(code).toBe(1);
        expect(stderr).toBe(`${NO_TTY_MESSAGE}\n`);
      },
      TIMEOUT_MS,
    );
  });
}
