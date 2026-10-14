// CI only (0017 section 1; 0009 section 1 checks 2 and 4): `runTui` on a real PTY. Quitting with q
// twice, Ctrl+C and SIGTERM leave the alternate screen and give the shell its cooked terminal back
// (ICANON and ECHO), and the process ends on its own. Piped stdin exits non-zero with one line.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { NO_TTY_MESSAGE } from "./run";

const MAIN = join(import.meta.dir, "testing", "pty-main.ts");
const ICANON = process.platform === "darwin" ? 0x100 : 0o2;
const ECHO = 0o10;
const TIMEOUT_MS = 30_000;

async function inPty(quit: (terminal: Bun.Terminal, proc: Bun.Subprocess) => void) {
  let text = "";
  const terminal = new Bun.Terminal({
    cols: 100,
    rows: 30,
    data: (_terminal, data) => {
      text += new TextDecoder().decode(data);
    },
  });
  try {
    const proc = Bun.spawn([process.execPath, MAIN], { terminal });
    const limit = performance.now() + 10_000;
    // The office frame, and raw mode: a frame can come before Ink's raw-mode effect.
    while (!text.includes("dipsaus-orchestrator") || (terminal.localFlags & ICANON) !== 0) {
      if (performance.now() > limit) throw new Error(`no frame in raw mode:\n${text}`);
      await Bun.sleep(20);
    }
    const raw = (terminal.localFlags & ICANON) === 0;
    quit(terminal, proc);
    const code = await proc.exited;
    await Bun.sleep(50);
    return {
      raw,
      code,
      text,
      cooked: (terminal.localFlags & ICANON) !== 0 && (terminal.localFlags & ECHO) !== 0,
    };
  } finally {
    terminal.close();
  }
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
          const result = await inPty(quit);
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
