// `dipo hook <event> [--wait <seconds>]` (DIPO-59 AC #1): the hidden form reads the payload, relays
// it over the host protocol's handshake, prints only the host's answer, and exits 0 silently on
// every failure. A small line-socket server stands in for the worker host.

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ChildExit, ChildProcess, Spawn } from "@dipsaus-orchestrator/contract";
import {
  CLAUDE_GATE_NO_DECISION_MARKER,
  connectHost,
  GH_REFUSAL,
  hostSocketPath,
  LAUNCH_FILE,
  listenLineSocket,
  systemClock,
  WorkerHost,
  type HostClient,
  type HostLaunch,
} from "@dipsaus-orchestrator/engine";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  BASH_GH_FAILED_REASON,
  GATE_FAILED_REASON,
  GATE_NO_ANSWER_REASON,
  gateDenyOutput,
  HOOK_DEADLINE_MS,
  NUDGE_REPLY_MARGIN_MS,
  parseHookArgs,
  runHookForm,
  trimPayload,
} from "./hook";
import { defaultIo, type DaemonIo } from "./io";

const RUN = "run_01JZ0000000000000000000009";

function io(env: Record<string, string>, input: string | null, out: string[]): DaemonIo {
  return {
    ...defaultIo,
    env,
    clock: systemClock,
    writeLine: (line) => out.push(`line:${line}`),
    writeError: (line) => out.push(`err:${line}`),
    write: (text) => out.push(text),
    readInput: async () => input,
  };
}

/** A PreToolUse payload of a WebFetch call for `url` (DIPO-164). */
const PAYLOAD = (url: string) =>
  JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "WebFetch",
    tool_input: { url, prompt: "summarise" },
  });

/** A host that answers the handshake with version 2 and every hook op with `output`. */
function fakeHost(path: string, output: string, frames: unknown[]) {
  return listenLineSocket(path, (connection) => ({
    line: (text) => {
      const frame = JSON.parse(text) as Record<string, unknown>;
      frames.push(frame);
      if (frame["kind"] === "hello") {
        connection.send(JSON.stringify({ kind: "hello", version: 2, run: RUN, pid: 1 }));
      } else {
        connection.send(
          JSON.stringify({ kind: "reply", id: frame["id"], ok: true, result: { output } }),
        );
      }
    },
    closed: () => undefined,
  }));
}

describe("dipo hook", () => {
  it("parses the event and an optional --wait in seconds", () => {
    expect(parseHookArgs(["Stop"])).toEqual({ event: "Stop" });
    expect(parseHookArgs(["PermissionRequest", "--wait", "300"])).toEqual({
      event: "PermissionRequest",
      waitMs: 300_000,
    });
    expect(parseHookArgs([])).toBeNull();
    expect(parseHookArgs(["Stop", "--wait", "0"])).toBeNull();
    expect(parseHookArgs(["Stop", "--wait", "99999"])).toBeNull();
    expect(parseHookArgs(["bad name"])).toBeNull();
  });

  it("exits 0 and prints nothing without a host socket, with bad arguments or an unreachable host", () =>
    withTempDir(async (dir) => {
      const out: string[] = [];
      expect(await runHookForm(["Stop"], io({}, "{}", out))).toBe(0);
      const env = { DIPO_HOST_SOCKET: join(dir, "none.sock"), DIPO_RUN: RUN };
      expect(await runHookForm([], io(env, "{}", out))).toBe(0);
      expect(await runHookForm(["Stop"], io(env, "{}", out))).toBe(0);
      expect(await runHookForm(["Stop"], io(env, null, out))).toBe(0);
      expect(out).toEqual([]);
    }));

  it("relays the payload with the hook versions and prints the host's answer as is", () =>
    withTempDir(async (dir) => {
      const socket = join(dir, "h.sock");
      const frames: unknown[] = [];
      const server = fakeHost(socket, '{"decision":"x"}', frames);
      try {
        const out: string[] = [];
        const env = { DIPO_HOST_SOCKET: socket, DIPO_RUN: RUN };
        const code = await runHookForm(
          ["PermissionRequest", "--wait", "5"],
          io(env, '{"hook_event_name":"PermissionRequest"}\n', out),
        );
        expect(code).toBe(0);
        expect(out).toEqual(['{"decision":"x"}']);
        expect(frames).toEqual([
          { kind: "hello", versions: [2], run: RUN },
          {
            kind: "op",
            id: 1,
            op: "hook",
            payload: '{"hook_event_name":"PermissionRequest"}\n',
            waitMs: 5000,
          },
        ]);
      } finally {
        await server.stop();
      }
    }));
});

