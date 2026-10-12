// The `dipo` command line: `--version`, `--help`, the daemon-side forms, the daemon subcommands and
// the hidden `self-check`; later stories add subcommands. Daemon-side forms go through `runDaemon`
// (0004, 0006 decision 2); every other subcommand goes through `client`.

import { connectToDaemon, systemClock } from "@dipsaus-orchestrator/client/node";
import type { Clock } from "@dipsaus-orchestrator/contract";
import { runDaemon } from "@dipsaus-orchestrator/daemon";
import { checkInk, INK_SELF_CHECK_NAME } from "@dipsaus-orchestrator/tui";

import { type ConnectDaemon, DAEMON_SUBCOMMANDS } from "./daemon-commands";
import {
  compiledStamp,
  currentRuntime,
  formatVersion,
  formatVersionJson,
  versionInfo,
  type BuildStamp,
  type Runtime,
} from "./version";

export const packageName = "@dipsaus-orchestrator/cli";

export type ClientCheck = { readonly name: string; readonly run: () => Promise<void> | void };

export type CliDeps = {
  readonly writeLine: (line: string) => void;
  readonly writeError: (line: string) => void;
  readonly runDaemon: (argv: readonly string[]) => Promise<number>;
  readonly connectDaemon: ConnectDaemon;
  readonly clock: Clock;
  readonly clientChecks: readonly ClientCheck[];
  readonly stamp: BuildStamp | undefined;
  readonly runtime: Runtime;
};

export const HELP = `dipo: run your software products with a model as your team

Usage:
  dipo [options]
  dipo daemon --foreground [--log-level <level>]
                    run the daemon in this terminal; logs also go to stderr
  dipo daemon log-level <level>
                    set the running daemon's log level until it restarts
                    (error, warn, info, debug or trace)
  dipo daemon resume-scheduling
                    leave safe mode so the daemon schedules work again

Options:
  --version         print the version, commit, Bun version and platform
  --version --json  print the same fields as JSON
  -h, --help        print this help`;

/** `dipo daemon` forms that run daemon-side code; the lifecycle subcommands go through `client`. */
export const DAEMON_FORMS: ReadonlySet<string> = new Set([
  "--foreground",
  "worker-host",
  "wait-pid",
]);

export function defaultDeps(): CliDeps {
  const stamp = compiledStamp();
  const runtime = currentRuntime();
  const { version } = versionInfo(stamp, runtime);
  return {
    writeLine: (line) => process.stdout.write(`${line}\n`),
    writeError: (line) => process.stderr.write(`${line}\n`),
    runDaemon: (argv) => runDaemon(argv, { version }),
    connectDaemon: async () => {
      const { client } = await connectToDaemon({
        client: { name: "dipo-cli", version },
        origin: "cli",
      });
      return client;
    },
    clock: systemClock,
    clientChecks: [{ name: INK_SELF_CHECK_NAME, run: checkInk }],
    stamp,
    runtime,
  };
}

/** Runs the command line and resolves to the process exit code. */
export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const args = [...argv];
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    deps.writeLine(HELP);
    return 0;
  }
  if (args[0] === "--version") {
    const rest = args.slice(1);
    const info = versionInfo(deps.stamp, deps.runtime);
    if (rest.length === 0) {
      deps.writeLine(formatVersion(info));
      return 0;
    }
    if (rest.length === 1 && rest[0] === "--json") {
      deps.writeLine(formatVersionJson(info));
      return 0;
    }
  }
  if (args[0] === "daemon" && DAEMON_FORMS.has(args[1] ?? "")) {
    return deps.runDaemon(args.slice(1));
  }
  const subcommand = args[0] === "daemon" ? DAEMON_SUBCOMMANDS.get(args[1] ?? "") : undefined;
  if (subcommand !== undefined) return subcommand(args.slice(2), deps);
  if (args[0] === "self-check" && args.length === 1) {
    return selfCheck(deps);
  }
  deps.writeError(`dipo: unknown arguments: ${args.join(" ")}\nRun \`dipo --help\` for usage.`);
  return 2;
}

// Hidden: probes the runtime features the daemon (through `runDaemon`) and the TUI rely on inside the
// compiled binary. One line per check; stops with a non-zero code at the first failure.
async function selfCheck(deps: CliDeps): Promise<number> {
  const daemonCode = await deps.runDaemon(["self-check"]);
  if (daemonCode !== 0) return daemonCode;
  for (const check of deps.clientChecks) {
    try {
      await check.run();
    } catch (error) {
      deps.writeLine(
        `fail ${check.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
    deps.writeLine(`ok   ${check.name}`);
  }
  return 0;
}
