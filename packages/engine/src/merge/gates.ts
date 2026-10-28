// Merge gates (0002). A merge gate is a `gates` row of kind `merge` for one PR head
// (`gates.head_sha`), opened when the review verdict holds for the head and its required checks are
// green on it (or no CI ran for it), so the maintainer only ever approves something that can merge.
// dipo turns GitHub's auto-merge on for a story PR only once its gate for the head is approved.
//
// - Waiting. The gate waits for the maintainer when the run's configuration snapshot sets
//   `mergeSlot.autoMerge` false, the story is flagged test-before-merge, the reviewer marked a
//   criterion `maintainer`, the story passed review only by a maintainer override, or a hold label
//   is on the PR (`autorelease: pending` always, which no setting removes, and every label of
//   `mergeSlot.holdLabels`). Otherwise it is decided `approved` by `rule` when it opens, and
//   recorded, so the audit trail shows every merge decision. `mergeWaits` decides this as data.
//   A gate reopened because a hold label appeared or a head dipo did not push showed up while
//   auto-merge was on waits too.
// - The release path. A PR whose diff changes a path the base's CODEOWNERS gives an owner
//   (`release-path.ts`) needs the maintainer's code owner approval, which for a PR opened with the
//   maintainer's login is the maintainer's merge on the host. Its gate waits for the maintainer and
//   is marked hand-merge only (`gates.hand_merge` `release-path`): `dipo approve` refuses it,
//   dipo never turns auto-merge on for it and never passes `--admin`, and only the hand merge
//   (below) or a reject decides it.
// - The test (DIPO-309). A flagged story waits only while no test pass is recorded for the head
//   (`testPassedFor`): a pass recorded before the gate opens keeps the flag out of its reasons, and
//   a pass on an open gate whose only reason is the flag decides it `approved` by the maintainer
//   (`decideTestedMergeGates`): the pass is the maintainer's merge decision. The gate keeps its
//   reasons by kind (`gates.waits`) for that.
// - Summary. Built by code: why the gate waits and what to do; for a flagged story the manual
//   test-plan entries and the `dipo test` line, and for any story the test recorded for the head.
//   The gate's phase is `test` for a flagged story and `merge` otherwise.
// - A head per gate. A gate holds for its own head and for a head its approval was carried to
//   (task-file commits such as the close-out); a new head after a fix round opens a new gate with a
//   new id. An open gate whose head no longer holds is decided `rejected` by rule as superseded,
//   so nothing waits on a head that is gone.
// - The override gate. A story parked `review-blocked` gets a merge gate waiting
//   for the maintainer whose summary lists the blocking findings and whose `override_of` names the
//   blocked verdict's review gate. Approving it needs a note and records the override
//   (`commands.ts`); that approval is the story's merge decision.
// - A hand merge. When the Done poll finds the story's PR merged on the host, the open gate is
//   decided `approved` by `maintainer` with the note "merged on the host".
//
// Writes run inside the caller's transaction and return the change-log entries to append.

import {
  type GateId,
  type GateView,
  type IdSource,
  type RunId,
  type StoryKey,
} from "@dipsaus-orchestrator/contract";

