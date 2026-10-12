// Example messages for the contract tests. Plain data on purpose: each one must earn its pass by
// parsing, not by type-checking. Every new contract shape adds a fixture here (DIPO-15 rule).

const ULID = "01J9ZK5Q8W3V4X6Y7Z8A9B0C1D";
const ULID2 = "01J9ZK5Q8W3V4X6Y7Z8A9B0C2E";

export const ids = {
  office: `off_${ULID}`,
  storyKey: `sto_${ULID}`,
  run: `run_${ULID}`,
  agent: `agt_${ULID}`,
  gate: `gat_${ULID}`,
  question: `qst_${ULID}`,
  test: `tst_${ULID}`,
  request: ULID,
  request2: ULID2,
};

export const softwareCursor = { stream: "software", epoch: "e1", seq: 42 };
export const officeCursor = { stream: `office:${ids.office}`, epoch: "e2", seq: 7 };

export const officeSummary = {
  office: ids.office,
  name: "dipsaus-orchestrator",
  path: "/Users/me/code/dipsaus-orchestrator",
  running: 1,
  parked: 2,
  onHold: 1,
  waitingOnMaintainer: 1,
};

export const commandFixtures: Record<string, { args: unknown; result: unknown }> = {
  "office.open": {
    args: { path: "/Users/me/code/dipsaus-orchestrator" },
    result: { office: ids.office, registered: true },
  },
  "office.forget": { args: { office: ids.office }, result: { office: ids.office } },
  "office.init": {
    args: { office: ids.office },
    result: { office: ids.office, pr: { number: 12, url: "https://github.com/o/r/pull/12" } },
  },
  "office.purge": { args: { office: ids.office }, result: { office: ids.office } },
  "office.rescan": { args: {}, result: { scan: "started" } },
  "office.reloadConfig": {
    args: { office: ids.office },
    result: {
      office: ids.office,
      valid: false,
      errors: [".dipo/office.yaml: caps.maxAgents: expected number"],
    },
  },
  "daemon.stop": { args: { stopWorkers: false }, result: { state: "draining" } },
  "daemon.setLogLevel": { args: { level: "debug" }, result: { level: "debug" } },
  "daemon.resumeScheduling": { args: {}, result: { state: "running" } },
};

export const readFixtures: Record<string, { args: unknown; result: unknown }> = {
  "engine.hello": {
    args: { contract: { major: 1, minor: 0 }, client: { name: "dipo-cli", version: "0.1.0" } },
    result: {
      engine: "0.1.0",
      contract: { major: 1, minor: 0 },
      capabilities: ["replay", "daemon.control"],
      daemon: "running",
      offices: [officeSummary],
      cursor: softwareCursor,
    },
  },
  "commands.describe": {
    args: {},
    result: {
      commands: [
        {
          name: "office.purge",
          args: {
            type: "object",
            properties: { office: { type: "string" } },
            required: ["office"],
          },
          result: { type: "object" },
          since: 0,
          level: "software",
          confirm: true,
          irreversible: true,
        },
      ],
      reads: [
        {
          name: "daemon.status",
          args: { type: "object", properties: {} },
          result: { type: "object" },
          since: 0,
        },
      ],
    },
  },
  "daemon.status": {
    args: {},
    result: {
      state: "running",
      pid: 4242,
      version: "0.1.0",
      uptimeMs: 60_000,
      socket: "/Users/me/.local/state/dipo/run/dipo.sock",
      loadedOffices: [ids.office],
      activeRuns: 1,
      keepAwake: { held: true, reason: "1 active run" },
      upgradePending: false,
      tools: {
        claude: "/Users/me/.local/bin/claude",
        backlog: "/opt/homebrew/bin/backlog",
        gh: "/opt/homebrew/bin/gh",
        git: "/usr/bin/git",
        // rg was not found on PATH, so it is absent.
      },
    },
  },
};

export const eventFixtures: Record<string, unknown> = {
  "office.registered": { office: ids.office, path: officeSummary.path, name: officeSummary.name },
  "office.forgotten": { office: ids.office },
  "office.summary": officeSummary,
  "daemon.state": { from: "recovering", to: "safe", reason: "crash loop" },
  "scan.finished": { scripts: { verify: "bun run verify" }, warnings: [] },
  "engine.notice": { level: "warn", code: "reconcile.mismatch", text: "DIPO-3 vanished." },
  "stream.mark": { caughtUp: true },
};

const event = {
  cursor: officeCursor,
  at: "2026-10-12T09:00:00Z",
  type: "scan.finished",
  causedBy: ids.request,
  data: eventFixtures["scan.finished"],
};

export const clientFrameFixtures: Record<string, unknown> = {
  "auth with code": { kind: "auth", requestId: ids.request, code: "c0de" },
  "auth with token": { kind: "auth", requestId: ids.request, token: "t0ken" },
  command: {
    kind: "command",
    requestId: ids.request,
    name: "office.open",
    args: commandFixtures["office.open"]?.args,
    origin: "cli",
  },
  "office command": {
    kind: "command",
    requestId: ids.request,
    office: ids.office,
    name: "office.rescan",
    args: {},
    origin: "conversation",
    confirmed: true,
  },
  read: { kind: "read", requestId: ids.request, name: "daemon.status", args: {} },
  subscribe: {
    kind: "subscribe",
    requestId: ids.request,
    stream: `office:${ids.office}`,
    after: officeCursor,
    filter: ["work.", "story."],
  },
  unsubscribe: { kind: "unsubscribe", stream: "software" },
};

export const serverFrameFixtures: Record<string, unknown> = {
  "command reply": {
    kind: "reply",
    reply: {
      ok: true,
      requestId: ids.request,
      result: { scan: "started" },
      changed: true,
      cursor: officeCursor,
    },
  },
  "read reply": { kind: "reply", reply: { ok: true, requestId: ids.request, result: {} } },
  "error reply": {
    kind: "reply",
    reply: {
      ok: false,
      requestId: ids.request,
      error: {
        code: "contract.unsupported",
        message: "The daemon speaks contract 2.0.",
        retryable: false,
        details: { contract: { major: 2, minor: 0 }, version: "2.0.0" },
      },
    },
  },
  events: { kind: "events", events: [event] },
};

export const malformedClientFrames: Record<string, unknown> = {
  "unknown kind": { kind: "hello", requestId: ids.request },
  "auth with code and token": {
    kind: "auth",
    requestId: ids.request,
    code: "c0de",
    token: "t0ken",
  },
  "auth with neither": { kind: "auth", requestId: ids.request },
  "bad request id": { kind: "read", requestId: "not-a-ulid", name: "daemon.status", args: {} },
  "bad origin": { ...(clientFrameFixtures["command"] as object), origin: "robot" },
  "bad stream": { kind: "unsubscribe", stream: "office:nope" },
};

export const malformedServerFrames: Record<string, unknown> = {
  "unknown kind": { kind: "push", events: [] },
  "empty events": { kind: "events", events: [] },
  "command reply without changed and result": { kind: "reply", reply: { ok: true } },
};
