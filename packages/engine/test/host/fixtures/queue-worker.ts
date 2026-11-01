// A stand-in for a Claude Code stream-json session run with `--replay-user-messages`, for the
// real-host steer tests of DIPO-412. It reads its stdin the whole time and keeps every user
// message it gets in a queue, as Claude Code does, and takes a queued message in the way the live
// probe of 2026-11-01 (Claude Code 2.1.316, Haiku) showed:
// - the first message starts turn 1, which runs one Bash call;
// - a message that came while the call ran is read right after the call's result, in the same
//   turn: echoed as a replayed user line;
// - the turn's report follows once the file `answer` exists in QUEUE_GATES; a message that came
//   after the call ended is read only after that result, as the first message of a new turn.
// Each turn's done report says in its summary which messages the turn read. The Bash call ends
// once the file `tool-done` exists. It exits 0 when its stdin closes.

import { existsSync } from "node:fs";
import { join } from "node:path";

const gates = process.env["QUEUE_GATES"] ?? "";
const MODEL = "claude-haiku-5-5";
const SESSION = "session-412";

const queue: string[] = [];
let ended = false;
let wake: (() => void) | null = null;

function print(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function readStdin(): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffered += decoder.decode(chunk);
    for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
      const line = JSON.parse(buffered.slice(0, at)) as { message: { content: string } };
      buffered = buffered.slice(at + 1);
      queue.push(line.message.content);
      wake?.();
    }
  }
  ended = true;
  wake?.();
}

function stdinEnded(): boolean {
  return ended;
}

/** The next queued message; null once stdin closed with none left. */
async function nextMessage(): Promise<string | null> {
  while (queue.length === 0 && !stdinEnded()) {
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
    wake = null;
  }
  return queue.shift() ?? null;
}

async function gate(name: string): Promise<void> {
  while (!existsSync(join(gates, name))) await Bun.sleep(10);
}

const usage = { input_tokens: 2, output_tokens: 7 };

function init(): void {
  print({
    type: "system",
    subtype: "init",
    session_id: SESSION,
    model: MODEL,
    claude_code_version: "2.1.316",
    permissionMode: "bypassPermissions",
    tools: ["Bash", "StructuredOutput"],
    apiKeySource: "none",
  });
}

function replay(text: string): void {
  print({
    type: "user",
    message: { role: "user", content: text },
    session_id: SESSION,
    parent_tool_use_id: null,
    isReplay: true,
  });
}

function result(read: readonly string[], id: string): void {
  print({
    type: "assistant",
    message: { model: MODEL, id, type: "message", role: "assistant", content: [], usage },
    parent_tool_use_id: null,
    session_id: SESSION,
  });
  print({
    type: "result",
    subtype: "success",
    session_id: SESSION,
    is_error: false,
    num_turns: 2,
    terminal_reason: "completed",
    permission_denials: [],
    structured_output: {
      status: "done",
      criteria: [{ n: 1, met: true, evidence: "the test" }],
      summary: `read: ${read.join(" | ")}`,
      commitSubject: "Do the story",
    },
    modelUsage: {
      [MODEL]: {
        inputTokens: 4,
        outputTokens: 10,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
  });
}

void readStdin();

const task = await nextMessage();
if (task !== null) {
  init();
  replay(task);
  const read = [task];
  print({
    type: "assistant",
    message: {
      model: MODEL,
      id: "msg-1",
      type: "message",
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu-1", name: "Bash", input: { command: "sleep 8" } }],
      usage,
    },
    parent_tool_use_id: null,
    session_id: SESSION,
  });
  await gate("tool-done");
  print({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu-1", content: "slept" }],
    },
    parent_tool_use_id: null,
    session_id: SESSION,
  });
  // What came during the call joins this turn.
  for (const text of queue.splice(0)) {
    replay(text);
    read.push(text);
  }
  await gate("answer");
  result(read, "msg-2");
  // What came after the call is read after the result, one new turn each.
  for (let turn = 3; ; turn++) {
    const text = await nextMessage();
    if (text === null) break;
    init();
    replay(text);
    result([text], `msg-${turn}`);
  }
}
process.exit(0);