import { TEST_BEFORE_MERGE } from "../backlog/fields/labels";
import type { NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import type { StoredReviewVerdict } from "../review/store";
import { markPhase } from "../run/markers";
import { runProgress, workRefOf } from "../views/work";

/** The gate kind of a merge gate. */
export const MERGE_GATE_KIND = "merge";

/**
 * The release-please label: dipo never turns auto-merge on for a PR that carries it, for any PR
 * kind and in any office (0002, 0016). In code, so no setting removes it.
 */
export const AUTORELEASE_LABEL = "autorelease: pending";

/** The note of a merge gate a hand merge on the host decided (0002). */
export const HAND_MERGE_NOTE = "merged on the host";

/** `gates.hand_merge` of a gate whose PR changes the release path (DIPO-331). */
export const RELEASE_PATH_HOLD = "release-path";

/** Why only a merge on the host decides a merge gate; null for a gate dipo may merge. */
export type HandMerge = typeof RELEASE_PATH_HOLD;

/** Why a merge gate waits for the maintainer (0002). */
export type MergeWait =
  | { readonly kind: "autoMergeOff" }
  | { readonly kind: "testBeforeMerge" }
  | { readonly kind: "maintainerCriteria"; readonly criteria: readonly number[] }
  | { readonly kind: "override" }
  | { readonly kind: "holdLabel"; readonly labels: readonly string[] }
  | { readonly kind: "releasePath"; readonly paths: readonly string[] }
  /** The PR's head on GitHub is one dipo did not push (0002): only a hand merge or a discard. */
  | { readonly kind: "foreignHead"; readonly head: string };

/** Pure: the labels of `labels` that hold a PR: `autorelease: pending` and `holdLabels`. */
export function holdLabelsOn(labels: readonly string[], holdLabels: readonly string[]): string[] {
  const holding = new Set([AUTORELEASE_LABEL, ...holdLabels].map((label) => label.toLowerCase()));
  return labels.filter((label) => holding.has(label.toLowerCase()));
}

/** Pure: true when `labels` hold the release-please label. */
export function autoreleasePending(labels: readonly string[]): boolean {
  return labels.some((label) => label.toLowerCase() === AUTORELEASE_LABEL);
}

/** What `mergeWaits` decides from. */
export interface MergeWaitFacts {
  /** `mergeSlot.autoMerge` of the run's configuration snapshot. */
  readonly autoMerge: boolean;
  readonly testBeforeMerge: boolean;
  /** The verdict that holds for the head. */
  readonly verdict: Pick<StoredReviewVerdict, "criteria" | "override">;
  /** The PR's labels that hold it (`holdLabelsOn`). */
  readonly holdLabels: readonly string[];
  /** The release paths the PR's diff changes (`StoryMergeGit.releasePaths`); none by default. */
  readonly releasePaths?: readonly string[];
}

/** Pure: every reason the merge gate waits for the maintainer; none: it is decided by rule. */
export function mergeWaits(facts: MergeWaitFacts): MergeWait[] {
  const waits: MergeWait[] = [];
  if (!facts.autoMerge) waits.push({ kind: "autoMergeOff" });
  if (facts.testBeforeMerge) waits.push({ kind: "testBeforeMerge" });
  const maintainer = facts.verdict.criteria
    .filter((entry) => entry.status === "maintainer")
    .map((entry) => entry.n);
  if (maintainer.length > 0) waits.push({ kind: "maintainerCriteria", criteria: maintainer });
  if (facts.verdict.override !== null) waits.push({ kind: "override" });
  if (facts.holdLabels.length > 0) waits.push({ kind: "holdLabel", labels: facts.holdLabels });
  const release = facts.releasePaths ?? [];
  if (release.length > 0) waits.push({ kind: "releasePath", paths: release });
  return waits;
}

/** Pure: one line per reason a merge gate waits. */
export function waitLine(wait: MergeWait): string {
  switch (wait.kind) {
    case "autoMergeOff":
      return "mergeSlot.autoMerge is off for this office, so every story merge waits for the maintainer";
    case "testBeforeMerge":
      return `the story is flagged ${TEST_BEFORE_MERGE}`;
    case "maintainerCriteria":
      return `the reviewer marked criteria only the maintainer can check: ${wait.criteria.map((n) => `#${n}`).join(", ")}`;
    case "override":
      return "the story passed review only by the maintainer's override";
    case "holdLabel":
      return `the PR carries ${wait.labels.length === 1 ? "the hold label" : "the hold labels"} ${wait.labels.map((label) => `"${label}"`).join(", ")}`;
    case "releasePath":
      return `it changes the release path, which needs the maintainer's code owner approval: ${releasePathList(wait.paths)}`;
    case "foreignHead":
      return `its head on GitHub is ${wait.head.slice(0, 12)}, which dipo did not push, so dipo turned auto-merge off`;
  }
}

/** The most release paths a summary or notice names; the rest are counted. */
const RELEASE_PATHS_NAMED = 10;

/** Pure: the release paths, at most `RELEASE_PATHS_NAMED` of them, and how many more. */
export function releasePathList(paths: readonly string[]): string {
  const named = paths.slice(0, RELEASE_PATHS_NAMED).join(", ");
  const more = paths.length - RELEASE_PATHS_NAMED;
  return more > 0 ? `${named} and ${more} more` : named;
}

/** Pure: the hand-merge line of a gate summary, or null when `dipo approve` decides the gate. */
function handMergeLine(story: string, waits: readonly MergeWait[]): string | null {
  if (waits.some((wait) => wait.kind === "releasePath")) {
    return `dipo never merges a PR that changes the release path and never bypasses the code owner review: the maintainer merges it by hand on GitHub, which closes this gate. To send it back instead, reject it with \`dipo reject ${story} --note <text>\`.`;
  }
  if (waits.some((wait) => wait.kind === "foreignHead")) {
    return `dipo never merges a head it did not push: merge it by hand on GitHub, or discard the story with \`dipo discard ${story}\`.`;
  }
  const held = waits.find(
    (wait): wait is Extract<MergeWait, { kind: "holdLabel" }> => wait.kind === "holdLabel",
  );
  if (held !== undefined && autoreleasePending(held.labels)) {
    return `It carries "${AUTORELEASE_LABEL}", so dipo never merges it: merge it by hand on GitHub.`;
  }
  return null;
}

/** What a merge gate's summary names. */
export interface MergeSummaryFacts {
  readonly story: string;
  readonly pr: { readonly number: number; readonly url: string };
  readonly head: string;
  readonly waits: readonly MergeWait[];
  /** The manual test-plan entries of a flagged story (`check`, `expect` when given). */
  readonly manual?: readonly { readonly check: string; readonly expect?: string }[];
  /** The newest test recorded for the story run (DIPO-309), of any head; none when untested. */
  readonly test?: {
    readonly result: "pass" | "fail";
    readonly head: string;
    readonly note: string | null;
  } | null;
}

/** Pure: the summary line of the test recorded for the story, or null (DIPO-309). */
export function testLine(
  head: string,
  test: MergeSummaryFacts["test"],
  flagged: boolean,
): string | null {
  const at = head.slice(0, 12);
  if (test === null || test === undefined) {
    return flagged ? `No test is recorded for ${at}.` : null;
  }
  if (test.head !== head) {
    const was = `the last test, a ${test.result} at ${test.head.slice(0, 12)}, was of an earlier head`;
    return flagged
      ? `No test is recorded for ${at}, and ${was}: the new head needs a new test.`
      : `No test is recorded for ${at}; ${was}.`;
  }
  const note = test.note === null ? "" : `: ${oneLine(test.note)}`;
  return `The maintainer's test of ${at} ${test.result === "pass" ? "passed" : "failed"}${note}.`;
}

/** Pure: the code-built summary of a merge gate (0002). */
export function mergeGateSummary(facts: MergeSummaryFacts): string {
  const head = facts.head.slice(0, 12);
  if (facts.waits.length === 0) {
    const tested = testLine(facts.head, facts.test, false);
    return `${facts.story}: PR #${facts.pr.number} at ${head} passed review and its required checks; dipo commits the close-out and turns GitHub's auto-merge on.${tested === null ? "" : ` ${tested}`}`;
  }
  const lines = [
    `${facts.story}: PR #${facts.pr.number} (${facts.pr.url}) at ${head} passed review and its required checks, and its merge waits for the maintainer:`,
    ...facts.waits.map((wait) => `- ${waitLine(wait)}`),
  ];
  const flagged = facts.waits.some((wait) => wait.kind === "testBeforeMerge");
  const tested = testLine(facts.head, facts.test, flagged);
  if (tested !== null) lines.push(tested);
  if (flagged) {
    const manual = facts.manual ?? [];
    lines.push(
      manual.length === 0 ? "Manual test-plan entries: none." : "Manual test-plan entries:",
      ...manual.map(
        (entry, i) =>
          `  ${i + 1}. ${entry.check}${entry.expect === undefined ? "" : ` (expect: ${entry.expect})`}`,
      ),
      `Test the pushed head with \`dipo test ${facts.story}\`; a pass decides this gate when it waits for nothing else.`,
    );
  }
  const hand = handMergeLine(facts.story, facts.waits);
  const held = facts.waits.some((wait) => wait.kind === "holdLabel");
  lines.push(
    hand ??
      `Approve with \`dipo approve ${facts.story}\` or reject with \`dipo reject ${facts.story} --note <text>\`; a merge by hand on GitHub also closes this gate.${held ? " An approved PR still waits until its hold label is gone." : ""}`,
  );
  return lines.join("\n");
}

/** Pure: the summary of the override gate of a story parked `review-blocked`. */
export function overrideGateSummary(input: {
  readonly story: string;
  readonly verdict: Pick<StoredReviewVerdict, "commit" | "round" | "criteria" | "findings">;
  readonly failed: number;
}): string {
  const unmet = input.verdict.criteria
    .filter((entry) => entry.status === "unmet")
    .map((entry) => `- criterion #${entry.n} unmet: ${oneLine(entry.evidence)}`);
  const blocking = input.verdict.findings
    .filter((finding) => finding.severity === "blocking")
    .map((finding) => {
      const where =
        finding.file === undefined
          ? finding.testEntry === undefined
            ? ""
            : ` (test-plan entry #${finding.testEntry})`
          : ` at ${finding.file}${finding.line === undefined ? "" : `:${finding.line}`}`;
      return `- blocking ${finding.kind}${where}: ${oneLine(finding.text)}`;
    });
  return [
    `${input.story} parked review-blocked after ${input.failed} failed review round${input.failed === 1 ? "" : "s"}; round ${input.verdict.round} at ${input.verdict.commit.slice(0, 12)} blocked on:`,
    ...unmet,
    ...blocking,
    `Approve past the blocked review with \`dipo approve ${input.story} --note <why>\` (the note is required and recorded as an override); the PR then goes through its required checks and GitHub's auto-merge.`,
  ].join("\n");
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= 300 ? line : `${line.slice(0, 299)}…`;
}

// ---- records ------------------------------------------------------------------------------------

/** A stored merge gate with its decision, if any. */
export interface StoredMergeGate {
  readonly gate: GateId;
  readonly runId: RunId;
  readonly key: StoryKey;
  readonly head: string;
  readonly waitingOn: "maintainer" | "rule";
  readonly summary: string;
  /** The review gate whose blocked verdict this gate overrides; null for a plain merge gate. */
  readonly overrideOf: GateId | null;
  /** Why only a merge on the host decides it (DIPO-331); null for a gate dipo may merge. */
  readonly handMerge: HandMerge | null;
  /** The kinds of the reasons it waits for the maintainer (DIPO-309); null for an older gate. */
  readonly waits: readonly MergeWait["kind"][] | null;
  readonly openedAt: number;
  readonly decision: {
    readonly decision: "approved" | "rejected";
    readonly by: "maintainer" | "rule";
    readonly note: string | null;
    readonly at: number;
  } | null;
}

interface GateRow {
  gate_id: string;
  run_id: string;
  key: string;
  head_sha: string | null;
  waiting_on: "maintainer" | "rule";
  summary: string;
  override_of: string | null;
  hand_merge: string | null;
  waits: string | null;
  opened_at: number;
  decision: "approved" | "rejected" | null;
  decided_by: "maintainer" | "rule" | null;
  note: string | null;
  decided_at: number | null;
}

const SELECT = `select g.gate_id, g.run_id, g.key, g.head_sha, g.waiting_on, g.summary,
    g.override_of, g.hand_merge, g.waits, g.opened_at, d.decision, d.decided_by, d.note, d.decided_at
  from gates g
  left join gate_decisions d on d.office_id = g.office_id and d.gate_id = g.gate_id
  where g.office_id = $office_id and g.kind = 'merge'`;

function toGate(row: GateRow): StoredMergeGate {
  return {
    gate: row.gate_id as GateId,
    runId: row.run_id as RunId,
    key: row.key as StoryKey,
    head: row.head_sha ?? "",
    waitingOn: row.waiting_on,
    summary: row.summary,
    overrideOf: row.override_of as GateId | null,
    handMerge: row.hand_merge === RELEASE_PATH_HOLD ? RELEASE_PATH_HOLD : null,
    waits: waitKindsOf(row.waits),
    openedAt: row.opened_at,
    decision:
      row.decision === null || row.decided_by === null || row.decided_at === null
        ? null
        : { decision: row.decision, by: row.decided_by, note: row.note, at: row.decided_at },
  };
}

/** The wait kinds stored on a gate; null for a gate stored without them. */
function waitKindsOf(text: string | null): MergeWait["kind"][] | null {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((kind): kind is MergeWait["kind"] => typeof kind === "string")
      : null;
  } catch {
    return null;
  }
}

