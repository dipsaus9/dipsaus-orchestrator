// Stored Ready gate decisions (0007 section 4, 0012 section 3). A rule-decided Ready gate is one
// `gates` row of kind `ready` or `pickup` (the mode) and its one `gate_decisions` row: approved
// when every rule passed, rejected otherwise, with every rule result and the story content hash.
// The writes here run inside the caller's transaction.

import type { GateId, IdSource, StoryKey } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../../db/office";
import { GATE_RULES, type GateMode, type GateResult, type GateRule } from "../types";

/**
 * One rule's result as stored: passed, or failed with every message it gave. A rule that only
 * warns (R29) always passed, with its warnings, when it gave any (DIPO-251).
 */
export interface RuleResult {
  readonly rule: GateRule;
  readonly passed: boolean;
  readonly messages: readonly string[];
  readonly warnings?: readonly string[];
}

/** A stored Ready gate decision. */
export interface GateDecisionRecord {
  readonly gate: GateId;
  readonly key: StoryKey;
  readonly mode: GateMode;
  readonly passed: boolean;
  readonly ruleResults: readonly RuleResult[];
  readonly contentHash: string;
  readonly decidedAt: number;
}

/** The rules a mode evaluates, by name, in the order `rulesFor(mode)` runs them. */
export function ruleNamesFor(mode: GateMode): GateRule[] {
  const shared = GATE_RULES.filter((rule) => rule !== "R01a" && rule !== "R01b");
  return [mode === "ready" ? "R01a" : "R01b", ...shared];
}

/** Every rule of the result's mode with its failures and warnings; a rule with no failure passed. */
export function ruleResults(result: GateResult): RuleResult[] {
  return ruleNamesFor(result.mode).map((rule) => {
    const messages = result.failures
      .filter((failure) => failure.rule === rule)
      .map((failure) => failure.message);
    const warnings = (result.warnings ?? [])
      .filter((warning) => warning.rule === rule)
      .map((warning) => warning.message);
    return {
      rule,
      passed: messages.length === 0,
      messages,
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  });
}

export interface StoreDecision {
  readonly key: StoryKey;
  readonly result: GateResult;
  readonly contentHash: string;
  readonly at: number;
}

/** Writes the gate and its rule decision; call it inside an immediate transaction. */
export function storeGateDecision(
  office: OfficeHandle,
  ids: IdSource,
  decision: StoreDecision,
): GateDecisionRecord {
  const gate = ids.next("gat") as GateId;
  const { result, key, contentHash, at } = decision;
  const failed = result.failures.length;
  office.run(
    `insert into gates (office_id, gate_id, kind, key, run_id, opened_at, waiting_on, summary)
     values ($office_id, $gate, $kind, $key, null, $at, null, $summary)`,
    {
      gate,
      kind: result.mode,
      key,
      at,
      summary: result.passed ? "passed" : `${failed} ${failed === 1 ? "failure" : "failures"}`,
    },
  );
  const results = ruleResults(result);
  office.run(
    `insert into gate_decisions
       (office_id, gate_id, decision, decided_by, note, rule_results, content_hash, decided_at)
     values ($office_id, $gate, $decision, 'rule', null, $results, $hash, $at)`,
    {
      gate,
      decision: result.passed ? "approved" : "rejected",
      results: JSON.stringify(results),
      hash: contentHash,
      at,
    },
  );
  return {
    gate,
    key,
    mode: result.mode,
    passed: result.passed,
    ruleResults: results,
    contentHash,
    decidedAt: at,
  };
}

interface DecisionRow {
  gate_id: string;
  key: string;
  kind: string;
  decision: string;
  rule_results: string;
  content_hash: string;
  decided_at: number;
}

const READY_KINDS = "('ready', 'pickup')";

function recordOf(row: DecisionRow): GateDecisionRecord {
  return {
    gate: row.gate_id as GateId,
    key: row.key as StoryKey,
    mode: row.kind as GateMode,
    passed: row.decision === "approved",
    ruleResults: JSON.parse(row.rule_results) as RuleResult[],
    contentHash: row.content_hash,
    decidedAt: row.decided_at,
  };
}

/**
 * The latest passing Ready gate decision (either mode) for the story `key` with exactly this
 * content hash, or undefined when there is none.
 */
export function findPassingDecision(
  office: OfficeHandle,
  key: StoryKey,
  contentHash: string,
): GateDecisionRecord | undefined {
  const row = office.get<DecisionRow>(
    `select g.gate_id, g.key, g.kind, d.decision, d.rule_results, d.content_hash, d.decided_at
       from gate_decisions d
       join gates g on g.office_id = d.office_id and g.gate_id = d.gate_id
      where d.office_id = $office_id and g.key = $key and g.kind in ${READY_KINDS}
        and d.content_hash = $hash and d.decision = 'approved'
      order by d.decided_at desc, d.rowid desc
      limit 1`,
    { key, hash: contentHash },
  );
  return row === null ? undefined : recordOf(row);
}

/** Every Ready gate decision of `key`, oldest first. */
export function gateDecisionsOf(office: OfficeHandle, key: StoryKey): GateDecisionRecord[] {
  return office
    .all<DecisionRow>(
      `select g.gate_id, g.key, g.kind, d.decision, d.rule_results, d.content_hash, d.decided_at
         from gate_decisions d
         join gates g on g.office_id = d.office_id and g.gate_id = d.gate_id
        where d.office_id = $office_id and g.key = $key and g.kind in ${READY_KINDS}
        order by d.decided_at, d.rowid`,
      { key },
    )
    .map(recordOf);
}
