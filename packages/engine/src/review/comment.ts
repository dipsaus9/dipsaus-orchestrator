// The PR comment of a review round (0019 section 3, DIPO-152), built by code from the stored
// verdict, never by a model. Format: a heading with the round and the verdict, a line with the
// commit, the reviewer's model and effort and the time, the criteria, the findings (a finding whose
// evidence failed is advisory and marked unverified) and the summary. It holds the report only: no
// prompt text, token counts, cost, session or run ids, and no worker report.
//
// The comment is capped at `REVIEW_COMMENT_MAX` characters: over the cap the advisory findings are
// cut first, last one first, with a marker; a comment still over the cap after that is cut at the
// cap with a marker. Redacting env values is the caller's step after the cap (`redactComment`).

import type { ReviewCriterionResult, ReviewFinding } from "@dipsaus-orchestrator/contract";

import { type EnvSecret, redactSecrets } from "../hooks/web-guard";

import type { StoredReviewVerdict } from "./store";

/** GitHub allows 65,536 characters in a comment; dipo keeps under (0019 section 3). */
export const REVIEW_COMMENT_MAX = 60_000;

const SHORT_SHA = 7;

/** What a comment holds besides the verdict. */
export interface CommentFacts {
  /** The reviewer agent's effort; null when it is not known. */
  readonly effort: string | null;
}

/** `text` as an inline code span whose delimiter no backtick run inside it can end. */
function codeSpan(text: string): string {
  const flat = text.replaceAll(/\s*\r?\n\s*/g, " ").trim();
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}

const indent = (text: string, by: string): string =>
  text
    .trim()
    .split(/\r?\n/)
    .map((line) => `${by}${line}`.trimEnd())
    .join("\n");

function utc(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function criterionLine(entry: ReviewCriterionResult): string {
  const evidence = entry.evidence.trim();
  const [first = "", ...rest] = evidence.split(/\r?\n/);
  return [`- #${entry.n} ${entry.status}: ${first}`.trimEnd(), ...rest.map((l) => `  ${l}`)]
    .join("\n")
    .trimEnd();
}

function findingLine(finding: ReviewFinding): string {
  const place =
    finding.file !== undefined
      ? ` · ${codeSpan(`${finding.file}${finding.line === undefined ? "" : `:${finding.line}`}`)}`
      : finding.testEntry !== undefined
        ? ` · test-plan entry #${finding.testEntry}`
        : finding.criterion !== undefined
          ? ` · criterion #${finding.criterion}`
          : "";
  const severity = finding.unverified === true ? "advisory (unverified)" : finding.severity;
  return [
    `- ${severity} · ${finding.kind}${place}`,
    ...(finding.quote === undefined || finding.quote.trim() === ""
      ? []
      : [`  > ${codeSpan(finding.quote)}`]),
    indent(finding.text, "  "),
  ].join("\n");
}

function render(
  verdict: StoredReviewVerdict,
  facts: CommentFacts,
  findings: readonly string[],
  note: string | null,
): string {
  const effort = facts.effort === null || facts.effort === "" ? "" : ` (effort ${facts.effort})`;
  return [
    `### dipo review, round ${verdict.round} of the story: ${verdict.verdict}`,
    `Commit \`${verdict.commit.slice(0, SHORT_SHA)}\` · reviewer ${verdict.model}${effort} · ${utc(verdict.decidedAt)}`,
    `**Criteria**\n${verdict.criteria.length === 0 ? "- none" : verdict.criteria.map(criterionLine).join("\n")}`,
    `**Findings**\n${findings.length === 0 ? "- none" : findings.join("\n")}${note === null ? "" : `\n${note}`}`,
    `**Summary:** ${verdict.summary.trim()}`,
  ].join("\n\n");
}

/**
 * Pure: the comment of a stored verdict, at most `REVIEW_COMMENT_MAX` characters. The advisory
 * findings are cut first, from the last, and a marker says how many.
 */
export function reviewComment(
  verdict: StoredReviewVerdict,
  facts: CommentFacts,
  max: number = REVIEW_COMMENT_MAX,
): string {
  const items = verdict.findings.map((finding) => ({
    finding,
    text: findingLine(finding),
  }));
  const full = render(
    verdict,
    facts,
    items.map((item) => item.text),
    null,
  );
  if (full.length <= max) return full;
  const kept = [...items];
  let cut = 0;
  const attempt = (): string => {
    const note =
      cut === 0
        ? null
        : `- … ${cut} advisory finding${cut === 1 ? "" : "s"} cut to keep the comment under ${max} characters`;
    return render(
      verdict,
      facts,
      kept.map((item) => item.text),
      note,
    );
  };
  let text = attempt();
  while (text.length > max) {
    let last = -1;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (kept[i]?.finding.severity === "advisory") {
        last = i;
        break;
      }
    }
    if (last === -1) break;
    kept.splice(last, 1);
    cut += 1;
    text = attempt();
  }
  if (text.length <= max) return text;
  const marker = `\n\n[dipo: cut, showing the first ${max} characters of this comment.]`;
  return `${text.slice(0, max - marker.length)}${marker}`;
}

/**
 * Pure: `comment` with every env value of `secrets` replaced by `[redacted]`, line by line, so a
 * value found in a line never turns the rest of the comment into a single marker.
 */
export function redactComment(comment: string, secrets: readonly EnvSecret[]): string {
  if (secrets.length === 0) return comment;
  return comment
    .split("\n")
    .map((line) => redactSecrets(line, secrets))
    .join("\n");
}
