// No env value reaches stored web lines (DIPO-164 review; 0020 section 11b): the `[web] <tool>
// <query or URL>` line of a call whose URL holds a value of the copied env files is stored with
// `[redacted]` in its place, in `output_chunks` and in the `work.output` change-log entries read
// from it, as 0008 redacts review comments. The refusal still names the file and key. The derived
// `web-calls` recording runs through the real ingestion and the real web check.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { StoryId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config";
import {
  cutWebLine,
  type EnvSecret,
  MIN_SECRET_CHARS,
  REDACTED_TEXT,
  redactSecrets,
  redactWebTarget,
  WebGuard,
} from "../../src/hooks/web-guard";
import type { IngestAdapter } from "../../src/ingest/ingestor";
import { INPUT_MAX_CHARS } from "../../src/ingest/output";
import { insertRun } from "../../src/run";
import { OfficeIngest } from "../../src/run/hosts";
import { addStory } from "../../src/stories/keys";
import { encode } from "../../src/workers/claude-cli/encode";
import { initialState, interpret } from "../../src/workers/claude-cli/interpret";
import type { ParseState } from "../../src/workers/types";
import {
  appendLines,
  hostLines,
  ingestFixture,
  loggedEvents,
  storedOutput,
  target,
} from "../ingest/helpers";
import { loadRecording } from "../workers/replay";

// The fixture env file of the `web` scenario (tools/recordings/scenarios.ts).
const VALUE = "fixture-env-value-7f3a9c";
const SECRETS: EnvSecret[] = [{ file: ".env", key: "FIXTURE_API_KEY", value: VALUE }];

const claude: IngestAdapter = {
  interpret: (line, state) =>
    interpret(line, state as unknown as ReturnType<typeof initialState>) as unknown as {
      events: [];
      state: ParseState;
    },
};

describe("redactSecrets (pure)", () => {
  it("redacts a value as written, percent-encoded in either hex case, and encoded part by part or twice", () => {
    const secrets: EnvSecret[] = [{ file: ".env", key: "K", value: "p@ss word/1" }];
    for (const url of [
      "https://x.test/?p=p@ss word/1&q=1",
      "https://x.test/?p=p%40ss%20word%2F1&q=1",
      "https://x.test/?p=p%40ss%20word%2f1&q=1",
      "https://x.test/?p=p%40ss+word%2F1&q=1",
      "https://x.test/?p=%70%40ss%20word%2F1&q=1",
      "https://x.test/?p=p%2540ss%2520word%252F1&q=1",
    ]) {
      const line = `[web] WebFetch ${url}`;
      const out = redactSecrets(line, secrets);
      expect(out).toContain(REDACTED_TEXT);
      expect(out.startsWith("[web] WebFetch ")).toBe(true);
      expect(out).not.toContain("word");
    }
    // Encoded as a whole, only the value goes; encoded part by part, the word holding it.
    expect(redactSecrets("[web] WebFetch https://x.test/?p=p%40ss%20word%2F1&q=1", secrets)).toBe(
      `[web] WebFetch https://x.test/?p=${REDACTED_TEXT}&q=1`,
    );
    expect(redactSecrets("[web] WebFetch https://x.test/?p=%70%40ss%20word%2F1", secrets)).toBe(
      `[web] WebFetch ${REDACTED_TEXT}`,
    );
    expect(redactSecrets("[web] WebFetch https://x.test/?k=abc", secrets)).toBe(
      "[web] WebFetch https://x.test/?k=abc",
    );
  });

  it("redacts the target whole when the env files cannot be read, keeping the tool", () => {
    expect(redactWebTarget(`[web] WebSearch why does ${VALUE} fail`)).toBe(
      `[web] WebSearch ${REDACTED_TEXT}`,
    );
    expect(redactWebTarget("[web] WebFetch")).toBe("[web] WebFetch");
  });
});

/** Ingests the `web-calls` recording through `OfficeIngest` with the web check's redaction. */
async function ingestWebCalls(
  dir: string,
  secrets: () => EnvSecret[],
  recording = loadRecording("web-calls"),
) {
  const f = await ingestFixture(dir);
  const at = f.t.clock.now();
  const { key } = f.office.immediate(() =>
    addStory(f.office, f.t.ids, { story: StoryId.parse("DIPO-1") }, at),
  );
  f.office.immediate(() =>
    insertRun(f.office, {
      runId: f.run,
      kind: "story",
      key,
      story: "DIPO-1",
      tier: "M",
      role: "developer",
      model: "haiku",
      startSha: "c".repeat(40),
      branch: "DIPO-1/x",
      worktree: join(dir, "tree"),
      slot: 1,
      budgetUnit: "tokens",
      budgetLimit: 1000,
      loopCap: 3,
      reviewRoundCap: null,
      configHash: "h",
      overrideKeys: null,
      runProfileId: null,
      startedAt: at,
      scope: null,
    }),
  );
  const warnings: string[] = [];
  const guard = new WebGuard({
    clock: f.t.clock,
    offices: { config: () => OFFICE_DEFAULTS },
    steering: { send: async () => ({ ok: true }) },
    encode,
    secrets,
    warn: (message) => warnings.push(message),
  });
  appendLines(f.eventFile, hostLines(recording));
  new OfficeIngest({
    clock: f.t.clock,
    pricing: () => null,
    redactOutput: (office, run, text) => guard.redactOutput(office, run, text),
  }).attach(
    f.office,
    { runId: f.run, agentId: f.agent },
    target(f, claude, initialState({ plannedModel: "haiku" }) as unknown as ParseState),
    null,
  );
  const output = storedOutput(f.office, f.run);
  const logged = JSON.stringify(
    loggedEvents(f.office).filter((event) => event.type === "work.output"),
  );
  return { output, logged, warnings };
}