/** The merge gate `gate`, or null when there is no merge gate of that id. */
export function mergeGate(office: OfficeHandle, gate: string): StoredMergeGate | null {
  const row = office.get<GateRow>(`${SELECT} and g.gate_id = $gate`, { gate });
  return row === null ? null : toGate(row);
}

/** The run's merge gates, oldest first. */
export function mergeGatesOfRun(office: OfficeHandle, runId: RunId | string): StoredMergeGate[] {
  return office
    .all<GateRow>(`${SELECT} and g.run_id = $run order by g.opened_at, g.rowid`, { run: runId })
    .map(toGate);
}

/** The story's open merge gate that waits for the maintainer, newest first; null when none. */
export function openMaintainerMergeGate(
  office: OfficeHandle,
  key: StoryKey | string,
): StoredMergeGate | null {
  const row = office.get<GateRow>(
    `${SELECT} and g.key = $key and g.waiting_on = 'maintainer' and d.gate_id is null
      order by g.opened_at desc, g.rowid desc limit 1`,
    { key },
  );
  return row === null ? null : toGate(row);
}

/** The run's override gate for the review gate `verdictGate`, or null. */
export function overrideGateOf(
  office: OfficeHandle,
  runId: RunId | string,
  verdictGate: string,
): StoredMergeGate | null {
  const row = office.get<GateRow>(
    `${SELECT} and g.run_id = $run and g.override_of = $verdict
      order by g.opened_at desc, g.rowid desc limit 1`,
    { run: runId, verdict: verdictGate },
  );
  return row === null ? null : toGate(row);
}

