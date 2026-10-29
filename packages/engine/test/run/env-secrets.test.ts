// The values of the env files dipo copied for a run and the run's web calls (0002, 0020): env files
// read as KEY=value lines, a value found as written or percent-encoded, naming the file and key and
// never the value; and the run's web calls counted by tool in `runs` and copied to its outcome row.

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type RunId, StoryId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import type { OfficeHandle } from "../../src/db/office";
import { endRun, insertRun, runOutcome } from "../../src/run";
import {
  decodedForms,
  type EnvSecret,
  findSecret,
  lenientDecode,
  MIN_SECRET_CHARS,
  parseEnvText,
  readEnvSecrets,
} from "../../src/run/env-secrets";
import { WebCalls } from "../../src/run/web-calls";
import { addStory } from "../../src/stories/keys";
import type { WorkerEvent } from "../../src/workers/types";
import { addOffice, openTestState, type TestState } from "../commands/helpers";

const RUN = "run_01JZ0000000000000000000164" as RunId;
const VALUE = "sk-live-9f8e7d6c5b4a";
const SECRETS: EnvSecret[] = [
  { file: ".env", key: "STRIPE_KEY", value: VALUE },
  { file: ".env", key: "MODE", value: "dev" },
  { file: "config/.env.local", key: "DB_PASSWORD", value: "p@ss word/1" },
];

describe("env files as KEY=value lines", () => {
  it("reads plain, exported, quoted and commented values", () => {
    const text = [
      "# a comment",
      "A=1",
      "export B = two words # trailing",
      'C="quoted # not a comment"',
      "D='single'",
      "E=",
      "not a line",
      "F=has#hash",
    ].join("\n");
    expect(parseEnvText(text)).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "two words" },
      { key: "C", value: "quoted # not a comment" },
      { key: "D", value: "single" },
      { key: "F", value: "has#hash" },
    ]);
  });
});

describe("findSecret (pure)", () => {
  it("finds a value as written, naming the file and key and not the value", () => {
    const hit = findSecret(`https://api.example/v1?token=${VALUE}`, SECRETS);
    expect(hit).toEqual({ file: ".env", key: "STRIPE_KEY" });
    expect(JSON.stringify(hit)).not.toContain(VALUE);
  });

  it("finds a percent-encoded value, in either hex case, and a plus for a space", () => {
    const encoded = encodeURIComponent("p@ss word/1");
    expect(encoded).toBe("p%40ss%20word%2F1");
    const wanted = { file: "config/.env.local", key: "DB_PASSWORD" };
    expect(findSecret(`https://x.test/?p=${encoded}`, SECRETS)).toEqual(wanted);
    expect(findSecret(`https://x.test/?p=${encoded.toLowerCase()}`, SECRETS)).toEqual(wanted);
    expect(findSecret("https://x.test/?p=p%40ss+word%2F1", SECRETS)).toEqual(wanted);
  });

  it("finds a value that is percent-encoded in the target character by character", () => {
    const every = [...VALUE].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("");
    expect(findSecret(`https://x.test/${every}`, SECRETS)).toEqual({
      file: ".env",
      key: "STRIPE_KEY",
    });
  });

  it("decodes leniently: a stray %, an invalid UTF-8 escape and a double encoding hide nothing (review)", () => {
    const secrets: EnvSecret[] = [{ file: ".env", key: "TOKEN", value: "abcd1234" }];
    const hit = { file: ".env", key: "TOKEN" };
    // A stray '%' makes decodeURIComponent throw for the whole target.
    expect(findSecret("https://x.test/?a=%&k=%61bcd1234", secrets)).toEqual(hit);
    // An invalid UTF-8 escape elsewhere in the target, and right next to the value.
    expect(findSecret("https://x.test/?x=%C0&k=%61bcd1234", secrets)).toEqual(hit);
    expect(findSecret("https://x.test/?k=%C0%61bcd1234", secrets)).toEqual(hit);
    // Encoded twice, and three times.
    expect(findSecret("https://x.test/?k=%2561bcd1234", secrets)).toEqual(hit);
    expect(findSecret("https://x.test/?k=%252561bcd1234", secrets)).toEqual(hit);
    // The invalid escape is kept as written, the valid one decoded.
    expect(lenientDecode("%C0%61%&%zz%e2%82%ac")).toBe("%C0a%&%zz€");
    expect(decodedForms("%2561")).toEqual(["%2561", "%61", "a"]);
  });

  it("allows a clean URL or query and ignores values under the minimum length", () => {
    expect(findSecret("https://docs.example/api/reference", SECRETS)).toBeNull();
    expect(findSecret("how to configure a dev server mode", SECRETS)).toBeNull();
    expect("dev".length).toBeLessThan(MIN_SECRET_CHARS);
    expect(findSecret("https://x.test/%zz", SECRETS)).toBeNull();
  });
});

