// The permission question of a `needs-permission` park (0008 section 5, DIPO-75), pure parts: the
// recorded tool and action read back from the park detail, the text the maintainer sees, and the
// first message of the resumed session for allow and deny.
//
// A developer works in its box with every permission (DIPO-240, 0021 section 7), so no hook relays
// an approval call and nothing is allowed once at the hook any more: an answer resumes the run in
// its box with a message that names the call. With no Mac sandbox there is no sandbox block to
// warn about either; what the box may reach is the box's network rules (0021 section 3), which no
// answer changes. The answer is never written as a rule, the run settings or the office config.

import { permissionText } from "./questions";

/** The tool and action a `needs-permission` park records (detail `<tool>: <action>`). */
export interface RecordedPermission {
  readonly tool: string;
  readonly action: string;
}

/** The detail of a `needs-permission` park as run control writes it (`<tool>: <action>`). */
export function permissionDetail(permission: RecordedPermission): string {
  return `${permission.tool}: ${permission.action}`;
}

/** Pure: the recorded tool and action of a `needs-permission` park detail; null when malformed. */
export function recordedPermission(detail: string): RecordedPermission | null {
  const at = detail.indexOf(": ");
  if (at <= 0) return null;
  const tool = detail.slice(0, at);
  const action = detail.slice(at + 2);
  if (/\s/.test(tool) || action === "") return null;
  return { tool, action };
}

/** What the maintainer sees for the park's question: the call as `Tool(action)`. */
export function parkQuestionText(permission: RecordedPermission): string {
  return permissionText(permission.tool, permission.action);
}

/** The first message of the session resumed by an answer to the park's question. */
export function parkAnswerMessage(
  permission: RecordedPermission,
  decision: "allow" | "deny",
  note: string,
): string {
  const { tool, action } = permission;
  const said = note.trim() === "" ? "" : `\n\nThe maintainer adds: ${note.trim()}`;
  if (decision === "allow") {
    return (
      `The maintainer allows this ${tool} call: ${action}\n` +
      `Go ahead with it in your box. This answer is for this call; it changes no rule or setting.${said}`
    );
  }
  return `The maintainer denied ${tool}: ${action}. Do it without ${action}.${said}`;
}
