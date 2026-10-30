// `dipo tui` (DIPO-53, 0009): wires the TUI to this process. The terminal is process stdin and
// stdout, the session comes from `connectOrStart` (the daemon starts when autostart allows,
// 0006), and the office of the current directory comes from the workspace, as for every office
// command. The TUI itself is in `@dipsaus-orchestrator/tui`.

import { homedir } from "node:os";
import { resolve } from "node:path";

import { ClientError, DipoClient } from "@dipsaus-orchestrator/client";
import {
  connectOrStart,
  OtherVersionError,
  systemClock,
  systemLifecycleDeps,
} from "@dipsaus-orchestrator/client/node";
import { type OfficeId, TUI_CLIENT_NAME } from "@dipsaus-orchestrator/contract";
import type { TuiSession } from "@dipsaus-orchestrator/tui";

import type { Workspace } from "./workspace";

/** `path` as typed in the TUI, made absolute against `cwd`; `~` is the home directory. */
export function resolveTypedPath(cwd: string, path: string, home: string = homedir()): string {
  const expanded = path === "~" ? home : path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
  return resolve(cwd, expanded);
}

/** The office of the repository around the workspace's directory, else null. */
export async function workspaceOffice(workspace: Workspace): Promise<OfficeId | null> {
  const location = await workspace.locate(workspace.cwd);
  return location === null ? null : workspace.readOfficeId(location.commonDir);
}

/** A readable message for a failed connect; a daemon of another version says to restart it. */
export function connectFailure(error: unknown): Error {
  if (error instanceof OtherVersionError) return new Error(error.message);
  if (error instanceof ClientError) return new Error(`${error.code}: ${error.message}`);
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Lets the process end once the TUI is done: Ink leaves a terminal stdin paused but referenced.
 * stdin from a file such as `/dev/null` is a stream without `unref`, so it is skipped.
 */
export function releaseStdin(stdin: { unref?: unknown }): void {
  if (typeof stdin.unref === "function") (stdin.unref as () => void).call(stdin);
}

/** `dipo tui` for this process. */
export function systemTui(
  version: string,
  workspace: Workspace,
): (args: readonly string[]) => Promise<number> {
  return async (args) => {
    const clientInfo = { name: TUI_CLIENT_NAME, version };
    const lifecycle = systemLifecycleDeps({ client: clientInfo, origin: "tui" });
    // The TUI loads only for `dipo tui`, so every other command starts without it (DIPO-318).
    const { runTui } = await import("@dipsaus-orchestrator/tui");
    const code = await runTui(args, {
      stdin: process.stdin,
      stdout: process.stdout,
      env: process.env,
      clock: systemClock,
      writeError: (line) => process.stderr.write(`${line}\n`),
      connect: async (): Promise<TuiSession> => {
        let session;
        try {
          ({ session } = await connectOrStart(lifecycle));
        } catch (error) {
          throw connectFailure(error);
        }
        if (!(session instanceof DipoClient)) throw new Error("the daemon session is not a client");
        return session;
      },
      currentOffice: () => workspaceOffice(workspace),
      resolvePath: (path) => resolveTypedPath(workspace.cwd, path),
      onSignal: (signal, handler) => {
        process.on(signal, handler);
        return () => process.off(signal, handler);
      },
      clientInfo,
    });
    releaseStdin(process.stdin);
    return code;
  };
}
