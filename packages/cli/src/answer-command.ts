// `dipo answer <question> --text <answer> [--office <id>]` (DIPO-59, DIPO-159, 0020): sends
// `work.answer` for a question the engine asked, in the office of `--office` or of the current
// directory.
//
// The answer is always a flag, `--text <answer>`, so an answer that happens to read "allow" is
// never taken as a decision (0020); text after the question id without `--text` is a usage error.
//
// An answer the worker waits for goes to it now. An answer to the question of a story parked
// `ambiguous-spec` on it resumes the story (DIPO-159), and the resumed run is printed; an answer to a question a stopping or capped run
// carried waits for the story's next session.

import { QuestionId, workAnswer } from "@dipsaus-orchestrator/contract";

import { engineFailure, usage } from "./daemon-commands";
import { type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";

export interface AnswerArgs {
  readonly question: QuestionId;
  readonly text: string;
}

/** `<question>` with `text` from `--text`; a string is the usage error. */
export function parseAnswer(words: readonly string[], text?: string): AnswerArgs | string {
  const [id, first] = words;
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
  if (first === undefined) return "answer needs --text <answer>";
  return "answer: the answer goes in --text <answer>, in quotes";
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
      { question: parsed.question, text: parsed.text },
      { office },
    );
    if (!outcome.ok) {
      return outcome.error.code === "office.unknown"
        ? "unknown"
        : engineFailure(deps, outcome.error);
    }
    const { question, delivered, run } = outcome.result;
    deps.writeLine(`answered ${question} (delivered ${delivered})`);
    // The question of a story parked on it: the answer resumes the story's run.
    if (run !== undefined) deps.writeLine(`resumed run ${run}`);
    else if (delivered === "on-resume") {
      deps.writeLine(
        "the answer waits for the story's next session; dipo watch shows where it is now",
      );
    }
    return 0;
  });
}
