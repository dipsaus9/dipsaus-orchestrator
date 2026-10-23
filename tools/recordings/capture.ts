// `bun run recordings:capture <scenario>` (0017 section 2, "Capture"). A dev script, never a test:
//
// 1. builds the fixture repository `packages/engine/test/fixtures/repos/<name>` as a main checkout
//    plus a linked worktree in a fresh temp directory under `$DIPO_TMP` (else `/tmp`);
// 2. runs `claude` with the adapter's own launch plan (DIPO-40) plus `--include-partial-messages`
//    and `--include-hook-events`;
// 3. holds every line with its arrival time and the exit status in memory only;
// 4. scrubs, checks decision fields and the usage checksum, runs the secret guard, and only then
//    writes `stream.jsonl` and `meta.json`. The raw stream is never written to disk.

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  encodeClaudeOp,
  findSecret,
  HOOK_PROTOCOL_VERSIONS,
  listenLineSocket,
  OFFICE_DEFAULTS,
  planClaudeLaunch,
  readEnvSecrets,
  readInstalledPlugins,
  refusalText,
  REPORT_JSON_SCHEMAS,
  SETTINGS_FILE,
  systemClock,
  UNCHECKED_TEXT,
} from "../../packages/engine/src/index";
import type { LaunchPlan, LineServer, WorkerSpec } from "../../packages/engine/src/index";
import { withTempRepo } from "../../packages/testkit/src/index";
import { decisionFieldProblems } from "./checks";
import type { Envelope, Meta, SteerRecord } from "./format";
import {
  FIXTURE_REPOS_DIR,
  isRecord,
  serializeMeta,
  serializeStream,
  writeRecording,
} from "./format";
import { findScenario, SCENARIOS, SYSTEM_PROMPT, turnText, WEB_ENV_FILE } from "./scenarios";
import type { CapturePaths, Scenario } from "./scenarios";
import { Scrubber, WEB_INPUT_FIELDS } from "./scrub";
import type { PathRoot } from "./scrub";
import { guardSecrets, machineNeedles } from "./secrets";
import type { Needle } from "./secrets";
import { stdoutOf, usageChecksum } from "./usage";

/** Quiet time after a `result` before the next message is sent or stdin is closed. */
const SETTLE_MS = 3_000;
const EXTRA_FLAGS = ["--include-partial-messages", "--include-hook-events"] as const;

/** The extra flags the plan does not pass itself (it passes `--include-partial-messages`). */
function extraFlags(argv: readonly string[]): string[] {
  return EXTRA_FLAGS.filter((flag) => !argv.includes(flag));
}

/** The CLI entry the hooks run when capturing from source (`<bun> <main.ts> hook <event>`). */
const CLI_MAIN = join(import.meta.dir, "..", "..", "packages", "cli", "src", "main.ts");

const IDLE = Symbol("idle");
const ENDED = Symbol("ended");

/** Lines of one running process, queued as they arrive. */
class LineQueue {
  private readonly items: Envelope[] = [];
  private waiter: (() => void) | null = null;
  private open = 2;

  push(item: Envelope): void {
    this.items.push(item);
    this.wake();
  }

  close(): void {
    this.open -= 1;
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  async next(ms: number): Promise<Envelope | typeof IDLE | typeof ENDED> {
    const item = this.items.shift();
    if (item !== undefined) return item;
    if (this.open <= 0) return ENDED;
    const arrived = new Promise<void>((resolve) => {
      this.waiter = resolve;
    });
    const winner = await Promise.race([
      arrived.then(() => "line" as const),
      Bun.sleep(ms).then(() => IDLE),
    ]);
    if (winner === IDLE) {
      this.waiter = null;
      return IDLE;
    }
    return this.next(ms);
  }
}

async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      onLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) onLine(buffer);
}

