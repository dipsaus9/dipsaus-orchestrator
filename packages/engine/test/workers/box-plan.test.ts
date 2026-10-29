// The box worker's launch (DIPO-271, criteria 1 and 2): the worker host starts claude inside the
// story's box as a long-running `container exec`, with the stream-json input and output it reads
// from a Mac worker; inside the box claude runs with all permissions, and none of the Mac worker's
// sandbox settings, hooks or permission relay is planned. A run is a box run when its run
// directory records a box; its reviewer runs in a read-only box of its own (`review-tools.test.ts`).
// The box's placeholder key is accepted at `system/init` for a box run's sessions.

import { describe, expect, it } from "bun:test";

import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config";
import type { BoxSession } from "../../src/box/workers";
import { BOX_PLACEHOLDER_API_KEY } from "../../src/box/model-proxy";
import { uncontained } from "../../src/box/firewall";
import { BOX_USER_ENV } from "../../src/box/user";
import { BoxError } from "../../src/box/port";
import { BOX_REST_WAIT_CODE } from "../../src/box/workers";
import { BOX_TOKEN_CHECK } from "../../src/box/token-check";
import {
  type ClaudeBoxWorkers,
  claudeCliAdapter,
  claudeWorkerPort,
} from "../../src/workers/claude-cli/adapter";
import { BOX_CLAUDE, BOX_CLAUDE_ENV, planInBox } from "../../src/workers/claude-cli/box-plan";
import { userMessageLine } from "../../src/workers/claude-cli/encode";
import { initialState } from "../../src/workers/claude-cli/interpret";
import { AdapterHolds, type StickyHoldStore } from "../../src/workers/hold";
import type { RunLaunchPaths } from "../../src/workers/port";
import { PlanError, type HostLine, type ParseState } from "../../src/workers/types";
import { FAKE_CLIENT_ENV, FAKE_CONTAINER, FakeBoxes } from "../box/fake-boxes";
import {
  context,
  HOME,
  MAIN,
  reviewSpec,
  RUN_DIR,
  SHORT_TMP_DIR,
  spec,
  TMP_DIR,
  WORKDIR,
} from "./launch-fixtures";

const BOX = "dipo-run-0001";
const ROUTES = {
  ANTHROPIC_API_KEY: BOX_PLACEHOLDER_API_KEY,
  ANTHROPIC_BASE_URL: "http://192.0.2.10:4000",
  NO_PROXY: "192.0.2.10",
  HTTPS_PROXY: "http://192.0.2.10:3128",
  HTTP_PROXY: "http://192.0.2.10:3128",
  NODE_EXTRA_CA_CERTS: "/dipo/safe-chain-ca.pem",
};
const PATHS: RunLaunchPaths = {
  workdir: WORKDIR,
  mainCheckout: MAIN,
  runDir: RUN_DIR,
  hostSocket: `${RUN_DIR}/host.sock`,
  tmpDir: TMP_DIR,
  shortTmpDir: SHORT_TMP_DIR,
};

function session(): BoxSession {
  const boxes = new FakeBoxes();
  return {
    box: BOX,
    workdir: "/work",
    env: ROUTES,
    systemFile: "/dipo/system.md",
    exec: (command, env) => boxes.execLiveCommand(BOX, command, { cwd: "/work", env }),
    stop: boxes.stopCommand(BOX),
  };
}

/** The `--env` values of a `container exec` argv, as the box gets them. */
function boxEnv(argv: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--env") continue;
    const [key, ...value] = (argv[i + 1] ?? "").split("=");
    env[key ?? ""] = value.join("=");
  }
  return env;
}

/** The argv after the box name: what runs inside the box. */
/** The command the worker runs in the box; it must run contained (DIPO-281, `firewall.ts`). */
function inBox(argv: readonly string[]): string[] {
  const inner = uncontained(argv.slice(argv.indexOf(BOX) + 1));
  if (inner === null) throw new Error(`the box command is not contained: ${argv.join(" ")}`);
  return [...inner];
}

