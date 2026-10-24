// The maintainer's confirmations laid over the profile code detected (0013 sections 2 to 6, DIPO-310).
// Pure: a code profile and the stored marks (confirmations, pending proposals, nothing to start)
// go in; the effective profile, the per-capability marks and the refusals come out.
//
// - A confirmation applies only to a capability code leaves unresolved or in conflict: the fallback
//   and the confirm command exist for those (0013 section 6). A capability code resolves wins, and
//   the scan removes a confirmation it made redundant (`supersededConfirmations`).
// - A confirmation made at another fingerprint is stale (0013 section 5): it keeps working for
//   `run` and the test command (the maintainer's answer of 2026-10-22) and waits on the desk to be
//   confirmed again.
// - A pending proposal is never part of the effective profile, so nothing runs it.
// - Nothing to start drops the missing-`dev` deviation and counts toward Conforming (0013 section 2).

import { shownSpec } from "./diff";
import {
  CAPABILITIES,
  type CapabilityName,
  type CommandSpec,
  type Confidence,
  type ConformanceLevel,
  type Deviation,
  type Resolution,
  type RunProfile,
} from "./detect";

/** The CLI the refusals and the desk name for the fallback (0013 amendment of 2026-10-22). */
export const INFER_COMMAND = "dipo office infer";
/** The CLI of the confirm command (DIPO-310's design choice: `dipo office confirm <action>`). */
export const CONFIRM_COMMAND = "dipo office confirm";
/** The CLI that lists the profile. */
export const PROFILE_COMMAND = "dipo office profile";

/** How a confirmation came about: an accepted proposal, or the maintainer's own command. */
export type ConfirmationSource = "inferred" | "maintainer";

/** One confirmed capability, as `capability_confirmations` holds it. */
export interface Confirmation {
  readonly capability: CapabilityName;
  readonly source: ConfirmationSource;
  readonly spec: CommandSpec;
  /** What it was confirmed on: the proposal's evidence, or `set by the maintainer`. */
  readonly evidence: string;
  /** The profile fingerprint it was confirmed at. */
  readonly fingerprint: string;
  readonly confirmedAt: number;
}

/** One pending proposal of the fallback (0013 section 6 step 3). Never executed. */
export interface Proposal {
  readonly capability: CapabilityName;
  readonly spec: CommandSpec;
  /** What the model said of its own proposal; the stored confidence is always `low`. */
  readonly modelConfidence: Confidence;
  /** The evidence the model named: files and what they say. */
  readonly evidence: readonly string[];
  readonly fingerprint: string;
  /** The fallback session run that proposed it. */
  readonly runId: string | null;
  readonly proposedAt: number;
}

/** Everything the maintainer and the fallback stored for an office. */
export interface ScanMarks {
  readonly confirmations: readonly Confirmation[];
  readonly proposals: readonly Proposal[];
  readonly nothingToStart: boolean;
}

export const NO_MARKS: ScanMarks = { confirmations: [], proposals: [], nothingToStart: false };

/** A capability as the profile read shows it: code's resolution and what lies over it. */
export interface CapabilityMark {
  /** What code detected, before any confirmation. */
  readonly code: Resolution<CommandSpec>;
  /** The confirmation in force; null when none applies. */
  readonly confirmation: Confirmation | null;
  readonly confirmed: boolean;
  /** Confirmed at another fingerprint: it keeps working until it is confirmed again. */
  readonly stale: boolean;
  /** The pending proposal; null when none waits. */
  readonly pending: Proposal | null;
}

export interface EffectiveProfile {
  readonly profile: RunProfile;
  readonly marks: Readonly<Record<CapabilityName, CapabilityMark>>;
  readonly nothingToStart: boolean;
  /** Why the test command refuses (0013 section 2): install or `dev` unresolved; null when not. */
  readonly testRefusal: string | null;
}

