// The prompts of an action as boxes (spec.md, States; screens/11-desk-previews.txt and
// 12-states.txt): the Composer (acc border, dim label, text hi, `▍` cursor in acc) for an answer or
// a note; the top-up of a budget-exceeded resume with its caps before and after; the discard prompt,
// the only red-bordered one, with what `story.losses` says is lost, its note and the typed id; and
// the drop prompt, acc until "also delete its branch" is ticked. A yes or no is one line. The Desk
// draws the box in the focused item's preview, any other view under its body.

import type { Role } from "./colour";
import type { Flow } from "./actions";
import { shareChosen, TOP_UPS } from "./actions";
import { compactCount, wrapWords } from "./format";
import { seg, type Seg, type SegLine } from "./segments";

interface BoxGlyphs {
  readonly tl: string;
  readonly tr: string;
  readonly bl: string;
  readonly br: string;
  readonly h: string;
  readonly v: string;
  readonly cursor: string;
  readonly arrow: string;
  readonly open: string;
  readonly close: string;
  readonly cross: string;
}

function boxGlyphs(ascii: boolean): BoxGlyphs {
  return ascii
    ? {
        tl: "+",
        tr: "+",
        bl: "+",
        br: "+",
        h: "-",
        v: "|",
        cursor: "_",
        arrow: "->",
        open: "[",
        close: "]",
        cross: "x",
      }
    : {
        tl: "┌",
        tr: "┐",
        bl: "└",
        br: "┘",
        h: "─",
        v: "│",
        cursor: "▍",
        arrow: "→",
        open: "⟦",
        close: "⟧",
        cross: "✗",
      };
}

/** `rows` inside a box of `width` cells, the border in `role` on every border cell. */
export function boxed(
  rows: readonly SegLine[],
  width: number,
  role: Role,
  ascii: boolean,
): SegLine[] {
  const g = boxGlyphs(ascii);
  const inner = Math.max(1, width - 2);
  const edge = (left: string, right: string): SegLine => [
    seg(`${left}${g.h.repeat(inner)}${right}`, role),
  ];
  return [
    edge(g.tl, g.tr),
    ...rows.map((row): SegLine => {
      const cut: Seg[] = [];
      let left = inner;
      for (const piece of row) {
        const text = piece.text.slice(0, left);
        cut.push({ ...piece, text });
        left -= text.length;
      }
      return [seg(g.v, role), ...cut, seg(" ".repeat(Math.max(0, left))), seg(g.v, role)];
    }),
    edge(g.bl, g.br),
  ];
}

/** A draft's rows in hi at `width`, the cursor in acc after its last character. */
function draftRows(draft: string, width: number, indent: string, cursor: string): SegLine[] {
  const lines = draft
    .split("\n")
    .flatMap((line) => wrapWords(line, Math.max(1, width - indent.length - 1)));
  return lines.map((line, i): SegLine => [
    seg(i === 0 ? "" : indent),
    seg(line, "hi"),
    ...(i === lines.length - 1 ? [seg(cursor, "acc")] : []),
  ]);
}

/** The Composer: a dim label on the first row, then the draft. */
function composer(label: string, draft: string, width: number, ascii: boolean): SegLine[] {
  const g = boxGlyphs(ascii);
  const inner = width - 4;
  const rows: SegLine[] = [
    [seg(" "), seg(label, "dim")],
    ...draftRows(draft, inner, "", g.cursor).map((row): SegLine => [seg(" "), ...row]),
  ];
  return boxed(rows, width, "acc", ascii);
}

/** `2.0M → 3.0M tokens · 400 → 600 turns`, from the caps the engine named. */
export function capsText(flow: Flow, ascii: boolean): SegLine {
  const g = boxGlyphs(ascii);
  const dot = ascii ? "-" : "·";
  const caps = flow.caps?.details;
  if (caps === undefined || flow.caps?.share !== shareChosen(flow)) {
    return [seg("ctrl-s shows the caps before it resumes", "dim")];
  }
  return [
    seg(`${compactCount(caps.before.budgetTokens)} ${g.arrow} `),
    seg(compactCount(caps.after.budgetTokens), "hi"),
    seg(` tokens ${dot} ${caps.before.maxTurns} ${g.arrow} `),
    seg(String(caps.after.maxTurns), "hi"),
    seg(" turns"),
  ];
}

/** A field's dim label, padded to 8. */
function field(name: string): Seg {
  return seg(name.padEnd(8), "dim");
}

/** The top-up prompt (mock 4): the share, the caps before and after, the note. */
function topUp(flow: Flow, width: number, ascii: boolean): SegLine[] {
  const g = boxGlyphs(ascii);
  const chosen = shareChosen(flow);
  const choices: Seg[] = [];
  for (const share of TOP_UPS) {
    const text = ` +${share}% `;
    if (share === chosen) {
      choices.push(seg(g.open, "acc"), seg(text, "hi"), seg(g.close, "acc"));
    } else choices.push(seg(` ${text} `, "dim"));
  }
  const note = flow.field === "note";
  const draft = draftRows(flow.draft, width - 12, " ".repeat(9), note ? g.cursor : "");
  const rows: SegLine[] = [
    [seg(" "), field("top up"), ...choices, seg(flow.field === "choice" ? "  ←→" : "", "dim")],
    [seg(" "), field("caps"), ...capsText(flow, ascii)],
    [seg(" "), field("note"), ...(draft[0] ?? [])],
    ...draft.slice(1).map((row): SegLine => [seg(" "), ...row]),
  ];
  return boxed(rows, width, "acc", ascii);
}

