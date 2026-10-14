// Steering for the Claude Code CLI (0008 section 6): every op becomes stream-json user messages on
// stdin, a stdin close or signals. `priority` decides when Claude reads a message sent during a
// running turn: `next` once the running tool calls finish, `now` interrupts the turn.

import type { HostOp, SteerOp } from "../types";
import { permissionOutput } from "./hooks";

export type MessagePriority = "now" | "next" | "later";

/** Milliseconds from a stop to SIGTERM and to SIGKILL (0004, 0006, 0008 section 6). */
export const STOP_SIGTERM_AFTER_MS = 10_000;
export const STOP_SIGKILL_AFTER_MS = 30_000;

export const PAUSE_MESSAGE = "Paused by the maintainer: stop and reply only `paused`.";
export const STOP_MESSAGE = "Stopped by the maintainer: stop now and reply only `stopped`.";

/** One stream-json user message line, newline included. */
export function userMessageLine(text: string, priority?: MessagePriority): string {
  const message = {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    ...(priority === undefined ? {} : { priority }),
  };
  return `${JSON.stringify(message)}\n`;
}

/** Pure: the host ops for one steering op. */
export function encode(op: SteerOp): HostOp[] {
  switch (op.kind) {
    case "steer":
      return [{ write: userMessageLine(op.text, "next") }];
    case "answer":
      // The worker's turn has ended and it waits on stdin, so the answer is simply the next turn.
      return [{ write: userMessageLine(op.text) }];
    case "pause":
      return [{ write: userMessageLine(PAUSE_MESSAGE, "now") }];
    case "stop":
      return [
        { write: userMessageLine(STOP_MESSAGE, "now") },
        { closeStdin: true },
        { signal: "SIGTERM", afterMs: STOP_SIGTERM_AFTER_MS },
        { signal: "SIGKILL", afterMs: STOP_SIGKILL_AFTER_MS },
      ];
    case "kill":
      return [{ signal: "SIGKILL" }];
    case "hookReply":
      // The waiting `PermissionRequest` hook prints this (0008 section 5); empty is no decision.
      return [{ hookReply: op.reply.hook, output: permissionOutput(op.reply) }];
    default: {
      const unknown: never = op;
      throw new Error(`unknown steer op ${JSON.stringify(unknown)}`);
    }
  }
}
