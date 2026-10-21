// The box door (DIPO-272, 0021 section 7): the `dipo-part` command and dipo's reader, run for real
// with the system shell on a host folder that stands for the box's queue (a fake box whose exec
// runs the command here), the checks every message passes, the report kinds and the door poller.

import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import type { Signal } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  ackDoor,
  BoxDoor,
  checkPartMessage,
  cleanDoorText,
  DIPO_PART_PATH,
  dipoPartScript,
  DOOR_MAX_PARTS_PER_READ,
  DOOR_QUEUE,
  DOOR_READ_MAX_BYTES,
  DOOR_READ_SECONDS,
  DOOR_RECORD_FILE,
  type DoorPart,
  doorAckCommand,
  doorReadCommand,
  installDipoPart,
  PART_MESSAGE_MAX_BYTES,
  parseDoorRead,
  readDoor,
} from "../../src/box/door";
import { BoxError, type BoxPort, type BoxProcess } from "../../src/box/port";
import {
  parseWorkerReport,
  WORKER_REPORT_CAPS,
  WORKER_REPORT_MAX_CHARS,
} from "../../src/workers/claude-cli/report-schema";
import type { WorkerReport } from "../../src/workers/types";
import { FakeBoxes } from "./fake-boxes";

const encoder = new TextEncoder();
const ESC = "\u001b";
const RLO = String.fromCodePoint(0x202e);
const LRI = String.fromCodePoint(0x2066);
const PDI = String.fromCodePoint(0x2069);
const ZWSP = String.fromCodePoint(0x200b);
const BOM = String.fromCodePoint(0xfeff);
const TAG_A = String.fromCodePoint(0xe0041);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);

/**
 * A fake box whose exec runs dipo's command with the host's shell, on `queue` in place of the
 * box's `DOOR_QUEUE`: the real scripts, on a host folder.
 */
class HostBox implements Pick<BoxPort, "execLive"> {
  readonly commands: string[][] = [];
  kills = 0;
  stdinEnded = 0;
  constructor(readonly queue: string) {}

  execLive(_box: string, command: readonly [string, ...string[]]): BoxProcess {
    this.commands.push([...command]);
    const argv = command.map((arg) => arg.replaceAll(`'${DOOR_QUEUE}'`, `'${this.queue}'`));
    const child = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    return {
      stdin: {
        write: (chunk) => {
          void child.stdin.write(chunk);
        },
        end: () => {
          this.stdinEnded += 1;
          void child.stdin.end();
        },
      },
      stdout: child.stdout,
      stderr: child.stderr,
      exited: child.exited.then((code) => ({
        code: child.signalCode === null ? code : null,
        signal: child.signalCode ?? null,
      })),
      kill: (signal?: Signal) => {
        this.kills += 1;
        child.kill(signal);
      },
    };
  }
}

/** The frames of a read that printed `text`. */
function frames(text: string) {
  return parseDoorRead(encoder.encode(text));
}

function nothing(): void {}

/** A box whose read prints `chunks`, then hangs when `hang`; it counts kills. */
function printingBox(chunks: readonly Uint8Array[], hang = false) {
  const state = { kills: 0 };
  let finish!: (exit: { code: number | null; signal: Signal | null }) => void;
  const exited = new Promise<{ code: number | null; signal: Signal | null }>((resolve) => {
    finish = resolve;
  });
  let close: () => void = nothing;
  const boxes: Pick<BoxPort, "execLive"> = {
    execLive: () => ({
      stdin: { write: () => {}, end: () => {} },
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          close = () => {
            try {
              controller.close();
            } catch {
              // Already closed.
            }
          };
          if (!hang) close();
        },
      }),
      stderr: new ReadableStream({ start: (controller) => controller.close() }),
      exited,
      kill: (signal: Signal = "SIGTERM") => {
        state.kills += 1;
        close();
        finish({ code: null, signal });
      },
    }),
  };
  if (!hang) finish({ code: 0, signal: null });
  return { boxes, state };
}

