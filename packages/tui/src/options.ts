// `dipo tui` flags and display settings (0009 section 9): `--no-color` and `NO_COLOR` turn colour
// off, `--ascii` replaces non-ASCII glyphs, `--inline` renders in the normal scrollback instead of
// the alternate screen, and `--office <id>` opens that office first.

import { type OfficeId, OfficeId as OfficeIdSchema } from "@dipsaus-orchestrator/contract";

export interface TuiOptions {
  readonly color: boolean;
  readonly ascii: boolean;
  readonly inline: boolean;
  readonly office: OfficeId | null;
}

/** What the views need to know about the terminal. */
export interface Display {
  readonly color: boolean;
  readonly ascii: boolean;
}

/** `NO_COLOR` set to any non-empty value turns colour off (no-color.org). */
export function noColorEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.NO_COLOR;
  return value !== undefined && value !== "";
}

/** Parses the arguments after `tui`; a string is a usage error. */
export function parseTuiArgs(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): TuiOptions | string {
  let color = !noColorEnv(env);
  let ascii = false;
  let inline = false;
  let office: OfficeId | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--no-color") color = false;
    else if (arg === "--ascii") ascii = true;
    else if (arg === "--inline") inline = true;
    else if (arg === "--office") {
      const parsed = OfficeIdSchema.safeParse(args[i + 1]);
      if (!parsed.success) return "--office needs an office id (off_...)";
      office = parsed.data;
      i += 1;
    } else {
      return `unknown argument ${JSON.stringify(arg)}`;
    }
  }
  return { color, ascii, inline, office };
}