/** True when a capability is one the fallback and the confirm command may act on. */
export function needsFallback(resolution: Resolution<CommandSpec>): boolean {
  return resolution.status !== "resolved";
}

const confirmedConfidence: Confidence = "high";

function confirmedResolution(confirmation: Confirmation): Resolution<CommandSpec> {
  const by = confirmation.source === "inferred" ? "accepted proposal" : "set by the maintainer";
  return {
    status: "resolved",
    value: confirmation.spec,
    source: confirmation.source,
    confidence: confirmedConfidence,
    evidence: `confirmed (${by}): ${confirmation.evidence}`,
  };
}

/** The conformance level of a code profile with the nothing-to-start mark (0013 section 2). */
export function levelOf(profile: RunProfile, nothingToStart: boolean): ConformanceLevel {
  if (profile.conformance.level === "non-standard") return "non-standard";
  const { capabilities, conformance, toolchain } = profile;
  const deviations = conformance.deviations;
  const conforming =
    !deviations.some((d) => d.code === "no-lockfile") &&
    toolchain.packageManager.status === "resolved" &&
    capabilities.test.status === "resolved" &&
    (capabilities.dev.status === "resolved" || nothingToStart) &&
    capabilities.verify.status === "resolved" &&
    !deviations.some((d) => d.code.startsWith("fixed-port:"));
  return conforming ? "conforming" : "partial";
}

/** The hint every refusal for an unresolved capability ends with (criterion 5). */
export function fallbackHint(capability: CapabilityName): string {
  return `Or have a model propose it with \`${INFER_COMMAND}\`, or set it with \`${CONFIRM_COMMAND} set ${capability} -- <command>\`.`;
}

/** The `run` refusal of the effective profile: null when verify resolved or is confirmed. */
function runRefusalOf(code: RunProfile, verify: Resolution<CommandSpec>): string | null {
  if (verify.status === "resolved") return null;
  const base =
    code.runRefusal ??
    'Verify is unresolved: add a "verify" script to package.json that runs the checks a story must pass before review.';
  return `${base} ${fallbackHint("verify")}`;
}

/**
 * Why the test command refuses (0013 section 2): install unresolved, or `dev` unresolved while the
 * product is not marked as having nothing to start. A stale confirmation still counts; a pending
 * proposal never does. Null when the test command may run.
 */
function testRefusalOf(profile: RunProfile, nothingToStart: boolean): string | null {
  const { install, dev } = profile.capabilities;
  if (install.status !== "resolved") {
    return `Install is ${install.status === "conflict" ? "in conflict" : "unresolved"}: commit the package manager's lockfile, or declare the install. ${fallbackHint("install")}`;
  }
  if (dev.status !== "resolved" && !nothingToStart) {
    return `"dev" is ${dev.status === "conflict" ? "in conflict" : "unresolved"}: add a "dev" script that starts the product, or mark the product as having nothing to start with \`${CONFIRM_COMMAND} nothing-to-start\`. ${fallbackHint("dev")}`;
  }
  return null;
}

/** The code profile with the marks laid over it. Pure. */
export function effectiveProfile(code: RunProfile, marks: ScanMarks): EffectiveProfile {
  const confirmations = new Map(marks.confirmations.map((c) => [c.capability, c]));
  const proposals = new Map(marks.proposals.map((p) => [p.capability, p]));
  const capabilities = { ...code.capabilities };
  const perCapability = {} as Record<CapabilityName, CapabilityMark>;
  for (const name of CAPABILITIES) {
    const resolution = code.capabilities[name];
    const stored = confirmations.get(name);
    const applies = stored !== undefined && needsFallback(resolution);
    if (applies) capabilities[name] = confirmedResolution(stored);
    perCapability[name] = {
      code: resolution,
      confirmation: applies ? stored : null,
      confirmed: applies,
      stale: applies && stored.fingerprint !== code.fingerprint,
      pending: needsFallback(resolution) ? (proposals.get(name) ?? null) : null,
    };
  }
  const deviations: readonly Deviation[] = marks.nothingToStart
    ? code.conformance.deviations.filter((d) => d.code !== "missing-dev")
    : code.conformance.deviations;
  const profile: RunProfile = {
    ...code,
    capabilities,
    conformance: { level: levelOf(code, marks.nothingToStart), deviations },
    runRefusal: runRefusalOf(code, capabilities.verify),
  };
  return {
    profile,
    marks: perCapability,
    nothingToStart: marks.nothingToStart,
    testRefusal: testRefusalOf(profile, marks.nothingToStart),
  };
}