describe("the box worker's plan (criteria 1 and 2)", () => {
  it("runs claude in the box as a long-running exec with the stream-json input and output", () => {
    const plan = planInBox(spec(), session(), RUN_DIR);
    expect(plan.argv.slice(0, 5)).toEqual([
      FAKE_CONTAINER,
      "exec",
      "--interactive",
      "--workdir",
      "/work",
    ]);
    expect(inBox(plan.argv)).toEqual([
      BOX_CLAUDE,
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--session-id",
      spec().session.id,
      "--model",
      "sonnet",
      "--effort",
      "medium",
      "--max-turns",
      "120",
      "--permission-mode",
      "bypassPermissions",
      "--tools",
      "Read,Edit,Write,Glob,Grep,Bash",
      "--strict-mcp-config",
      "--append-system-prompt-file",
      "/dipo/system.md",
      "--exclude-dynamic-system-prompt-sections",
      "--disable-slash-commands",
      "--json-schema",
      JSON.stringify(spec().reportSchema),
    ]);
    // The task is the first stream-json user message, on stdin, as for a Mac worker.
    expect(plan.stdin).toEqual([userMessageLine(spec().taskMessage)]);
    // A resumed session resumes in the box.
    const resumed = planInBox(
      spec({ session: { id: spec().session.id, resume: true } }),
      session(),
      RUN_DIR,
    );
    expect(inBox(resumed.argv)).toContain("--resume");
  });

  it("plans no sandbox settings, hooks, permission relay or dipo socket for the box", () => {
    const plan = planInBox(spec(), session(), RUN_DIR);
    const text = JSON.stringify(plan);
    expect(plan.files).toEqual([]);
    for (const flag of [
      "--settings",
      "--setting-sources",
      "--permission-prompts",
      "--mcp-config",
    ]) {
      expect(plan.argv).not.toContain(flag);
    }
    expect(text).not.toContain("DIPO_HOST_SOCKET");
    expect(text).not.toContain("host.sock");
    expect(text).not.toContain(" hook ");
    // Nothing of the Mac's home reaches the box's argv; the host's cwd is the run directory.
    expect(JSON.stringify(plan.argv)).not.toContain(HOME);
    // The box gets exactly the routes' variables and what claude needs; the client on the Mac
    // only the backend's client environment.
    // The box user's home and PATH first (DIPO-334).
    expect(boxEnv(plan.argv)).toEqual({ ...BOX_USER_ENV, ...ROUTES, ...BOX_CLAUDE_ENV });
    expect(plan.env).toEqual(FAKE_CLIENT_ENV);
    expect(plan.cwd).toBe(RUN_DIR);
    // The host stops the box, since a killed exec client leaves claude running in it.
    expect(plan.stopCommand).toEqual([FAKE_CONTAINER, "stop", BOX]);
  });

  it("plans a developer or reviewer session in a box, never a `session`", () => {
    expect(() => planInBox(spec({ kind: "session", web: false }), session(), RUN_DIR)).toThrow(
      PlanError,
    );
    expect(() =>
      planInBox(
        reviewSpec({ session: { id: spec().session.id, resume: true } }),
        session(),
        RUN_DIR,
      ),
    ).toThrow(/never resumed/);
  });
});

const clock = new ManualClock();
const neverSpawn = () => {
  throw new Error("no Mac launch check may run for a box worker");
};

function port(boxes: ClaudeBoxWorkers, holds: AdapterHolds) {
  return claudeWorkerPort({
    claudePath: `${HOME}/.local/bin/claude`,
    home: HOME,
    env: { PATH: "/usr/bin:/bin", HOME },
    spawn: neverSpawn,
    clock,
    holds,
    pluginFiles: { read: () => undefined, dirs: () => [] },
    boxes,
  });
}

