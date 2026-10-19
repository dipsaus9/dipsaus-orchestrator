// The web tools' PreToolUse check and count (DIPO-164; 0020 section 11b): a URL or query holding a
// value from the copied env files, plain or percent-encoded, is denied naming the file and key and
// never the value; a clean one is let through; a failure to check denies; and the run's web calls
// are counted by tool in `runs` and copied to its outcome row.

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type RunId, StoryId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import type { OfficeHandle } from "../../src/db/office";
import {
  type EnvSecret,
  findSecret,
  MIN_SECRET_CHARS,
  parseEnvText,
  readEnvSecrets,
  refusalText,
  UNCHECKED_TEXT,
  WebGuard,
} from "../../src/hooks/web-guard";
import { endRun, insertRun, runOutcome } from "../../src/run";
import type { RunSteering } from "../../src/run/control";
import { addStory } from "../../src/stories/keys";
import { encode } from "../../src/workers/claude-cli/encode";
import type { HostOp, SteerOp, WorkerEvent } from "../../src/workers/types";
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

  it("allows a clean URL or query and ignores values under the minimum length", () => {
    expect(findSecret("https://docs.example/api/reference", SECRETS)).toBeNull();
    expect(findSecret("how to configure a dev server mode", SECRETS)).toBeNull();
    expect("dev".length).toBeLessThan(MIN_SECRET_CHARS);
    expect(findSecret("https://x.test/%zz", SECRETS)).toBeNull();
  });

  it("words the refusal with the file and key, for a URL and for a query", () => {
    const hit = { file: ".env", key: "STRIPE_KEY" };
    expect(refusalText("WebFetch", hit)).toBe(
      "The URL contains a value from .env (STRIPE_KEY); never send env values in a web call. Remove it and try again.",
    );
    expect(refusalText("WebSearch", hit)).toContain("The query contains");
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
  readonly guard: WebGuard;
  readonly ops: SteerOp[];
  readonly outputs: HostOp[][];
  readonly warnings: string[];
}

async function withWorld(
  fn: (w: World) => Promise<void> | void,
  secrets: () => EnvSecret[] = () => SECRETS,
): Promise<void> {
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
      const ops: SteerOp[] = [];
      const outputs: HostOp[][] = [];
      const warnings: string[] = [];
      const steering: RunSteering = {
        send: async (_office, _run, host) => {
          outputs.push([...host]);
          return { ok: true };
        },
      };
      const guard = new WebGuard({
        clock: t.clock,
        offices: { config: () => OFFICE_DEFAULTS },
        steering,
        encode: (op) => {
          ops.push(op);
          return encode(op);
        },
        secrets,
        warn: (message) => warnings.push(message),
      });
      await fn({ t, office, guard, ops, outputs, warnings });
    } finally {
      t.state.close();
    }
  });
}

const call = (id: number, tool: string, target: string): WorkerEvent => ({
  t: "hook",
  hook: { kind: "webCall", id, tool, target },
});
const activity = (tool: string, agentId?: string): WorkerEvent => ({
  t: "activity",
  kind: "tool",
  tool,
  ...(agentId === undefined ? {} : { agentId }),
});

async function pass(w: World, ...events: WorkerEvent[]): Promise<void> {
  w.guard.onWorkerEvents(w.office, RUN, "agt-1", events);
  await w.guard.idle();
}

describe("WebGuard (DIPO-164)", () => {
  it("denies a URL holding an env value, naming the file and key and never the value", () =>
    withWorld(async (w) => {
      await pass(w, call(10, "WebFetch", `https://api.example/?k=${VALUE}`));
      expect(w.ops).toEqual([
        {
          kind: "toolGate",
          reply: {
            hook: 10,
            decision: "deny",
            reason: refusalText("WebFetch", { file: ".env", key: "STRIPE_KEY" }),
          },
        },
      ]);
      const sent = JSON.stringify(w.outputs);
      expect(sent).toContain("permissionDecision");
      expect(sent).toContain(".env (STRIPE_KEY)");
      expect(sent).not.toContain(VALUE);
    }));

  it("denies a percent-encoded value in a query", () =>
    withWorld(async (w) => {
      await pass(w, call(11, "WebSearch", `why does ${encodeURIComponent(VALUE)} fail`));
      expect(w.ops[0]).toMatchObject({ kind: "toolGate", reply: { hook: 11, decision: "deny" } });
    }));

  it("lets a clean URL proceed: an empty reply that prints nothing", () =>
    withWorld(async (w) => {
      await pass(w, call(12, "WebFetch", "https://docs.example/guide"));
      expect(w.ops).toEqual([{ kind: "toolGate", reply: { hook: 12, decision: null } }]);
      expect(w.outputs).toEqual([[{ hookReply: 12, output: "" }]]);
    }));

  it("denies when the env files cannot be read: it fails closed", () =>
    withWorld(
      async (w) => {
        await pass(w, call(13, "WebFetch", "https://docs.example/guide"));
        expect(w.ops).toEqual([
          { kind: "toolGate", reply: { hook: 13, decision: "deny", reason: UNCHECKED_TEXT } },
        ]);
        expect(w.warnings).toEqual(["a web call could not be checked"]);
      },
      () => {
        throw new Error("EACCES");
      },
    ));

  it("ignores a call with no hook id: no host holds it", () =>
    withWorld(async (w) => {
      await pass(w, {
        t: "hook",
        hook: { kind: "webCall", id: null, tool: "WebFetch", target: "https://x.test" },
      });
      expect(w.ops).toEqual([]);
    }));

  it("counts a run's web calls by tool, a subagent's and a refused one included, and copies them to the outcome", () =>
    withWorld(async (w) => {
      await pass(w, activity("WebSearch"), activity("Read"), activity("WebFetch"));
      await pass(w, activity("WebSearch", "toolu-9"));
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
