// The Pipeline (0009, DIPO-460): the one component that draws where a story is on
// `setup ━━ build ━━ review ━━ test ━━ merge`, the engine's `KNOWN_PHASES`. Finished phases are ok,
// the current one is `● name` in acc, the phases to come are faint and dotted. Verify and CI are
// marks inside a phase (`build ✓`), never phases of their own. Every view that shows a phase
// draws it here; `--ascii` swaps `━ ┄ ● ✓ ✗` for `= . * + x`.

import { KNOWN_PHASES } from "@dipsaus-orchestrator/contract";

import type { Display } from "./options";
import { SpanLine, type Span } from "./spans";
import { glyphs } from "./views";

/** A mark inside a phase: passed or failed. */
export type Mark = "met" | "failed";

export interface PipelineSpec {
  /** The phase the story is in, the engine's word; an unknown one shows after the phases to come. */
  readonly phase: string;
  /** Marks after a phase's name, such as verify on `build` or CI on `test`. */
  readonly marks?: Readonly<Record<string, Mark>>;
  /** The phase that failed, with the check that failed in it; it replaces the current phase. */
  readonly failed?: { readonly phase: string; readonly check?: string };
  readonly ascii: boolean;
}

/** The pipeline as coloured spans, no trailing space. */
export function pipelineSpans(spec: PipelineSpec): Span[] {
  const g = glyphs(spec.ascii);
  const to = spec.ascii ? "." : "┄";
  const done = g.done.repeat(2);
  const next = to.repeat(2);
  const at = spec.failed === undefined ? spec.phase : spec.failed.phase;
  const current = (KNOWN_PHASES as readonly string[]).indexOf(at);
  if (current === -1) {
    // An unknown phase: every phase to come, then the word the engine sent.
    return [
      { text: `${next} ${KNOWN_PHASES.join(` ${next} `)}`, role: "faint" },
      { text: ` ${at}`, role: "dim" },
    ];
  }
  const mark = (phase: string) => {
    const found = spec.marks?.[phase];
    return found === undefined ? "" : ` ${found === "met" ? g.met : g.failed}`;
  };
  const spans: Span[] = [];
  const before = KNOWN_PHASES.slice(0, Math.max(0, current));
  if (before.length > 0) {
    spans.push({
      text: `${before.map((phase) => `${phase}${mark(phase)}`).join(` ${done} `)} ${done} `,
      role: "ok",
    });
  }
  const phase = KNOWN_PHASES[current];
  const after = KNOWN_PHASES.slice(current + 1);
  if (phase !== undefined) {
    if (spec.failed === undefined) {
      spans.push({ text: `${g.live} ${phase}${mark(phase)}`, role: "acc" });
    } else {
      const check = spec.failed.check === undefined ? "" : ` ${g.dot} ${spec.failed.check}`;
      spans.push({ text: `${g.failed} ${phase}${check}`, role: "err" });
    }
  }
  if (after.length > 0) {
    spans.push({ text: ` ${next} ${after.join(` ${next} `)}`, role: "faint" });
  }
  return spans;
}

export function Pipeline(
  props: PipelineSpec & {
    readonly display: Display;
    /** Plain text before the pipeline, such as a one-column margin. */
    readonly lead?: string;
  },
) {
  const { display, lead, ...spec } = props;
  const spans = pipelineSpans(spec);
  return (
    <SpanLine spans={lead === undefined ? spans : [{ text: lead }, ...spans]} display={display} />
  );
}
