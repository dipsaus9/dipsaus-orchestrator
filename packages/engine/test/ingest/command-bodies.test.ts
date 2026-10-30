// The opt-in `privacy.storeCommandBodies` (0007 section 8, DIPO-83): with it on, a tool line in
// `output_chunks` holds the call's input as one cut line; with it off, the default, the lines are
// exactly as before and no command text reaches the state database. Hand-made stream-json lines
// run through the real Claude parser.

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { SEQUENCE_SAMPLES } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { type IngestAdapter, Ingestor } from "../../src/ingest/ingestor";
import { INPUT_MAX_CHARS, oneLineInput, outputText, toolLine } from "../../src/ingest/output";
import { OfficeIngest } from "../../src/run/hosts";
import { initialState, interpret } from "../../src/workers/claude-cli/interpret";
import type { HostLine, ParseState } from "../../src/workers/types";
import {
  appendLines,
  type IngestFixture,
  ingestFixture,
  loggedEvents,
  storedOutput,
  target,
} from "./helpers";

const MODEL = "claude-haiku-5-5";
/** Looks like a credential on purpose: it must never be stored without the opt-in. */
const SECRET = "ghp_SECRETtoken0123456789abcdefABCDEF";
const COMMAND = `curl -H "Authorization: Bearer ${SECRET}" \\\n  https://api.example.test/repos`;
const LONG = `echo ${"a".repeat(INPUT_MAX_CHARS + 50)}`;

const claude: IngestAdapter = {
  interpret: (line, state) =>
    interpret(line, state as unknown as ReturnType<typeof initialState>) as unknown as {
      events: [];
      state: ParseState;
    },
};

function stdout(t: number, data: unknown): HostLine {
  return { t, ch: "stdout", data: JSON.stringify(data) };
}

