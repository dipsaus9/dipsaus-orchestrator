// The model proxy's count (DIPO-425, 0008): every model request a box sends through the real proxy
// (`startModelProxy`, its token read from a fake `security`, a fake upstream) counts against the
// run of the box that sent it, in the run records the caps and the spend alerts read. The runs live
// in a migrated test database built from fixtures; the ledger is the daemon's
// (`proxiedUsageLedger`), the registry a map from box address to session, as `BoxWorkers` keeps it.
//
// - criterion 1: a program other than Claude Code (a plain JSON request) adds its answer's input,
//   output, cache-creation and cache-read tokens to its box's run; the token cap and the day's
//   spend include them;
// - criterion 2: a stream counts from its last usage event, and a cut-off stream from what arrived;
// - criterion 3: a Claude Code turn counts once: the proxy's count plus that turn's stream;
// - criterion 4: the sender is its peer address only; a run a header or the body names is ignored;
// - criterion 5: the old barrier still holds, and count_tokens is forwarded and adds nothing;
// - criterion 6: the bypass forms (another run claimed, the box's own credential; the web route is
//   in web-proxy.test.ts);
// - criterion 7: with the registry lookup or the usage write failing, nothing is forwarded.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { AgentId, RunId, StoryId, StoryKey } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import {
  BOX_PLACEHOLDER_API_KEY,
  CAP_REFUSAL,
  type ListenHttp,
  type ModelUsageLedger,
  type ProxyHandler,
  type ProxyOwner,
  startModelProxy,
  type UpstreamFetch,
} from "../../src/box/model-proxy";
import { type IngestAdapter, Ingestor } from "../../src/ingest/ingestor";
import { peerAddress } from "../../src/platform/peer";
import { recordAgent } from "../../src/records/agents";
import { runTotals } from "../../src/records/caps";
import { proxiedUsageLedger } from "../../src/records/proxied-usage";
import { insertRun } from "../../src/records/run-records";
import { addStory } from "../../src/records/story-keys";
import { sumUsage } from "../../src/views/usage";
import { claudeCliAdapter } from "../../src/workers/claude-cli/adapter";
import { initialState } from "../../src/workers/claude-cli/interpret";
import type { ParseState } from "../../src/workers/types";
import {
  appendLines,
  hostLines,
  type IngestFixture,
  ingestFixture,
  target,
} from "../ingest/helpers";
import { context, withoutSkills } from "../workers/launch-fixtures";
import { loadRecording } from "../workers/replay";
import { fakeContainer } from "./fake-container";

const TOKEN_TEXT = "fake-box-login-for-tests-0123456789";
const HOST = "192.0.2.1";
/** Two boxes on the box network, each a session's. */
const BOX_A = "192.0.2.20";
const BOX_B = "192.0.2.21";
const BUDGET = 1_000;

interface Forwarded {
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

/** The fake upstream: every request kept, each answered by `answer`. */
function upstreamOf(answer: (path: string) => Response): {
  fetch: UpstreamFetch;
  calls: Forwarded[];
} {
  const calls: Forwarded[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({
        url,
        headers: init.headers as Headers,
        body: new TextDecoder().decode(init.body as ArrayBuffer),
      });
      return answer(new URL(url).pathname);
    },
  };
}