describe("dipo hook payloads and deadline (DIPO-59 review)", () => {
  it("relays only scalar fields, long strings cut, of a call that does not wait, and a waiting call whole", () => {
    const payload = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "a.ts" },
      tool_response: { content: "x".repeat(100_000) },
      last_assistant_message: "y".repeat(5000),
      stop_hook_active: false,
    });
    expect(JSON.parse(trimPayload(payload, false))).toEqual({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "a.ts" },
      last_assistant_message: "y".repeat(1024),
      stop_hook_active: false,
    });
    const failure = JSON.stringify({
      hook_event_name: "StopFailure",
      error: "rate_limit",
      error_type: "e".repeat(2000),
    });
    expect(JSON.parse(trimPayload(failure, false))).toEqual({
      hook_event_name: "StopFailure",
      error: "rate_limit",
      error_type: "e".repeat(1024),
    });
    expect(trimPayload(payload, true)).toBe(payload);
    expect(trimPayload("not json", false)).toBe("not json");
  });
});

/** A host that answers the handshake and holds every hook op, answering after `afterMs` or never. */
function slowHost(path: string, output: string, frames: unknown[], afterMs: number | null) {
  return listenLineSocket(path, (connection) => ({
    line: (text) => {
      const frame = JSON.parse(text) as Record<string, unknown>;
      frames.push(frame);
      if (frame["kind"] === "hello") {
        connection.send(JSON.stringify({ kind: "hello", version: 2, run: RUN, pid: 1 }));
      } else if (afterMs !== null) {
        systemClock.setTimeout(() => {
          connection.send(
            JSON.stringify({ kind: "reply", id: frame["id"], ok: true, result: { output } }),
          );
        }, afterMs);
      }
    },
    closed: () => undefined,
  }));
}

describe("dipo hook --nudge (DIPO-60 AC #3)", () => {
  it("parses --nudge without a value", () => {
    expect(parseHookArgs(["PostToolUse", "--nudge"])).toEqual({
      event: "PostToolUse",
      nudge: true,
    });
    expect(parseHookArgs(["PostToolUse", "--nudge", "5"])).toBeNull();
  });

  it("keeps only the written file's path of a tool input", () => {
    const payload = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/w/a.ts", old_string: "a", new_string: "b".repeat(5000) },
    });
    expect(JSON.parse(trimPayload(payload, false))).toEqual({
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/w/a.ts" },
    });
    const bash = JSON.stringify({ hook_event_name: "PostToolUse", tool_input: { command: "ls" } });
    expect(JSON.parse(trimPayload(bash, false))).toEqual({ hook_event_name: "PostToolUse" });
  });

  it("asks the host to hold the call within the deadline and prints the nudge it answers", () =>
    withTempDir(async (dir) => {
      const socket = join(dir, "n.sock");
      const frames: Record<string, unknown>[] = [];
      const nudge =
        '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"x"}}';
      const server = slowHost(socket, nudge, frames, 50);
      try {
        const out: string[] = [];
        const env = { DIPO_HOST_SOCKET: socket, DIPO_RUN: RUN };
        await runHookForm(
          ["PostToolUse", "--nudge"],
          io(env, '{"hook_event_name":"PostToolUse"}', out),
        );
        expect(out).toEqual([nudge]);
        const op = frames.find((frame) => frame["op"] === "hook");
        expect(op?.["waitMs"]).toBeGreaterThan(0);
        expect(op?.["waitMs"]).toBeLessThanOrEqual(HOOK_DEADLINE_MS - NUDGE_REPLY_MARGIN_MS);
      } finally {
        await server.stop();
      }
    }));

  it("ends within 2 s and prints nothing when the host never answers", () =>
    withTempDir(async (dir) => {
      const socket = join(dir, "s.sock");
      const server = slowHost(socket, "late", [], null);
      try {
        const out: string[] = [];
        const env = { DIPO_HOST_SOCKET: socket, DIPO_RUN: RUN };
        const started = systemClock.now();
        const code = await runHookForm(
          ["SessionStart", "--nudge"],
          io(env, '{"hook_event_name":"SessionStart"}', out),
        );
        expect(code).toBe(0);
        expect(systemClock.now() - started).toBeLessThan(2_000);
        expect(out).toEqual([]);
      } finally {
        await server.stop();
      }
    }));
});

