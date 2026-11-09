// `evaluateGate`, the Ready gate as a pure function (0012). Inputs in, verdict out: it
// reads no file, process, clock, database or model, and the same input gives the same result.

import { FieldBlockError, parseFieldBlock } from "../story-store/fields/block";
import { readLabels } from "../story-store/fields/labels";
import {
  type GateContext,
  r01a,
  r01b,
  r31,
  type RuleCheck,
  SHARED_RULES,
  warningRulesFor,
} from "./rules";
import { BUILT_IN_ROSTER, type GateInput, type GateMode, type GateResult } from "./types";

/**
 * The rules a mode fails on: R01a or R01b, then R02 to R30 but R29, which only warns; R31 only at
 * pickup.
 */
export function rulesFor(mode: GateMode): readonly RuleCheck[] {
  return [mode === "ready" ? r01a : r01b, ...SHARED_RULES, ...(mode === "pickup" ? [r31] : [])];
}

function readFields(description: string): Pick<GateContext, "fields" | "fieldError"> {
  try {
    return { fields: parseFieldBlock(description).fields, fieldError: undefined };
  } catch (error) {
    if (!(error instanceof FieldBlockError)) throw error;
    const detail = error.line === undefined ? error.detail : `${error.detail} (line ${error.line})`;
    return { fields: undefined, fieldError: detail };
  }
}

/**
 * Evaluates every rule of `mode` and returns every failure and every warning (R29, R32); passes only
 * with zero failures, whatever the warnings.
 */
export function evaluateGate(input: GateInput, mode: GateMode): GateResult {
  const context: GateContext = {
    input,
    mode,
    story: input.story,
    ...readFields(input.story.description),
    labels: readLabels(input.story.labels),
    roster: input.roster ?? BUILT_IN_ROSTER,
  };
  const failures = rulesFor(mode).flatMap((rule) => rule(context));
  const warnings = warningRulesFor(mode).flatMap((rule) => rule(context));
  const waiting = input.story.waitingOn ?? [];
  return {
    mode,
    passed: failures.length === 0,
    failures,
    ...(warnings.length === 0 ? {} : { warnings }),
    ...(waiting.length === 0 ? {} : { waitingOn: waiting }),
  };
}
