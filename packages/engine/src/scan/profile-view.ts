// The run profile as `office.profile` returns it and `dipo office profile` prints it (DIPO-310),
// and its rows on the desk: each pending proposal and each stale confirmation is a hand action
// with its `dipo office confirm` line (criterion 9). Code builds every line; clients only lay them
// out.

import {
  type OfficeId,
  type ProfileCapabilityView,
  type ProfileView,
  RunId,
} from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";

import {
  CONFIRM_COMMAND,
  confirmationFix,
  deviationFix,
  INFER_COMMAND,
  type CapabilityMark,
} from "./confirm";
import { shownSpec } from "./diff";
import { CAPABILITIES, type CapabilityName, type CommandSpec, type Resolution } from "./detect";
import { currentProfile } from "./store";

const iso = (ms: number) => new Date(ms).toISOString();

function runOf(id: string | null): { run?: RunId } {
  const parsed = RunId.safeParse(id);
  return parsed.success ? { run: parsed.data } : {};
}

const shown = (spec: CommandSpec) => ({
  command: shownSpec(spec),
  commands: spec.commands.map((argv) => [...argv]),
  cwd: spec.cwd,
});

/** The command lines one capability offers, in the order a client lists them. */
export function capabilityCli(
  name: CapabilityName,
  resolution: Resolution<CommandSpec>,
  mark: CapabilityMark,
  nothingToStart: boolean,
): string[] {
  if (mark.code.status === "resolved") return [];
  const lines: string[] = [];
  if (mark.pending !== null) {
    lines.push(
      `${CONFIRM_COMMAND} accept ${name}`,
      `${CONFIRM_COMMAND} edit ${name} -- <command>`,
      `${CONFIRM_COMMAND} reject ${name}`,
    );
  }
  if (mark.stale) lines.push(`${CONFIRM_COMMAND} keep ${name}`);
  if (mark.code.status === "conflict") {
    mark.code.candidates.forEach((_, at) =>
      lines.push(`${CONFIRM_COMMAND} pick ${name} ${at + 1}`),
    );
  }
  if (resolution.status !== "resolved" && mark.pending === null) {
    if (!(name === "dev" && nothingToStart)) lines.push(INFER_COMMAND);
    if (name === "dev" && !nothingToStart) lines.push(`${CONFIRM_COMMAND} nothing-to-start`);
  }
  if (!(name === "dev" && nothingToStart && resolution.status !== "resolved")) {
    lines.push(`${CONFIRM_COMMAND} set ${name} -- <command>`);
  }
  return lines;
}

/** The office's profile view; `inferring` says whether a fallback session runs or waits. */
export function profileView(
  officeId: OfficeId,
  office: OfficeHandle,
  inferring: boolean,
): ProfileView {
  const current = currentProfile(office);
  if (current === null) {
    return {
      office: officeId,
      scanned: false,
      nothingToStart: false,
      inferring,
      runRefusal:
        "Verify is unresolved: the office has no run profile yet. Run `dipo office rescan`.",
      capabilities: [],
      deviations: [],
    };
  }
  const { profile, marks, nothingToStart } = current;
  const capabilities = CAPABILITIES.map((name): ProfileCapabilityView => {
    const resolution = profile.capabilities[name];
    const mark = marks[name];
    const view: ProfileCapabilityView = {
      name,
      status: resolution.status,
      confirmed: mark.confirmed,
      stale: mark.stale,
      cli: capabilityCli(name, resolution, mark, nothingToStart),
    };
    const resolved =
      resolution.status === "resolved"
        ? {
            ...shown(resolution.value),
            source: resolution.source,
            confidence: resolution.confidence,
            evidence: resolution.evidence,
          }
        : {};
    const pending =
      mark.pending === null
        ? {}
        : {
            pending: {
              ...shown(mark.pending.spec),
              confidence: "low" as const,
              modelConfidence: mark.pending.modelConfidence,
              evidence: [...mark.pending.evidence],
              stale: mark.pending.fingerprint !== current.code.fingerprint,
              ...runOf(mark.pending.runId),
              proposedAt: iso(mark.pending.proposedAt),
            },
          };
    const candidates =
      resolution.status === "conflict"
        ? {
            candidates: resolution.candidates.map((candidate, at) => ({
              n: at + 1,
              ...shown(candidate.value),
              source: candidate.source,
              confidence: candidate.confidence,
              evidence: candidate.evidence,
            })),
          }
        : {};
    const fix = mark.confirmed || mark.pending !== null ? { fix: confirmationFix(name) } : {};
    return { ...view, ...resolved, ...pending, ...candidates, ...fix };
  });
  return {
    office: officeId,
    scanned: true,
    scannedAt: iso(current.scannedAt),
    commit: current.commit,
    fingerprint: profile.fingerprint,
    level: profile.conformance.level,
    nothingToStart,
    inferring,
    ...(profile.runRefusal === null ? {} : { runRefusal: profile.runRefusal }),
    ...(current.testRefusal === null ? {} : { testRefusal: current.testRefusal }),
    capabilities,
    deviations: profile.conformance.deviations.map((deviation) => {
      const fix = deviationFix(deviation);
      return {
        code: deviation.code,
        message: deviation.message,
        conflict: deviation.conflict,
        ...(fix === null ? {} : { fix }),
      };
    }),
  };
}