function assistant(t: number, id: string, content: unknown[]): HostLine {
  return stdout(t, {
    type: "assistant",
    message: {
      model: MODEL,
      id,
      type: "message",
      role: "assistant",
      content,
      usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: null,
    session_id: "session-1",
  });
}

const LINES: HostLine[] = [
  assistant(1, "msg-1", [{ type: "text", text: "Checking the API." }]),
  assistant(2, "msg-1", [
    { type: "tool_use", id: "toolu-1", name: "Bash", input: { command: COMMAND } },
  ]),
  assistant(3, "msg-2", [
    { type: "tool_use", id: "toolu-2", name: "Read", input: { file_path: "src/a.ts" } },
  ]),
  assistant(4, "msg-3", [
    { type: "tool_use", id: "toolu-3", name: "Bash", input: { command: LONG } },
  ]),
  { t: 5, ch: "exit", data: JSON.stringify({ code: 0, signal: null }) },
];

async function ingest(
  dir: string,
  storeCommandBodies: boolean | undefined,
  lines: readonly HostLine[] = LINES,
): Promise<IngestFixture> {
  const f = await ingestFixture(dir);
  appendLines(f.eventFile, [...lines]);
  new Ingestor({
    office: f.office,
    clock: f.t.clock,
    ...(storeCommandBodies === undefined ? {} : { privacy: () => ({ storeCommandBodies }) }),
  }).track(target(f, claude, initialState({ plannedModel: "haiku" }) as unknown as ParseState));
  return f;
}

/** Every byte of the state database files, WAL included. */
function databaseBytes(dir: string): string {
  const stateDir = join(dir, "state");
  return readdirSync(stateDir)
    .filter((name) => name.startsWith("dipo.db"))
    .map((name) => readFileSync(join(stateDir, name)).toString("latin1"))
    .join("");
}

function workOutputText(f: IngestFixture): string {
  return loggedEvents(f.office)
    .filter((event) => event.type === "work.output")
    .map((event) => JSON.stringify(event.data))
    .join("");
}

describe("privacy.storeCommandBodies (DIPO-83)", () => {
  it("off by default: tool lines name the tool and path only, and no command text is stored", () =>
    withTempDir(async (dir) => {
      for (const setting of [undefined, false]) {
        const sub = join(dir, String(setting));
        const f = await ingest(sub, setting);
        expect(storedOutput(f.office, f.run)).toBe(
          "Checking the API.\n[tool] Bash\n[tool] Read src/a.ts\n[tool] Bash\n",
        );
        expect(workOutputText(f)).not.toContain(SECRET);
        f.t.state.close();
        // Not in any row, the parser state or the change log: nowhere in the database files.
        expect(databaseBytes(sub)).not.toContain(SECRET);
        expect(databaseBytes(sub)).not.toContain("api.example.test");
      }
    }));

  it("on: a Bash line reads `[tool] Bash <command>` on one line, long commands cut with a marker", () =>
    withTempDir(async (dir) => {
      const f = await ingest(dir, true);
      const cut = Array.from(LONG).length - INPUT_MAX_CHARS;
      expect(storedOutput(f.office, f.run)).toBe(
        [
          "Checking the API.",
          `[tool] Bash curl -H "Authorization: Bearer ${SECRET}" \\ https://api.example.test/repos`,
          "[tool] Read src/a.ts",
          `[tool] Bash ${LONG.slice(0, INPUT_MAX_CHARS)} [cut ${cut} more chars]`,
          "",
        ].join("\n"),
      );
      // The live detail reads the same lines through `work.output`.
      expect(workOutputText(f)).toContain(`[tool] Bash curl -H`);
      // The database scan the off case relies on does see stored text.
      f.t.state.close();
      expect(databaseBytes(dir)).toContain(SECRET);
    }));

  it("OfficeIngest asks for the opt-in of the run's own office", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      const asked: string[] = [];
      appendLines(f.eventFile, LINES.slice(1, 2));
      new OfficeIngest({
        clock: f.t.clock,
        privacy: (office) => {
          asked.push(office);
          return { storeCommandBodies: true };
        },
      }).attach(
        f.office,
        { runId: f.run, agentId: f.agent },
        target(f, claude, initialState({ plannedModel: "haiku" }) as unknown as ParseState),
        null,
      );
      expect(asked).toEqual([f.office.officeId]);
      expect(storedOutput(f.office, f.run)).toContain(`Bearer ${SECRET}`);
    }));

  it("reads the opt-in at every pass, so a reloaded configuration applies to the next output", () =>
    withTempDir(async (dir) => {
      const f = await ingestFixture(dir);
      let on = false;
      const ingestor = new Ingestor({
        office: f.office,
        clock: f.t.clock,
        privacy: () => ({ storeCommandBodies: on }),
      });
      appendLines(f.eventFile, LINES.slice(1, 2));
      ingestor.track(
        target(f, claude, initialState({ plannedModel: "haiku" }) as unknown as ParseState),
      );
      on = true;
      appendLines(f.eventFile, LINES.slice(3));
      f.t.clock.advance(1_000);
      const stored = storedOutput(f.office, f.run);
      expect(stored.startsWith("[tool] Bash\n[tool] Bash echo aaa")).toBe(true);
      expect(stored).not.toContain(SECRET);
    }));
});