describe("stored web lines (DIPO-164 review)", () => {
  it("never hold an env value: the refused fetch's URL is stored with [redacted] in its place", () =>
    withTempDir(async (dir) => {
      const { output, logged, warnings } = await ingestWebCalls(dir, () => SECRETS);
      expect(output.split("\n").filter((line) => line.startsWith("[web] "))).toEqual([
        "[web] WebSearch bun test runner documentation",
        "[web] WebFetch https://bun.sh/docs/cli/test",
        `[web] WebFetch https://example.com/lookup?token=${REDACTED_TEXT}`,
      ]);
      expect(output).not.toContain(VALUE);
      expect(logged).toContain("[web] WebFetch https://example.com/lookup?token=");
      expect(logged).not.toContain(VALUE);
      expect(warnings).toEqual([]);
    }));

  it("redact a value across the INPUT_MAX_CHARS cut before cutting: no prefix of it stays", () =>
    withTempDir(async (dir) => {
      // The refused URL padded so the value starts 5 characters before the cut and runs past it.
      const refused = `https://example.com/lookup?token=${VALUE}`;
      const head = "https://example.com/lookup?pad=";
      const pad = "a".repeat(INPUT_MAX_CHARS - 5 - head.length - "&token=".length);
      const url = `${head}${pad}&token=${VALUE}`;
      expect(url.indexOf(VALUE)).toBe(INPUT_MAX_CHARS - 5);
      const recording = JSON.parse(
        JSON.stringify(loadRecording("web-calls")).replaceAll(refused, url),
      ) as ReturnType<typeof loadRecording>;
      expect(JSON.stringify(recording)).toContain(url);

      const { output, logged, warnings } = await ingestWebCalls(dir, () => SECRETS, recording);
      // No prefix of the value of MIN_SECRET_CHARS characters or more is stored or logged.
      for (let length = MIN_SECRET_CHARS; length <= VALUE.length; length++) {
        expect(output).not.toContain(VALUE.slice(0, length));
        expect(logged).not.toContain(VALUE.slice(0, length));
      }
      const redacted = `${head}${pad}&token=${REDACTED_TEXT}`;
      expect(output.split("\n").filter((line) => line.startsWith("[web] WebFetch "))).toEqual([
        "[web] WebFetch https://bun.sh/docs/cli/test",
        `[web] WebFetch ${redacted.slice(0, INPUT_MAX_CHARS)} [cut ${redacted.length - INPUT_MAX_CHARS} more chars]`,
      ]);
      expect(warnings).toEqual([]);
    }));

  it("cuts a web line only after it is redacted, and leaves other lines alone", () => {
    const long = `[web] WebSearch ${"q".repeat(INPUT_MAX_CHARS + 7)}`;
    expect(cutWebLine(long)).toBe(
      `[web] WebSearch ${"q".repeat(INPUT_MAX_CHARS)} [cut 7 more chars]`,
    );
    expect(cutWebLine("[web] WebFetch https://x.test")).toBe("[web] WebFetch https://x.test");
    expect(cutWebLine(REDACTED_TEXT)).toBe(REDACTED_TEXT);
    expect(cutWebLine("[web] WebFetch")).toBe("[web] WebFetch");
  });

  it("redact every web target when the env files cannot be read", () =>
    withTempDir(async (dir) => {
      const { output, logged, warnings } = await ingestWebCalls(dir, () => {
        throw new Error("EACCES");
      });
      expect(output.split("\n").filter((line) => line.startsWith("[web] "))).toEqual([
        `[web] WebSearch ${REDACTED_TEXT}`,
        `[web] WebFetch ${REDACTED_TEXT}`,
        `[web] WebFetch ${REDACTED_TEXT}`,
      ]);
      expect(output).not.toContain(VALUE);
      expect(logged).not.toContain(VALUE);
      expect(warnings[0]).toBe("the web output could not be checked for env values");
    }));
});
