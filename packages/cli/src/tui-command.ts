// `dipo tui` (DIPO-53, 0009): wires the TUI to this process. The terminal is process stdin and
// stdout, the session comes from `connectOrStart` (the daemon starts when autostart allows,
// 0006), and the office of the current directory comes from the workspace, as for every office
// command. The TUI itself is in `@dipsaus-orchestrator/tui`.

import { homedir } from "node:os";
import { resolve } from "node:path";

import { ClientError, DipoClient } from "@dipsaus-orchestrator/client";
import {
  connectOrStart,
  systemClock,
  systemLifecycleDeps,
  versionHint,
} from "@dipsaus-orchestrator/client/node";
import { ContractUnsupportedDetails, type OfficeId } from "@dipsaus-orchestrator/contract";
import { runTui, type TuiSession } from "@dipsaus-orchestrator/tui";

import type { Workspace } from "./workspace";

export const TUI_CLIENT_NAME = "dipo-tui";

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

/** A readable message for a failed connect, with the restart hint for another contract. */
export function connectFailure(error: unknown, version: string): Error {
  if (error instanceof ClientError) {
    let message = `${error.code}: ${error.message}`;
    if (error.code === "contract.unsupported") {
      const details = ContractUnsupportedDetails.safeParse(error.engineError?.details);
      const hint = details.success ? versionHint(version, details.data.version) : null;
      message += `; ${hint ?? "run `dipo daemon restart`"}`;
    }
    return new Error(message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** `dipo tui` for this process. */
export function systemTui(
  version: string,
  workspace: Workspace,
): (args: readonly string[]) => Promise<number> {
  return async (args) => {
    const clientInfo = { name: TUI_CLIENT_NAME, version };
    const lifecycle = systemLifecycleDeps({ client: clientInfo, origin: "tui" });
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
          throw connectFailure(error, version);
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
    // Ink leaves stdin paused but referenced; let the process end.
    process.stdin.unref();
    return code;
  };
}
