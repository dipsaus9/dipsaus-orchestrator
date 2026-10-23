// The run profile's fallback and confirmation (0013 sections 4 to 6 and the amendment of 2026-10-22,
// DIPO-310): `office.infer` starts the model session that proposes what code could not resolve,
// `office.confirm` accepts, edits, rejects or sets a capability by hand, and `office.profile` lists
// the profile with its confirmations, pending proposals and deviations. The shapes of the profile
// belong to the scan (0013); every text in them is built by the engine.

import { z } from "zod";

import { defineCommand, defineRead } from "./definition";
import { OfficeId, RunId } from "./ids";

const Timestamp = z.iso.datetime();

// The capabilities of a run profile (0013 section 4). Closed: a confirm of another name is refused.
export const PROFILE_CAPABILITIES = [
  "install",
  "setup",
  "dev",
  "test",
  "lint",
  "typecheck",
  "verify",
  "build",
] as const;
export const ProfileCapability = z.enum(PROFILE_CAPABILITIES);
export type ProfileCapability = z.infer<typeof ProfileCapability>;

// Argument lists run in order without a shell. At most ten commands of at most 64 arguments.
export const ProfileCommands = z
  .array(z.array(z.string().min(1).max(1_000)).min(1).max(64))
  .min(1)
  .max(10);

// A repo-relative working directory; `.` is the root.
export const ProfileCwd = z.string().min(1).max(300);

// Since minor 1 (DIPO-310) [`scan.fallback`]: starts the fallback for the capabilities the current
// profile leaves unresolved or in conflict (0013 section 6), only when the maintainer asks, never
// on its own. `started`: its session runs now; `queued`: it starts once the office's running one
// ends (one session run per office at a time, 0019 amendment of 2026-10-22); `nothing`: code and
// the confirmations leave nothing to infer, so no model is asked. `capabilities` names what the
// request asks for. The proposals arrive as `scan.finished` with trigger `infer`; a proposal that
// fails a check is dropped with an `engine.notice`. Errors: `scan.noProfile`.
export const officeInfer = defineCommand({
  name: "office.infer",
  level: "office",
  args: z.object({}),
  result: z.object({
    infer: z.enum(["started", "queued", "nothing"]),
    capabilities: z.array(ProfileCapability),
  }),
  confirm: false,
  irreversible: false,
  since: 1,
});

// What `office.confirm` does (DIPO-310's design choice):
// - `accept`: the pending proposal becomes confirmed, source `inferred`;
// - `edit`: the proposal with the maintainer's commands, confirmed, source `maintainer`;
// - `reject`: the pending proposal is removed;
// - `set`: the maintainer's own commands, confirmed, source `maintainer`, without the model;
// - `pick`: candidate `candidate` (from 1) of a conflict, confirmed, source `maintainer`;
// - `keep`: a stale confirmation is confirmed again at the current fingerprint;
// - `nothing-to-start`: the product has nothing to start (`value` false takes the mark back).
export const ConfirmArgs = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept"), capability: ProfileCapability }),
  z.object({
    action: z.literal("edit"),
    capability: ProfileCapability,
    commands: ProfileCommands,
    cwd: ProfileCwd.optional(),
  }),
  z.object({ action: z.literal("reject"), capability: ProfileCapability }),
  z.object({
    action: z.literal("set"),
    capability: ProfileCapability,
    commands: ProfileCommands,
    cwd: ProfileCwd.optional(),
  }),
  z.object({
    action: z.literal("pick"),
    capability: ProfileCapability,
    candidate: z.int().positive(),
  }),
  z.object({ action: z.literal("keep"), capability: ProfileCapability }),
  z.object({ action: z.literal("nothing-to-start"), value: z.boolean().optional() }),
]);
export type ConfirmArgs = z.infer<typeof ConfirmArgs>;

// Since minor 1 (DIPO-310) [`scan.fallback`]: the maintainer's answer to a capability (0013 section
// 6 steps 4 and 5). It writes only the database, recomputes the `run` refusal and emits
// `scan.finished` with trigger `confirm` and the diff. `source` and `confirmed` are the
// capability's after the command; `runRefusal` is absent when `run` may start. Errors:
// `scan.noProfile`, `scan.noProposal` (accept, edit or reject without a pending proposal),
// `scan.resolvedByCode` (a capability code resolves: change the script instead), `scan.notConflict`
// and `scan.noCandidate` (pick), `scan.notConfirmed` (keep), `scan.invalidCommand` (a working
// directory outside the repository).
export const officeConfirm = defineCommand({
  name: "office.confirm",
  level: "office",
  args: ConfirmArgs,
  result: z.object({
    capability: ProfileCapability.optional(),
    source: z.string().optional(),
    confirmed: z.boolean(),
    diff: z.array(z.string()),
    runRefusal: z.string().optional(),
  }),
  confirm: false,
  irreversible: false,
  since: 1,
});

// A command list as the engine shows it, with its working directory.
const ShownCommand = z.object({
  command: z.string(),
  commands: z.array(z.array(z.string())),
  cwd: z.string(),
});

export const ProfileProposal = ShownCommand.extend({
  confidence: z.literal("low"),
  modelConfidence: z.string(),
  evidence: z.array(z.string()),
  stale: z.boolean(),
  run: RunId.optional(),
  proposedAt: Timestamp,
});
export type ProfileProposal = z.infer<typeof ProfileProposal>;

export const ProfileCandidate = ShownCommand.extend({
  n: z.int().positive(),
  source: z.string(),
  confidence: z.string(),
  evidence: z.string(),
});

// One capability of the profile: its status in the effective profile and what lies over it.
export const ProfileCapabilityView = z.object({
  name: ProfileCapability,
  status: z.enum(["resolved", "conflict", "unresolved"]),
  command: z.string().optional(),
  commands: z.array(z.array(z.string())).optional(),
  cwd: z.string().optional(),
  source: z.string().optional(),
  confidence: z.string().optional(),
  evidence: z.string().optional(),
  confirmed: z.boolean(),
  stale: z.boolean(),
  pending: ProfileProposal.optional(),
  candidates: z.array(ProfileCandidate).optional(),
  // How the repository could make a confirmation unnecessary (0013 section 6 step 6).
  fix: z.string().optional(),
  // The command lines this capability offers, built by the engine.
  cli: z.array(z.string()),
});
export type ProfileCapabilityView = z.infer<typeof ProfileCapabilityView>;

export const ProfileDeviation = z.object({
  code: z.string(),
  message: z.string(),
  conflict: z.boolean(),
  // The standard script that would remove it; absent when none does.
  fix: z.string().optional(),
});

// Since minor 1 (DIPO-310) [`scan.fallback`]: the office's current run profile. `scanned` is false
// before the first scan, with no other field but `office`, `inferring` and `capabilities` empty.
export const ProfileView = z.object({
  office: OfficeId,
  scanned: z.boolean(),
  scannedAt: Timestamp.optional(),
  commit: z.string().optional(),
  fingerprint: z.string().optional(),
  level: z.string().optional(),
  nothingToStart: z.boolean(),
  inferring: z.boolean(),
  runRefusal: z.string().optional(),
  testRefusal: z.string().optional(),
  capabilities: z.array(ProfileCapabilityView),
  deviations: z.array(ProfileDeviation),
});
export type ProfileView = z.infer<typeof ProfileView>;

export const officeProfile = defineRead({
  name: "office.profile",
  args: z.object({ office: OfficeId }),
  result: ProfileView,
  since: 1,
});

export const profileCommands = [officeInfer, officeConfirm] as const;
export const profileReads = [officeProfile] as const;
