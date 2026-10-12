// The `dipo` field block of a story description (0010 section 3; 0012 F10, F14, F15, F16). The
// engine parses the block's YAML and validates it with this schema; a failure is Ready gate rule
// R02. Unknown keys fail, and every text value must be a YAML string, so `answer: 5173` fails.
// The schema checks shape only: presence and content rules (R15, R18, R20) belong to the gate.

import { z } from "zod";

import { Lifecycle, ParkReason } from "./work";

const QUOTE = "expected a string: quote this value";

// A text value. A number, boolean or date that YAML read unquoted fails with a hint.
const Text = z.string({ error: QUOTE });

// R18 without the story id, which the schema does not know: `<ID>/<slug>`, slug at most 40.
const Branch = Text.regex(
  /^[A-Za-z][A-Za-z0-9]*-[0-9]+(\.[0-9]+)*\/[a-z0-9]+(-[a-z0-9]+)*$/,
  "branch must be <ID>/<slug> with a lowercase hyphenated slug",
).refine((branch) => branch.slice(branch.indexOf("/") + 1).length <= 40, {
  message: "branch slug is longer than 40 characters",
});

export const FieldBlockUnknown = z.strictObject({
  q: Text,
  status: z.enum(["open", "resolved"]),
  answer: Text.optional(),
});
export type FieldBlockUnknown = z.infer<typeof FieldBlockUnknown>;

export const TestPlanEntry = z.strictObject({
  kind: z.enum(["automated", "manual"]),
  check: Text,
  expect: Text.optional(),
});
export type TestPlanEntry = z.infer<typeof TestPlanEntry>;

// Exactly one of `entries` or `not_applicable` with a reason.
export const TestPlan = z
  .strictObject({
    entries: z.array(TestPlanEntry).optional(),
    not_applicable: Text.optional(),
  })
  .refine((plan) => (plan.entries === undefined) !== (plan.not_applicable === undefined), {
    message: "test_plan needs exactly one of entries or not_applicable",
  });
export type TestPlan = z.infer<typeof TestPlan>;

// Only while Parked.
export const FieldBlockPark = z.strictObject({
  reason: Text.pipe(ParkReason),
  from: Lifecycle,
  note: Text,
});
export type FieldBlockPark = z.infer<typeof FieldBlockPark>;

// Every key is optional here: a draft may have none. The gate decides which are required.
export const FieldBlock = z.strictObject({
  branch: Branch.optional(),
  unknowns: z.array(FieldBlockUnknown).optional(),
  test_plan: TestPlan.optional(),
  park: FieldBlockPark.optional(),
});
export type FieldBlock = z.infer<typeof FieldBlock>;
