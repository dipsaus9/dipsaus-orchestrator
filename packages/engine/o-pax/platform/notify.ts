// Desk notifications (DIPO-357): one macOS notification through `osascript`, which macOS ships. The
// text is an AppleScript string literal, so no text a worker or a host wrote can end the script;
// control characters become spaces, since a string literal holds one line. The call runs through
// the injected `Spawn` and has the call deadline (DIPO-314), so a stuck notification cannot hold
// the daemon. A failure throws; the caller logs it and goes on.

import type { Clock, Spawn } from "@dipsaus-orchestrator/contract";

import { CALL_DEADLINE_MS, withDeadline } from "./deadline";

/** The title and the body of one notification, each one line of text. */
export interface NotificationText {
  readonly title: string;
  readonly body: string;
}

/** Posts one notification; rejects when it could not be posted. */
export type PostNotification = (notice: NotificationText) => Promise<void>;

/** An AppleScript string literal of `text`, with its quotes and backslashes escaped. */
export function appleScriptString(text: string): string {
  const oneLine = text.replace(/\p{Cc}/gu, " ");
  return `"${oneLine.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The `osascript` script that shows `notice` as a macOS notification. */
export function notificationScript(notice: NotificationText): string {
  return `display notification ${appleScriptString(notice.body)} with title ${appleScriptString(notice.title)}`;
}

/** The notifier of this platform, through `osascript` started by `spawn`. */
export function systemPostNotification(spawn: Spawn, clock: Clock): PostNotification {
  return async (notice) => {
    const cmd = ["osascript", "-e", notificationScript(notice)] as const;
    const child = spawn({ cmd });
    const exit = await withDeadline(child, child.exited, {
      clock,
      deadlineMs: CALL_DEADLINE_MS,
      timedOut: () => new Error(`osascript did not finish within ${CALL_DEADLINE_MS} ms`),
    });
    if (exit.code !== 0) throw new Error(`osascript exited with code ${exit.code ?? "none"}`);
  };
}