describe("the Claude worker port with box workers", () => {
  it("prepares a box run's developer session in its box, with none of the Mac launch checks", async () => {
    const asked: unknown[] = [];
    const holds = new AdapterHolds({ clock, notify: () => {} });
    const prepared = await port(
      {
        isBoxRun: (runDir) => runDir === RUN_DIR,
        session: async (input) => {
          asked.push(input);
          return session();
        },
      },
      holds,
    ).prepare(spec(), PATHS, OFFICE_DEFAULTS, "7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d");
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(asked).toEqual([
      { runId: "run-0001", runDir: RUN_DIR, systemFile: `${RUN_DIR}/system.md` },
    ]);
    expect(inBox(prepared.plan.argv)[0]).toBe(BOX_CLAUDE);
    expect(prepared.plan.lineScrub).toBeDefined();
  });

  it("refuses a box run's launch while the sticky box-token hold stands, before the box is used", async () => {
    let record: ReturnType<StickyHoldStore["read"]> = null;
    const holds = new AdapterHolds({
      clock,
      notify: () => {},
      sticky: {
        checks: new Set([BOX_TOKEN_CHECK]),
        liftedBy: "Replace the box login with `dipo login box`.",
        store: {
          read: () => record,
          write: (next) => {
            record = next;
          },
          clear: () => {
            record = null;
          },
        },
      },
    });
    holds.hold("claude-cli", [{ check: BOX_TOKEN_CHECK, detail: "the token was found" }]);
    let used = false;
    const prepared = await port(
      {
        isBoxRun: () => true,
        session: async () => {
          used = true;
          return session();
        },
      },
      holds,
    ).prepare(spec(), PATHS, OFFICE_DEFAULTS, "7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d");
    expect(prepared).toMatchObject({
      ok: false,
      outcome: "startFailed",
      hold: { check: BOX_TOKEN_CHECK },
    });
    expect(used).toBe(false);
  });

  it("holds the adapter when the box cannot be made ready, and refuses a run whose box is gone as a plan", async () => {
    const holds = new AdapterHolds({ clock, notify: () => {} });
    const broken = await port(
      {
        isBoxRun: () => true,
        session: async () => {
          throw new BoxError("box.failed", "container system is not running");
        },
      },
      holds,
    ).prepare(spec(), PATHS, OFFICE_DEFAULTS, "7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d");
    expect(broken).toMatchObject({ ok: false, hold: { check: "box" } });
    expect(holds.adapterHeld("claude-cli")?.detail).toContain("container system is not running");

    const gone = port(
      {
        isBoxRun: () => true,
        session: async () => {
          throw new BoxError("box.gone", "the box was deleted when the run ended");
        },
      },
      new AdapterHolds({ clock, notify: () => {} }),
    ).prepare(spec(), PATHS, OFFICE_DEFAULTS, "7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d");
    expect(await gone.catch((error: unknown) => error)).toBeInstanceOf(PlanError);
  });

  it("refuses a session that waited too long for its box's rest through the start failure path (DIPO-278)", async () => {
    const holds = new AdapterHolds({ clock, notify: () => {} });
    const waited = await port(
      {
        isBoxRun: () => true,
        session: async () => {
          throw new BoxError(
            BOX_REST_WAIT_CODE,
            "the box of run run_1 is still being checked and stopped after 15 minutes; the session did not start.",
          );
        },
      },
      holds,
    ).prepare(spec(), PATHS, OFFICE_DEFAULTS, "7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d");
    expect(waited).toMatchObject({ ok: false, outcome: "startFailed", hold: { check: "box" } });
    expect(holds.adapterHeld("claude-cli")?.detail).toContain("the session did not start");
  });

  it("never plans a developer session on the Mac: a run without a box, or a daemon without box workers, is refused as a plan (DIPO-240)", async () => {
    const holds = new AdapterHolds({ clock, notify: () => {} });
    const noBox = port({ isBoxRun: () => false, session: async () => session() }, holds);
    const refused = await noBox
      .prepare(spec(), PATHS, OFFICE_DEFAULTS, "7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d")
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PlanError);
    expect((refused as PlanError).message).toContain("and the run has no box");
    const noWorkers = claudeWorkerPort({
      claudePath: `${HOME}/.local/bin/claude`,
      home: HOME,
      env: { PATH: "/usr/bin:/bin", HOME },
      spawn: neverSpawn,
      clock,
      holds,
    });
    const without = await noWorkers
      .prepare(spec(), PATHS, OFFICE_DEFAULTS, "7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d")
      .catch((error: unknown) => error);
    expect((without as PlanError).message).toContain("this daemon has no box backend");
    expect(holds.adapterHeld("claude-cli")).toBeNull();
  });

  it("shows the dry run the command Claude Code runs in the box, with placeholders (DIPO-240)", () => {
    const preview = port(
      { isBoxRun: () => false, session: async () => session() },
      new AdapterHolds({ clock, notify: () => {} }),
    ).previewBox?.(spec(), PATHS);
    expect(preview?.argv[0]).toBe(BOX_CLAUDE);
    expect(preview?.argv).toContain("bypassPermissions");
    expect(preview?.files).toEqual([]);
    expect(Object.keys(preview?.env ?? {})).toContain("HTTPS_PROXY");
  });
});

function init(apiKeySource: string): HostLine {
  return {
    t: 1,
    ch: "stdout",
    data: `${JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "s",
      model: "claude-sonnet-5",
      claude_code_version: "2.1.303",
      cwd: "/work",
      permissionMode: "bypassPermissions",
      tools: ["Bash", "Read"],
      apiKeySource,
      mcp_servers: [],
      slash_commands: [],
      skills: [],
      plugins: [],
    })}\n`,
  };
}
const initDeps = {
  spawn: () => {
    throw new Error("unused");
  },
  clock: new ManualClock(),
};

/** True when the init line with the placeholder key's source is rejected. */
function rejected(boxWorker: boolean, reportKind: "implement" | "review"): boolean {
  const adapter = claudeCliAdapter(context(), initDeps, { boxWorker });
  const state = initialState({ reportKind }) as unknown as ParseState;
  const events = adapter.interpret(init("ANTHROPIC_API_KEY"), state).events;
  return events.some((event) => event.t === "initRejected");
}

describe("the box's placeholder key at system/init", () => {
  it("is accepted for the box's developer, and refused for a developer off a box run", () => {
    expect(rejected(true, "implement")).toBe(false);
    expect(rejected(false, "implement")).toBe(true);
  });

  it("is accepted for every reviewer, whose session runs in its box, with or without the run's box record (DIPO-347)", () => {
    const holds = new AdapterHolds({ clock, notify: () => {} });
    for (const boxRun of [true, false]) {
      const claude = port({ isBoxRun: () => boxRun, session: async () => session() }, holds);
      const adapter = claude.adapter(PATHS, OFFICE_DEFAULTS);
      const state = claude.initialState(reviewSpec({ model: "sonnet" }));
      const events = adapter.interpret(init("ANTHROPIC_API_KEY"), state).events;
      expect(events.some((event) => event.t === "initRejected")).toBe(false);
    }
    // A developer's state from its spec carries no exemption of its own.
    const developer = port({ isBoxRun: () => false, session: async () => session() }, holds);
    const events = developer
      .adapter(PATHS, OFFICE_DEFAULTS)
      .interpret(init("ANTHROPIC_API_KEY"), developer.initialState(spec())).events;
    expect(events.some((event) => event.t === "initRejected")).toBe(true);
  });
});