describe("dipo hook --gate (DIPO-164; 0020 section 11b)", () => {
  const DENY_NO_ANSWER = gateDenyOutput(GATE_NO_ANSWER_REASON);

  it("parses --gate without a value", () => {
    expect(parseHookArgs(["PreToolUse", "--gate"])).toEqual({ event: "PreToolUse", gate: true });
    expect(parseHookArgs(["PreToolUse", "--gate", "5"])).toBeNull();
  });

  it("keeps a URL or query whole, never cut, and drops the rest of the tool input", () => {
    const url = `https://x.test/?q=${"a".repeat(5000)}`;
    const kept = JSON.parse(trimPayload(PAYLOAD(url), false, true)) as {
      tool_input: Record<string, unknown>;
    };
    expect(kept.tool_input).toEqual({ url });
    const search = JSON.stringify({ tool_name: "WebSearch", tool_input: { query: "q", x: "y" } });
    expect(JSON.parse(trimPayload(search, false, true))).toEqual({
      tool_name: "WebSearch",
      tool_input: { query: "q" },
    });
  });

  it("prints the engine's deny as is, nothing for the engine's pass marker, and a deny for an empty or any other answer", () =>
    withTempDir(async (dir) => {
      const deny = gateDenyOutput("The URL contains a value from .env (KEY); never send it.");
      const cases = [
        [deny, [deny]],
        // The pass carries no decision: empty stdout and exit 0, so Claude's own permission rules
        // (the run settings' allow, and any deny rule) decide the call.
        [CLAUDE_GATE_NO_DECISION_MARKER, []],
        // The worker host's own answer when nobody decided: never an allow (0020 section 11b).
        ["", [DENY_NO_ANSWER]],
        // An explicit allow would bypass Claude's permission rules: only the marker passes.
        [
          '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}',
          [DENY_NO_ANSWER],
        ],
        [
          '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}',
          [DENY_NO_ANSWER],
        ],
        [`${CLAUDE_GATE_NO_DECISION_MARKER}\n`, [DENY_NO_ANSWER]],
        ["allow", [DENY_NO_ANSWER]],
      ] as const;
      for (const [index, [answer, printed]] of cases.entries()) {
        const socket = join(dir, `g${index}.sock`);
        const frames: Record<string, unknown>[] = [];
        const server = slowHost(socket, answer, frames, 20);
        try {
          const out: string[] = [];
          const env = { DIPO_HOST_SOCKET: socket, DIPO_RUN: RUN };
          const code = await runHookForm(
            ["PreToolUse", "--gate"],
            io(env, PAYLOAD("https://x.test"), out),
          );
          expect({ code, out }).toEqual({ code: 0, out: [...printed] });
          const op = frames.find((frame) => frame["op"] === "hook");
          expect(op?.["waitMs"]).toBeGreaterThan(0);
          expect(op?.["waitMs"]).toBeLessThanOrEqual(HOOK_DEADLINE_MS - NUDGE_REPLY_MARGIN_MS);
          expect(String(op?.["payload"])).toContain("https://x.test");
        } finally {
          await server.stop();
        }
      }
    }));

  it("prints a deny within 2 s when the engine does not answer", () =>
    withTempDir(async (dir) => {
      const socket = join(dir, "never.sock");
      const server = slowHost(socket, "late", [], null);
      try {
        const out: string[] = [];
        const env = { DIPO_HOST_SOCKET: socket, DIPO_RUN: RUN };
        const started = systemClock.now();
        const code = await runHookForm(
          ["PreToolUse", "--gate"],
          io(env, PAYLOAD("https://x.test"), out),
        );
        expect(code).toBe(0);
        expect(systemClock.now() - started).toBeLessThan(2_000);
        expect(out).toEqual([DENY_NO_ANSWER]);
        expect(JSON.parse(DENY_NO_ANSWER)).toEqual({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: GATE_NO_ANSWER_REASON,
          },
        });
      } finally {
        await server.stop();
      }
    }));

  it("fails closed on every other failure: no socket, an unreachable host, no payload", () =>
    withTempDir(async (dir) => {
      const env = { DIPO_HOST_SOCKET: join(dir, "none.sock"), DIPO_RUN: RUN };
      for (const [e, input] of [
        [{}, PAYLOAD("https://x.test")],
        [env, PAYLOAD("https://x.test")],
        [env, null],
      ] as const) {
        const out: string[] = [];
        expect(await runHookForm(["PreToolUse", "--gate"], io(e, input, out))).toBe(0);
        expect(out).toEqual([DENY_NO_ANSWER]);
      }
      // Arguments that do not parse still fail closed.
      const out: string[] = [];
      expect(await runHookForm(["PreToolUse", "--gate", "x"], io(env, "{}", out))).toBe(0);
      expect(out).toEqual([DENY_NO_ANSWER]);
    }));

  it("exits 2 with the reason on stderr when it cannot print its decision", async () => {
    const errors: string[] = [];
    const failing: DaemonIo = {
      ...io({}, PAYLOAD("https://x.test"), []),
      write: () => {
        throw new Error("EPIPE");
      },
      writeError: (line) => errors.push(line),
    };
    expect(await runHookForm(["PreToolUse", "--gate"], failing)).toBe(2);
    expect(errors).toEqual([GATE_FAILED_REASON]);
    // Not even stderr: still 2.
    const silent: DaemonIo = {
      ...failing,
      writeError: () => {
        throw new Error("EPIPE");
      },
    };
    expect(await runHookForm(["PreToolUse", "--gate"], silent)).toBe(2);
  });
});