describe("tool lines", () => {
  it("collapse line breaks, tabs and control characters into single spaces", () => {
    expect(oneLineInput("git status\n\n\tgit log\r\n --oneline\u001b[0m ")).toBe(
      "git status git log --oneline",
    );
    expect(toolLine("Bash", undefined, "  \n ")).toBe("[tool] Bash\n");
    expect(toolLine("Grep", "src", "TODO")).toBe("[tool] Grep src TODO\n");
  });

  it("cut by characters, not bytes, and say how much was left out", () => {
    const input = "é".repeat(INPUT_MAX_CHARS + 3);
    expect(oneLineInput(input)).toBe(`${"é".repeat(INPUT_MAX_CHARS)} [cut 3 more chars]`);
    expect(oneLineInput("x".repeat(INPUT_MAX_CHARS))).toBe("x".repeat(INPUT_MAX_CHARS));
  });

  it("leave the input out unless the opt-in is on, and never store a subagent's calls", () => {
    const event = { t: "activity", kind: "tool", tool: "Bash", input: "rm -rf build" } as const;
    expect(outputText(event)).toBe("[tool] Bash\n");
    expect(outputText(event, { storeCommandBodies: false })).toBe("[tool] Bash\n");
    expect(outputText(event, { storeCommandBodies: true })).toBe("[tool] Bash rm -rf build\n");
    expect(outputText({ ...event, agentId: "toolu-9" }, { storeCommandBodies: true })).toBe("");
  });
});

describe("stored output is cleaned of terminal control characters (DIPO-313)", () => {
  for (const [name, sample] of Object.entries(SEQUENCE_SAMPLES)) {
    it(`stores ${name} as plain text`, () => {
      expect([name, outputText({ t: "output", text: `a${sample}b` } as never)]).toEqual([
        name,
        "ab\n",
      ]);
      expect(
        outputText({
          t: "activity",
          kind: "tool",
          tool: "Read",
          path: `src/a${sample}.ts`,
        } as never),
      ).toBe("[tool] Read src/a.ts\n");
      expect(
        outputText(
          { t: "activity", kind: "tool", tool: "Bash", input: `ls${sample} -l` } as never,
          { storeCommandBodies: true },
        ),
      ).toBe("[tool] Bash ls -l\n");
    });
  }
});

// DIPO-312: a stored tool line holds no credential-shaped value, with the input stored (the
// default of the office configuration) and in the path.
describe("stored tool lines are scrubbed of credentials (DIPO-312)", () => {
  const TOKEN = `ghp_${"Z9y8".repeat(10)}`;
  const KEY = `sk-ant-api03-${"q".repeat(40)}`;
  const REMOTE = "https://x-access-token:hunter2hunter2@github.com/o/r.git";
  const SCRUB_LINES: HostLine[] = [
    assistant(1, "msg-1", [
      {
        type: "tool_use",
        id: "toolu-1",
        name: "Bash",
        input: { command: `git push ${REMOTE} HEAD && curl -H "x-api-key: ${KEY}" -d ${TOKEN}` },
      },
    ]),
    assistant(2, "msg-2", [
      { type: "tool_use", id: "toolu-2", name: "Read", input: { file_path: `notes/${TOKEN}.md` } },
    ]),
    { t: 3, ch: "exit", data: JSON.stringify({ code: 0, signal: null }) },
  ];

  it("replaces every secret shape and credentialed URL by [redacted] before it is stored", () =>
    withTempDir(async (dir) => {
      const f = await ingest(dir, true, SCRUB_LINES);
      expect(storedOutput(f.office, f.run)).toBe(
        [
          '[tool] Bash git push [redacted] HEAD && curl -H "x-api-key: [redacted]" -d [redacted]',
          "[tool] Read notes/[redacted].md",
          "",
        ].join("\n"),
      );
      expect(workOutputText(f)).not.toContain(TOKEN);
      f.t.state.close();
      const bytes = databaseBytes(dir);
      for (const secret of [TOKEN, KEY, "hunter2hunter2"]) expect(bytes).not.toContain(secret);
    }));

  it("scrubs before it cuts, so a cut never leaves part of a secret", () => {
    const input = `${"x ".repeat(INPUT_MAX_CHARS / 2 - 5)}${TOKEN}`;
    const line = toolLine("Bash", undefined, input);
    expect(line).not.toContain("ghp_");
    expect(line).not.toContain("Z9y8");
    expect(toolLine("Bash", undefined, `echo ${KEY}`)).toBe("[tool] Bash echo [redacted]\n");
  });
});
