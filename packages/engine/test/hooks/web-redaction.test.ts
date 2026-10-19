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
  type EnvSecret,
  REDACTED_TEXT,
  redactSecrets,
  redactWebTarget,
  WebGuard,
} from "../../src/hooks/web-guard";
import type { IngestAdapter } from "../../src/ingest/ingestor";
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
async function ingestWebCalls(dir: string, secrets: () => EnvSecret[]) {
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
  appendLines(f.eventFile, hostLines(loadRecording("web-calls")));
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
