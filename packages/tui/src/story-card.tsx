// The story detail Enter opens from a desk row (0009 section 4, 0019 section 14, DIPO-308): the
// story's header, its park record (reason, cause, detail and age, from the desk item the engine
// built, else from the story's view) and every review verdict `story.detail` returns, oldest
// round first: round, commit, verdict, the per-criterion results and the findings with their
// evidence, any maintainer override and the PR comment's URL. Esc returns to the desk with the
// same row selected.
//
// Evidence labels follow 0019 section 14: the per-criterion results and the findings are the
// reviewer's word (`claimed`, `*`), while the verdict computed from them and a quote the engine
// checked against the commit are `checked` (no marker). A finding whose evidence failed that check
// says `unverified`. Without the `evidence` capability the values are plain.

import type {
  DeskItem,
  EngineError,
  ReviewFinding,
  ReviewVerdict,
  StoryView,
  Verdict,
} from "@dipsaus-orchestrator/contract";
import { Box, Text } from "ink";

import { age, marked, truncate } from "./format";
import type { Display } from "./options";
import { parkWords } from "./desk";
import { clockTime, glyphs } from "./views";

/** What `story.detail` answered for the card, as far as it shows it. */
export type CardOutcome =
  | {
      readonly ok: true;
      readonly view: StoryView;
      readonly verdicts: readonly Verdict[];
    }
  | { readonly ok: false; readonly error: EngineError };

/** `*` for a claimed value when the engine reports evidence labels. */
function claimed(value: string, evidence: boolean): string {
  return marked(value, evidence ? "claimed" : undefined);
}

/** Where a finding points: `#2`, `test 1`, `src/a.ts:12`. */
function findingPlace(finding: ReviewFinding): string {
  const parts: string[] = [];
  if (finding.criterion !== undefined) parts.push(`#${finding.criterion}`);
  if (finding.testEntry !== undefined) parts.push(`test ${finding.testEntry}`);
  if (finding.file !== undefined) {
    parts.push(finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`);
  }
  return parts.join(" ");
}

/** One line of text: line breaks and control characters become single spaces. */
function oneLine(text: string): string {
  // oxlint-disable-next-line no-control-regex
  return text.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
}

/** The lines of one review round. */
export function verdictLines(
  review: ReviewVerdict,
  decided: Verdict,
  evidence: boolean,
  dot: string,
): string[] {
  const lines = [
    `round ${review.round} ${dot} ${review.commit.slice(0, 12)} ${dot} ${review.verdict}${review.carried === true ? " (carried to a later head)" : ""} ${dot} ${clockTime(Date.parse(decided.at))}`,
  ];
  if (review.criteria.length > 0) {
    lines.push(
      `  criteria: ${review.criteria
        .map((result) => `#${result.n} ${claimed(result.status, evidence)}`)
        .join("  ")}`,
    );
    for (const result of review.criteria) {
      if (result.evidence.trim() === "") continue;
      lines.push(`    #${result.n} ${claimed(oneLine(result.evidence), evidence)}`);
    }
  }
  for (const finding of review.findings) {
    const place = findingPlace(finding);
    const head = `${finding.severity} ${finding.kind}${place === "" ? "" : ` ${place}`}`;
    lines.push(`  finding ${head}: ${claimed(oneLine(finding.text), evidence)}`);
    if (finding.quote !== undefined) {
      const label = finding.unverified === true ? "unverified" : "checked";
      lines.push(`    quote (${label}): ${JSON.stringify(oneLine(finding.quote))}`);
    } else if (finding.unverified === true) {
      lines.push("    unverified");
    }
  }
  if (review.findings.length === 0) lines.push("  no findings");
  if (review.override !== undefined) {
    lines.push(
      `  overridden by you ${clockTime(Date.parse(review.override.at))}: ${JSON.stringify(oneLine(review.override.note))}`,
    );
  }
  if (review.commentUrl !== undefined) lines.push(`  comment: ${review.commentUrl}`);
  return lines;
}

/** The card's lines: header, park record, then the review rounds. */
export function cardLines(options: {
  readonly item: DeskItem;
  readonly outcome: CardOutcome | null;
  readonly now: number;
  readonly evidence: boolean;
  readonly display: Display;
}): string[] {
  const { item, outcome, now, evidence } = options;
  const { dot, ellipsis } = glyphs(options.display.ascii);
  const view = outcome?.ok === true ? outcome.view : null;
  const lines = [
    view === null
      ? `${item.story ?? item.kind}`
      : `${view.story} ${view.title} ${dot} ${view.lifecycle}`,
  ];
  // The park record: the desk item's, else the story view's.
  const reason = item.reason ?? view?.parked?.reason;
  if (reason !== undefined) {
    const words = item.reason === undefined ? reason : parkWords(item);
    const since = item.reason === undefined ? (view?.parked?.since ?? item.since) : item.since;
    const detail = item.reason === undefined ? (view?.parked?.detail ?? "") : item.detail;
    lines.push(`park: ${words} ${dot} ${age(now - Date.parse(since))} ago`);
    if (detail !== "") lines.push(`  ${detail}`);
  } else {
    lines.push(`${item.kind}: ${item.detail}`);
  }
  if (item.pr !== undefined)
    lines.push(`PR #${item.pr.number} ${item.pr.state} ${dot} ${item.pr.url}`);
  if (outcome === null) {
    lines.push(`reading the story${ellipsis}`);
    return lines;
  }
  if (!outcome.ok) {
    lines.push(`story.detail: ${outcome.error.code}: ${outcome.error.message}`);
    return lines;
  }
  const reviews = outcome.verdicts.filter(
    (verdict): verdict is Verdict & { review: ReviewVerdict } => verdict.review !== undefined,
  );
  lines.push(
    reviews.length === 0 ? "no review verdicts yet" : `review verdicts (${reviews.length})`,
  );
  for (const verdict of reviews)
    lines.push(...verdictLines(verdict.review, verdict, evidence, dot));
  return lines;
}

export function StoryCard(props: {
  readonly item: DeskItem;
  readonly outcome: CardOutcome | null;
  readonly now: number;
  readonly evidence: boolean;
  readonly display: Display;
  readonly columns: number;
  readonly height: number;
  /** The first line shown, for scrolling with `j` and `k`. */
  readonly top: number;
}) {
  const { ellipsis } = glyphs(props.display.ascii);
  const lines = cardLines(props);
  const top = Math.max(0, Math.min(props.top, Math.max(0, lines.length - props.height)));
  return (
    <Box flexDirection="column">
      {lines.slice(top, top + Math.max(1, props.height)).map((text, i) => (
        <Text key={top + i} wrap="truncate-end">
          {` ${truncate(text, props.columns - 1, ellipsis)}`}
        </Text>
      ))}
    </Box>
  );
}