/** A worker that runs until `end` is called (as in the engine's host tests). */
function heldWorker(): { spawn: Spawn; end: () => void } {
  let end!: () => void;
  const exited = new Promise<ChildExit>((resolve) => {
    end = () => resolve({ code: 0, signal: null });
  });
  const closed = () =>
    new ReadableStream<Uint8Array>({
      async start(controller) {
        await exited;
        controller.close();
      },
    });
  const child: ChildProcess = {
    pid: 4242,
    stdin: { write: () => 0, end: () => undefined } as unknown as ChildProcess["stdin"],
    stdout: closed(),
    stderr: closed(),
    exited,
    kill: () => undefined,
  };
  return { spawn: () => child, end };
}

/** A real `WorkerHost` in this process on a held worker, for the relay to reach. */
async function withWorkerHost(
  fn: (ctx: { host: WorkerHost; socket: string }) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const runDir = join(dir, "run");
    mkdirSync(runDir, { recursive: true });
    const socket = hostSocketPath(join(dir, "rt"), RUN);
    const launch: HostLaunch = {
      version: 1,
      run: RUN,
      agent: "agt_01JZ0000000000000000000009",
      socket,
      plan: { argv: ["/usr/local/bin/claude", "-p"], env: {}, cwd: dir, files: [], stdin: [] },
    };
    writeFileSync(join(runDir, LAUNCH_FILE), JSON.stringify(launch), { mode: 0o600 });
    const worker = heldWorker();
    const host = WorkerHost.start({
      runId: RUN,
      runDir,
      clock: systemClock,
      spawn: worker.spawn,
      killGroup: () => undefined,
      pid: 777,
    });
    try {
      await fn({ host, socket });
    } finally {
      worker.end();
      await host.done;
    }
  });
}

async function watchingEngine(socket: string): Promise<HostClient> {
  const connected = await connectHost(socket, { runId: RUN, clock: systemClock, timeoutMs: 2000 });
  if (!connected.ok) throw new Error(`cannot connect: ${connected.reason}`);
  await connected.client.watch(() => undefined);
  return connected.client;
}