function inQueue(fn: (queue: string, dir: string) => Promise<void>): Promise<void> {
  return withTempDir(async (dir) => {
    const queue = join(dir, "parts");
    mkdirSync(queue, { recursive: true });
    await fn(queue, dir);
  });
}

/** Runs the `dipo-part` command for `queue` with the host's shell. */
async function dipoPart(
  dir: string,
  queue: string,
  args: readonly string[],
  waitSeconds = 0,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const script = join(dir, `dipo-part-${waitSeconds}`);
  writeFileSync(script, dipoPartScript(queue, waitSeconds), { mode: 0o755 });
  const child = Bun.spawn(["/bin/sh", script, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

const queued = (queue: string): string[] =>
  readdirSync(queue)
    .filter((name) => !name.startsWith("."))
    .toSorted();

function exec(box: Pick<BoxPort, "execLive">, clock = new ManualClock()) {
  return { boxes: box, box: "dipo-run_1", clock };
}

describe("the dipo-part command (criterion 1)", () => {
  it("queues its one message as one file in the box's queue and says when dipo has not taken it yet", () =>
    inQueue(async (queue, dir) => {
      const result = await dipoPart(dir, queue, ["Add the greeting module"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("dipo has not taken the part yet");
      const files = queued(queue);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^[0-9]+-[0-9]+\.part$/);
      expect(readFileSync(join(queue, files[0] ?? ""), "utf8")).toBe("Add the greeting module");
    }));

  it("refuses no message, two arguments, an empty message and one over the limit, and queues nothing", () =>
    inQueue(async (queue, dir) => {
      for (const args of [[], ["one", "two"], [""], ["x".repeat(PART_MESSAGE_MAX_BYTES + 1)]]) {
        const result = await dipoPart(dir, queue, args);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("dipo-part");
      }
      expect(queued(queue)).toEqual([]);
      const limit = await dipoPart(dir, queue, ["x".repeat(PART_MESSAGE_MAX_BYTES)]);
      expect(limit.code).toBe(0);
    }));

  it("waits until dipo takes the part, and says when dipo refused it", () =>
    inQueue(async (queue, dir) => {
      const box = new HostBox(queue);
      const waiting = dipoPart(dir, queue, ["Wire the reader"], 20);
      while (queued(queue).length === 0) await Bun.sleep(20);
      const read = await readDoor(exec(box));
      expect(read.parts.map((part) => part.message)).toEqual(["Wire the reader"]);
      await ackDoor(
        exec(box),
        read.parts.map((part) => part.name),
        [],
      );
      const taken = await waiting;
      expect(taken.code).toBe(0);
      expect(taken.stdout).toContain("dipo took the part");

      const refusedWait = dipoPart(dir, queue, ["Refuse me"], 20);
      while (queued(queue).length === 0) await Bun.sleep(20);
      const name = queued(queue)[0] ?? "";
      await ackDoor(exec(box), [], [name]);
      const refused = await refusedWait;
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("dipo refused the message");
      expect(queued(queue)).toEqual([]);
    }));

  it("is installed by dipo with copy-in at a fixed path and made executable, never taken from the box", () =>
    withTempDir(async (tmp) => {
      const boxes = new FakeBoxes();
      await boxes.create({
        runId: "run_1",
        image: "dipo-box:x",
        network: { name: "n", mode: "hostOnly", hostAddress: "192.0.2.10" },
      });
      await boxes.start("dipo-run_1");
      await installDipoPart({ boxes, tmpRoot: tmp }, "dipo-run_1");
      expect(boxes.log).toContain(`copy in dipo-run_1 ${DIPO_PART_PATH}`);
      expect(boxes.log).toContain("exec dipo-run_1 /bin/chmod");
      // The stage folder is dipo's own, and it is gone afterwards.
      expect(readdirSync(tmp)).toEqual([]);
    }));
});

describe("dipo's reader of the door (criterion 1)", () => {
  it("runs a fixed command on the exec's argv that names no file in the box, with stdin closed", () => {
    const command = doorReadCommand();
    expect(command.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    // Where the box has `timeout`, the script runs under it inside the box.
    expect(command[2]).toContain(`exec timeout ${DOOR_READ_SECONDS} /bin/sh -c`);
    const script = command.at(-1) ?? "";
    expect(script).toContain(`cd '${DOOR_QUEUE}'`);
    expect(script).not.toContain(DIPO_PART_PATH);
    expect(() => doorAckCommand(["../../etc/passwd"], [])).toThrow(BoxError);
    expect(() => doorAckCommand([], ["x; rm -rf /.part"])).toThrow(BoxError);
  });

  it("reads queued parts in order, removes the taken ones, and finds nothing more", () =>
    inQueue(async (queue) => {
      writeFileSync(join(queue, "1700000000-10.part"), "First part");
      writeFileSync(join(queue, "1700000001-11.part"), "Second part\nwith a body line");
      const box = new HostBox(queue);
      const read = await readDoor(exec(box));
      expect(read.complete).toBe(true);
      expect(read.refused).toEqual([]);
      expect(read.parts).toEqual([
        { name: "1700000000-10.part", message: "First part" },
        { name: "1700000001-11.part", message: "Second part\nwith a body line" },
      ]);
      expect(box.stdinEnded).toBe(1);
      await ackDoor(
        exec(box),
        read.parts.map((part) => part.name),
        [],
      );
      expect(queued(queue)).toEqual([]);
      expect((await readDoor(exec(box))).parts).toEqual([]);
    }));

  it("finds nothing when the box has no queue yet", () =>
    withTempDir(async (dir) => {
      const read = await readDoor(exec(new HostBox(join(dir, "missing"))));
      expect(read).toEqual({ parts: [], refused: [], complete: true });
    }));

  it("takes at most a read's worth of parts and leaves the rest for the next read", () =>
    inQueue(async (queue) => {
      for (let i = 0; i < DOOR_MAX_PARTS_PER_READ + 3; i += 1) {
        writeFileSync(join(queue, `${1700000000 + i}-1.part`), `Part ${i}`);
      }
      const box = new HostBox(queue);
      const first = await readDoor(exec(box));
      expect(first.parts).toHaveLength(DOOR_MAX_PARTS_PER_READ);
      await ackDoor(
        exec(box),
        first.parts.map((part) => part.name),
        [],
      );
      expect((await readDoor(exec(box))).parts).toHaveLength(3);
    }));
});

describe("the checks on every message (criterion 3)", () => {
  it("refuses a message over the size limit, and renames it so the command tells the worker", () =>
    inQueue(async (queue) => {
      writeFileSync(join(queue, "1700000000-1.part"), "y".repeat(PART_MESSAGE_MAX_BYTES * 3));
      const box = new HostBox(queue);
      const read = await readDoor(exec(box));
      expect(read.parts).toEqual([]);
      expect(read.refused).toEqual([
        {
          name: "1700000000-1.part",
          refusal: "tooBig",
          detail: `the message has ${PART_MESSAGE_MAX_BYTES * 3} bytes; at most ${PART_MESSAGE_MAX_BYTES} are allowed`,
        },
      ]);
      expect(read.complete).toBe(true);
      await ackDoor(exec(box), [], ["1700000000-1.part"]);
      expect(queued(queue)).toEqual(["1700000000-1.part.refused"]);
    }));

  it("refuses bytes that are not UTF-8 and a message with no text once cleaned", () =>
    inQueue(async (queue) => {
      writeFileSync(join(queue, "1700000000-1.part"), new Uint8Array([0x41, 0xff, 0xfe, 0x42]));
      writeFileSync(join(queue, "1700000000-2.part"), `${ESC}[31m${ESC}[0m  ${RLO}${ZWSP}`);
      const read = await readDoor(exec(new HostBox(queue)));
      expect(read.parts).toEqual([]);
      expect(read.refused.map((refused) => [refused.name, refused.refusal])).toEqual([
        ["1700000000-1.part", "notText"],
        ["1700000000-2.part", "empty"],
      ]);
    }));

  it("removes a queue entry that is not a plain file with a part name, without reading it", () =>
    inQueue(async (queue, dir) => {
      writeFileSync(join(dir, "secret"), "outside the queue");
      symlinkSync(join(dir, "secret"), join(queue, "1700000000-1.part"));
      mkdirSync(join(queue, "1700000000-2.part"));
      writeFileSync(join(queue, "evil$(touch x).part"), "Name with a command");
      writeFileSync(join(queue, "1700000000-3.part"), "Kept");
      const read = await readDoor(exec(new HostBox(queue)));
      expect(read.parts).toEqual([{ name: "1700000000-3.part", message: "Kept" }]);
      expect(read.refused.map((refused) => refused.refusal)).toEqual([
        "badName",
        "badName",
        "badName",
      ]);
      expect(queued(queue)).toEqual(["1700000000-3.part"]);
      expect(readFileSync(join(dir, "secret"), "utf8")).toBe("outside the queue");
      expect(JSON.stringify(read)).not.toContain("outside the queue");
    }));

  it("cleans terminal control sequences and characters before a message is stored or shown", () =>
    inQueue(async (queue) => {
      writeFileSync(
        join(queue, "1700000000-1.part"),
        `${ESC}]0;owned${String.fromCharCode(7)}Fix ${ESC}[31mred${ESC}[0m text\r\n\u0007bell\u009b2Jdone`,
      );
      const read = await readDoor(exec(new HostBox(queue)));
      expect(read.parts.map((part) => part.message)).toEqual(["Fix red text\nbelldone"]);
    }));

  it("removes bidi overrides and isolates, hidden characters and tag characters", () => {
    const text = `Fix ${RLO}gnp.exe${LRI}x${PDI} ${ZWSP}${BOM}a${TAG_A}b${LINE_SEPARATOR}c`;
    expect(cleanDoorText(text)).toBe("Fix gnp.exex ab\nc");
    expect(cleanDoorText(String.fromCharCode(0xd800))).toBe(String.fromCodePoint(0xfffd));
  });

  it("removes an escape with the whole astral character after it, never half of one", () => {
    const text = cleanDoorText(`${ESC}${String.fromCodePoint(0x1f600)}after`);
    expect(text).toBe("after");
    expect(text.isWellFormed()).toBe(true);
    expect(cleanDoorText(`a${ESC}`).isWellFormed()).toBe(true);
  });

  it("removes variation selectors, joiners, fillers and the other invisible characters", () => {
    for (const point of [
      0xe0100, 0xe01ef, 0xfe00, 0xfe0f, 0x180e, 0x00ad, 0x034f, 0x115f, 0x1160, 0x3164, 0x200c,
      0x200d,
    ]) {
      expect([point, cleanDoorText(`a${String.fromCodePoint(point)}b`)]).toEqual([point, "ab"]);
    }
  });

  it("keeps ordinary text, tabs, accents and emoji, and is idempotent", () => {
    const text = "Café\tnaïve 👍🏽 日本語\nnext line";
    expect(cleanDoorText(text)).toBe(text);
    const dirty = `${ESC}[1mBold${ESC}[0m ${RLO}x${ESC}P1;2q${ESC}\\ ok`;
    expect(cleanDoorText(cleanDoorText(dirty))).toBe(cleanDoorText(dirty));
    expect(cleanDoorText(dirty)).toBe("Bold x ok");
  });

  it("checks a part's bytes: the size limit first, then UTF-8, then the schema", () => {
    expect(checkPartMessage(encoder.encode(" Add tests \n"), 12)).toEqual({
      ok: true,
      message: "Add tests",
    });
    expect(checkPartMessage(encoder.encode("x"), PART_MESSAGE_MAX_BYTES + 1)).toMatchObject({
      ok: false,
      refusal: "tooBig",
    });
    expect(checkPartMessage(new Uint8Array([0xc3]), 1)).toMatchObject({
      ok: false,
      refusal: "notText",
    });
    expect(checkPartMessage(encoder.encode(" \n\t "), 4)).toMatchObject({
      ok: false,
      refusal: "empty",
    });
  });

  it("refuses a read whose frames do not follow the format, and stops at the first bad one", () => {
    expect(frames("part 1-1.part 2\nok\nend\n")).toEqual({
      parts: [{ name: "1-1.part", message: "ok" }],
      refused: [],
      complete: true,
    });
    expect(frames("hello\npart 1-1.part 2\nok\nend\n")).toMatchObject({
      parts: [],
      refused: [{ refusal: "badFrame" }],
      complete: false,
    });
    expect(frames("part 1-1.part 9\nok\nend\n")).toMatchObject({
      parts: [],
      refused: [{ name: "1-1.part", refusal: "badFrame" }],
      complete: false,
    });
    expect(frames("part ../x.part 2\nok\nend\n").refused[0]?.refusal).toBe("badFrame");
    expect(frames(`${"x".repeat(200)}\nend\n`).refused[0]?.refusal).toBe("badFrame");
    expect(frames("part 1-1.part 2\nok\n").complete).toBe(false);
    expect(frames("end\ntrailing").complete).toBe(false);
  });

  it("refuses more frames than one read takes, as a bad frame, and stops there", async () => {
    const many = Array.from({ length: DOOR_MAX_PARTS_PER_READ + 4 }, () => "skip\n").join("");
    const { boxes } = printingBox([encoder.encode(`${many}end\n`)]);
    const read = await readDoor(exec(boxes));
    expect(read.complete).toBe(false);
    expect(read.refused).toHaveLength(DOOR_MAX_PARTS_PER_READ + 1);
    expect(read.refused.at(-1)).toMatchObject({ name: null, refusal: "badFrame" });
  });

  it("cuts a read that prints more than its cap, and kills the exec client", async () => {
    const { boxes, state } = printingBox([new Uint8Array(DOOR_READ_MAX_BYTES + 1)]);
    const error = (await readDoor(exec(boxes)).catch((e: unknown) => e)) as BoxError;
    expect(error).toBeInstanceOf(BoxError);
    expect(error.code).toBe("box.doorFailed");
    expect(state.kills).toBe(1);
  });

  it("ends a read that passes its deadline, and kills the exec client", async () => {
    const clock = new ManualClock();
    const { boxes, state } = printingBox([encoder.encode("part 1-1.part 2\n")], true);
    const reading = readDoor(exec(boxes, clock)).catch((e: unknown) => e);
    await Bun.sleep(10);
    clock.advance(60_000);
    const error = (await reading) as BoxError;
    expect(error.code).toBe("box.doorFailed");
    expect(state.kills).toBe(1);
  });
});

const DONE: WorkerReport = {
  status: "done",
  criteria: [{ n: 1, met: true, evidence: "bun test packages/engine/test/box passes" }],
  summary: "Added the door.",
  commitSubject: "add the box door",
};

describe("the report kinds: story done, question, blocked and proposal (criteria 2 and 3)", () => {
  it("reads a story done, a question, a blocked report with its reason, and proposals", () => {
    expect(parseWorkerReport(DONE)).toEqual({ ok: true, report: DONE });
    const question: WorkerReport = {
      ...DONE,
      status: "blocked",
      question: "Should a refused part park the story?",
    };
    expect(parseWorkerReport(question)).toEqual({ ok: true, report: question });
    const blocked: WorkerReport = { ...DONE, status: "blocked", summary: "The image has no git." };
    expect(parseWorkerReport(blocked)).toEqual({ ok: true, report: blocked });
    const proposals: WorkerReport = {
      ...DONE,
      proposals: [
        {
          kind: "follow-up",
          title: "Cut the part subject",
          outcome: "Subjects fit.",
          why: "Long.",
        },
        { kind: "spike", title: "Linux boxes", outcome: "A decision.", why: "Asked twice." },
        {
          kind: "tool",
          title: "Add jq to the image",
          outcome: "jq runs in the box.",
          why: "The tests read JSON.",
          paths: ["tools/check.sh"],
        },
      ],
    };
    expect(parseWorkerReport(proposals)).toEqual({ ok: true, report: proposals });
  });

  it("refuses more than three proposals, an unknown proposal kind and fields over their caps", () => {
    const one = { kind: "follow-up", title: "T", outcome: "O", why: "W" };
    for (const report of [
      { ...DONE, proposals: [one, one, one, one] },
      { ...DONE, proposals: [{ ...one, kind: "rewrite-dipo" }] },
      { ...DONE, summary: "s".repeat(WORKER_REPORT_CAPS.summary + 1) },
      { ...DONE, question: "q".repeat(WORKER_REPORT_CAPS.question + 1) },
      { ...DONE, proposals: [{ ...one, title: "t".repeat(WORKER_REPORT_CAPS.proposalTitle + 1) }] },
    ]) {
      expect(parseWorkerReport(report)).toEqual({
        ok: false,
        error: "structured_output fails the report schema",
      });
    }
  });

  it("refuses a report over the size limit before reading any field", () => {
    const big = { ...DONE, notes: "n".repeat(WORKER_REPORT_MAX_CHARS) };
    const read = parseWorkerReport(big);
    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.error).toContain(`at most ${WORKER_REPORT_MAX_CHARS}`);
  });

  it("refuses an unknown field without naming it, so no worker text reaches the park detail", () => {
    const read = parseWorkerReport({ ...DONE, [`${ESC}]0;x${ESC}\\run this`]: 1 });
    expect(read).toEqual({ ok: false, error: "structured_output fails the report schema" });
  });

  it("never cleans a key: one that cleaning would change is refused, also a known field's name", () => {
    const { summary, ...rest } = DONE;
    for (const key of [`summary${ZWSP}`, `summ${ESC}[0mary`, `summary${RLO}`]) {
      expect(parseWorkerReport({ ...rest, [key]: summary })).toEqual({
        ok: false,
        error: "structured_output fails the report schema",
      });
    }
    const proposal = { kind: "tool", title: "jq", outcome: "jq runs", [`why${TAG_A}`]: "x" };
    expect(parseWorkerReport({ ...DONE, proposals: [proposal] }).ok).toBe(false);
  });

  it("cleans every text of the report, and refuses a required one that is empty once cleaned", () => {
    const read = parseWorkerReport({
      ...DONE,
      status: "blocked",
      summary: `Blocked ${ESC}[2J${RLO}on the image`,
      question: `Which ${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\?`,
      proposals: [{ kind: "tool", title: `jq${ZWSP}`, outcome: "jq runs", why: `x${TAG_A}y` }],
    });
    expect(read).toEqual({
      ok: true,
      report: {
        ...DONE,
        status: "blocked",
        summary: "Blocked on the image",
        question: "Which link?",
        proposals: [{ kind: "tool", title: "jq", outcome: "jq runs", why: "xy" }],
      },
    });
    expect(parseWorkerReport({ ...DONE, summary: `${ESC}[31m${RLO}` }).ok).toBe(false);
  });
});

function poller(queue: string, onPart: (part: DoorPart) => Promise<void> | void) {
  const clock = new ManualClock();
  const refused: string[] = [];
  const door = new BoxDoor({
    boxes: new HostBox(queue),
    clock,
    onPart,
    onRefused: (_run, refusal) => refused.push(refusal.refusal),
  });
  return { door, clock, refused };
}

function record(runDir: string): unknown[] {
  return readFileSync(join(runDir, DOOR_RECORD_FILE), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}

describe("the door poller (criterion 1)", () => {
  it("reads each running box on its clock, records each part in the run directory and hands it on", () =>
    inQueue(async (queue, dir) => {
      const parts: DoorPart[] = [];
      let handed!: () => void;
      const first = new Promise<void>((resolve) => {
        handed = resolve;
      });
      const p = poller(queue, (part) => {
        parts.push(part);
        handed();
      });
      writeFileSync(join(queue, "1700000000-1.part"), `Add the reader${ESC}[0m`);
      p.door.start("run_1", "dipo-run_1", dir);
      expect(p.door.open).toEqual(["run_1"]);
      p.clock.advance(5_000);
      await first;
      await p.door.read("run_1");
      expect(parts).toEqual([
        {
          runId: "run_1",
          box: "dipo-run_1",
          n: 1,
          name: "1700000000-1.part",
          message: "Add the reader",
          at: p.clock.now(),
        },
      ]);
      expect(queued(queue)).toEqual([]);
      expect(record(dir)).toEqual([
        {
          kind: "part",
          at: p.clock.now(),
          n: 1,
          name: "1700000000-1.part",
          message: "Add the reader",
        },
      ]);
      p.door.stop("run_1");
      expect(p.door.open).toEqual([]);
      expect(p.door.read("run_1")).toBeNull();
    }));

  it("leaves a part queued when handing it on fails, and hands it once more without a second record", () =>
    inQueue(async (queue, dir) => {
      let fail = true;
      const parts: number[] = [];
      const p = poller(queue, (part) => {
        parts.push(part.n);
        if (fail) throw new Error("the commit failed");
      });
      writeFileSync(join(queue, "1700000000-1.part"), "One");
      p.door.start("run_1", "dipo-run_1", dir);
      await p.door.read("run_1");
      expect(queued(queue)).toEqual(["1700000000-1.part"]);
      fail = false;
      await p.door.read("run_1");
      expect(parts).toEqual([1, 1]);
      expect(queued(queue)).toEqual([]);
      expect(record(dir)).toHaveLength(1);
      p.door.close();
    }));

  it("records and warns about a bad frame once while its door is open", () =>
    withTempDir(async (dir) => {
      const { boxes } = printingBox([encoder.encode("part 1-1.part 9\nok\nend\n")]);
      const warnings: string[] = [];
      const door = new BoxDoor({
        boxes,
        clock: new ManualClock(),
        warn: (message) => warnings.push(message),
      });
      door.start("run_1", "dipo-run_1", dir);
      await door.read("run_1");
      await door.read("run_1");
      expect(record(dir)).toMatchObject([
        { kind: "refused", name: "1-1.part", refusal: "badFrame" },
      ]);
      expect(warnings).toEqual(["the box door refused a message"]);
      door.close();
    }));

  it("numbers parts on across a restart from the record, and records each refusal", () =>
    inQueue(async (queue, dir) => {
      const parts: number[] = [];
      const p = poller(queue, (part) => {
        parts.push(part.n);
      });
      writeFileSync(join(queue, "1700000000-1.part"), "One");
      p.door.start("run_1", "dipo-run_1", dir);
      await p.door.read("run_1");
      p.door.close();
      const again = poller(queue, (part) => {
        parts.push(part.n);
      });
      writeFileSync(join(queue, "1700000001-1.part"), "Two");
      writeFileSync(join(queue, "1700000002-1.part"), "z".repeat(PART_MESSAGE_MAX_BYTES + 5));
      again.door.start("run_1", "dipo-run_1", dir);
      await again.door.read("run_1");
      expect(parts).toEqual([1, 2]);
      expect(again.refused).toEqual(["tooBig"]);
      expect(record(dir)).toMatchObject([
        { kind: "part", n: 1, message: "One" },
        { kind: "refused", name: "1700000002-1.part", refusal: "tooBig" },
        { kind: "part", n: 2, message: "Two" },
      ]);
      expect(queued(queue)).toEqual(["1700000002-1.part.refused"]);
      again.door.close();
    }));
});
