// The reserved labels (0010 section 3; 0012 F11, F12, F13): `tier:<T>`, `role:<name>` and the flag
// `test-before-merge`. Every label follows the grammar `[a-z0-9-]+(:[A-Za-z0-9-]+)?`; a label
// outside it is reported. How many tiers or roles a story may carry (R16, R17) is the gate's rule,
// so every one found is returned.

/** The label grammar of 0010 section 3. */
export const LABEL_GRAMMAR = /^[a-z0-9-]+(:[A-Za-z0-9-]+)?$/;

export const TIER_PREFIX = "tier:";
export const ROLE_PREFIX = "role:";
export const TEST_BEFORE_MERGE = "test-before-merge";

export interface StoryLabels {
  /** The `<T>` of every `tier:<T>` label, in label order. */
  readonly tiers: readonly string[];
  /** The `<name>` of every `role:<name>` label, in label order. */
  readonly roles: readonly string[];
  readonly testBeforeMerge: boolean;
  /** Labels that follow the grammar and are not reserved. */
  readonly other: readonly string[];
  /** Labels outside the grammar; they are not read as tier, role or flag. */
  readonly invalid: readonly string[];
}

export function isValidLabel(label: string): boolean {
  return LABEL_GRAMMAR.test(label);
}

/** Reads the reserved labels from a story's label list. */
export function readLabels(labels: readonly string[]): StoryLabels {
  const tiers: string[] = [];
  const roles: string[] = [];
  const other: string[] = [];
  const invalid: string[] = [];
  let testBeforeMerge = false;
  for (const label of labels) {
    if (!isValidLabel(label)) invalid.push(label);
    else if (label.startsWith(TIER_PREFIX)) tiers.push(label.slice(TIER_PREFIX.length));
    else if (label.startsWith(ROLE_PREFIX)) roles.push(label.slice(ROLE_PREFIX.length));
    else if (label === TEST_BEFORE_MERGE) testBeforeMerge = true;
    else other.push(label);
  }
  return { tiers, roles, testBeforeMerge, other, invalid };
}
