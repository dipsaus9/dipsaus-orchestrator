// `dipo answer <question> --text <answer> [--office <id>]` and `dipo answer <question> allow|deny
// [reason] [--office <id>]` (DIPO-59, DIPO-159, 0020 section 7): sends `work.answer` for a question
// the engine asked, in the office of `--office` or of the current directory.
//
// A worker's question takes its answer as a flag, `--text <answer>`, so an answer that happens to
// be the word "allow" is never read as a decision; text after the question id without `--text` is
// a usage error. `allow` and `deny` answer a permission question (0008 section 5): `deny` may be
// followed by a reason, which the worker is told. The engine refuses a decision for a worker
// question and a text for a permission question with `args.invalid`.
//
// An answer the worker waits for goes to it now. An answer to the question of a story parked on it
// resumes the story (an `ambiguous-spec` question park, DIPO-159, or a `needs-permission` park,
// DIPO-75), and the resumed run is printed; an answer to a question a stopping or capped run
// carried waits for the story's next session.

import { QuestionId, workAnswer } from "@dipsaus-orchestrator/contract";

import { engineFailure, usage } from "./daemon-commands";
import { type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";

export interface AnswerArgs {
  readonly question: QuestionId;
  readonly text: string;
  readonly decision?: "allow" | "deny";
}

/**
 * `<question> allow|deny [reason]`, or `<question>` with `text` from `--text`; a string is the
 * usage error.
 */
export function parseAnswer(words: readonly string[], text?: string): AnswerArgs | string {
  const [id, first, ...rest] = words;
  if (id === undefined) return "answer needs a question id (qst_...)";
  const question = QuestionId.safeParse(id);
  if (!question.success) return `answer: ${JSON.stringify(id)} is not a question id (qst_...)`;
  if (text !== undefined) {
    if (first !== undefined) {
      return "answer: --text takes the whole answer; put it in quotes and give nothing else";
    }
    if (text.trim() === "") return "answer: --text needs an answer";
    return { question: question.data, text };
  }
  if (first === undefined) return "answer needs allow, deny or --text <answer>";
  if (first === "allow") {
    if (rest.length > 0) return "answer: allow takes no text";
    return { question: question.data, text: "", decision: "allow" };
  }
  if (first === "deny") {
    return { question: question.data, text: rest.join(" "), decision: "deny" };
  }
  return "answer: a worker question's answer goes in --text <answer>; allow and deny answer a permission question";
}

export async function answerCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
  const words: string[] = [];
  const rest: string[] = [];
  let text: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--office") {
      rest.push(arg, ...(i + 1 < args.length ? [args[i + 1] ?? ""] : []));
      i += 1;
    } else if (arg === "--text") {
      if (text !== undefined) return usage(deps, "answer: --text is given once");
      if (i + 1 >= args.length) return usage(deps, "answer: --text needs an answer");
      text = args[i + 1] ?? "";
      i += 1;
    } else if (arg.startsWith("--")) {
      rest.push(arg);
    } else {
      words.push(arg);
    }
  }
  const parsed = parseAnswer(words, text);
  if (typeof parsed === "string") return usage(deps, parsed);
  const options = parseOptions(rest, false);
  if (typeof options === "string") return usage(deps, `answer: ${options}`);
  return withOffice(deps, options.office, async (session, office) => {
    const outcome = await session.command(
      workAnswer,
      {
        question: parsed.question,
        text: parsed.text,
        ...(parsed.decision === undefined ? {} : { decision: parsed.decision }),
      },
      { office },
    );
    if (!outcome.ok) {
      return outcome.error.code === "office.unknown"
        ? "unknown"
        : engineFailure(deps, outcome.error);
    }
    const what = parsed.decision ?? "answered";
    const { question, delivered, run } = outcome.result;
    deps.writeLine(
      `${what === "answered" ? "answered" : what === "allow" ? "allowed" : "denied"} ${question} (delivered ${delivered})`,
    );
    // The question of a story parked on it: the answer resumes the story's run.
    if (run !== undefined) deps.writeLine(`resumed run ${run}`);
    else if (delivered === "on-resume") {
      deps.writeLine(
        parsed.decision === undefined
          ? "the answer waits for the story's next session; dipo watch shows where it is now"
          : "the story did not resume; dipo watch shows where it is now",
      );
    }
    return 0;
  });
}