/** One `dipo hook PreToolUse --gate` call for a WebFetch, relayed to `socket`. */
async function gate(socket: string): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const env = { DIPO_HOST_SOCKET: socket, DIPO_RUN: RUN };
  const code = await runHookForm(["PreToolUse", "--gate"], io(env, PAYLOAD("https://x.test"), out));
  return { code, out };
}

describe("dipo hook --gate against the real worker host (DIPO-164 review)", () => {
  const DENY_NO_ANSWER = gateDenyOutput(GATE_NO_ANSWER_REASON);

  it("denies when no engine watches the host (the daemon is down or restarting)", () =>
    withWorkerHost(async ({ socket }) => {
      expect(await gate(socket)).toEqual({ code: 0, out: [DENY_NO_ANSWER] });
    }));

  it("denies when the engine watches but its answer does not come before the host's wait passes", () =>
    withWorkerHost(async ({ host, socket }) => {
      const client = await watchingEngine(socket);
      try {
        const started = systemClock.now();
        const call = gate(socket);
        for (let i = 0; i < 200 && host.pendingHooks.length === 0; i++) await Bun.sleep(5);
        // The host held the call, then answered it empty once its wait passed.
        expect(host.pendingHooks).toHaveLength(1);
        expect(await call).toEqual({ code: 0, out: [DENY_NO_ANSWER] });
        expect(systemClock.now() - started).toBeLessThan(2_000);
      } finally {
        client.close();
      }
    }));

  it("denies when the host cannot relay the call (relayHook returns null)", () =>
    withWorkerHost(async ({ host, socket }) => {
      const client = await watchingEngine(socket);
      try {
        host.relayHook = () => null;
        expect(await gate(socket)).toEqual({ code: 0, out: [DENY_NO_ANSWER] });
      } finally {
        client.close();
      }
    }));

  it("lets the call on to Claude's permission rules only on the engine's pass marker", () =>
    withWorkerHost(async ({ host, socket }) => {
      const client = await watchingEngine(socket);
      try {
        for (const [reply, printed] of [
          ["", [DENY_NO_ANSWER]],
          [
            '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}',
            [DENY_NO_ANSWER],
          ],
          [CLAUDE_GATE_NO_DECISION_MARKER, []],
        ] as const) {
          const call = gate(socket);
          for (let i = 0; i < 200 && host.pendingHooks.length === 0; i++) await Bun.sleep(5);
          const [hook] = host.pendingHooks;
          await client.request({ op: "hookReply", hook: hook ?? 0, output: reply });
          expect(await call).toEqual({ code: 0, out: [...printed] });
        }
      } finally {
        client.close();
      }
    }));
});

/** One `dipo hook PreToolUse --bash` call for a Bash `command`, with the host socket in the env. */
async function bashCall(
  socket: string,
  command: string,
  check?: (command: string) => string | null,
): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const env = { DIPO_HOST_SOCKET: socket, DIPO_RUN: RUN };
  const payload = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });
  const code = await runHookForm(["PreToolUse", "--bash"], io(env, payload, out), check);
  return { code, out };
}

function throwingCheck(): string | null {
  throw new Error("boom");
}

