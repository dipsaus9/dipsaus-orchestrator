// Stored review verdicts (0019 sections 5, 6 and 16). Each verdict is one review gate: a `gates`
// row of kind `review` with its rule decision in `gate_decisions` (approved, or rejected for a
// blocked verdict; its content hash is the code tree key), and one `review_verdicts` row with the
// round, the reviewed commit, the code tree key, the judged criteria and findings, the validation
// notes, the comment URL, the commit an approval was carried from and any maintainer override. A
// verdict holds for every commit with the same code tree key, so the engine reads it back by run
// and code tree key and never reviews a tree that has one (section 6). Writes run inside the
// caller's transaction.

import type {
  GateId,
  IdSource,
  ReviewCriterionResult,
  ReviewFinding,
  ReviewSummary,
  ReviewVerdict,
  RunId,
  StoryKey,
} from "@dipsaus-orchestrator/contract";

import type { NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { readUsage } from "../ingest/usage";
import { REVIEWER_ROLE } from "../run/caps";

import { findingCounts, type JudgedReview, type ReviewDecision } from "./verdict";

/** What a review round's verdict is stored with. */
export interface NewReviewVerdict {
  readonly runId: RunId;
  readonly key: StoryKey;
  readonly round: number;
  /** The reviewer agent whose report was judged; null for an approval carried to a new head. */
  readonly agent: string | null;
  readonly model: string;
  /** The reviewed commit, and its code tree key (0010). */
  readonly commit: string;
  readonly codeTreeKey: string;
  readonly judged: JudgedReview;
  /** The approved head this approval was carried from (section 6); absent for a reviewed head. */
  readonly carriedFrom?: string | null;
  readonly at: number;
}

/** A stored verdict. */
export interface StoredReviewVerdict {
  readonly gate: GateId;
  readonly runId: RunId;
  readonly key: StoryKey;
  readonly round: number;
  readonly agent: string | null;
  readonly model: string;
  readonly commit: string;
  readonly codeTreeKey: string;
  readonly verdict: ReviewDecision;
  readonly criteria: readonly ReviewCriterionResult[];
  readonly findings: readonly ReviewFinding[];
  readonly summary: string;
  readonly notes: readonly string[];
  readonly commentUrl: string | null;
  readonly carriedFrom: string | null;
  readonly override: { readonly note: string; readonly at: number } | null;
  readonly decidedAt: number;
}

interface VerdictRow {
  gate_id: string;
  run_id: string;
  key: string;
  round: number;
  agent_id: string | null;
  model: string;
  commit_sha: string;
  code_tree_key: string;
  verdict: ReviewDecision;
  criteria: string;
  findings: string;
  summary: string;
  validation_notes: string;
  comment_url: string | null;
  carried_from: string | null;
  override_note: string | null;
  override_at: number | null;
  decided_at: number;
}

const COLUMNS = `gate_id, run_id, key, round, agent_id, model, commit_sha, code_tree_key, verdict,
  criteria, findings, summary, validation_notes, comment_url, carried_from, override_note,
  override_at, decided_at`;

function toRecord(row: VerdictRow): StoredReviewVerdict {
  return {
    gate: row.gate_id as GateId,
    runId: row.run_id as RunId,
    key: row.key as StoryKey,
    round: row.round,
    agent: row.agent_id,
    model: row.model,
    commit: row.commit_sha,
    codeTreeKey: row.code_tree_key,
    verdict: row.verdict,
    criteria: JSON.parse(row.criteria) as ReviewCriterionResult[],
    findings: JSON.parse(row.findings) as ReviewFinding[],
    summary: row.summary,
    notes: JSON.parse(row.validation_notes) as string[],
    commentUrl: row.comment_url,
    carriedFrom: row.carried_from,
    override:
      row.override_note === null || row.override_at === null
        ? null
        : { note: row.override_note, at: row.override_at },
    decidedAt: row.decided_at,
  };
}

/** The gate's rule results: the unmet criteria and the blocking findings, each failing its rule. */
function ruleResults(judged: JudgedReview): unknown[] {
  const unmet = judged.criteria
    .filter((entry) => entry.status === "unmet")
    .map((entry) => `criterion #${entry.n} unmet: ${entry.evidence.trim()}`);
  const blocking = judged.findings
    .filter((finding) => finding.severity === "blocking")
    .map((finding) => {
      const where =
        finding.file === undefined
          ? finding.testEntry === undefined
            ? ""
            : ` (test-plan entry #${finding.testEntry})`
          : ` at ${finding.file}${finding.line === undefined ? "" : `:${finding.line}`}`;
      return `blocking ${finding.kind}${where}: ${finding.text.trim()}`;
    });
  return [
    { rule: "criteria", passed: unmet.length === 0, messages: unmet },
    { rule: "findings", passed: blocking.length === 0, messages: blocking },
  ];
}

function gateSummary(judged: JudgedReview): string {
  const { blocking, advisory } = findingCounts(judged.findings);
  return `${judged.verdict}: ${blocking} blocking, ${advisory} advisory`;
}

/**
 * Writes the verdict as a review gate decided by rule and its `review_verdicts` row; call it
 * inside an immediate transaction.
 */
export function recordReviewVerdict(
  office: OfficeHandle,
  ids: IdSource,
  verdict: NewReviewVerdict,
): StoredReviewVerdict {
  const gate = ids.next("gat") as GateId;
  const { judged, at } = verdict;
  office.run(
    `insert into gates (office_id, gate_id, kind, key, run_id, opened_at, waiting_on, summary)
     values ($office_id, $gate, 'review', $key, $run, $at, null, $summary)`,
    { gate, key: verdict.key, run: verdict.runId, at, summary: gateSummary(judged) },
  );
  office.run(
    `insert into gate_decisions
       (office_id, gate_id, decision, decided_by, note, rule_results, content_hash, decided_at)
     values ($office_id, $gate, $decision, 'rule', null, $results, $hash, $at)`,
    {
      gate,
      decision: judged.verdict === "approved" ? "approved" : "rejected",
      results: JSON.stringify(ruleResults(judged)),
      hash: verdict.codeTreeKey,
      at,
    },
  );
  office.run(
    `insert into review_verdicts (office_id, ${COLUMNS})
     values ($office_id, $gate, $run, $key, $round, $agent, $model, $commit, $tree, $verdict,
       $criteria, $findings, $summary, $notes, null, $carried, null, null, $at)`,
    {
      gate,
      run: verdict.runId,
      key: verdict.key,
      round: verdict.round,
      agent: verdict.agent,
      model: verdict.model,
      commit: verdict.commit,
      tree: verdict.codeTreeKey,
      verdict: judged.verdict,
      criteria: JSON.stringify(judged.criteria),
      findings: JSON.stringify(judged.findings),
      summary: judged.summary,
      notes: JSON.stringify(judged.notes),
      carried: verdict.carriedFrom ?? null,
      at,
    },
  );
  const stored = reviewVerdictOfGate(office, gate);
  if (stored === null) throw new Error(`review verdict ${gate} vanished inside its write`);
  return stored;
}

/** The verdict of the review gate `gate`, or null when it has none. */
export function reviewVerdictOfGate(
  office: OfficeHandle,
  gate: GateId,
): StoredReviewVerdict | null {
  const row = office.get<VerdictRow>(
    `select ${COLUMNS} from review_verdicts where office_id = $office_id and gate_id = $gate`,
    { gate },
  );
  return row === null ? null : toRecord(row);
}

/**
 * The latest verdict of the run `runId` (one run per claim) on the code tree `codeTreeKey`, or
 * null when that tree has none: the engine never starts a review of a tree that has one.
 */
export function reviewVerdictForTree(
  office: OfficeHandle,
  runId: RunId,
  codeTreeKey: string,
): StoredReviewVerdict | null {
  const row = office.get<VerdictRow>(
    `select ${COLUMNS} from review_verdicts
      where office_id = $office_id and run_id = $run and code_tree_key = $tree
      order by decided_at desc, rowid desc limit 1`,
    { run: runId, tree: codeTreeKey },
  );
  return row === null ? null : toRecord(row);
}

/** Every verdict of the story `key`, oldest first. */
export function reviewVerdictsOf(office: OfficeHandle, key: StoryKey): StoredReviewVerdict[] {
  return office
    .all<VerdictRow>(
      `select ${COLUMNS} from review_verdicts where office_id = $office_id and key = $key
        order by decided_at, rowid`,
      { key },
    )
    .map(toRecord);
}

/** Stores the URL of the PR comment posted for the verdict (section 3). */
export function recordReviewCommentUrl(office: OfficeHandle, gate: GateId, url: string): void {
  office.run(
    `update review_verdicts set comment_url = $url where office_id = $office_id and gate_id = $gate`,
    { gate, url },
  );
}

/** Marks the verdict overridden by the maintainer, with the required note (section 11). */
export function recordReviewOverride(
  office: OfficeHandle,
  gate: GateId,
  override: { readonly note: string; readonly at: number },
): void {
  office.run(
    `update review_verdicts set override_note = $note, override_at = $at
      where office_id = $office_id and gate_id = $gate`,
    { gate, note: override.note, at: override.at },
  );
}

/**
 * The verdict as `story.detail` shows it (`Verdict.review`, section 14): the reviewer agent's
 * usage, zero for a carried approval or an agent retention removed.
 */
export function reviewVerdictView(
  office: OfficeHandle,
  stored: StoredReviewVerdict,
): ReviewVerdict {
  const usage = readUsage(office, {
    run: stored.runId,
    agent: stored.agent ?? "",
    role: REVIEWER_ROLE,
    tier: "",
    budgetLimit: 0,
  }).agent;
  return {
    round: stored.round,
    commit: stored.commit,
    codeTreeKey: stored.codeTreeKey,
    verdict: stored.verdict,
    criteria: [...stored.criteria],
    findings: [...stored.findings],
    summary: stored.summary,
    model: stored.model,
    usage,
    ...(stored.commentUrl === null ? {} : { commentUrl: stored.commentUrl }),
    ...(stored.carriedFrom === null ? {} : { carried: true }),
    ...(stored.override === null
      ? {}
      : {
          override: { note: stored.override.note, at: new Date(stored.override.at).toISOString() },
        }),
  };
}

/** The review summary of the verdict's `gate.decided` event (section 14). */
export function reviewSummary(stored: StoredReviewVerdict): ReviewSummary {
  return {
    round: stored.round,
    commit: stored.commit,
    verdict: stored.verdict,
    ...findingCounts(stored.findings),
    ...(stored.commentUrl === null ? {} : { commentUrl: stored.commentUrl }),
  };
}

/** The `gate.decided` entry of a stored verdict, for the caller's change log commit. */
export function reviewDecidedEntry(stored: StoredReviewVerdict): NewEntry {
  return {
    type: "gate.decided",
    key: stored.key,
    run: stored.runId,
    delta: {
      gate: stored.gate,
      decision: stored.verdict === "approved" ? "approved" : "rejected",
      by: "rule",
      review: reviewSummary(stored),
    },
  };
}
