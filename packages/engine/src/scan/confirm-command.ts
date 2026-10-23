// `office.confirm` (0013 section 6 steps 4 and 5, DIPO-310): the maintainer accepts, edits or
// rejects a pending proposal, sets a capability by hand, picks one candidate of a conflict,
// confirms a stale confirmation again, or marks the product as having nothing to start. It writes
// only the database, inside the command's transaction: the confirmation, proposal and mark rows.
// The run refusal follows, because `verifyResolved` reads the effective profile; the command emits
// `scan.finished` with trigger `confirm` and the diff of the effective profile.
//
// Sources (0013 section 6): accept gives `inferred`, edit, set and pick give `maintainer`; each is
// confirmed. A capability code resolves is refused (`scan.resolvedByCode`): the fallback and the
// confirmations exist only for what code leaves unresolved or in conflict, and a rescan would
// replace such a confirmation anyway (criterion 8).

import type { ConfirmArgs, ProfileCapability } from "@dipsaus-orchestrator/contract";

import type { NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type { OfficeHandle } from "../db/office";

import { normalCwd } from "./answer";
import type { ConfirmationSource } from "./confirm";
import { diffProfiles, profileScripts, shownSpec } from "./diff";
import type { CapabilityName, CommandSpec } from "./detect";
import { deleteProposal, readMarks, writeConfirmation, writeNothingToStart } from "./marks";
import { currentProfile, type StoredProfile } from "./store";

export interface ConfirmOutcome {
  readonly result: {
    capability?: ProfileCapability;
    source?: string;
    confirmed: boolean;
    diff: string[];
    runRefusal?: string;
  };
  readonly entry: NewEntry;
}

function cwdOf(cwd: string | undefined, fallback: string): string {
  const clean = normalCwd(cwd ?? fallback);
  if (clean === null) {
    throw new CommandError(
      "scan.invalidCommand",
      `The working directory ${JSON.stringify(cwd)} leaves the repository; give a folder relative to its root.`,
    );
  }
  return clean;
}

function noProposal(capability: CapabilityName): CommandError {
  return new CommandError(
    "scan.noProposal",
    `${capability} has no pending proposal. Run \`dipo office infer\`, or set it with \`dipo office confirm set ${capability} -- <command>\`.`,
  );
}

/** Applies one confirm action inside the caller's transaction. */
export function applyConfirm(office: OfficeHandle, args: ConfirmArgs, now: number): ConfirmOutcome {
  const before = currentProfile(office);
  if (before === null) {
    throw new CommandError(
      "scan.noProfile",
      "The office has no run profile yet. Run `dipo office rescan` first.",
    );
  }
  const extra: string[] = [];
  let capability: CapabilityName | undefined;

  if (args.action === "nothing-to-start") {
    const value = args.value ?? true;
    writeNothingToStart(office, value, now);
    if (value !== before.nothingToStart) {
      extra.push(
        value
          ? "+ nothing to start: the product has nothing to start (set by the maintainer)"
          : "- nothing to start: taken back by the maintainer",
      );
    }
  } else {
    capability = args.capability;
    const mark = before.marks[capability];
    if (mark.code.status === "resolved") {
      throw new CommandError(
        "scan.resolvedByCode",
        `${capability} is resolved by code (${shownSpec(mark.code.value)}, ${mark.code.evidence}). Change the script instead; a confirmation applies only to what code leaves unresolved or in conflict.`,
      );
    }
    const confirm = (source: ConfirmationSource, spec: CommandSpec, evidence: string) =>
      writeConfirmation(office, {
        capability: args.capability,
        source,
        spec,
        evidence,
        fingerprint: before.code.fingerprint,
        confirmedAt: now,
      });
    const pending = mark.pending;
    switch (args.action) {
      case "accept": {
        if (pending === null) throw noProposal(capability);
        confirm("inferred", pending.spec, pending.evidence.join("; "));
        deleteProposal(office, capability);
        break;
      }
      case "edit": {
        if (pending === null) throw noProposal(capability);
        const spec = { commands: args.commands, cwd: cwdOf(args.cwd, pending.spec.cwd) };
        confirm("maintainer", spec, `edited from the proposal ${shownSpec(pending.spec)}`);
        deleteProposal(office, capability);
        break;
      }
      case "reject": {
        if (pending === null) throw noProposal(capability);
        deleteProposal(office, capability);
        extra.push(`- ${capability} proposal: ${shownSpec(pending.spec)} (rejected)`);
        break;
      }
      case "set": {
        confirm(
          "maintainer",
          { commands: args.commands, cwd: cwdOf(args.cwd, ".") },
          "set by the maintainer",
        );
        if (deleteProposal(office, capability) && pending !== null) {
          extra.push(`- ${capability} proposal: ${shownSpec(pending.spec)} (replaced)`);
        }
        break;
      }
      case "pick": {
        if (mark.code.status !== "conflict") {
          throw new CommandError(
            "scan.notConflict",
            `${capability} is not in conflict; use \`dipo office confirm set ${capability} -- <command>\`.`,
          );
        }
        const candidate = mark.code.candidates[args.candidate - 1];
        if (candidate === undefined) {
          throw new CommandError(
            "scan.noCandidate",
            `${capability} has ${mark.code.candidates.length} candidates; pick one of 1 to ${mark.code.candidates.length}.`,
          );
        }
        confirm(
          "maintainer",
          candidate.value,
          `picked candidate ${args.candidate} of the conflict: ${candidate.evidence}`,
        );
        deleteProposal(office, capability);
        break;
      }
      case "keep": {
        const confirmation = readMarks(office).confirmations.find(
          (c) => c.capability === capability,
        );
        if (confirmation === undefined || !mark.confirmed) {
          throw new CommandError(
            "scan.notConfirmed",
            `${capability} has no confirmation to keep. Set it with \`dipo office confirm set ${capability} -- <command>\`.`,
          );
        }
        writeConfirmation(office, {
          ...confirmation,
          fingerprint: before.code.fingerprint,
          confirmedAt: now,
        });
        if (mark.stale) extra.push(`~ ${capability} confirmation: stale -> confirmed again`);
        break;
      }
    }
  }

  const after = currentProfile(office);
  if (after === null) throw new Error("the run profile could not be read back");
  const diff = [...diffProfiles(before.profile, after.profile), ...extra];
  const result = confirmResult(after, capability, diff);
  return {
    result,
    entry: {
      type: "scan.finished",
      delta: {
        scripts: profileScripts(after.profile),
        warnings: [],
        trigger: "confirm",
        level: after.profile.conformance.level,
        deviations: after.profile.conformance.deviations.map((d) => d.message),
        diff,
      },
    },
  };
}

function confirmResult(
  after: StoredProfile,
  capability: CapabilityName | undefined,
  diff: string[],
): ConfirmOutcome["result"] {
  const refusal = after.profile.runRefusal;
  const base = { diff, ...(refusal === null ? {} : { runRefusal: refusal }) };
  if (capability === undefined) return { ...base, confirmed: false };
  const resolution = after.profile.capabilities[capability];
  return {
    ...base,
    capability,
    confirmed: after.marks[capability].confirmed,
    ...(resolution.status === "resolved" ? { source: resolution.source } : {}),
  };
}
