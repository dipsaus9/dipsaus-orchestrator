// `dipo daemon logs [-f] [--office <id>] [--run <id>] [--level <level>]` (0006 decision 13,
// DIPO-64). Named offline maintenance (0006 amendment of 2026-10-12): it reads `daemon.log` and its
// rotated files through the log reader of `client/node`, never through the daemon, so it works
// with the daemon stopped and never starts one.

import {
  followLogs,
  type LogFilter,
  readLogs,
  renderFiltered,
} from "@dipsaus-orchestrator/client/node";
import { type Clock, LogLevel } from "@dipsaus-orchestrator/contract";

/** Where `dipo daemon logs` reads; `stop` ends `-f` (tests). */
export interface DaemonLogsDeps {
  readonly dir: string;
  readonly stop?: AbortSignal;
}

export interface LogsCommandDeps {
  readonly writeLine: (line: string) => void;
  readonly writeError: (line: string) => void;
  readonly clock: Clock;
  readonly logs: DaemonLogsDeps;
}

export interface LogsOptions {
  readonly follow: boolean;
  readonly filter: LogFilter;
}

export const LOGS_USAGE = `daemon logs takes -f, --office <id>, --run <id> and --level <${LogLevel.options.join("|")}>`;

/** Parses the options; a string is an error message. */
export function parseLogsArgs(args: readonly string[]): LogsOptions | string {
  let follow = false;
  const filter: { office?: string; run?: string; level?: LogLevel } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if ((arg === "-f" || arg === "--follow") && !follow) {
      follow = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value === "" || value.startsWith("-")) return LOGS_USAGE;
    if (arg === "--office" && filter.office === undefined) filter.office = value;
    else if (arg === "--run" && filter.run === undefined) filter.run = value;
    else if (arg === "--level" && filter.level === undefined) {
      const level = LogLevel.safeParse(value);
      if (!level.success) return LOGS_USAGE;
      filter.level = level.data;
    } else return LOGS_USAGE;
    index += 1;
  }
  return { follow, filter };
}

export async function logsCommand(
  args: readonly string[],
  deps: LogsCommandDeps,
  usage: (message: string) => number,
): Promise<number> {
  const options = parseLogsArgs(args);
  if (typeof options === "string") return usage(options);
  const { dir } = deps.logs;
  try {
    if (options.follow) {
      await followLogs({
        logsDir: dir,
        filter: options.filter,
        clock: deps.clock,
        write: deps.writeLine,
        ...(deps.logs.stop === undefined ? {} : { signal: deps.logs.stop }),
      });
      return 0;
    }
    const { lines, found } = readLogs(dir);
    if (!found) {
      deps.writeError(`dipo: no daemon log in ${dir} yet.`);
      return 0;
    }
    for (const line of renderFiltered(lines, options.filter)) deps.writeLine(line);
    return 0;
  } catch (error) {
    deps.writeError(
      `dipo: cannot read the daemon log in ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