/** What a discard or drop loses, as the prompt lists it: `Lost: 3 commits not on the base`. */
function lostRows(flow: Flow): SegLine[] {
  const commits = flow.losses ?? [];
  if (commits.length === 0)
    return [[seg("  "), seg("Lost: nothing, no commit is off the base", "dim")]];
  const many = commits.length === 1 ? "1 commit" : `${commits.length} commits`;
  return [
    [seg("  "), seg(`Lost: ${many} not on the base`, "dim")],
    ...commits.map((commit): SegLine => [
      seg("  "),
      seg(`  ${commit.sha} `, "dim"),
      seg(commit.subject),
    ]),
  ];
}

/** The typed id row: `type  DIPO-44▍   to confirm`. */
function typedRow(flow: Flow, ascii: boolean): SegLine {
  return [
    seg("  "),
    seg("type  ", "dim"),
    seg(flow.draft, "hi"),
    seg(boxGlyphs(ascii).cursor, "acc"),
    seg("   to confirm", "dim"),
  ];
}

/** The discard prompt (mock 23): red border, what is lost, the note, the typed id. */
function discard(flow: Flow, width: number, ascii: boolean): SegLine[] {
  const g = boxGlyphs(ascii);
  const story = flow.target.story ?? "the story";
  const step = flow.steps[flow.at];
  const text = wrapWords(
    "This ends the run, deletes the branch and returns the story to Refined. It can’t be undone.",
    Math.min(60, width - 6),
  );
  const rows: SegLine[] = [
    [seg("  "), seg(`${g.cross} `, "err"), seg(`Discard ${story}?`, "hi", true)],
    [],
    ...text.map((line): SegLine => [seg("  "), seg(line)]),
    [],
  ];
  if (flow.losses !== null) rows.push(...lostRows(flow), []);
  if (step?.kind === "text") {
    const draft = draftRows(flow.draft, width - 12, " ".repeat(8), g.cursor);
    rows.push([seg("  "), seg("note  ", "dim"), ...(draft[0] ?? [])]);
    rows.push(...draft.slice(1).map((row): SegLine => [seg("  "), ...row]));
  } else {
    rows.push([seg("  "), seg("note  ", "dim"), seg(flow.values.note ?? "")]);
  }
  if (step?.kind === "typed") rows.push(typedRow(flow, ascii));
  return boxed(rows, width, "err", ascii);
}

/** The drop prompt (mock 24): acc, red once the branch box is ticked and the id is asked. */
function drop(flow: Flow, width: number, ascii: boolean): SegLine[] {
  const story = flow.target.story ?? "the story";
  const remove = flow.values.deleteBranch === true;
  const role: Role = remove ? "err" : "acc";
  const commits = flow.losses?.length ?? 0;
  const kept = commits === 1 ? "keeps 1 commit" : `keeps ${commits} commits`;
  const rows: SegLine[] = [
    [seg("  "), seg("! ", role), seg(`Drop ${story} from the backlog?`, "hi", true)],
    [],
    [seg("  "), seg("Archives the story and releases its claim.")],
    [],
    [
      seg("  "),
      seg(remove ? "[x]" : "[ ]", role),
      seg(" also delete its branch "),
      seg("(space)", "dim"),
    ],
  ];
  if (!remove) rows.push([seg("  "), seg(`    ${kept} if left unticked`, "dim")]);
  else rows.push([], ...lostRows(flow));
  if (flow.steps[flow.at]?.kind === "typed") rows.push([], typedRow(flow, ascii));
  return boxed(rows, width, role, ascii);
}

/**
 * The open prompt of `flow` as rows of `width` cells, or a reading line. `context` puts what it is
 * about above a Composer (a question's text), for a prompt drawn outside the Desk's preview.
 */
export function promptRows(
  flow: Flow,
  options: { readonly width: number; readonly ascii: boolean; readonly context: boolean },
): SegLine[] {
  const { ascii } = options;
  const width = Math.max(20, options.width);
  const ellipsis = ascii ? "..." : "…";
  const step = flow.steps[flow.at];
  if (step === undefined || (flow.reading && step.kind !== "topup")) {
    return [[seg(`${flow.label}: reading what is lost${ellipsis}`, "dim")]];
  }
  const above: SegLine[] =
    options.context && flow.target.text !== undefined
      ? wrapWords(`${flow.label}: ${flow.target.text}`, width).map((line): SegLine => [seg(line)])
      : [];
  switch (step.kind) {
    case "text":
      if (flow.id === "discard") return discard(flow, width, ascii);
      return [...above, ...composer(step.label, flow.draft, width, ascii)];
    case "topup":
      return topUp(flow, width, ascii);
    case "typed":
      return flow.id === "drop" ? drop(flow, width, ascii) : discard(flow, width, ascii);
    case "drop":
      return drop(flow, width, ascii);
    case "yesno":
      return wrapWords(`${step.question} [y/N]`, width).map((line): SegLine => [seg(line)]);
    case "losses":
      return [[seg(`${flow.label}: reading what is lost${ellipsis}`, "dim")]];
  }
}
