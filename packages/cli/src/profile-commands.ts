// `dipo office infer`, `dipo office profile` and `dipo office confirm` (DIPO-310, 0013 section 6):
//
// - `infer` sends `office.infer`, which starts the scan fallback's model session for what code
//   left unresolved or in conflict, and waits for its `scan.finished` (trigger `infer`) to print
//   the proposals; a session that takes longer is left running and the command says where to look.
// - `profile [--json]` reads `office.profile` and prints each capability with its command, source,
//   confidence, confirmed, pending proposal and stale flags, then the deviations with their fix.
// - `confirm <action> ...` sends `office.confirm`: `accept|reject|keep <capability>`,
//   `edit|set <capability> [--cwd <dir>] -- <command>`, `pick <capability> <n>`, and
//   `nothing-to-start [--undo]`. A command after `--` is one quoted string or its words, commands
//   joined by `&&`; nothing here runs it.
//
// Every line printed comes from the engine; this file lays it out.

import {
  type ConfirmArgs,
  officeConfirm,
  officeInfer,
  officeProfile,
  type OfficeId,
  ProfileCapability,
  type ProfileView,
  scanFinished,
  StreamName,
} from "@dipsaus-orchestrator/contract";

import { engineFailure, type DaemonSession, usage } from "./daemon-commands";
import { type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";

type Subcommand = (args: readonly string[], deps: OfficeCommandDeps) => Promise<number>;

/** How long `office infer` waits for its session: the `scan` block's 5 minutes and some. */
export const INFER_WAIT_MS = 8 * 60_000;

type ScanFinished = ReturnType<typeof scanFinished.data.parse>;

/** Splits one command line into words: quotes group, `&&` between words separates commands. */
export function splitCommands(words: readonly string[]): string[][] | string {
  const tokens: string[] = [];
  const text = words.length === 1 ? (words[0] ?? "") : null;
  if (text === null) {
    tokens.push(...words);
  } else {
    let current = "";
    let started = false;
    let quote: string | null = null;
    for (const char of text) {
      if (quote !== null) {
        if (char === quote) quote = null;
        else current += char;
      } else if (char === '"' || char === "'") {
        quote = char;
        started = true;
      } else if (/\s/.test(char)) {
        if (started) tokens.push(current);
        current = "";
        started = false;
      } else {
        current += char;
        started = true;
      }
    }
    if (quote !== null) return "the command has an unclosed quote";
    if (started) tokens.push(current);
  }
  const commands: string[][] = [[]];
  for (const token of tokens) {
    if (token === "&&") commands.push([]);
    else commands[commands.length - 1]?.push(token);
  }
  if (commands.some((command) => command.length === 0)) {
    return "give a command after --, commands joined by &&";
  }
  return commands;
}

interface ConfirmParse {
  readonly office: OfficeId | null;
  readonly args: ConfirmArgs;
}

/** Parses `dipo office confirm` arguments; a string is a usage error. */
export function parseConfirm(argv: readonly string[]): ConfirmParse | string {
  const dash = argv.indexOf("--");
  const head = dash === -1 ? [...argv] : argv.slice(0, dash);
  const tail = dash === -1 ? null : argv.slice(dash + 1);
  let cwd: string | undefined;
  let undo = false;
  const rest: string[] = [];
  for (let i = 0; i < head.length; i++) {
    const arg = head[i] ?? "";
    if (arg === "--cwd") {
      const value = head[i + 1];
      if (value === undefined || value.startsWith("-")) return "--cwd needs a folder";
      cwd = value;
      i += 1;
    } else if (arg === "--undo") {
      undo = true;
    } else {
      rest.push(arg);
    }
  }
  const options: string[] = [];
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    if (arg === "--office") {
      options.push(arg, rest[i + 1] ?? "");
      i += 1;
    } else if (arg.startsWith("-")) {
      return `unknown argument ${JSON.stringify(arg)}`;
    } else positional.push(arg);
  }
  const parsed = parseOptions(options, false);
  if (typeof parsed === "string") return parsed;
  const [action, capabilityText, extra] = positional;
  if (action === undefined)
    return "name an action: accept, edit, reject, set, pick, keep or nothing-to-start";
  if (action === "nothing-to-start") {
    if (positional.length > 1 || tail !== null || cwd !== undefined) {
      return "nothing-to-start takes only --undo";
    }
    return { office: parsed.office, args: { action, value: !undo } };
  }
  if (undo) return "--undo goes with nothing-to-start only";
  const capability = ProfileCapability.safeParse(capabilityText);
  if (!capability.success) {
    return `name a capability: ${ProfileCapability.options.join(", ")}`;
  }
  const name = capability.data;
  if (action === "accept" || action === "reject" || action === "keep") {
    if (extra !== undefined || tail !== null || cwd !== undefined) {
      return `${action} takes only the capability`;
    }
    return { office: parsed.office, args: { action, capability: name } };
  }
  if (action === "pick") {
    const n = Number(extra);
    if (!Number.isInteger(n) || n < 1 || positional.length > 3 || tail !== null) {
      return "pick takes the capability and the candidate's number";
    }
    return { office: parsed.office, args: { action, capability: name, candidate: n } };
  }
  if (action === "edit" || action === "set") {
    if (extra !== undefined) return `${action} takes its command after --`;
    if (tail === null || tail.length === 0) return `${action} needs a command after --`;
    const commands = splitCommands(tail);
    if (typeof commands === "string") return commands;
    return {
      office: parsed.office,
      args: {
        action,
        capability: name,
        commands,
        ...(cwd === undefined ? {} : { cwd }),
      },
    };
  }
  return `unknown action ${JSON.stringify(action)}`;
}