/** What a merge gate opens with. */
export interface NewMergeGate {
  readonly runId: RunId;
  readonly key: StoryKey;
  readonly head: string;
  readonly waits: readonly MergeWait[];
  readonly summary: string;
  /**
   * The phase the run enters while the gate stands: `test` for a flagged story, else `merge`; none
   * for the override gate of a parked story.
   */
  readonly phase?: "test" | "merge";
  readonly overrideOf?: GateId | null;
  readonly at: number;
}

/**
 * Opens a merge gate: decided `approved` by rule at once when nothing makes it wait, else waiting
 * for the maintainer. Returns the gate and the entries: the run's phase, `gate.reached`, and
 * `gate.decided` for a rule decision.
 */
export function openMergeGate(
  office: OfficeHandle,
  ids: IdSource,
  input: NewMergeGate,
): { readonly gate: StoredMergeGate; readonly entries: NewEntry[] } {
  const gate = ids.next("gat") as GateId;
  const waitingOn = input.waits.length === 0 && input.overrideOf == null ? "rule" : "maintainer";
  const hand = input.waits.some((wait) => wait.kind === "releasePath") ? RELEASE_PATH_HOLD : null;
  office.run(
    `insert into gates (office_id, gate_id, kind, key, run_id, opened_at, waiting_on, summary,
       head_sha, override_of, hand_merge, waits)
     values ($office_id, $gate, 'merge', $key, $run, $at, $waiting, $summary, $head, $override,
       $hand, $waits)`,
    {
      hand,
      waits: JSON.stringify(input.waits.map((wait) => wait.kind)),
      gate,
      key: input.key,
      run: input.runId,
      at: input.at,
      waiting: waitingOn,
      summary: input.summary,
      head: input.head,
      override: input.overrideOf ?? null,
    },
  );
  const entries: NewEntry[] =
    input.phase === undefined ? [] : [...phaseEntries(office, input.runId, input.phase, input.at)];
  const reached = gateView(office, input.runId, {
    gate,
    waitingOn,
    summary: input.summary,
  });
  if (reached !== null) {
    entries.push({ type: "gate.reached", key: input.key, run: input.runId, delta: reached });
  }
  if (waitingOn === "rule") {
    entries.push(
      ...decideMergeGate(office, gate, {
        decision: "approved",
        by: "rule",
        note: null,
        at: input.at,
      }),
    );
  }
  const stored = mergeGate(office, gate);
  if (stored === null) throw new Error(`merge gate ${gate} vanished inside its write`);
  return { gate: stored, entries };
}