/** A Messages API answer as JSON (`stream: false`). */
function jsonAnswer(usage: Record<string, unknown>, model = "claude-haiku-5-5-20260101"): Response {
  return new Response(JSON.stringify({ id: "msg_1", type: "message", model, content: [], usage }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Server-sent events, each `data:` line one event; with `cut` the connection drops after them. */
function streamAnswer(events: readonly unknown[], options: { cut?: boolean } = {}): Response {
  const text = events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  // Split mid-line, as a network does, one chunk per read.
  const chunks = [bytes.slice(0, 37), bytes.slice(37)];
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift();
      if (next !== undefined) controller.enqueue(next);
      else if (options.cut === true) controller.error(new Error("connection reset"));
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const MESSAGE_START = {
  type: "message_start",
  message: {
    id: "msg_2",
    model: "claude-haiku-5-5",
    usage: {
      input_tokens: 40,
      output_tokens: 1,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 500,
      cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
    },
  },
};

/** A request from a box, as a program in it sends one. */
function boxRequest(
  path: string,
  body: unknown = { model: "claude-haiku-5-5" },
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://${HOST}:4000${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": BOX_PLACEHOLDER_API_KEY,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** The real proxy, started as the daemon starts it; returns the handler its listener got. */
async function realProxy(
  counting: ModelUsageLedger,
  upstream: UpstreamFetch,
): Promise<ProxyHandler> {
  let handler: ProxyHandler | null = null;
  const listen: ListenHttp = (options) => {
    handler = options.fetch;
    return { port: 4000, stop: async () => {} };
  };
  const security = fakeContainer((args) =>
    args[0] === "find-generic-password" ? { stdout: `${TOKEN_TEXT}\n` } : undefined,
  );
  await startModelProxy({
    network: { hostAddress: HOST },
    ledger: counting,
    keychain: { spawn: security.spawn, clock: new ManualClock(), env: { PATH: "/usr/bin:/bin" } },
    listen,
    upstream: "https://model.example",
    fetch: upstream,
  });
  if (handler === null) throw new Error("the proxy did not listen");
  return handler;
}

let dir: string;
let f: IngestFixture;
/** The second run, in box B. */
let runB: RunId;
let agentB: AgentId;
/** The box-address registry, as `BoxWorkers` keeps it. */
let owners: Map<string, ProxyOwner>;

function addRun(run: RunId, agent: AgentId, story: string): void {
  f.office.immediate(() => {
    const { key } = addStory(f.office, f.t.ids, { story: StoryId.parse(story) }, f.t.clock.now());
    insertRun(f.office, {
      runId: run,
      kind: "story",
      key,
      story,
      tier: "S",
      role: "developer",
      model: "haiku",
      startSha: "b".repeat(40),
      branch: `${story}/count`,
      budgetUnit: "tokens",
      budgetLimit: BUDGET,
      loopCap: 3,
      reviewRoundCap: null,
      configHash: "h",
      overrideKeys: null,
      runProfileId: null,
      startedAt: f.t.clock.now(),
    });
    recordAgent(f.office, {
      agentId: agent,
      runId: run,
      role: "developer",
      model: "haiku",
      startedAt: f.t.clock.now(),
    });
  });
}

/** The daemon's ledger over the fixture office, with the registry `owners`. */
function ledger(overrides: Partial<ModelUsageLedger> = {}): ModelUsageLedger {
  return {
    ...proxiedUsageLedger({
      owner: (address) => owners.get(address) ?? null,
      office: (office) => (office === f.office.officeId ? f.office : undefined),
      clock: f.t.clock,
    }),
    ...overrides,
  };
}

/** The refusals the proxy recorded, oldest first. */
function refusals(): { run: string; reason: string }[] {
  return f.office.all<{ run: string; reason: string }>(
    "select run_id as run, reason from proxy_refusals where office_id = $office_id order by run_id, refusal",
  );
}

/** The stored tokens of `run`, summed over its rows. */
function stored(run: RunId): {
  input: number;
  output: number;
  create: number;
  read: number;
  cost: number | null;
} {
  const row = f.office.get<{
    input: number;
    output: number;
    create: number;
    read: number;
    cost: number | null;
  }>(
    `select coalesce(sum(input), 0) as input, coalesce(sum(output), 0) as output,
       coalesce(sum(cache_create), 0) as "create", coalesce(sum(cache_read), 0) as read,
       sum(cost_micros) as cost
     from usage_totals where office_id = $office_id and run_id = $run`,
    { run },
  );
  return row ?? { input: 0, output: 0, create: 0, read: 0, cost: null };
}

beforeEach(async () => {
  dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "proxy-count-"));
  f = await ingestFixture(dir);
  runB = RunId.parse(f.t.ids.next("run"));
  agentB = AgentId.parse(f.t.ids.next("agt"));
  addRun(f.run, f.agent, "DIPO-1");
  addRun(runB, agentB, "DIPO-2");
  owners = new Map([
    [BOX_A, { office: f.office.officeId, run: f.run, agent: f.agent }],
    [BOX_B, { office: f.office.officeId, run: runB, agent: agentB }],
  ]);
});

afterEach(() => {
  f.t.state.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a model request of a program other than Claude Code (criterion 1)", () => {
  it("adds its answer's four token kinds to the box's run, which the token cap and the day's spend count", async () => {
    const upstream = upstreamOf(() =>
      jsonAnswer({
        input_tokens: 300,
        output_tokens: 200,
        cache_creation_input_tokens: 600,
        cache_read_input_tokens: 9_000,
      }),
    );
    const handle = await realProxy(ledger(), upstream.fetch);
    const spendBefore = sumUsage(f.t.state, f.t.clock.now()).total.day.tokens;
    const response = await handle(boxRequest("/v1/messages"), BOX_A);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { usage: unknown }).usage).toBeDefined();
    expect(stored(f.run)).toMatchObject({ input: 300, output: 200, create: 600, read: 9_000 });
    expect(stored(runB)).toMatchObject({ input: 0, output: 0, create: 0, read: 0 });
    // Budget tokens are input, output and cache creation (0008): the run's cap is reached.
    const totals = runTotals(f.office, f.run, f.t.clock.now(), f.t.clock.now());
    expect(totals.budgetTokens).toBe(1_100);
    expect(totals.budgetTokens).toBeGreaterThanOrEqual(BUDGET);
    expect(sumUsage(f.t.state, f.t.clock.now()).total.day.tokens - spendBefore).toBe(1_100);
  });

  it("still counts an answer that comes after the run's agent was made final, in the day's spend", async () => {
    const handle = await realProxy(
      ledger(),
      upstreamOf(() => jsonAnswer({ input_tokens: 5, output_tokens: 7 })).fetch,
    );
    await handle(boxRequest("/v1/messages"), BOX_A);
    // The run ends (`endRun`): its rows become final and go into `usage_daily`.
    const { finalizeAgentUsage } = await import("../../src/records/usage");
    f.office.immediate(() => finalizeAgentUsage(f.office, f.run, f.agent, f.t.clock.now()));
    const spend = sumUsage(f.t.state, f.t.clock.now()).total.day.tokens;
    expect(spend).toBe(12);
    // The office's verify in the box at done calls the model once more.
    await handle(boxRequest("/v1/messages"), BOX_A);
    expect(sumUsage(f.t.state, f.t.clock.now()).total.day.tokens).toBe(24);
  });
});

describe("a streamed answer (criterion 2)", () => {
  it("counts the final message_delta usage over the message_start usage", async () => {
    const upstream = upstreamOf(() =>
      streamAnswer([
        MESSAGE_START,
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 90 } },
        { type: "message_stop" },
      ]),
    );
    const handle = await realProxy(ledger(), upstream.fetch);
    const response = await handle(boxRequest("/v1/messages"), BOX_A);
    // The box gets the stream as it came.
    expect(await response.text()).toContain('"message_stop"');
    expect(stored(f.run)).toMatchObject({ input: 40, output: 90, create: 30, read: 500 });
    const split = f.office.get<{ m5: number; h1: number }>(
      `select sum(cache_create_5m) as m5, sum(cache_create_1h) as h1 from usage_totals
       where office_id = $office_id and run_id = $run`,
      { run: f.run },
    );
    expect(split).toEqual({ m5: 10, h1: 20 });
  });

  it("counts a stream cut off before its last event from what arrived, never as zero", async () => {
    const upstream = upstreamOf(() =>
      streamAnswer(
        [MESSAGE_START, { type: "message_delta", delta: {}, usage: { output_tokens: 12 } }],
        { cut: true },
      ),
    );
    const handle = await realProxy(ledger(), upstream.fetch);
    const response = await handle(boxRequest("/v1/messages"), BOX_A);
    await response.text().catch(() => "");
    expect(stored(f.run)).toMatchObject({ input: 40, output: 12, create: 30, read: 500 });
  });

  it("counts a stream the box stops reading from what arrived", async () => {
    const upstream = upstreamOf(() => {
      const bytes = new TextEncoder().encode(`data: ${JSON.stringify(MESSAGE_START)}\n\n`);
      // The upstream keeps the stream open: only the box's cancel ends it.
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => controller.enqueue(bytes),
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const handle = await realProxy(ledger(), upstream.fetch);
    const response = await handle(boxRequest("/v1/messages"), BOX_A);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(stored(f.run)).toMatchObject({ input: 40, output: 1, create: 30, read: 500 });
  });

  it("counts each change as the upstream sends it, while a box holds the stream open unread", async () => {
    // The upstream sends message_start, later a delta, and stays open; the box reads nothing more
    // than the first chunk and holds the connection (the review's B1).
    let more!: (event: unknown) => void;
    const upstream = upstreamOf(() => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(MESSAGE_START)}\n\n`));
          more = (event) =>
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const handle = await realProxy(ledger(), upstream.fetch);
    const response = await handle(boxRequest("/v1/messages"), BOX_A);
    await response.body!.getReader().read();
    await Bun.sleep(5);
    // Input and cache count at message_start, before the stream ends.
    expect(stored(f.run)).toMatchObject({ input: 40, output: 1, create: 30, read: 500 });
    more({ type: "message_delta", delta: {}, usage: { output_tokens: 700 } });
    await Bun.sleep(5);
    // The box never read it; the proxy read it from the upstream and counted it.
    expect(stored(f.run)).toMatchObject({ input: 40, output: 700, create: 30, read: 500 });
  });

  it("keeps the 1 hour share of the cache writes when a later report gives no split", async () => {
    const upstream = upstreamOf(() =>
      streamAnswer([
        MESSAGE_START,
        {
          type: "message_delta",
          delta: {},
          usage: { output_tokens: 5, cache_creation_input_tokens: 30 },
        },
      ]),
    );
    const handle = await realProxy(ledger(), upstream.fetch);
    await (await handle(boxRequest("/v1/messages"), BOX_A)).text();
    const split = f.office.get<{ m5: number; h1: number }>(
      `select sum(cache_create_5m) as m5, sum(cache_create_1h) as h1 from usage_totals
       where office_id = $office_id and run_id = $run`,
      { run: f.run },
    );
    expect(split).toEqual({ m5: 10, h1: 20 });
  });
});

describe("a Claude Code turn (criterion 3)", () => {
  it("is counted once: the proxy's count stands, and its stream adds no tokens but keeps the CLI's cost", async () => {
    // One recorded turn: its result reports 2 input, 155 output, 1,662 cache creation and 3,682
    // cache read tokens for claude-haiku-5-5, and its cost.
    const recording = withoutSkills(loadRecording("success-single"));
    const handle = await realProxy(
      ledger(),
      upstreamOf(() =>
        jsonAnswer(
          {
            input_tokens: 2,
            output_tokens: 155,
            cache_creation_input_tokens: 1_662,
            cache_read_input_tokens: 3_682,
          },
          "claude-haiku-5-5",
        ),
      ).fetch,
    );
    await handle(boxRequest("/v1/messages"), BOX_A);
    const counted = stored(f.run);
    // The same turn's stream, as a box session's adapter reads it.
    const adapter = claudeCliAdapter(
      context(),
      {
        spawn: () => {
          throw new Error("unused");
        },
        clock: new ManualClock(),
      },
      { boxWorker: true },
    ) as unknown as IngestAdapter;
    const ingestor = new Ingestor({ office: f.office, clock: f.t.clock });
    ingestor.track(
      target(f, adapter, initialState({ plannedModel: "haiku" }) as unknown as ParseState, {
        budgetLimit: BUDGET,
      }),
    );
    appendLines(f.eventFile, hostLines(recording));
    ingestor.pass(f.run, f.agent);
    ingestor.close();
    const after = stored(f.run);
    expect({ ...after, cost: null }).toEqual({ ...counted, cost: null });
    expect(after).toMatchObject({ input: 2, output: 155, create: 1_662, read: 3_682 });
    // The cost the CLI reported, as reported, on the row of the proxy's tokens.
    expect(after.cost).toBe(Math.round(0.00044692000000000006 * 1_000_000));
    const rows = f.office.all<{ model: string; turns: number; budget_used: number }>(
      `select model, turns, budget_used from usage_totals where office_id = $office_id and run_id = $run`,
      { run: f.run },
    );
    // The turns and the proxy's tokens sit on one model row.
    const row = rows.find((candidate) => candidate.model === "claude-haiku-5-5");
    expect(row).toMatchObject({ budget_used: 2 + 155 + 1_662 });
    expect(row?.turns).toBeGreaterThan(0);
    expect(rows.reduce((sum, candidate) => sum + candidate.turns, 0)).toBe(row?.turns ?? -1);
  });
});

describe("who sent it (criteria 4 and 6)", () => {
  it("knows the sender by its peer address only: a run named in a header or the body is ignored", async () => {
    const upstream = upstreamOf(() => jsonAnswer({ input_tokens: 10, output_tokens: 1 }));
    const handle = await realProxy(ledger(), upstream.fetch);
    // Box A claims box B's run every way it can.
    await handle(
      boxRequest(
        "/v1/messages",
        { model: "claude-haiku-5-5", metadata: { user_id: runB }, run: runB, agent: agentB },
        {
          "x-dipo-run": runB,
          "x-dipo-agent": agentB,
          forwarded: `for=${BOX_B}`,
          "x-forwarded-for": BOX_B,
        },
      ),
      BOX_A,
    );
    expect(stored(f.run)).toMatchObject({ input: 10, output: 1 });
    expect(stored(runB)).toMatchObject({ input: 0, output: 0 });
  });

  it("refuses an address no running session owns, and forwards nothing", async () => {
    const upstream = upstreamOf(() => jsonAnswer({ input_tokens: 10 }));
    const handle = await realProxy(ledger(), upstream.fetch);
    for (const peer of ["192.0.2.99", null, ""]) {
      const response = await handle(boxRequest("/v1/messages"), peer);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(TOKEN_TEXT);
    }
    // A box whose session ended: its entry went when its routes were released.
    owners.delete(BOX_B);
    expect((await handle(boxRequest("/v1/messages"), BOX_B)).status).toBe(403);
    expect(upstream.calls).toEqual([]);
  });

  it("knows an IPv4-mapped peer by its IPv4 address", () => {
    expect(peerAddress("::ffff:192.0.2.20")).toBe(BOX_A);
    expect(peerAddress(BOX_A)).toBe(BOX_A);
    expect(peerAddress("2001:db8::5")).toBe("2001:db8::5");
    expect(peerAddress(undefined)).toBeNull();
    expect(peerAddress("")).toBeNull();
  });

  it("sends its own login, never the box's Authorization or x-api-key, and still counts", async () => {
    const upstream = upstreamOf(() => jsonAnswer({ input_tokens: 3, output_tokens: 4 }));
    const handle = await realProxy(ledger(), upstream.fetch);
    await handle(
      boxRequest("/v1/messages", undefined, {
        authorization: "Bearer sk-ant-the-box-made-this-up",
        "x-api-key": "sk-ant-api03-another-key",
      }),
      BOX_A,
    );
    const headers = upstream.calls[0]?.headers;
    expect(headers?.get("authorization")).toBe(`Bearer ${TOKEN_TEXT}`);
    expect(headers?.get("x-api-key")).toBeNull();
    expect(stored(f.run)).toMatchObject({ input: 3, output: 4 });
  });
});

describe("the old barrier (criterion 5)", () => {
  it("refuses another path (404), method (405) and an oversized body (413), forwarding nothing", async () => {
    const upstream = upstreamOf(() => jsonAnswer({ input_tokens: 1 }));
    const handle = await realProxy(ledger(), upstream.fetch);
    expect((await handle(boxRequest("/v1/models"), BOX_A)).status).toBe(404);
    expect((await handle(boxRequest("/v1/messages/batches"), BOX_A)).status).toBe(404);
    const get = new Request(`http://${HOST}:4000/v1/messages`, { method: "GET" });
    expect((await handle(get, BOX_A)).status).toBe(405);
    const big = new Request(`http://${HOST}:4000/v1/messages`, {
      method: "POST",
      headers: { "content-length": String(65 * 1024 * 1024) },
      body: "{}",
    });
    expect((await handle(big, BOX_A)).status).toBe(413);
    expect(upstream.calls).toEqual([]);
    expect(stored(f.run)).toMatchObject({ input: 0, output: 0 });
  });

  it("passes a 3xx back as it came, without the token, and counts nothing for it", async () => {
    const upstream = upstreamOf(
      () => new Response(null, { status: 307, headers: { location: "/v1/oauth/steal" } }),
    );
    const handle = await realProxy(ledger(), upstream.fetch);
    const response = await handle(boxRequest("/v1/messages"), BOX_A);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/v1/oauth/steal");
    expect(JSON.stringify([...response.headers])).not.toContain(TOKEN_TEXT);
    expect(stored(f.run)).toMatchObject({ input: 0, output: 0 });
  });

  it("refuses count_tokens too when the run's office is not loaded", async () => {
    const upstream = upstreamOf(() => jsonAnswer({ input_tokens: 1 }));
    const handle = await realProxy(ledger(), upstream.fetch);
    owners.set(BOX_A, { office: "off_not_loaded", run: f.run, agent: f.agent });
    expect((await handle(boxRequest("/v1/messages/count_tokens"), BOX_A)).status).toBe(503);
    expect(upstream.calls).toEqual([]);
  });

  it("forwards count_tokens and adds no tokens for it", async () => {
    const upstream = upstreamOf(
      () =>
        new Response(JSON.stringify({ input_tokens: 4_000 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const handle = await realProxy(ledger(), upstream.fetch);
    const response = await handle(boxRequest("/v1/messages/count_tokens"), BOX_A);
    expect(response.status).toBe(200);
    expect(upstream.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/v1/messages/count_tokens",
    ]);
    expect(stored(f.run)).toMatchObject({ input: 0, output: 0, create: 0, read: 0 });
  });
});

describe("fail closed (criterion 7)", () => {
  it("refuses and forwards nothing when the registry lookup fails", async () => {
    const upstream = upstreamOf(() => jsonAnswer({ input_tokens: 1 }));
    const handle = await realProxy(
      ledger({
        owner: () => {
          throw new Error("the registry cannot be read");
        },
      }),
      upstream.fetch,
    );
    expect((await handle(boxRequest("/v1/messages"), BOX_A)).status).toBe(403);
    expect((await handle(boxRequest("/v1/messages/count_tokens"), BOX_A)).status).toBe(403);
    expect(upstream.calls).toEqual([]);
  });

  it("refuses and forwards nothing when the run's usage cannot be written", async () => {
    const upstream = upstreamOf(() => jsonAnswer({ input_tokens: 1 }));
    const handle = await realProxy(ledger(), upstream.fetch);
    // The registry names a run the office does not know, then an agent its run does not have.
    owners.set(BOX_A, { office: f.office.officeId, run: "run_unknown", agent: f.agent });
    expect((await handle(boxRequest("/v1/messages"), BOX_A)).status).toBe(503);
    owners.set(BOX_A, { office: f.office.officeId, run: f.run, agent: agentB });
    expect((await handle(boxRequest("/v1/messages"), BOX_A)).status).toBe(503);
    // An office that is not loaded.
    owners.set(BOX_A, { office: "off_not_loaded", run: f.run, agent: f.agent });
    expect((await handle(boxRequest("/v1/messages"), BOX_A)).status).toBe(503);
    // The database itself refuses the write.
    owners.set(BOX_A, { office: f.office.officeId, run: f.run, agent: f.agent });
    f.t.state.close();
    const refused = await handle(boxRequest("/v1/messages"), BOX_A);
    expect(refused.status).toBe(503);
    expect(await refused.text()).not.toContain(TOKEN_TEXT);
    expect(upstream.calls).toEqual([]);
    // `afterEach` closes it again.
    f = { ...f, t: { ...f.t, state: { close: () => {} } as unknown as typeof f.t.state } };
  });

  it("refuses with nothing forwarded when only the write fails and reads still work", async () => {
    const upstream = upstreamOf(() => jsonAnswer({ input_tokens: 1 }));
    const handle = await realProxy(ledger(), upstream.fetch);
    f.t.state.connection.exec("pragma query_only = 1");
    // The run and its agent are read, but the account cannot be written.
    expect(f.office.get("select 1 as found from runs where office_id = $office_id")).not.toBeNull();
    const refused = await handle(boxRequest("/v1/messages"), BOX_A);
    expect(refused.status).toBe(503);
    expect(upstream.calls).toEqual([]);
    f.t.state.connection.exec("pragma query_only = 0");
    expect((await handle(boxRequest("/v1/messages"), BOX_A)).status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
  });

  it("forwards nothing more after an answer's count failed, until a write goes through", async () => {
    const upstream = upstreamOf(() => {
      // The database stops taking writes while the model answers.
      f.t.state.connection.exec("pragma query_only = 1");
      return jsonAnswer({ input_tokens: 9 });
    });
    const handle = await realProxy(ledger(), upstream.fetch);
    expect((await handle(boxRequest("/v1/messages"), BOX_A)).status).toBe(503);
    expect((await handle(boxRequest("/v1/messages"), BOX_A)).status).toBe(503);
    // The retry was not forwarded: one request spent, none uncounted again.
    expect(upstream.calls).toHaveLength(1);
    f.t.state.connection.exec("pragma query_only = 0");
  });

  it("refuses new requests with 429 once the run's token cap is reached, forwarding nothing", async () => {
    const upstream = upstreamOf(() => jsonAnswer({ input_tokens: BUDGET, output_tokens: 1 }));
    const handle = await realProxy(ledger(), upstream.fetch);
    expect((await handle(boxRequest("/v1/messages"), BOX_A)).status).toBe(200);
    const capped = await handle(boxRequest("/v1/messages"), BOX_A);
    expect(capped.status).toBe(429);
    expect(await capped.text()).not.toContain(TOKEN_TEXT);
    expect(upstream.calls).toHaveLength(1);
    // Another run's box is not held by it.
    expect((await handle(boxRequest("/v1/messages"), BOX_B)).status).toBe(200);
  });

  it("records each refusal it sends against the run its peer address names, never one a header or body names (DIPO-484)", async () => {
    const upstream = upstreamOf(() => jsonAnswer({ input_tokens: BUDGET, output_tokens: 1 }));
    const handle = await realProxy(ledger(), upstream.fetch);
    expect(refusals()).toEqual([]);
    await handle(boxRequest("/v1/messages"), BOX_A);
    // BOX_A's run is capped; the request claims the other run in a header and in the body.
    const claimed = boxRequest(
      "/v1/messages",
      { model: "claude-haiku-5-5", run: runB },
      { "x-dipo-run": runB },
    );
    expect((await handle(claimed, BOX_A)).status).toBe(429);
    expect((await handle(boxRequest("/v1/messages"), BOX_A)).status).toBe(429);
    expect(refusals()).toEqual([
      { run: f.run, reason: CAP_REFUSAL },
      { run: f.run, reason: CAP_REFUSAL },
    ]);
    // A request that is passed on, or one from a box no session owns, records no refusal.
    expect((await handle(boxRequest("/v1/messages"), BOX_B)).status).toBe(200);
    expect((await handle(boxRequest("/v1/messages"), "192.0.2.99")).status).toBe(403);
    expect(refusals()).toHaveLength(2);
  });

  it("answers 503 instead of the body when an answer's usage cannot be added", async () => {
    const upstream = upstreamOf(() => jsonAnswer({ input_tokens: 1 }));
    const base = ledger();
    const handle = await realProxy(
      {
        owner: base.owner,
        open: () => () => {
          throw new Error("the write failed");
        },
      },
      upstream.fetch,
    );
    const response = await handle(boxRequest("/v1/messages"), BOX_A);
    expect(response.status).toBe(503);
  });
});

/** A run of any kind, with its one agent, for the cases of the session runs (DIPO-470). */
interface RunOf {
  readonly kind: "story" | "session";
  readonly role: string;
  readonly budgetLimit: number;
  readonly reviewMaxTokens?: number | null;
}

const AUDIT_BOX = "192.0.2.22";
const UNKNOWN_BOX = "192.0.2.23";
let storyNo = 100;

function addRunOf(run: RunId, agent: AgentId, of: RunOf): void {
  f.office.immediate(() => {
    const now = f.t.clock.now();
    let key: StoryKey | null = null;
    let story: string | null = null;
    if (of.kind === "story") {
      story = `DIPO-${storyNo++}`;
      key = addStory(f.office, f.t.ids, { story: StoryId.parse(story) }, now).key;
    }
    insertRun(f.office, {
      runId: run,
      kind: of.kind,
      key,
      story,
      tier: of.kind === "story" ? "S" : null,
      role: of.role,
      model: "haiku",
      startSha: of.kind === "story" ? "b".repeat(40) : null,
      branch: story === null ? null : `${story}/count`,
      budgetUnit: "tokens",
      budgetLimit: of.budgetLimit,
      loopCap: 0,
      reviewRoundCap: null,
      reviewMaxTokens: of.reviewMaxTokens ?? null,
      configHash: "h",
      overrideKeys: null,
      runProfileId: null,
      startedAt: now,
    });
    recordAgent(f.office, {
      agentId: agent,
      runId: run,
      role: of.role,
      model: "haiku",
      startedAt: now,
    });
  });
}

describe("session runs and the caps of a run (DIPO-470)", () => {
  it("forwards an idea audit's requests with no token cap and counts them, while a developer at its cap is refused", async () => {
    const audit = RunId.parse(f.t.ids.next("run"));
    const auditAgent = AgentId.parse(f.t.ids.next("agt"));
    addRunOf(audit, auditAgent, { kind: "session", role: "auditor", budgetLimit: 0 });
    owners.set(AUDIT_BOX, { office: f.office.officeId, run: audit, agent: auditAgent });
    const upstream = upstreamOf(() => jsonAnswer({ input_tokens: BUDGET, output_tokens: 1 }));
    const handle = await realProxy(ledger(), upstream.fetch);
    for (let i = 0; i < 3; i++) {
      expect((await handle(boxRequest("/v1/messages"), AUDIT_BOX)).status).toBe(200);
    }
    expect(upstream.calls).toHaveLength(3);
    expect(stored(audit)).toMatchObject({ input: 3 * BUDGET, output: 3 });
    // Fail closed on the same path: a developer over its cap gets 429 and nothing more is forwarded.
    expect((await handle(boxRequest("/v1/messages"), BOX_A)).status).toBe(200);
    expect((await handle(boxRequest("/v1/messages"), BOX_A)).status).toBe(429);
    expect(upstream.calls).toHaveLength(4);
  });

  it("refuses a scan session over its real budget with 429", async () => {
    const scan = RunId.parse(f.t.ids.next("run"));
    const scanAgent = AgentId.parse(f.t.ids.next("agt"));
    addRunOf(scan, scanAgent, { kind: "session", role: "scanner", budgetLimit: BUDGET });
    owners.set(AUDIT_BOX, { office: f.office.officeId, run: scan, agent: scanAgent });
    const upstream = upstreamOf(() => jsonAnswer({ input_tokens: BUDGET, output_tokens: 1 }));
    const handle = await realProxy(ledger(), upstream.fetch);
    expect((await handle(boxRequest("/v1/messages"), AUDIT_BOX)).status).toBe(200);
    expect((await handle(boxRequest("/v1/messages"), AUDIT_BOX)).status).toBe(429);
    expect(upstream.calls).toHaveLength(1);
  });

  it("refuses a reviewer over its own cap with 429 while its run is under budget", async () => {
    const run = RunId.parse(f.t.ids.next("run"));
    const reviewer = AgentId.parse(f.t.ids.next("agt"));
    addRunOf(run, reviewer, {
      kind: "story",
      role: "reviewer",
      budgetLimit: BUDGET,
      reviewMaxTokens: 500,
    });
    owners.set(AUDIT_BOX, { office: f.office.officeId, run, agent: reviewer });
    const upstream = upstreamOf(() => jsonAnswer({ input_tokens: 600, output_tokens: 1 }));
    const handle = await realProxy(ledger(), upstream.fetch);
    expect((await handle(boxRequest("/v1/messages"), AUDIT_BOX)).status).toBe(200);
    expect((await handle(boxRequest("/v1/messages"), AUDIT_BOX)).status).toBe(429);
    expect(upstream.calls).toHaveLength(1);
  });

  it("refuses a request from an address no running session owns with 403, forwarding nothing", async () => {
    const upstream = upstreamOf(() => jsonAnswer({ input_tokens: 1 }));
    const handle = await realProxy(ledger(), upstream.fetch);
    expect((await handle(boxRequest("/v1/messages"), UNKNOWN_BOX)).status).toBe(403);
    expect(upstream.calls).toEqual([]);
  });

  const bypasses: [string, RunOf][] = [
    [
      "a story run recorded with budget limit 0",
      { kind: "story", role: "developer", budgetLimit: 0 },
    ],
    ["a planner agent on a story run", { kind: "story", role: "planner", budgetLimit: BUDGET }],
    ["an auditor agent on a story run", { kind: "story", role: "auditor", budgetLimit: BUDGET }],
    ["an agent with an unknown role", { kind: "story", role: "intruder", budgetLimit: BUDGET }],
  ];
  for (const [name, of] of bypasses) {
    it(`refuses ${name} with 429 once its tokens reach its budget`, async () => {
      const run = RunId.parse(f.t.ids.next("run"));
      const agent = AgentId.parse(f.t.ids.next("agt"));
      addRunOf(run, agent, of);
      owners.set(AUDIT_BOX, { office: f.office.officeId, run, agent });
      const upstream = upstreamOf(() => jsonAnswer({ input_tokens: BUDGET, output_tokens: 1 }));
      const handle = await realProxy(ledger(), upstream.fetch);
      if (of.budgetLimit === 0) {
        expect((await handle(boxRequest("/v1/messages"), AUDIT_BOX)).status).toBe(429);
        expect(upstream.calls).toEqual([]);
        return;
      }
      expect((await handle(boxRequest("/v1/messages"), AUDIT_BOX)).status).toBe(200);
      expect((await handle(boxRequest("/v1/messages"), AUDIT_BOX)).status).toBe(429);
      expect(upstream.calls).toHaveLength(1);
    });
  }
});
