// The diff between two run profiles (0013 section 4: "the previous confirmed profile, so a rescan
// can show a diff"). Each profile becomes a flat list of named facts in plain text; the diff is
// the facts that were added, removed or changed. Pure.

import { CAPABILITIES, type CommandSpec, type Resolution, type RunProfile } from "./detect";

/** A command as the maintainer would type it; an argument with a space is quoted. */
export function shownCommand(command: readonly string[]): string {
  return command.map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}

/** A command list as one line: the commands in order, joined with `&&`. */
export function shownSpec(spec: CommandSpec): string {
  const commands = spec.commands.map(shownCommand).join(" && ");
  return spec.cwd === "." ? commands : `${commands} (in ${spec.cwd})`;
}

function shownResolution<T>(resolution: Resolution<T>, show: (value: T) => string): string {
  switch (resolution.status) {
    case "resolved":
      return `${show(resolution.value)} [${resolution.source}, ${resolution.evidence}]`;
    case "conflict":
      return `conflict: ${resolution.candidates
        .map((candidate) => `${show(candidate.value)} [${candidate.source}, ${candidate.evidence}]`)
        .join(" | ")}`;
    case "unresolved":
      return "unresolved";
  }
}

/** The profile as named facts, in a stable order. */
export function profileFacts(profile: RunProfile): Map<string, string> {
  const facts = new Map<string, string>();
  const { toolchain } = profile;
  facts.set(
    "package manager",
    shownResolution(toolchain.packageManager, (pm) =>
      pm.version === null ? pm.name : `${pm.name}@${pm.version}`,
    ),
  );
  facts.set(
    "runtime version",
    shownResolution(toolchain.runtimeVersion, (v) => v),
  );
  facts.set(
    "workspaces",
    toolchain.workspaces.length === 0
      ? "none"
      : toolchain.workspaces.map((ws) => ws.dir).join(", "),
  );
  for (const name of CAPABILITIES) {
    facts.set(name, shownResolution(profile.capabilities[name], shownSpec));
  }
  facts.set("conformance", profile.conformance.level);
  for (const deviation of profile.conformance.deviations) {
    facts.set(`deviation ${deviation.code}`, deviation.message);
  }

  for (const file of profile.envFiles) {
    const from = file.example === null ? "declared" : `from ${file.example}`;
    const present = file.present ? "present" : "absent";
    const ignored = file.ignored ? "ignored" : "not ignored";
    facts.set(`env file ${file.path}`, `${from}, ${present}, ${ignored}`);
  }
  for (const script of profile.extraScripts) {
    facts.set(`script ${script.name}`, script.command);
  }
  return facts;
}

/**
 * The facts that changed from `previous` to `next`, one line each: `+ name: value` added,
 * `- name: value` removed, `~ name: old -> new` changed. Every fact is added when there is no
 * previous profile.
 */
export function diffProfiles(previous: RunProfile | null, next: RunProfile): string[] {
  const before = previous === null ? new Map<string, string>() : profileFacts(previous);
  const after = profileFacts(next);
  const lines: string[] = [];
  for (const [name, value] of after) {
    const old = before.get(name);
    if (old === undefined) lines.push(`+ ${name}: ${value}`);
    else if (old !== value) lines.push(`~ ${name}: ${old} -> ${value}`);
  }
  for (const [name, value] of before) {
    if (!after.has(name)) lines.push(`- ${name}: ${value}`);
  }
  return lines;
}

/** The resolved capabilities by name, as `scan.finished` reports them (0005 section 6). */
export function profileScripts(profile: RunProfile): Record<string, string> {
  const scripts: Record<string, string> = {};
  for (const name of CAPABILITIES) {
    const capability = profile.capabilities[name];
    if (capability.status === "resolved") scripts[name] = shownSpec(capability.value);
  }
  return scripts;
}
