// The story reader Enter opens from a desk row (0009, 0002, DIPO-308, DIPO-462; screens/04): the
// story's title and state, five sections (Story, Criteria, Reviews, Runs, Diff) and the section's
// text at an 84-column measure, centred, wrapped and never truncated. Reviews shows the newest
// round open and the earlier ones folded to one line (Enter opens the next one, again folds them);
// the Diff section reads `story.diff` when it is first shown. A proposed story's card (DIPO-454)
// is the desk item's proposed user story in full, its lines wrapped. Esc returns to the desk with
// the same row selected.
//
// A quote the engine checked against the commit is shown as it is; a finding whose evidence failed
// that check says `unverified` (0002).

import {
  type DeskIdea,
  type DeskItem,
  type EngineError,
  type ReviewFinding,
  type ReviewVerdict,
  ideaOriginWords,
  proposedStoryLines,
  type RunRecord,
  type StoryView,
  type Verdict,
} from "@dipsaus-orchestrator/contract";
import { Box } from "ink";

import { age, wrapWords } from "./format";
import type { Display } from "./options";
import { parkWords } from "./desk";
import { fitLine, type Seg, type SegLine, SegRow, seg, spread } from "./segments";
import { clockTime, glyphs } from "./views";

/** The measure of the reader's text, and its widest line. */
export const READER_MEASURE = 84;

export const SECTIONS = ["Story", "Criteria", "Reviews", "Runs", "Diff"] as const;
export type Section = (typeof SECTIONS)[number];

/** What `story.detail` answered for the card, as far as it shows it. */
export type CardOutcome =
  | {
      readonly ok: true;
      readonly view: StoryView;
      readonly verdicts: readonly Verdict[];
      readonly runs: readonly RunRecord[];
    }
  | { readonly ok: false; readonly error: EngineError };

/** What `story.diff` answered for the Diff section. */
export type DiffOutcome =
  | {
      readonly ok: true;
      readonly result: {
        readonly branch: string | null;
        readonly base?: string | undefined;
        readonly diff: string;
        readonly truncated: boolean;
        readonly unavailable?: string | undefined;
      };
    }
  | { readonly ok: false; readonly error: EngineError };

type ReviewedVerdict = Verdict & { review: ReviewVerdict };