function printDiff(deps: OfficeCommandDeps, diff: readonly string[]): void {
  if (diff.length === 0) {
    deps.writeLine("no change to the profile");
    return;
  }
  deps.writeLine("changes:");
  for (const line of diff) deps.writeLine(`  ${line}`);
}

async function confirmCommand(args: readonly string[], deps: OfficeCommandDeps): Promise<number> {
  const parsed = parseConfirm(args);
  if (typeof parsed === "string") return usage(deps, `office confirm: ${parsed}`);
  return withOffice(deps, parsed.office, async (session, office) => {
    const outcome = await session.command(officeConfirm, parsed.args, { office });
    if (!outcome.ok) {
      return outcome.error.code === "office.unknown"
        ? "unknown"
        : engineFailure(deps, outcome.error);
    }
    const result = outcome.result;
    const what =
      result.capability === undefined
        ? "the profile"
        : `${result.capability}: ${result.confirmed ? `confirmed (${result.source ?? "unknown"})` : "not confirmed"}`;
    deps.writeLine(`office ${office}: ${what}`);
    printDiff(deps, result.diff);
    deps.writeLine(
      result.runRefusal === undefined
        ? "dipo run can start stories"
        : `dipo run refuses: ${result.runRefusal}`,
    );
    return 0;
  });
}

/** Subscribes for the infer's `scan.finished`, then sends `office.infer`. */
async function inferAndWait(
  deps: OfficeCommandDeps,
  session: DaemonSession,
  office: OfficeId,
): Promise<number | "unknown"> {
  const finished = Promise.withResolvers<ScanFinished>();
  const live = Promise.withResolvers<void>();
  const subscription = session.subscribe(StreamName.parse(`office:${office}`), {
    onEvent: (event) => {
      if (event.type !== scanFinished.type) return;
      const data = scanFinished.data.safeParse(event.data);
      if (data.success && data.data.trigger === "infer") finished.resolve(data.data);
    },
    onCaughtUp: () => live.resolve(),
    onEnded: (error) => {
      const failed = new Error(`${error.code}: ${error.message}`);
      live.reject(failed);
      finished.reject(failed);
    },
  });
  try {
    await Promise.race([live.promise, finished.promise]);
    const outcome = await session.command(officeInfer, {}, { office });
    if (!outcome.ok) {
      return outcome.error.code === "office.unknown"
        ? "unknown"
        : engineFailure(deps, outcome.error);
    }
    const { infer, capabilities } = outcome.result;
    if (infer === "nothing") {
      deps.writeLine(
        `office ${office}: nothing to infer: code and your confirmations resolve every capability`,
      );
      return 0;
    }
    deps.writeLine(
      `office ${office}: the fallback ${infer === "queued" ? "waits for the running session, then asks" : "asks"} for ${capabilities.join(", ")}`,
    );
    const timeout = Promise.withResolvers<null>();
    const timer = deps.clock.setTimeout(() => timeout.resolve(null), INFER_WAIT_MS);
    try {
      const data = await Promise.race([finished.promise, timeout.promise]);
      if (data === null) {
        deps.writeLine(
          "the session still runs; its proposals arrive on `dipo desk` and in `dipo office profile`",
        );
        return 0;
      }
      if (data.error !== undefined) {
        deps.writeError(`dipo: ${data.error}`);
        return 1;
      }
      for (const warning of data.warnings) deps.writeLine(warning);
      const diff = data.diff ?? [];
      if (diff.length > 0) {
        deps.writeLine("proposals, pending until you confirm them:");
        for (const line of diff) deps.writeLine(`  ${line}`);
        deps.writeLine(
          "confirm with `dipo office confirm accept <capability>`; see `dipo office profile`",
        );
      }
      return 0;
    } finally {
      deps.clock.clearTimeout(timer);
    }
  } finally {
    subscription.unsubscribe();
  }
}