describe("readEnvSecrets", () => {
  it("reads the copy entries of worktree.files, files and directories, and skips links and absent files", () =>
    withTempDir((dir) => {
      mkdirSync(join(dir, "apps/web"), { recursive: true });
      writeFileSync(join(dir, ".env"), "STRIPE_KEY=sk-live-9f8e7d6c5b4a\n");
      writeFileSync(join(dir, "apps/web/.env.local"), "DB_PASSWORD=hunter2hunter2\n");
      writeFileSync(join(dir, "linked.env"), "LINKED=should-not-be-read\n");
      const files: OfficeConfig["worktree"]["files"] = [
        { path: ".env", mode: "copy", required: false },
        { path: "apps/", mode: "copy", required: false },
        { path: "missing/.env", mode: "copy", required: false },
        { path: "linked.env", mode: "link", required: false },
      ];
      expect(readEnvSecrets(dir, files)).toEqual([
        { file: ".env", key: "STRIPE_KEY", value: "sk-live-9f8e7d6c5b4a" },
        { file: "apps/web/.env.local", key: "DB_PASSWORD", value: "hunter2hunter2" },
      ]);
    }));
});

interface World {
  readonly t: TestState;
  readonly office: OfficeHandle;
  readonly calls: WebCalls;
}

async function withWorld(fn: (w: World) => Promise<void> | void): Promise<void> {
  await withTempDir(async (dir) => {
    const t = await openTestState(dir);
    try {
      const office = addOffice(t);
      const at = t.clock.now();
      const { key } = office.immediate(() =>
        addStory(office, t.ids, { story: StoryId.parse("DIPO-1") }, at),
      );
      office.immediate(() =>
        insertRun(office, {
          runId: RUN,
          kind: "story",
          key,
          story: "DIPO-1",
          tier: "M",
          role: "developer",
          model: "haiku",
          startSha: "c".repeat(40),
          branch: "DIPO-1/x",
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
      const calls = new WebCalls({
        offices: { config: () => OFFICE_DEFAULTS },
        checkout: () => undefined,
      });
      await fn({ t, office, calls });
    } finally {
      t.state.close();
    }
  });
}

const activity = (tool: string, agentId?: string): WorkerEvent => ({
  t: "activity",
  kind: "tool",
  tool,
  ...(agentId === undefined ? {} : { agentId }),
});

function pass(w: World, ...events: WorkerEvent[]): void {
  w.calls.onWorkerEvents(w.office, RUN, "agt-1", events);
}

describe("WebCalls", () => {
  it("counts a run's web calls by tool, a subagent's included, and copies them to the outcome", () =>
    withWorld((w) => {
      pass(w, activity("WebSearch"), activity("Read"), activity("WebFetch"));
      pass(w, activity("WebSearch", "toolu-9"));
      const row = w.office.get<{ web_searches: number; web_fetches: number }>(
        "select web_searches, web_fetches from runs where office_id = $office_id and run_id = $run",
        { run: RUN },
      );
      expect(row).toEqual({ web_searches: 2, web_fetches: 1 });
      w.office.immediate(() => endRun(w.office, RUN, w.t.clock.now() + 60_000, "in-review"));
      const outcome = runOutcome(w.office, RUN);
      expect(outcome?.webSearches).toBe(2);
      expect(outcome?.webFetches).toBe(1);
    }));
});
