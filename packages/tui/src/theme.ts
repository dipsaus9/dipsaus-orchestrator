// The terminal's theme (0009, DIPO-457): dark or light, found by asking the terminal for its
// background (OSC 11), then reading `COLORFGBG`, then dark. The truecolor Classical theme is an
// opt-in (`DIPO_TUI_THEME=classical`).

import type { Clock } from "@dipsaus-orchestrator/contract";

export type Tone = "dark" | "light";

/** The tone of an OSC 11 reply (`rgb:rrrr/gggg/bbbb`, 1 to 4 hex digits a channel), or null. */
export function toneFromOsc11(reply: string): Tone | null {
  const match = /rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(reply);
  if (match === null) return null;
  const [r, g, b] = [match[1], match[2], match[3]].map((hex) => {
    const digits = hex ?? "0";
    return parseInt(digits, 16) / (16 ** digits.length - 1);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? "light" : "dark";
}

/** The tone `COLORFGBG` (`fg;bg` or `fg;default;bg`) names: a background of 7 or 9 to 15 is light. */
export function toneFromColorFgBg(value: string | undefined): Tone | null {
  if (value === undefined) return null;
  const bg = Number(value.split(";").at(-1));
  if (!Number.isInteger(bg) || bg < 0 || bg > 15) return null;
  return bg === 7 || bg >= 9 ? "light" : "dark";
}

/** OSC 11, then `COLORFGBG`, then dark. */
export function detectTone(
  osc11: string | null,
  env: Readonly<Record<string, string | undefined>>,
): Tone {
  return (
    (osc11 === null ? null : toneFromOsc11(osc11)) ?? toneFromColorFgBg(env.COLORFGBG) ?? "dark"
  );
}

/** True when the maintainer opted in to the truecolor Classical theme. */
export function classicalEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.DIPO_TUI_THEME === "classical";
}

/** A whole OSC 11 reply: the colour, then BEL or ST. */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const OSC_REPLY = new RegExp(`rgb:[^${BEL}${ESC}]*(${BEL}|${ESC}\\\\)`);

/** Asks the terminal for its background colour; null when it does not answer in `timeoutMs`. */
export function queryBackground(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  clock: Clock,
  timeoutMs = 150,
): Promise<string | null> {
  if (stdin.isTTY !== true || stdout.isTTY !== true || typeof stdin.setRawMode !== "function") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const wasRaw = stdin.isRaw;
    let reply = "";
    const finish = (value: string | null) => {
      clock.clearTimeout(timer);
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      reply += chunk.toString();
      // The reply ends with BEL or ST.
      if (OSC_REPLY.test(reply)) finish(reply);
    };
    const timer = clock.setTimeout(() => finish(null), timeoutMs);
    stdin.setRawMode(true);
    stdin.on("data", onData);
    stdout.write(`${ESC}]11;?${ESC}\\`);
  });
}