/** Decides the gate; returns its `gate.decided` entry, or none when it was decided already. */
export function decideMergeGate(
  office: OfficeHandle,
  gate: GateId | string,
  decision: {
    readonly decision: "approved" | "rejected";
    readonly by: "maintainer" | "rule";
    readonly note: string | null;
    readonly at: number;
  },
): NewEntry[] {
  const stored = mergeGate(office, gate);
  if (stored === null || stored.decision !== null) return [];
  office.run(
    `insert into gate_decisions
       (office_id, gate_id, decision, decided_by, note, rule_results, content_hash, decided_at)
     values ($office_id, $gate, $decision, $by, $note, $results, $hash, $at)`,
    {
      gate,
      decision: decision.decision,
      by: decision.by,
      note: decision.note,
      results: JSON.stringify(
        decision.by === "rule" && decision.decision === "approved"
          ? [{ rule: "merge", passed: true, messages: [] }]
          : [],
      ),
      hash: stored.head === "" ? null : stored.head,
      at: decision.at,
    },
  );
  return [
    {
      type: "gate.decided",
      key: stored.key,
      run: stored.runId,
      delta: {
        gate: stored.gate,
        decision: decision.decision,
        by: decision.by,
        ...(decision.note === null ? {} : { note: decision.note }),
      },
    },
  ];
}

