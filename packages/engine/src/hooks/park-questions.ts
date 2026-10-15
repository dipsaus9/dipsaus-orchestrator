// The permission question of a `needs-permission` park (0008 section 5, DIPO-75), pure parts: the
// recorded tool and action read back from the park detail, whether the action is bound by the
// worker's sandbox (so allow once cannot help), the text the maintainer sees, and the first
// message of the resumed session for allow and deny.
//
// Allow once only ever answers the permission hook of the resumed run (`takeAllowOnce`). It never
// changes the run settings, the sandbox policy or the office config, so it cannot lift a sandbox
// block: network to a host not in `sandbox.allowedDomains`, or a write outside the worktree. For
// an action that looks sandbox-bound the question says so and points to the office config, which
// is reviewed like code. The check is a guide for the maintainer, not a boundary: the sandbox
// itself stays the boundary either way.

import { isAbsolute, normalize, relative, resolve } from "node:path";

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

/** What the sandbox check knows about the run. */
export interface SandboxFacts {
  /** The story worktree, the one tree the worker may write besides its temp directory. */
  readonly worktree: string | null;
  /** The office's `sandbox.allowedDomains`. */
  readonly allowedDomains: readonly string[];
}

/** Tools whose action is a file path the worker writes. */
const FILE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Tools whose action is a shell command run inside the sandbox. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash"]);

/** Programs that reach the network or a daemon socket whatever their arguments. */
const NETWORK_PROGRAMS: ReadonlySet<string> = new Set([
  "curl",
  "wget",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "nc",
  "ncat",
  "telnet",
  "ftp",
  "docker",
  "podman",
  "kubectl",
]);

/** Programs that reach the network for some verbs only (package installs, git transport). */
const NETWORK_VERBS: Readonly<Record<string, readonly string[]>> = {
  npm: ["install", "i", "add", "ci", "update", "publish", "view"],
  pnpm: ["install", "i", "add", "update", "publish"],
  yarn: ["install", "add", "upgrade", "publish"],
  bun: ["install", "i", "add", "update", "x", "publish"],
  pip: ["install", "download"],
  pip3: ["install", "download"],
  git: ["clone", "fetch", "pull", "push", "ls-remote"],
  brew: ["install", "upgrade", "update"],
};

const PROGRAMS_ALWAYS: ReadonlySet<string> = new Set(["npx", "bunx", "pnpx"]);

function domainAllowed(host: string, allowed: readonly string[]): boolean {
  const name = host.toLowerCase();
  return allowed.some((entry) => {
    const pattern = entry.toLowerCase();
    if (pattern.startsWith("*.")) return name.endsWith(pattern.slice(1));
    return name === pattern;
  });
}

function programOf(words: readonly string[]): { program: string; rest: string[] } | null {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? "")) i += 1;
  if (words[i] === "sudo" || words[i] === "env" || words[i] === "exec") i += 1;
  const first = words[i];
  if (first === undefined) return null;
  const program = first.split("/").at(-1) ?? first;
  return { program, rest: words.slice(i + 1) };
}

/** Why a shell command needs the network the sandbox closes; null when nothing shows it. */
function networkNeed(command: string, allowed: readonly string[]): string | null {
  const hosts = [...command.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^/\s:'"@]+@)?([^/\s:'"]+)/gi)]
    .map((match) => match[2] ?? "")
    .filter((host) => host !== "");
  const blocked = hosts.filter((host) => !domainAllowed(host, allowed));
  if (blocked.length > 0) return `reaches ${[...new Set(blocked)].join(", ")} over the network`;
  for (const segment of command.split(/[;&|()]+/)) {
    const words = segment
      .trim()
      .split(/\s+/)
      .filter((word) => word !== "");
    const found = programOf(words);
    if (found === null) continue;
    const { program, rest } = found;
    const verbs = NETWORK_VERBS[program];
    const verb = rest.find((word) => !word.startsWith("-"));
    if (
      NETWORK_PROGRAMS.has(program) ||
      PROGRAMS_ALWAYS.has(program) ||
      (verbs !== undefined && verb !== undefined && verbs.includes(verb))
    ) {
      // A URL whose every host is allowed already says where it goes.
      if (hosts.length > 0) return null;
      return `runs ${program}, which needs the network or a local daemon socket`;
    }
  }
  return null;
}

/** Why a file tool's path lies outside what the worker may write; null when inside. */
function writeOutside(action: string, worktree: string | null): string | null {
  if (worktree === null) return null;
  const root = normalize(worktree);
  const candidates = /\s/.test(action)
    ? action.split(/\s+/).filter((word) => word.includes("/") || word.startsWith("."))
    : [action];
  for (const candidate of candidates) {
    if (candidate === "") continue;
    const path = isAbsolute(candidate) ? normalize(candidate) : resolve(root, candidate);
    const inside = relative(root, path);
    if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) continue;
    return `writes ${candidate}, outside the worktree, where the worker's sandbox lets it write nothing`;
  }
  return null;
}

/**
 * Pure: why the recorded action is bound by the worker's sandbox, so allow once cannot let it
 * through; null when it does not look sandbox-bound.
 */
export function sandboxBinding(permission: RecordedPermission, facts: SandboxFacts): string | null {
  const { tool, action } = permission;
  if (FILE_TOOLS.has(tool)) return writeOutside(action, facts.worktree);
  if (SHELL_TOOLS.has(tool)) return networkNeed(action, facts.allowedDomains);
  return null;
}

/** The office config file the maintainer changes to let a sandbox-bound action through. */
export const OFFICE_CONFIG_FILE = ".dipo/office.yaml";

/**
 * What the maintainer sees for the park's question: the call as `Tool(action)`, and for a
 * sandbox-bound action that allow once cannot lift the sandbox block, with a pointer to the office
 * config.
 */
export function parkQuestionText(permission: RecordedPermission, binding: string | null): string {
  const call = permissionText(permission.tool, permission.action);
  if (binding === null) return call;
  return (
    `${call}. Sandbox-bound: it ${binding}. Allow once only passes the permission check and ` +
    `cannot lift a sandbox block; to let it through, change the sandbox section of the office ` +
    `config (${OFFICE_CONFIG_FILE}, for example sandbox.allowedDomains), which is reviewed like code.`
  );
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
      `The maintainer allowed this ${tool} call once: ${action}\n` +
      `Make exactly that call again now, with the same ${tool} input character for character. ` +
      `Only the first call that matches it exactly is allowed; any other call that needs a ` +
      `permission is still denied, and nothing about the sandbox changed.${said}`
    );
  }
  return `The maintainer denied ${tool}: ${action}. Do it without ${action}.${said}`;
}