/**
 * The confirmations a new code profile makes redundant, because code now resolves their
 * capability, each with its diff line (criterion 8). The scan deletes them.
 */
export function supersededConfirmations(
  code: RunProfile,
  marks: ScanMarks,
): { readonly capability: CapabilityName; readonly line: string }[] {
  return marks.confirmations.flatMap((confirmation) => {
    const resolution = code.capabilities[confirmation.capability];
    if (resolution.status !== "resolved") return [];
    return [
      {
        capability: confirmation.capability,
        line: `~ ${confirmation.capability} confirmation: ${shownSpec(confirmation.spec)} [${confirmation.source}] -> code resolves it: ${shownSpec(resolution.value)} [${resolution.source}, ${resolution.evidence}]; the confirmation is removed`,
      },
    ];
  });
}

/** The pending proposals a new code profile makes moot: code now resolves their capability. */
export function mootProposals(code: RunProfile, marks: ScanMarks): CapabilityName[] {
  return marks.proposals
    .filter((proposal) => !needsFallback(code.capabilities[proposal.capability]))
    .map((proposal) => proposal.capability);
}

/**
 * The diff lines of confirmations that turned stale between two fingerprints (criterion 8): one
 * per confirmation that was current at `before` and is not at `after`.
 */
export function staleLines(before: string | null, after: string, marks: ScanMarks): string[] {
  if (before === null || before === after) return [];
  return marks.confirmations
    .filter((c) => c.fingerprint === before)
    .map(
      (c) =>
        `! ${c.capability} confirmation is stale: the repository's run inputs changed since it was confirmed; it keeps working until \`${CONFIRM_COMMAND} keep ${c.capability}\``,
    );
}

/**
 * The standard script that would remove a deviation, as one line (0013 section 6 step 6); null for
 * a deviation no script removes.
 */
export function deviationFix(deviation: Deviation): string | null {
  const code = deviation.code;
  if (code === "missing-test") return 'add a "test" script';
  if (code === "missing-dev") {
    return `add a "dev" script, or run \`${CONFIRM_COMMAND} nothing-to-start\``;
  }
  if (code === "missing-lint") return 'add a "lint" script';
  if (code === "missing-typecheck") return 'add a "typecheck" script';
  if (code === "verify-composed" || code === "verify-declared-differs") {
    return 'add a "verify" script that runs the full gate';
  }
  if (code === "verify-conflict") {
    return 'rename the other "verify" (for example to "verify:puzzle") and add a "verify" script that runs the gate';
  }
  if (code === "relies-on-workflow") {
    return 'add the standard scripts ("verify", and install through the lockfile) so .claude/backlog-workflow.json is not needed';
  }
  if (code === "format-writes") return 'move the writing variant to "format:fix"';
  if (code === "no-lockfile") return "commit the package manager's lockfile";
  if (code.startsWith("fixed-port:")) return "let the PORT environment variable override the port";
  if (code === "no-package-json")
    return 'add a package.json with the standard scripts ("test", "verify", "dev")';
  return null;
}

/** The script whose rename or addition would let a confirmation go (0013 section 6 step 6). */
export function confirmationFix(capability: CapabilityName): string {
  if (capability === "install") {
    return "commit the package manager's lockfile, so install is derived from it";
  }
  return `add a "${capability}" script, so code resolves it and the confirmation can go`;
}