/** The review rounds, newest first. */
export function reviewRounds(verdicts: readonly Verdict[]): ReviewedVerdict[] {
  return verdicts
    .filter((verdict): verdict is ReviewedVerdict => verdict.review !== undefined)
    .toSorted((a, b) => b.review.round - a.review.round);
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

/** `text` wrapped to the room left after `lead`, whose width the later lines are indented by. */
function hanging(lead: SegLine, width: number, text: string, role?: Seg["role"]): SegLine[] {
  const indent = lead.reduce((sum, piece) => sum + piece.text.length, 0);
  const rows = wrapWords(text, Math.max(10, width - indent));
  return rows.map((row, i): SegLine => [
    ...(i === 0 ? lead : [seg(" ".repeat(indent))]),
    seg(row, role),
  ]);
}

const BLANK: SegLine = [seg("")];

/** The criteria results of a round: one wrapped line each, with the mark of its status. */
function criteriaLines(review: ReviewVerdict, ascii: boolean): SegLine[] {
  const out: SegLine[] = [];
  for (const result of review.criteria) {
    const met = result.status === "met";
    const mark = met ? (ascii ? "+" : "✓") : result.status === "unmet" ? (ascii ? "x" : "✗") : "?";
    const role = met ? "ok" : result.status === "unmet" ? "err" : "acc";
    out.push(
      ...hanging(
        [seg(`${mark} ${result.n}  `, role)],
        READER_MEASURE,
        result.evidence.trim() === "" ? result.status : result.evidence,
      ),
    );
  }
  return out;
}

/** The findings of a round, each wrapped with its quote under it. */
function findingLines(review: ReviewVerdict, ascii: boolean): SegLine[] {
  const out: SegLine[] = [];
  const bar = ascii ? "|" : "│";
  for (const finding of review.findings) {
    const place = findingPlace(finding);
    const role = finding.severity === "blocking" ? "err" : "acc";
    out.push(BLANK, [
      seg("!    ", role),
      seg(`${finding.severity} · ${finding.kind}`, role),
      seg(
        `${place === "" ? "" : ` · ${place}`}${finding.unverified === true ? " · unverified" : ""}`,
        "dim",
      ),
    ]);
    out.push(...hanging([seg("     ")], READER_MEASURE, finding.text));
    if (finding.quote !== undefined) {
      for (const row of wrapWords(finding.quote, READER_MEASURE - 8)) {
        out.push([seg("     "), seg(bar, "faint"), seg("  "), seg(row, "dim")]);
      }
    }
  }
  return out;
}

/** The one line a folded round shows: round, commit, time, what it found and its verdict. */
function foldedLine(round: ReviewedVerdict, open: boolean, ascii: boolean): SegLine {
  const { review } = round;
  const met = review.criteria.filter((result) => result.status === "met").length;
  const blocking = review.findings.filter((finding) => finding.severity === "blocking").length;
  const advisory = review.findings.length - blocking;
  const counts = [
    review.criteria.length === 0 ? null : `${met}/${review.criteria.length} met`,
    blocking === 0 ? null : `${blocking} blocking`,
    advisory === 0 ? null : `${advisory} advisory`,
  ].filter((part) => part !== null);
  return spread(
    [
      seg(open ? (ascii ? "v " : "▾ ") : ascii ? "> " : "▸ ", "dim"),
      seg(`ROUND ${review.round}`, "hi", true),
      seg(
        ` · ${review.commit.slice(0, 7)} · ${clockTime(Date.parse(round.at))}${counts.length === 0 ? "" : ` · ${counts.join(" · ")}`}`,
        "dim",
      ),
    ],
    [seg(review.verdict, review.verdict === "approved" ? "ok" : "err")],
    READER_MEASURE,
  );
}

/** One round, open: its header, criteria, findings, override and comment. */
function roundLines(round: ReviewedVerdict, ascii: boolean, header: boolean): SegLine[] {
  const { review } = round;
  const out: SegLine[] = [
    ...(header
      ? [
          spread(
            [
              seg(`ROUND ${review.round}`, "hi", true),
              seg(` · ${review.commit.slice(0, 7)} · ${clockTime(Date.parse(round.at))}`, "dim"),
            ],
            [seg(review.verdict, review.verdict === "approved" ? "ok" : "err")],
            READER_MEASURE,
          ),
          BLANK,
        ]
      : [BLANK]),
    ...criteriaLines(review, ascii),
    ...findingLines(review, ascii),
  ];
  if (review.findings.length === 0) out.push(BLANK, [seg("no findings", "dim")]);
  if (review.override !== undefined) {
    out.push(
      BLANK,
      ...hanging(
        [seg(`overridden by you ${clockTime(Date.parse(review.override.at))}: `, "dim")],
        READER_MEASURE,
        JSON.stringify(review.override.note),
      ),
    );
  }
  if (review.commentUrl !== undefined) {
    out.push(BLANK, [seg("o", "acc"), seg(" open comment on GitHub", "dim")]);
  }
  return out;
}

/**
 * The Reviews section: the newest round open, the others folded to one line, newest first; the
 * rounds in `open` are open too.
 */
export function reviewLines(
  verdicts: readonly Verdict[],
  open: readonly number[],
  ascii: boolean,
): SegLine[] {
  const rounds = reviewRounds(verdicts);
  if (rounds.length === 0) return [[seg("No review verdicts yet.", "dim")]];
  const rule: SegLine = [seg("─".repeat(READER_MEASURE), "faint")];
  const out: SegLine[] = [];
  rounds.forEach((round, index) => {
    if (index > 0) out.push(rule);
    const shown = index === 0 || open.includes(round.review.round);
    if (index === 0) out.push(...roundLines(round, ascii, true));
    else if (shown) out.push(foldedLine(round, true, ascii), ...roundLines(round, ascii, false));
    else out.push(foldedLine(round, false, ascii));
  });
  return out;
}

/** The rounds a press of Enter shows: the next folded round, and none once all are open. */
export function nextOpen(verdicts: readonly Verdict[], open: readonly number[]): number[] {
  const folded = reviewRounds(verdicts)
    .slice(1)
    .filter((round) => !open.includes(round.review.round));
  const next = folded[0];
  return next === undefined ? [] : [...open, next.review.round];
}

/** The Criteria section: the newest round's results. */
function criteriaSection(verdicts: readonly Verdict[], ascii: boolean): SegLine[] {
  const latest = reviewRounds(verdicts)[0];
  if (latest === undefined || latest.review.criteria.length === 0) {
    return [[seg("No criteria results yet: the story has not been reviewed.", "dim")]];
  }
  return [
    [seg(`as the review of round ${latest.review.round} judged them`, "dim")],
    BLANK,
    ...criteriaLines(latest.review, ascii),
  ];
}

/** The Runs section: each run with its role, model, times and how it ended. */
function runsSection(runs: readonly RunRecord[]): SegLine[] {
  if (runs.length === 0) return [[seg("This story has not run yet.", "dim")]];
  const out: SegLine[] = [];
  for (const run of runs) {
    const ended =
      run.endedAt === undefined ? "running" : `ended ${clockTime(Date.parse(run.endedAt))}`;
    out.push(
      ...hanging(
        [seg(`${run.role} `, "hi", true)],
        READER_MEASURE,
        `${run.model} · tier ${run.tier} · started ${clockTime(Date.parse(run.startedAt))} · ${ended}${run.outcome === undefined ? "" : ` · ${run.outcome}`}`,
        "dim",
      ),
    );
    if (run.doneReport?.notes !== undefined) {
      out.push(...hanging([seg("  ")], READER_MEASURE, run.doneReport.notes));
    }
    for (const proposal of run.doneReport?.proposals ?? []) {
      out.push(...hanging([seg("  proposal: ", "acc")], READER_MEASURE, proposal.title));
    }
    out.push(BLANK);
  }
  return out.slice(0, -1);
}

/** The Diff section: the branch's diff, painted by line, each line wrapped at the measure. */
function diffSection(diff: DiffOutcome | null, ellipsis: string): SegLine[] {
  if (diff === null) return [[seg(`reading the diff${ellipsis}`, "dim")]];
  if (!diff.ok) {
    return hanging(
      [seg("story.diff: ", "err")],
      READER_MEASURE,
      `${diff.error.code}: ${diff.error.message}`,
    );
  }
  const { result } = diff;
  if (result.diff === "") {
    return [[seg(result.unavailable ?? "The branch changes nothing against the base.", "dim")]];
  }
  const out: SegLine[] = [
    [seg(`${result.branch ?? "branch"} against ${result.base ?? "the base"}`, "dim")],
    BLANK,
  ];
  for (const line of result.diff.split("\n")) {
    const role: Seg["role"] =
      line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ")
        ? "hi"
        : line.startsWith("@@")
          ? "acc"
          : line.startsWith("+")
            ? "ok"
            : line.startsWith("-")
              ? "err"
              : "dim";
    const chars = Array.from(line);
    if (chars.length === 0) out.push(BLANK);
    for (let at = 0; at < chars.length; at += READER_MEASURE) {
      out.push([seg(chars.slice(at, at + READER_MEASURE).join(""), role)]);
    }
  }
  if (result.truncated)
    out.push(BLANK, [seg("The diff is cut here: it is longer than dipo reads.", "dim")]);
  return out;
}

/** The Story section: the park record, the PR and what the story waits on. */
function storySection(item: DeskItem, view: StoryView | null, now: number, dot: string): SegLine[] {
  const out: SegLine[] = [];
  const reason = item.reason ?? view?.parked?.reason;
  if (reason !== undefined) {
    const words = item.reason === undefined ? reason : parkWords(item);
    const since = item.reason === undefined ? (view?.parked?.since ?? item.since) : item.since;
    const detail = item.reason === undefined ? (view?.parked?.detail ?? "") : item.detail;
    out.push([
      seg("PARKED", "hi", true),
      seg(` ${dot} ${words} ${dot} ${age(now - Date.parse(since))} ago`, "dim"),
    ]);
    if (detail !== "") out.push(...hanging([seg("  ")], READER_MEASURE, detail));
  } else {
    out.push(...hanging([seg(`${item.kind}  `, "hi", true)], READER_MEASURE, item.detail));
  }
  if (item.pr !== undefined) {
    out.push(BLANK, [
      seg("PR  ", "dim"),
      seg(`#${item.pr.number} ${item.pr.state} ${dot} ${item.pr.url}`),
    ]);
  }
  if (view !== null) {
    if (view.waitingOn !== undefined && view.waitingOn.length > 0) {
      out.push(BLANK, [seg("waits on  ", "dim"), seg(view.waitingOn.join(", "))]);
    }
    for (const message of view.gateMessages ?? []) {
      out.push(...hanging([seg("gate  ", "dim")], READER_MEASURE, message));
    }
  }
  return out;
}

/** A proposed story's card (0022, DIPO-454): its title, where it came from, its story in full. */
export function ideaCardLines(idea: DeskIdea, dot: string): string[] {
  return [
    `proposed story ${dot} ${idea.title}`,
    `from ${ideaOriginWords(idea.origin)}${idea.run === undefined ? "" : ` ${dot} run ${idea.run}`}`,
    ...proposedStoryLines(idea.story),
  ];
}

export interface ReaderOptions {
  readonly item: DeskItem;
  readonly outcome: CardOutcome | null;
  readonly now: number;
  readonly display: Display;
  readonly section: Section;
  /** The earlier review rounds shown open, by round number. */
  readonly open: readonly number[];
  readonly diff: DiffOutcome | null;
}

/** The lines of the section shown, each at most `READER_MEASURE` cells wide. */
export function readerLines(options: ReaderOptions): SegLine[] {
  const { item, outcome, now, section } = options;
  const { dot, ellipsis } = glyphs(options.display.ascii);
  const ascii = options.display.ascii;
  if (item.idea !== undefined) {
    return ideaCardLines(item.idea, dot).flatMap((line): SegLine[] =>
      wrapWords(line, READER_MEASURE).map((row): SegLine => [seg(row)]),
    );
  }
  const view = outcome?.ok === true ? outcome.view : null;
  if (section === "Story") return storySection(item, view, now, dot);
  if (outcome === null) return [[seg(`reading the story${ellipsis}`, "dim")]];
  if (!outcome.ok) {
    return hanging(
      [seg("story.detail: ", "err")],
      READER_MEASURE,
      `${outcome.error.code}: ${outcome.error.message}`,
    );
  }
  if (section === "Criteria") return criteriaSection(outcome.verdicts, ascii);
  if (section === "Reviews") return reviewLines(outcome.verdicts, options.open, ascii);
  if (section === "Runs") return runsSection(outcome.runs);
  return diffSection(options.diff, ellipsis);
}

/** The tab line: the section shown in hi and underlined, the others dim, with their counts. */
function tabLine(options: ReaderOptions): SegLine {
  const { outcome, section } = options;
  const ok = outcome?.ok === true ? outcome : null;
  const counts: Record<Section, number | null> = {
    Story: null,
    Criteria: ok === null ? null : (reviewRounds(ok.verdicts)[0]?.review.criteria.length ?? 0),
    Reviews: ok === null ? null : reviewRounds(ok.verdicts).length,
    Runs: ok === null ? null : ok.runs.length,
    Diff: null,
  };
  const line: Seg[] = [];
  for (const name of SECTIONS) {
    if (line.length > 0) line.push(seg("    "));
    const text = counts[name] === null ? name : `${name} ${counts[name]}`;
    line.push(name === section ? { ...seg(text, "hi", true), underline: true } : seg(text, "dim"));
  }
  return line;
}

/** The header's lines: the title, the state, the tabs and a rule across `columns`. */
function headerLines(options: ReaderOptions, columns: number): SegLine[] {
  const { item, outcome } = options;
  const { dot, ellipsis } = glyphs(options.display.ascii);
  const view = outcome?.ok === true ? outcome.view : null;
  const title = view?.title ?? String(item.story ?? item.kind);
  const lines: SegLine[] = wrapWords(
    `${view === null ? "" : `${view.story} `}${title}`,
    columns - 2,
  ).map((row): SegLine => [seg(row, "hi", true)]);
  if (view !== null) {
    const rounds = outcome?.ok === true ? reviewRounds(outcome.verdicts).length : 0;
    const done = view.lifecycle === "Done";
    lines.push([
      seg(
        `${done ? (options.display.ascii ? "+ " : "✓ ") : ""}${view.lifecycle}`,
        done ? "ok" : "hi",
      ),
      seg(
        `${rounds === 0 ? "" : ` ${dot} ${rounds} review round${rounds === 1 ? "" : "s"}`}${outcome?.ok === true ? ` ${dot} ${outcome.runs.length} run${outcome.runs.length === 1 ? "" : "s"}` : ""}`,
        "dim",
      ),
    ]);
  } else if (outcome === null && item.idea === undefined) {
    lines.push([seg(`reading the story${ellipsis}`, "dim")]);
  }
  if (item.idea === undefined) {
    lines.push(tabLine(options), [seg("─".repeat(Math.max(0, columns - 2)), "faint")]);
  }
  return lines;
}

export function StoryCard(
  props: ReaderOptions & {
    readonly columns: number;
    readonly height: number;
    /** The first line of the section shown, for scrolling with `j` and `k`. */
    readonly top: number;
  },
) {
  const { columns, display } = props;
  const header = headerLines(props, columns);
  const body = readerLines(props);
  const room = Math.max(1, props.height - header.length);
  const top = Math.max(0, Math.min(props.top, Math.max(0, body.length - room)));
  const margin = Math.max(0, Math.floor((columns - READER_MEASURE) / 2));
  return (
    <Box flexDirection="column">
      {header.map((line, i) => (
        <Box key={`h${i}`} paddingLeft={1}>
          <SegRow line={line} display={display} />
        </Box>
      ))}
      {body.slice(top, top + room).map((line, i) => (
        <Box key={top + i} marginLeft={margin}>
          <SegRow line={fitLine(line, READER_MEASURE)} display={display} />
        </Box>
      ))}
    </Box>
  );
}