/** One profile row of the desk (criterion 9): an office item, with no story. */
export interface ProfileDeskItem {
  readonly kind: "PROFILE";
  readonly detail: string;
  /** When it began to wait, in ms. */
  readonly since: number;
  readonly actions: readonly {
    readonly command: "office.confirm" | "office.infer";
    readonly cli: string;
  }[];
}

/**
 * What refuses while a capability is unresolved (0013 section 2): `run` for verify, the test
 * command for install and `dev` (`dev` not when the product has nothing to start).
 */
function refusedBy(name: CapabilityName, nothingToStart: boolean): string | null {
  if (name === "verify") return "dipo run refuses stories";
  if (name === "install" || (name === "dev" && !nothingToStart)) return "the test command refuses";
  return null;
}

/**
 * The desk rows of the office's profile: a capability `run` or the test command needs that is
 * unresolved with no proposal (naming `dipo office infer`, criterion 5), each pending proposal and
 * each stale confirmation (criterion 9).
 */
export function profileDeskItems(office: OfficeHandle): ProfileDeskItem[] {
  const current = currentProfile(office);
  if (current === null) return [];
  const items: ProfileDeskItem[] = [];
  for (const name of CAPABILITIES) {
    const mark = current.marks[name];
    const pending = mark.pending;
    const resolution = current.profile.capabilities[name];
    const refused = refusedBy(name, current.nothingToStart);
    if (resolution.status !== "resolved" && pending === null && refused !== null) {
      items.push({
        kind: "PROFILE",
        detail: `${name} is ${resolution.status === "conflict" ? "in conflict" : "unresolved"}, so ${refused}`,
        since: current.scannedAt,
        actions: [
          { command: "office.infer", cli: INFER_COMMAND },
          ...(resolution.status === "conflict"
            ? resolution.candidates.map((_, at) => ({
                command: "office.confirm" as const,
                cli: `${CONFIRM_COMMAND} pick ${name} ${at + 1}`,
              }))
            : []),
          { command: "office.confirm", cli: `${CONFIRM_COMMAND} set ${name} -- <command>` },
          ...(name === "dev"
            ? [{ command: "office.confirm" as const, cli: `${CONFIRM_COMMAND} nothing-to-start` }]
            : []),
        ],
      });
    }
    if (pending !== null) {
      items.push({
        kind: "PROFILE",
        detail: `${name} · proposed ${shownSpec(pending.spec)} · confidence low · ${pending.evidence.join("; ")}`,
        since: pending.proposedAt,
        actions: [
          { command: "office.confirm", cli: `${CONFIRM_COMMAND} accept ${name}` },
          { command: "office.confirm", cli: `${CONFIRM_COMMAND} edit ${name} -- <command>` },
          { command: "office.confirm", cli: `${CONFIRM_COMMAND} reject ${name}` },
        ],
      });
    }
    const confirmation = mark.confirmation;
    if (mark.stale && confirmation !== null) {
      items.push({
        kind: "PROFILE",
        detail: `${name} · confirmed ${shownSpec(confirmation.spec)} is stale: the repository's run inputs changed since; it keeps working until confirmed again`,
        since: confirmation.confirmedAt,
        actions: [
          { command: "office.confirm", cli: `${CONFIRM_COMMAND} keep ${name}` },
          { command: "office.confirm", cli: `${CONFIRM_COMMAND} set ${name} -- <command>` },
        ],
      });
    }
  }
  return items;
}
