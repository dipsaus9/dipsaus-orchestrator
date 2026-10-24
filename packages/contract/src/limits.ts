// The plan-limit holds and the maintainer's allowance (0008 section 7, DIPO-338): `office.limits`
// lists the holds the plan's limits put on new sessions and the office's allowance, and
// `limits.allow` lets the office's new sessions go on past an `allowed_warning` until a time the
// maintainer names, or ends that allowance early. Every text is built by the engine.

import { z } from "zod";

import { defineCommand, defineRead } from "./definition";
import { OfficeId } from "./ids";

const Timestamp = z.iso.datetime();

// One hold on new sessions: the limit scope (`session` is the five-hour window, `weekly`,
// `model:<family>` or `unknown`), when it ends, the plan's utilization when the adapter read it,
// and whether it came from a rejected limit (a reviewer's) rather than a warning. `allowed` is true
// when the office's allowance lets its new sessions go on past it; a rejected limit and a warning
// on the five-hour window are never allowed.
export const PlanLimitHold = z.object({
  scope: z.string(),
  until: Timestamp,
  utilization: z.number().min(0).max(1).optional(),
  rejected: z.boolean(),
  allowed: z.boolean(),
});
export type PlanLimitHold = z.infer<typeof PlanLimitHold>;

// The maintainer's allowance in force: the origin of the command that set it (`cli`, `tui`, ...),
// when, until when, and the maintainer's note.
export const PlanLimitAllowance = z.object({
  by: z.string(),
  at: Timestamp,
  until: Timestamp,
  note: z.string(),
});
export type PlanLimitAllowance = z.infer<typeof PlanLimitAllowance>;

// Since minor 1 (DIPO-338) [`limits`]: with `until` and `note`, the office's new sessions go on past
// the `allowed_warning`s in force and any that arrive until `until`, which is cut to the latest
// reset a warning in force names; with `clear`, the allowance ends now. A rejected limit and the
// five-hour window still hold. `allowance` is the allowance in force after the command, absent
// after a clear. Errors: `limits.noWarning` (no warning that an allowance lifts is in force).
export const limitsAllow = defineCommand({
  name: "limits.allow",
  level: "office",
  args: z
    .object({
      until: Timestamp.optional(),
      note: z.string().max(500).optional(),
      clear: z.literal(true).optional(),
    })
    .refine(
      (a) =>
        a.clear === true
          ? a.until === undefined && a.note === undefined
          : a.until !== undefined && a.note !== undefined && a.note.trim() !== "",
      { message: "give until and a note, or clear alone" },
    ),
  result: z.object({ allowance: PlanLimitAllowance.optional() }),
  confirm: false,
  irreversible: false,
  since: 1,
});

// Since minor 1 (DIPO-338) [`limits`]: the plan-limit holds on new sessions, latest end first, and
// the office's allowance in force. Changes nothing.
export const officeLimits = defineRead({
  name: "office.limits",
  args: z.object({ office: OfficeId }),
  result: z.object({
    holds: z.array(PlanLimitHold),
    allowance: PlanLimitAllowance.optional(),
  }),
  since: 1,
});

export const limitsCommands = [limitsAllow] as const;
export const limitsReads = [officeLimits] as const;