async function inferCommand(args: readonly string[], deps: OfficeCommandDeps): Promise<number> {
  const options = parseOptions(args, false);
  if (typeof options === "string") return usage(deps, `office infer: ${options}`);
  return withOffice(
    deps,
    options.office,
    (session, office) => inferAndWait(deps, session, office),
    undefined,
    INFER_WAIT_MS + 60_000,
  );
}

/** The profile as plain-text lines. */
export function formatProfile(label: string, view: ProfileView): string[] {
  if (!view.scanned) {
    return [`${label} · no run profile yet: run \`dipo office rescan\``];
  }
  const lines = [
    `${label} · conformance ${view.level ?? "unknown"} · scanned ${view.scannedAt ?? "?"} at ${(view.commit ?? "").slice(0, 12)}${view.inferring ? " · fallback running" : ""}${view.nothingToStart ? " · nothing to start" : ""}`,
    view.runRefusal === undefined ? "run: can start stories" : `run: refused: ${view.runRefusal}`,
    view.testRefusal === undefined ? "test: can run" : `test: refused: ${view.testRefusal}`,
    "capabilities:",
  ];
  const width = Math.max(...view.capabilities.map((c) => c.name.length));
  for (const capability of view.capabilities) {
    const flags = [
      capability.confirmed ? "confirmed" : null,
      capability.stale ? "stale" : null,
      capability.pending === undefined ? null : "pending",
    ].filter((flag) => flag !== null);
    const head =
      capability.status === "resolved"
        ? `${capability.command ?? ""} · ${capability.source ?? "?"}, ${capability.confidence ?? "?"} · ${capability.evidence ?? ""}`
        : capability.status;
    lines.push(
      `  ${capability.name.padEnd(width)}  ${head}${flags.length === 0 ? "" : ` [${flags.join(", ")}]`}`,
    );
    const indent = " ".repeat(width + 4);
    for (const candidate of capability.candidates ?? []) {
      lines.push(
        `${indent}candidate ${candidate.n}: ${candidate.command} · ${candidate.source}, ${candidate.confidence} · ${candidate.evidence}`,
      );
    }
    const pending = capability.pending;
    if (pending !== undefined) {
      lines.push(
        `${indent}proposed: ${pending.command} · confidence low (the model said ${pending.modelConfidence})${pending.stale ? " · stale" : ""}`,
      );
      for (const evidence of pending.evidence) lines.push(`${indent}  evidence: ${evidence}`);
    }
    if (capability.fix !== undefined) lines.push(`${indent}to drop it: ${capability.fix}`);
    if (capability.cli.length > 0) lines.push(`${indent}${capability.cli.join(" | ")}`);
  }
  if (view.deviations.length === 0) {
    lines.push("no deviations from the script standard");
  } else {
    lines.push("deviations:");
    for (const deviation of view.deviations) {
      lines.push(
        `  - ${deviation.message}${deviation.fix === undefined ? "" : ` · fix: ${deviation.fix}`}`,
      );
    }
  }
  return lines;
}

async function profileCommand(args: readonly string[], deps: OfficeCommandDeps): Promise<number> {
  const json = args.includes("--json");
  const options = parseOptions(
    args.filter((arg) => arg !== "--json"),
    false,
  );
  if (typeof options === "string") return usage(deps, `office profile: ${options}`);
  return withOffice(
    deps,
    options.office,
    async (session, office) => {
      const outcome = await session.read(officeProfile, { office });
      if (!outcome.ok) {
        return outcome.error.code === "office.unknown"
          ? "unknown"
          : engineFailure(deps, outcome.error);
      }
      if (json) {
        deps.writeLine(JSON.stringify(outcome.result));
        return 0;
      }
      for (const line of formatProfile(`office ${office}`, outcome.result)) deps.writeLine(line);
      return 0;
    },
    undefined,
    undefined,
    "running",
    // Read only: a folder that is not an office is named, never offered to open.
    false,
  );
}

export const PROFILE_SUBCOMMANDS: ReadonlyMap<string, Subcommand> = new Map<string, Subcommand>([
  ["infer", inferCommand],
  ["profile", profileCommand],
  ["confirm", confirmCommand],
]);
