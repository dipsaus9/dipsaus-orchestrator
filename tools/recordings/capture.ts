// `bun run recordings:capture <scenario>` (0017 section 2, "Capture"). A dev script, never a test:
//
// 1. builds the fixture repository `packages/engine/test/fixtures/repos/<name>` as a main checkout
//    plus a linked worktree in a fresh temp directory under `$DIPO_TMP` (else `/tmp`);
// 2. runs `claude` with the adapter's own launch plan (DIPO-40) plus `--include-partial-messages`;
// 3. holds every line with its arrival time and the exit status in memory only;
// 4. scrubs, checks decision fields and the usage checksum, runs the secret guard, and only then
//    writes `stream.jsonl` and `meta.json`. The raw stream is never written to disk.

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";

import { OFFICE_DEFAULTS } from "../../packages/engine/src/config/schema";
import { systemClock } from "../../packages/engine/src/platform/clock";
import { encode as encodeClaudeOp } from "../../packages/engine/src/workers/claude-cli/encode";
import {
  plan as planClaudeLaunch,
  SETTINGS_FILE,
} from "../../packages/engine/src/workers/claude-cli/plan";
import { readInstalledPlugins } from "../../packages/engine/src/workers/claude-cli/plugins";
import { REPORT_JSON_SCHEMAS } from "../../packages/engine/src/workers/claude-cli/report-schema";
import type { LaunchPlan, WorkerSpec } from "../../packages/engine/src/workers/types";
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
import { findScenario, SCENARIOS, SYSTEM_PROMPT, turnText } from "./scenarios";
import type { CapturePaths, Scenario } from "./scenarios";
import { Scrubber } from "./scrub";
import type { PathRoot } from "./scrub";
import { guardSecrets, machineNeedles } from "./secrets";
import type { Needle } from "./secrets";
import { stdoutOf, usageChecksum } from "./usage";

/** Quiet time after a `result` before the next message is sent or stdin is closed. */
const SETTLE_MS = 3_000;
const EXTRA_FLAGS = ["--include-partial-messages"] as const;

/** The extra flags the plan does not pass itself (it passes `--include-partial-messages`). */
function extraFlags(argv: readonly string[]): string[] {
  return EXTRA_FLAGS.filter((flag) => !argv.includes(flag));
}

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
 * Why no story scenario is captured any more (DIPO-240, DIPO-347): dipo plans no developer or
 * reviewer session on the Mac, both run only in a box (0008), and a capture in a box is not built
 * yet. The committed recordings stay as they are.
 */
export const CAPTURE_REFUSED =
  "a developer and a reviewer session run only in a box (0008), and dipo plans neither on the Mac; capturing one in a box is not built yet";

export async function capture(scenario: Scenario): Promise<string> {
  if (scenario.kind === undefined || scenario.kind === "review") {
    throw new Error(`${scenario.name}: ${CAPTURE_REFUSED}`);
  }
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
      for (const [launch, processTurns, resume] of launches) {
        for (const file of launch.files) {
          writeFileSync(join(runDir, file.name), withExtraAllow(file.name, file.content, scenario));
        }
        await runProcess(launch, scenario, processTurns, start, resume, run);
      }
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
