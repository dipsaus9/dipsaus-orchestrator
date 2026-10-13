// The run environment of a story worktree (0010 section 8): every process the engine starts in
// the worktree (setup, verify, `dev`, the worker host) gets `DIPO_SLOT`, `DIPO_PORT_OFFSET`,
// `DIPO_STORY` and `DIPO_WORKTREE`; each `worktree.ports.named` entry as `NAME=<base + offset>`,
// or `PORT=<dev port from the run profile + offset>` when none are named; and the `worktree.env`
// entries with only `{slot}`, `{offset}`, `{port:N}`, `{id}` and `{worktree}` substituted. Nothing
// else is expanded: no shell, no `$VAR`, and any other brace text stays as written. Pure.

export interface RunEnvInput {
  readonly slot: number;
  /** `worktree.ports.stride` of the office. */
  readonly stride: number;
  /** The story id, `DIPO_STORY` and `{id}`. */
  readonly story: string;
  /** The absolute worktree path, `DIPO_WORKTREE` and `{worktree}`. */
  readonly worktree: string;
  /** `worktree.ports.named`: variable name to base port. */
  readonly named: Readonly<Record<string, number>>;
  /** The dev port from the run profile, or null when the scan found none. */
  readonly devPort: number | null;
  /** `worktree.env`: variable name to template. */
  readonly env: Readonly<Record<string, string>>;
}

/** A run environment that cannot be built (a bad name or a port past 65535). */
export class RunEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunEnvError";
  }
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLACEHOLDER = /\{(slot|offset|id|worktree|port:(\d+))\}/g;
const MAX_PORT = 65_535;

/** The engine's own variables; an office entry of the same name is refused. */
export const RUN_ENV_NAMES = ["DIPO_SLOT", "DIPO_PORT_OFFSET", "DIPO_STORY", "DIPO_WORKTREE"];

function port(name: string, base: number, offset: number): number {
  const value = base + offset;
  if (value > MAX_PORT) {
    throw new RunEnvError(
      `${name}: port ${base} plus the slot offset ${offset} is ${value}, past ${MAX_PORT}; lower worktree.ports.stride or worktree.maxSlots.`,
    );
  }
  return value;
}

function checkName(name: string, where: string): void {
  if (!NAME.test(name)) {
    throw new RunEnvError(`${where} has the variable name "${name}", which is not a valid name.`);
  }
  if (RUN_ENV_NAMES.includes(name)) {
    throw new RunEnvError(`${where} sets ${name}, which only dipo sets.`);
  }
}

/** Substitutes the documented placeholders in one `worktree.env` template. */
export function substitute(
  template: string,
  values: { slot: number; offset: number; story: string; worktree: string },
  name = "worktree.env",
): string {
  return template.replace(PLACEHOLDER, (_match, key: string, base: string | undefined) => {
    switch (key) {
      case "slot":
        return String(values.slot);
      case "offset":
        return String(values.offset);
      case "id":
        return values.story;
      case "worktree":
        return values.worktree;
      default:
        return String(port(name, Number(base), values.offset));
    }
  });
}

/** Builds the run environment; see the file comment. */
export function buildRunEnv(input: RunEnvInput): Record<string, string> {
  const offset = input.slot * input.stride;
  const env: Record<string, string> = {};
  const namedPorts = Object.entries(input.named);
  for (const [name, base] of namedPorts) {
    checkName(name, "worktree.ports.named");
    env[name] = String(port(name, base, offset));
  }
  if (namedPorts.length === 0 && input.devPort !== null) {
    env["PORT"] = String(port("PORT", input.devPort, offset));
  }
  const values = { slot: input.slot, offset, story: input.story, worktree: input.worktree };
  for (const [name, template] of Object.entries(input.env)) {
    checkName(name, "worktree.env");
    if (name in env) {
      throw new RunEnvError(`worktree.env sets ${name}, which is already a port variable.`);
    }
    env[name] = substitute(template, values, name);
  }
  env["DIPO_SLOT"] = String(input.slot);
  env["DIPO_PORT_OFFSET"] = String(offset);
  env["DIPO_STORY"] = input.story;
  env["DIPO_WORKTREE"] = input.worktree;
  return env;
}
