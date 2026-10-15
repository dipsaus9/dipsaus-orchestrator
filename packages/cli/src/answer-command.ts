// `dipo answer <question> <text|allow|deny> [--office <id>]` (DIPO-59): sends `work.answer` for a
// question the engine asked, in the office of `--office` or of the current directory. `allow` and
// `deny` answer a permission question (0008 section 5): `deny` may be followed by a reason, which
// the worker is told. Any other text is sent as the answer with no decision; the engine refuses it
// for a permission question with `args.invalid`. On the question of a `needs-permission` park
// (DIPO-75) the answer resumes the story, and the resumed run is printed.

import { QuestionId, workAnswer } from "@dipsaus-orchestrator/contract";

import { engineFailure, usage } from "./daemon-commands";
import { type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";

export interface AnswerArgs {
  readonly question: QuestionId;
  readonly text: string;
  readonly decision?: "allow" | "deny";
}

/** `<question> <text|allow|deny> [reason]`; a string is the usage error. */
export function parseAnswer(words: readonly string[]): AnswerArgs | string {
  const [id, first, ...rest] = words;
  if (id === undefined) return "answer needs a question id (qst_...)";
  const question = QuestionId.safeParse(id);
  if (!question.success) return `answer: ${JSON.stringify(id)} is not a question id (qst_...)`;
  if (first === undefined) return "answer needs allow, deny or an answer text";
  if (first === "allow") {
    if (rest.length > 0) return "answer: allow takes no text";
    return { question: question.data, text: "", decision: "allow" };
  }
  if (first === "deny") {
    return { question: question.data, text: rest.join(" "), decision: "deny" };
  }
  const text = [first, ...rest].join(" ");
  if (text.trim() === "") return "answer needs allow, deny or an answer text";
  return { question: question.data, text };
}

export async function answerCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
  const words: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--office") {
      rest.push(arg, ...(i + 1 < args.length ? [args[i + 1] ?? ""] : []));
      i += 1;
    } else if (arg.startsWith("--")) {
      rest.push(arg);
    } else {
      words.push(arg);
    }
  }
  const parsed = parseAnswer(words);
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
    // The question of a `needs-permission` park (DIPO-75): the answer resumes the story's run.
    if (run !== undefined) deps.writeLine(`resumed run ${run}`);
    else if (delivered === "on-resume") {
      deps.writeLine("the story did not resume; dipo watch shows where it is now");
    }
    return 0;
  });
}