function parseLine(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

interface ProcessRun {
  readonly lines: Envelope[];
  readonly steering: SteerRecord[];
}

/** Runs one launch plan and drives it through the scenario's turns. */
async function runProcess(
  launch: LaunchPlan,
  scenario: Scenario,
  turns: readonly string[],
  start: number,
  resume: boolean,
  out: ProcessRun,
): Promise<void> {
  const now = () => Math.round(performance.now() - start);
  const argv = [...launch.argv, ...extraFlags(launch.argv)];
  const proc = Bun.spawn(argv, {
    cwd: launch.cwd,
    env: { ...launch.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  out.steering.push({ t: now(), op: "spawn", resume });
  const queue = new LineQueue();
  const stdoutDone = readLines(proc.stdout, (text) =>
    queue.push({ t: now(), ch: "stdout", data: parseLine(text) }),
  ).finally(() => queue.close());
  const stderrDone = readLines(proc.stderr, (text) =>
    queue.push({ t: now(), ch: "stderr", data: text }),
  ).finally(() => queue.close());

  const write = (line: string, priority?: string) => {
    proc.stdin.write(line);
    proc.stdin.flush();
    out.steering.push({
      t: now(),
      op: "user",
      bytes: Buffer.byteLength(line),
      ...(priority === undefined ? {} : { priority }),
    });
  };
  for (const line of launch.stdin) write(line);

  const pending = turns.slice(1);
  let settling = false;
  let stdinClosed = false;
  let deltas = 0;
  let midDone = scenario.midTurn === undefined || resume;
  const deadline = performance.now() + scenario.timeoutMs;

  for (;;) {
    if (performance.now() > deadline) {
      proc.kill("SIGKILL");
      throw new Error(
        `${scenario.name}: no exit within ${scenario.timeoutMs} ms; nothing was written`,
      );
    }
    const item = await queue.next(SETTLE_MS);
    if (item === ENDED) break;
    if (item === IDLE) {
      if (!settling) continue;
      settling = false;
      const next = pending.shift();
      if (next !== undefined) {
        write(
          encodeClaudeOp({ kind: "answer", text: next })
            .map((op) => ("write" in op ? op.write : ""))
            .join(""),
        );
      } else if (!stdinClosed) {
        stdinClosed = true;
        await proc.stdin.end();
        out.steering.push({ t: now(), op: "closeStdin" });
      }
      continue;
    }
    out.lines.push(item);
    if (item.ch !== "stdout" || !isRecord(item.data)) continue;
    const data = item.data;
    if (data.type === "result") settling = true;
    if (
      !midDone &&
      data.type === "stream_event" &&
      isRecord(data.event) &&
      data.event.type === "content_block_delta"
    ) {
      deltas += 1;
      const mid = scenario.midTurn;
      if (mid !== undefined && deltas >= mid.afterDeltas) {
        midDone = true;
        if (mid.kind === "signal") {
          proc.kill(mid.signal);
          out.steering.push({ t: now(), op: "signal", signal: mid.signal });
        } else {
          for (const op of encodeClaudeOp({ kind: "pause" })) {
            if ("write" in op) write(op.write, "now");
          }
        }
      }
    }
  }
  await Promise.all([stdoutDone, stderrDone]);
  const code = await proc.exited;
  out.lines.push({
    t: now(),
    ch: "exit",
    data: { code: proc.signalCode === null ? code : null, signal: proc.signalCode ?? null },
  });
}

/**
 * A fixture worker host for the hook relay (0008 section 5, DIPO-59): it speaks the host
 * protocol's handshake and `hook` op, hands every relayed payload to `onHook`, answers a call that
 * does not wait with no output, and answers a waiting call only with what `answer` gives for it.
 * Without `answer`, or when it gives null, a waiting call is never answered, so the
 * `PermissionRequest` hook gives no decision once its wait has passed (0017 `permission-wait`: a
 * fixture that never answers).
 */
export function fixtureHost(
  path: string,
  onHook: (payload: unknown) => void,
  answer?: (payload: unknown) => string | null,
): LineServer {
  return listenLineSocket(path, (connection) => {
    let version: number | null = null;
    const send = (frame: unknown) => connection.send(JSON.stringify(frame));
    return {
      line: (text) => {
        const frame = parseLine(text);
        if (!isRecord(frame)) {
          connection.close();
          return;
        }
        if (version === null) {
          const offered = Array.isArray(frame.versions) ? frame.versions : [];
          const common = offered.filter(
            (offer): offer is number =>
              typeof offer === "number" && HOOK_PROTOCOL_VERSIONS.includes(offer),
          );
          if (frame.kind !== "hello" || common.length === 0) {
            send({
              kind: "refused",
              error: { code: "protocol.unsupported", message: "fixture host" },
              versions: HOOK_PROTOCOL_VERSIONS,
            });
            connection.close();
            return;
          }
          version = Math.max(...common);
          send({ kind: "hello", version, run: frame.run, pid: process.pid });
          return;
        }
        if (frame.op !== "hook" || typeof frame.payload !== "string") {
          send({
            kind: "reply",
            id: frame.id,
            ok: false,
            error: { code: "op.unknown", message: "fixture host" },
          });
          return;
        }
        const payload = parseLine(frame.payload);
        onHook(payload);
        if (typeof frame.waitMs !== "number") {
          send({ kind: "reply", id: frame.id, ok: true, result: { output: "" } });
          return;
        }
        const output = answer?.(payload) ?? null;
        if (output !== null) send({ kind: "reply", id: frame.id, ok: true, result: { output } });
      },
      closed: () => undefined,
    };
  });
}

/** The engine's answer to a waiting `PreToolUse` gate call, as the adapter encodes it. */
function gateOutputOf(reason: string | undefined): string {
  const reply =
    reason === undefined
      ? { hook: 0, decision: null }
      : { hook: 0, decision: "deny" as const, reason };
  const [op] = encodeClaudeOp({ kind: "toolGate", reply });
  return op !== undefined && "output" in op ? op.output : "";
}

/**
 * The fixture host's answer to a waiting call of the `web` scenario (`Scenario.webGate`), as the
 * engine answers it (0020 section 11b): a `PreToolUse` call of a web tool whose query or URL holds
 * a value of the workdir's env file gets Claude's deny naming the file and key, any other web call
 * the adapter's marker without a decision (which the relay prints as nothing), and a call whose
 * env file cannot be read a deny. Any other call (a `PermissionRequest`) is not answered: null.
 */
export function webGateAnswer(workdir: string, payload: unknown): string | null {
  if (!isRecord(payload) || payload.hook_event_name !== "PreToolUse") return null;
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const field = WEB_INPUT_FIELDS[tool];
  if (field === undefined) return null;
  const input = isRecord(payload.tool_input) ? payload.tool_input : {};
  const value = input[field];
  const target = typeof value === "string" ? value : JSON.stringify(payload.tool_input ?? {});
  let secrets;
  try {
    secrets = readEnvSecrets(workdir, [{ path: WEB_ENV_FILE, mode: "copy", required: false }]);
  } catch {
    return gateOutputOf(UNCHECKED_TEXT);
  }
  const hit = findSecret(target, secrets);
  return gateOutputOf(hit === null ? undefined : refusalText(tool, hit));
}

/**
 * How the capture's fixture host answers a waiting call of `scenario`: as the engine answers the
 * web gate when `webGate` is set (0020 section 11b), else never.
 */
export function hostAnswer(
  scenario: Scenario,
  workdir: string,
): ((payload: unknown) => string | null) | undefined {
  return scenario.webGate === true ? (payload) => webGateAnswer(workdir, payload) : undefined;
}

/** Adds a diagnostic scenario's extra allow rules to the run settings file. */
function withExtraAllow(name: string, content: string, scenario: Scenario): string {
  const extra = scenario.extraAllow ?? [];
  if (name !== SETTINGS_FILE || extra.length === 0) return content;
  const settings = JSON.parse(content) as { permissions: { allow: string[] } };
  settings.permissions.allow.push(...extra);
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function fixtureHash(dir: string): string {
  const hash = createHash("sha256");
  const walk = (path: string) => {
    for (const name of readdirSync(path).toSorted()) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else
        hash
          .update(`${relative(dir, full)}\0`)
          .update(readFileSync(full))
          .update("\0");
    }
  };
  walk(dir);
  return hash.digest("hex");
}

async function gitEmail(): Promise<Needle[]> {
  const proc = Bun.spawn(["git", "config", "--get", "user.email"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const email = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return email.length > 0 ? [{ name: "git user email", value: email }] : [];
}

function initVersion(lines: readonly Envelope[]): string | null {
  for (const data of stdoutOf(lines)) {
    if (isRecord(data) && data.type === "system" && data.subtype === "init") {
      return typeof data.claude_code_version === "string" ? data.claude_code_version : null;
    }
  }
  return null;
}

function normaliseFlags(argv: readonly string[], scrubber: Scrubber): string[] {
  const flags = [...argv.slice(1), ...extraFlags(argv)];
  return flags.map((flag, index) => {
    const previous = flags[index - 1];
    if (previous === "--json-schema") {
      return `<report schema sha256:${createHash("sha256").update(flag).digest("hex").slice(0, 12)}>`;
    }
    if (previous === "--session-id" || previous === "--resume")
      return scrubber.id(flag, "session_id");
    return scrubber.normalisePaths(flag);
  });
}

/**
 * Why a developer scenario is not captured any more (DIPO-240): dipo plans no developer session on
 * the Mac, and a capture in a box is not built yet. Its committed recordings stay as they are.
 */
export const DEVELOPER_CAPTURE_REFUSED =
  "a developer session runs only in its story's box (0021), and dipo plans none on the Mac; capturing one in a box is not built yet, so only review scenarios can be captured";

export async function capture(scenario: Scenario): Promise<string> {
  if (scenario.kind !== "review") throw new Error(`${scenario.name}: ${DEVELOPER_CAPTURE_REFUSED}`);
  const claudePath = Bun.which("claude");
  if (claudePath === null) throw new Error("claude is not on PATH");
  const fixtureDir = join(FIXTURE_REPOS_DIR, scenario.fixture);
  const home = homedir();

  return withTempRepo(
    async (repo) => {
      await repo.commitAll("fixture");
      const workdir = join(repo.root, "repo.worktrees", "story");
      await repo.git("worktree", "add", "--quiet", "-b", "story", workdir);
      const runDir = join(repo.root, "run");
      const sandboxTmp = join(repo.root, "tmp");
      mkdirSync(runDir, { recursive: true });
      mkdirSync(sandboxTmp, { recursive: true });
      const paths: CapturePaths = { root: repo.root, main: repo.dir, workdir, runDir };
      const turns = scenario.turns.map((turn) => turnText(turn, paths));
      const resumeTurns = (scenario.resumeTurns ?? []).map((turn) => turnText(turn, paths));
      const systemFile = join(runDir, "system.md");
      const systemPrompt = scenario.systemPrompt ?? SYSTEM_PROMPT;
      writeFileSync(systemFile, systemPrompt);
      scenario.prepare?.(paths);

      const sessionId = randomUUID();
      const specFor = (resume: boolean, first: string): WorkerSpec => ({
        run: "run-0001",
        agent: "agt-0001",
        kind: scenario.kind ?? "implement",
        workdir,
        model: scenario.model,
        effort: scenario.effort,
        caps: { budgetTokens: 300_000, maxTurns: scenario.maxTurns, maxMinutes: 30 },
        systemFile,
        taskMessage: first,
        tools: { allow: scenario.tools, deny: [] },
        session: { id: sessionId, resume },
        reportSchema: REPORT_JSON_SCHEMAS[scenario.kind ?? "implement"],
        hookRelay: scenario.hookRelay !== undefined,
      });
      const hostSocket = join(repo.root, "host.sock");
      const context = {
        claudePath,
        home,
        env: process.env,
        toolVariables: [],
        mainCheckout: repo.dir,
        runDir,
        hostSocket,
        tmpDir: sandboxTmp,
        sandbox: OFFICE_DEFAULTS.sandbox,
        // The hooks run this checkout's `dipo` from source with the Bun running the capture.
        hookCommand: [process.execPath, CLI_MAIN] as [string, ...string[]],
        // A reviewer loads no plugin: the plan switches off every installed one (0019 section 4).
        ...(scenario.kind === "review"
          ? { plugins: { installed: readInstalledPlugins(home), allowed: [] } }
          : {}),
      };
      const launches: [LaunchPlan, readonly string[], boolean][] = [];
      const first = planClaudeLaunch(specFor(false, turns[0] ?? ""), context);
      launches.push([first, turns, false]);
      if (resumeTurns.length > 0) {
        launches.push([
          planClaudeLaunch(specFor(true, resumeTurns[0] ?? ""), context),
          resumeTurns,
          true,
        ]);
      }

      const start = performance.now();
      const run = { lines: [] as Envelope[], steering: [] as SteerRecord[] };
      const host =
        scenario.hookRelay === undefined
          ? null
          : fixtureHost(
              hostSocket,
              (payload) =>
                run.lines.push({
                  t: Math.round(performance.now() - start),
                  ch: "hook",
                  data: payload,
                }),
              hostAnswer(scenario, workdir),
            );
      try {
        for (const [launch, processTurns, resume] of launches) {
          for (const file of launch.files) {
            writeFileSync(
              join(runDir, file.name),
              withExtraAllow(file.name, file.content, scenario),
            );
          }
          await runProcess(launch, scenario, processTurns, start, resume, run);
        }
      } finally {
        await host?.stop();
      }
      // Hook lines arrive on the fixture host, stream lines through the process queue: by time.
      run.lines.sort((a, b) => a.t - b.t);
      const checks =
        scenario.verify === undefined ? undefined : await scenario.verify(paths, run.lines);

      const roots: PathRoot[] = [
        { path: workdir, placeholder: "${WORKDIR}" },
        { path: repo.dir, placeholder: "${MAIN}" },
        { path: runDir, placeholder: "${RUN}" },
        { path: sandboxTmp, placeholder: "${TMP}" },
        { path: repo.root, placeholder: "${ROOT}" },
        { path: home, placeholder: "${HOME}" },
        { path: tmpdir(), placeholder: "${SYSTMP}" },
        { path: claudePath, placeholder: "${CLAUDE}" },
      ];
      const scrubber = new Scrubber(roots);
      const lines = run.lines.map((line) => scrubber.envelope(line));
      const rawChecksum = usageChecksum(stdoutOf(run.lines));
      if (usageChecksum(stdoutOf(lines)) !== rawChecksum) {
        throw new Error("scrubbing changed a usage number; nothing was written");
      }
      const problems = decisionFieldProblems(lines);
      if (problems.length > 0) {
        throw new Error(
          `decision fields redacted: ${problems.join(", ")}; extend the allowlist; nothing was written`,
        );
      }

      const prompt = [systemPrompt, ...turns, ...resumeTurns].join("\n");
      const meta: Meta = {
        scenario: scenario.name,
        source: "live",
        claude_code_version: initVersion(lines),
        captured_at: new Date(systemClock.now()).toISOString().slice(0, 10),
        expected: scenario.expected,
        usage_checksum: rawChecksum,
        fixture: scenario.fixture,
        fixture_sha256: fixtureHash(fixtureDir),
        model: scenario.model,
        flags: normaliseFlags(first.argv, scrubber),
        prompt_bytes: Buffer.byteLength(prompt),
        prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
        processes: launches.length,
        steering: run.steering,
        unknown_types: scrubber.report.unknownTypes,
        ...(scenario.kind === undefined ? {} : { kind: scenario.kind }),
        ...(scenario.hookRelay === undefined
          ? {}
          : { testConfig: { permissionWaitSeconds: scenario.hookRelay.waitSeconds } }),
        ...((scenario.extraAllow ?? []).length > 0
          ? { settings_patch: [`permissions.allow += ${JSON.stringify(scenario.extraAllow)}`] }
          : {}),
        // Findings may quote Claude Code's own messages, so their paths are normalised too.
        ...(checks === undefined
          ? {}
          : {
              checks: JSON.parse(scrubber.normalisePaths(JSON.stringify(checks))) as Record<
                string,
                unknown
              >,
            }),
      };
      const streamText = serializeStream(lines);
      const metaText = serializeMeta(meta);
      const needles = machineNeedles(await gitEmail());
      guardSecrets("stream.jsonl", streamText, needles);
      guardSecrets("meta.json", metaText, needles);
      const target = writeRecording(scenario.name, streamText, metaText);

      console.log(`wrote ${relative(process.cwd(), target)} (${lines.length} lines)`);
      console.log(
        `unknown types (redacted whole): ${JSON.stringify(scrubber.report.unknownTypes)}`,
      );
      console.log(
        `redacted string paths by kind: ${JSON.stringify(scrubber.report.redactedPaths)}`,
      );
      if (checks !== undefined) console.log(`checks: ${JSON.stringify(checks)}`);
      return target;
    },
    { fixture: fixtureDir },
  );
}

if (import.meta.main) {
  const names = process.argv.slice(2);
  if (names.length === 0) {
    console.error(
      `usage: bun run recordings:capture <scenario>...\nscenarios: ${SCENARIOS.map((s) => s.name).join(", ")}`,
    );
    process.exit(2);
  }
  for (const name of names) {
    const scenario = findScenario(name);
    if (scenario === undefined) {
      console.error(`unknown scenario ${name}`);
      process.exit(2);
    }
    await capture(scenario);
  }
}