describe("dipo hook --bash (DIPO-194; 0008 amendment of 2026-10-19)", () => {
  it("parses --bash without a value", () => {
    expect(parseHookArgs(["PreToolUse", "--bash"])).toEqual({ event: "PreToolUse", bash: true });
    expect(parseHookArgs(["PreToolUse", "--bash", "5"])).toBeNull();
  });

  it("denies a DIPO_TMP command, passes another, and never reaches the worker host", () =>
    withWorkerHost(async ({ host, socket }) => {
      const client = await watchingEngine(socket);
      try {
        const denied = await bashCall(socket, "export DIPO_TMP=$TMPDIR && bun run verify");
        expect(denied.code).toBe(0);
        expect(denied.out).toEqual([
          gateDenyOutput(
            "dipo refused this command because it sets or clears DIPO_TMP; dipo sets DIPO_TMP and the sandbox sets TMPDIR for the run, so never set or clear them (contract rule Temp files); run the command without it.",
          ),
        ]);
        expect(host.pendingHooks).toHaveLength(0);
        expect(await bashCall(socket, "bun run verify")).toEqual({ code: 0, out: [] });
        expect(host.pendingHooks).toHaveLength(0);
      } finally {
        client.close();
      }
    }));

  it("refuses a gh call other than the help forms with the engine's reason (DIPO-195)", () =>
    withWorkerHost(async ({ socket }) => {
      expect(await bashCall(socket, "gh pr view 12")).toEqual({
        code: 0,
        out: [gateDenyOutput(GH_REFUSAL)],
      });
      expect(await bashCall(socket, "gh pr view --help")).toEqual({ code: 0, out: [] });
    }));

  it("exits 2 with the reason on stderr when the check throws on a gh command, and 0 otherwise (DIPO-241)", () =>
    withWorkerHost(async ({ socket }) => {
      expect(await bashCall(socket, "/usr/local/bin/gh pr list", throwingCheck)).toEqual({
        code: 2,
        out: [`err:${BASH_GH_FAILED_REASON}`],
      });
      // Quotes, escapes and case do not hide gh from the shell, so they do not hide it here.
      for (const named of [
        "'g'h pr list",
        'g"h" pr list',
        "g\\h pr list",
        "g\\\nh pr list",
        "GH pr merge 1",
      ]) {
        expect([named, (await bashCall(socket, named, throwingCheck)).code]).toEqual([named, 2]);
      }
      expect(await bashCall(socket, "echo gh-free", throwingCheck)).toEqual({ code: 0, out: [] });
      expect(await bashCall(socket, "echo sigh", throwingCheck)).toEqual({ code: 0, out: [] });
      expect(await bashCall(socket, "export DIPO_TMP=x", throwingCheck)).toEqual({
        code: 0,
        out: [],
      });
    }));

  it("prints nothing and exits 0 for a check that throws, or a payload with no command", () =>
    withWorkerHost(async ({ socket }) => {
      expect(await bashCall(socket, "export DIPO_TMP=x", throwingCheck)).toEqual({
        code: 0,
        out: [],
      });
      const env = { DIPO_HOST_SOCKET: socket, DIPO_RUN: RUN };
      for (const input of ["null", '{"tool_input":{"command":5}}', "{}"]) {
        const out: string[] = [];
        expect(await runHookForm(["PreToolUse", "--bash"], io(env, input, out))).toBe(0);
        expect(out).toEqual([]);
      }
      // A payload it cannot parse or read exits 3: the shell fallback greps it for gh (DIPO-241).
      for (const input of ["not json", null]) {
        const out: string[] = [];
        expect(await runHookForm(["PreToolUse", "--bash"], io(env, input, out))).toBe(3);
        expect(out).toEqual([]);
      }
    }));
});

describe("dipo hook PermissionRequest --wait against the real worker host (DIPO-181)", () => {
  it("holds each waiting call until the engine's hookReply and prints that output, call after call", () =>
    withWorkerHost(async ({ host, socket }) => {
      const client = await watchingEngine(socket);
      try {
        for (const output of ['{"decision":"allow"}', '{"decision":"deny"}']) {
          const out: string[] = [];
          const env = { DIPO_HOST_SOCKET: socket, DIPO_RUN: RUN };
          const call = runHookForm(
            ["PermissionRequest", "--wait", "310"],
            io(env, '{"hook_event_name":"PermissionRequest"}', out),
          );
          for (let i = 0; i < 200 && host.pendingHooks.length === 0; i++) await Bun.sleep(5);
          expect(host.pendingHooks).toHaveLength(1);
          const [hook] = host.pendingHooks;
          const reply = await client.request({ op: "hookReply", hook: hook ?? 0, output });
          // The reply finds the held call: never hook.unknown.
          expect(reply).toEqual({ ok: true, result: undefined });
          expect(await call).toBe(0);
          expect(out).toEqual([output]);
        }
      } finally {
        client.close();
      }
    }));
});