/**
 * A test pass recorded for `head` (DIPO-309, 0002): each open merge gate of the story for that head
 * that waits for the maintainer only because the story is flagged test-before-merge is decided
 * `approved` by the maintainer, with the test in the note: the pass is the maintainer's merge
 * decision. A gate that waits for anything else keeps waiting. Inside the caller's transaction;
 * returns the `gate.decided` entries.
 */
export function decideTestedMergeGates(
  office: OfficeHandle,
  key: StoryKey | string,
  head: string,
  test: { readonly testId: string; readonly at: number },
): NewEntry[] {
  const open = office
    .all<GateRow>(
      `${SELECT} and g.key = $key and g.head_sha = $head and g.waiting_on = 'maintainer'
        and g.override_of is null and d.gate_id is null order by g.opened_at, g.rowid`,
      { key, head },
    )
    .map(toGate);
  return open
    .filter(
      (gate) =>
        gate.waits !== null && gate.waits.length === 1 && gate.waits[0] === "testBeforeMerge",
    )
    .flatMap((gate) =>
      decideMergeGate(office, gate.gate, {
        decision: "approved",
        by: "maintainer",
        note: `the maintainer's test ${test.testId} passed`,
        at: test.at,
      }),
    );
}

/**
 * The Done poll found the story's PR merged on the host (0002): its open merge gates are
 * decided `approved` by the maintainer with the note "merged on the host". Inside the caller's
 * transaction; returns the `gate.decided` entries.
 */
export function decideOnHandMerge(
  office: OfficeHandle,
  key: StoryKey | string,
  at: number,
): NewEntry[] {
  const open = office.all<{ gate_id: string }>(
    `select g.gate_id from gates g where g.office_id = $office_id and g.key = $key
       and g.kind = 'merge'
       and not exists (select 1 from gate_decisions d
         where d.office_id = g.office_id and d.gate_id = g.gate_id)
     order by g.opened_at, g.rowid`,
    { key },
  );
  return open.flatMap((row) =>
    decideMergeGate(office, row.gate_id, {
      decision: "approved",
      by: "maintainer",
      note: HAND_MERGE_NOTE,
      at,
    }),
  );
}

/** The `GateView` of a gate of the run, or null when the run has no agent to name. */
function gateView(
  office: OfficeHandle,
  runId: RunId,
  gate: {
    readonly gate: GateId;
    readonly waitingOn: "maintainer" | "rule";
    readonly summary: string;
  },
): GateView | null {
  const work = workRefOf(office, runId);
  if (work === null) return null;
  return {
    gate: gate.gate,
    work,
    kind: MERGE_GATE_KIND,
    waitingOn: gate.waitingOn,
    summary: gate.summary,
  };
}

/** The run's phase step and its `work.phase`, when the run is in another phase now. */
function phaseEntries(
  office: OfficeHandle,
  runId: RunId,
  phase: "test" | "merge",
  at: number,
): NewEntry[] {
  const last = office.get<{ value: string }>(
    `select value from run_steps where office_id = $office_id and run_id = $run and kind = 'phase'
      order by step desc limit 1`,
    { run: runId },
  );
  if (last?.value === phase) return [];
  const markers = markPhase(office, runId, phase, at);
  const work = workRefOf(office, runId);
  const progress = runProgress(office, runId);
  return work === null || progress === null
    ? markers
    : [
        ...markers,
        { type: "work.phase", key: work.key, run: runId, delta: { work, phase, progress } },
      ];
}

/** Pure: true when the story's labels flag it test-before-merge (0002, 0012). */
export function flaggedTestBeforeMerge(labels: unknown): boolean {
  return Array.isArray(labels) && labels.includes(TEST_BEFORE_MERGE);
}

/** The story's labels as the mirror holds them, for the test-before-merge flag. */
export function mirrorFlagged(office: OfficeHandle, key: StoryKey | string): boolean {
  const row = office.get<{ labels: string }>(
    "select labels from backlog_mirror where office_id = $office_id and key = $key",
    { key },
  );
  if (row === null) return false;
  try {
    return flaggedTestBeforeMerge(JSON.parse(row.labels) as unknown);
  } catch {
    return false;
  }
}
