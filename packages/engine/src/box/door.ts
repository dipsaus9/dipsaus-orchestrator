// The box door (0021 section 7, DIPO-272): how the worker in a box hands dipo a part (message W1),
// and the checks every text from the box passes before dipo stores or shows it. Story done,
// question, blocked and proposal (W2 to W5) travel in the worker's structured report and pass the
// same text checks there (`workers/claude-cli/report-schema.ts`).
//
// Part done is a file queue in the box that dipo reads from outside:
//
// - `dipo-part "message"` is a small shell command dipo writes from `dipoPartScript` and copies
//   into the box when it makes the box (`installDipoPart`), never one from the image or the code.
//   It checks its one argument, writes it as one file into `DOOR_QUEUE` (written under a temporary
//   name, then renamed, so a reader never sees half a message) and waits until dipo has taken it.
// - dipo reads the queue through the box backend's exec (`readDoor`), with a fixed script that is
//   part of dipo's own code and travels on the exec's argv, not a file in the box. It lists at most
//   `DOOR_MAX_PARTS_PER_READ` queue files and prints each as one frame: a header with its name and
//   size, then at most `PART_MESSAGE_MAX_BYTES + 1` of its bytes. dipo reads the output with a byte
//   cap and a deadline, and kills the exec client when either is passed.
// - After dipo recorded a part, it removes the file (`ackDoor`), which ends the command's wait; a
//   refused message is renamed to `<name>.refused`, so the command tells the worker it was refused.
//
// Why a queue and not a stream: the box never connects to dipo, and nothing in it can reach dipo's
// socket (0021 section 7). A queue file waits in the box while dipo is not reading (between two
// polls, or during a daemon restart while the box is stopped), and the command can wait for the
// file to go, so the worker knows when dipo took the part and leaves the files alone until then.
// A line on the worker's own output would mean reading the model's shell commands, the shell
// parsing 0021 does away with.
//
// The worker is root in its box and can replace any program there, `/bin/sh` included. That gives
// it no reach beyond its own messages: whatever the read prints is untrusted bytes, held to the byte
// cap, the deadline and the strict frame format, and every message is checked and cleaned like any
// other text from the box (`cleanDoorText`). dipo never runs a tool on the Mac on what it reads.
//
// A read or acknowledgement cut at its byte cap or deadline kills only the exec client on the Mac;
// the command it started can go on running in the box. This is accepted: it runs in the worker's
// own box, with nothing of the Mac, and the box is not stopped for it, so the worker is not ended.
// The read script does bounded work (at most `DOOR_MAX_PARTS_PER_READ` regular files, each read up
// to its byte cap), and where the box has `timeout` it also runs under `DOOR_READ_SECONDS` there.
//
// `BoxDoor` polls the queue of each box that runs a session, records each part and each refusal in
// the run directory (`DOOR_RECORD_FILE`, on the Mac, never in the box) and hands each part to its
// `onPart` callback. Delivering and committing the part is DIPO-273, which consumes that callback.
//
// A door is read only while its run goes on (DIPO-297): with `live`, no read starts once the run
// has ended (a decision was made, so its box is about to stop). A scheduled read that fails is
// logged only while the box still runs: when the door was stopped meanwhile, the run ended, or the
// backend no longer lists the box as running (stopping or stopped), the failure is the end of the
// session, not a door fault, and nothing is logged.

import { appendFileSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Clock, TimerHandle } from "@dipsaus-orchestrator/contract";
import { z } from "zod";

import { BOX_DIPO_DIR } from "./code";
import { BoxError, type BoxPort } from "./port";

/** Where `dipo-part` is installed in a box: on the box's PATH. */
export const DIPO_PART_PATH = "/usr/local/bin/dipo-part";
/** The queue `dipo-part` writes into and dipo reads from, under dipo's own folder in the box. */
export const DOOR_QUEUE = `${BOX_DIPO_DIR}/door/parts`;
/** The longest part message, in UTF-8 bytes before cleaning. */
export const PART_MESSAGE_MAX_BYTES = 1_000;
/** The most queue files one read takes; the rest wait for the next read. */
export const DOOR_MAX_PARTS_PER_READ = 16;
/** How long `dipo-part` waits for dipo to take its part, in seconds. */
export const DIPO_PART_WAIT_SECONDS = 300;
/** How often dipo reads the queue of a box that runs a session. */
export const DOOR_POLL_MS = 5_000;
/** The deadline of one read or acknowledgement in the box. */
export const DOOR_EXEC_TIMEOUT_MS = 30_000;
/** How long the read script may run inside the box, where the box has `timeout`. */
export const DOOR_READ_SECONDS = 20;
/** The prefix of the host folder dipo stages `dipo-part` in. */
export const DOOR_STAGE_PREFIX = "dipo-box-door-";
/** The run directory's record of every part and refusal the door read. */
export const DOOR_RECORD_FILE = "door-parts.ndjson";

/** The longest header line of a read frame. */
const MAX_HEADER = 96;
/**
 * The most bytes one read may print: every frame at its largest plus its header and newline, and
 * the end line.
 */
export const DOOR_READ_MAX_BYTES =
  DOOR_MAX_PARTS_PER_READ * (MAX_HEADER + PART_MESSAGE_MAX_BYTES + 2) + MAX_HEADER;
/** The most bytes an acknowledgement may print. */
const ACK_MAX_BYTES = 1_024;

/** A queue file's name as the read prints it: digits and hyphens, then `.part`. */
const PART_NAME = /^[0-9-]{1,40}\.part$/;

function shellQuoted(path: string): string {
  if (!/^\/[A-Za-z0-9_./-]+$/.test(path)) {
    throw new BoxError("box.refused", `the door path ${JSON.stringify(path)} is not a plain path.`);
  }
  return `'${path}'`;
}

/**
 * The `dipo-part` command, for the queue `queue`, waiting at most `waitSeconds` for dipo to take
 * the part. The installed command is `dipoPartScript()`; tests render it for a host folder.
 */
export function dipoPartScript(
  queue: string = DOOR_QUEUE,
  waitSeconds: number = DIPO_PART_WAIT_SECONDS,
): string {
  return `#!/bin/sh
# dipo-part "message": hands a part to dipo (decision 0021, message W1). dipo installed this
# command. It writes the message into a queue that dipo reads from outside the box; it never
# reaches dipo itself. dipo checks the message again and treats it as plain text.
set -u
queue=${shellQuoted(queue)}
max=${PART_MESSAGE_MAX_BYTES}
wait=${Math.max(0, Math.floor(waitSeconds))}
if [ "$#" -ne 1 ]; then
  echo 'usage: dipo-part "message"  (one argument: a short line that says what this part does)' >&2
  exit 2
fi
size=$(printf '%s' "$1" | wc -c | tr -d ' ')
if [ "$size" -eq 0 ]; then
  echo 'dipo-part: the message is empty' >&2
  exit 2
fi
if [ "$size" -gt "$max" ]; then
  echo "dipo-part: the message has $size bytes; at most $max are allowed" >&2
  exit 2
fi
mkdir -p "$queue" || exit 1
name="$(date +%s)-$$.part"
printf '%s' "$1" > "$queue/.$name.tmp" || exit 1
mv -f "$queue/.$name.tmp" "$queue/$name" || exit 1
i=0
while [ -e "$queue/$name" ]; do
  if [ "$i" -ge "$wait" ]; then
    echo 'dipo-part: dipo has not taken the part yet; it stays queued, and dipo takes it with the files as they are then'
    exit 0
  fi
  sleep 1
  i=$((i + 1))
done
if [ -e "$queue/$name.refused" ]; then
  rm -f "$queue/$name.refused"
  echo 'dipo-part: dipo refused the message (not plain text, or too long); hand the part again with a short plain message' >&2
  exit 1
fi
echo 'dipo-part: dipo took the part'
`;
}

/** The fixed read script for `queue`: one frame per queue file, then `end`. */
export function doorReadScript(queue: string = DOOR_QUEUE): string {
  return [
    `cd ${shellQuoted(queue)} 2>/dev/null || { echo end; exit 0; }`,
    "n=0",
    "for f in *.part; do",
    '  [ -e "$f" ] || [ -L "$f" ] || continue',
    "  n=$((n + 1))",
    `  [ "$n" -gt ${DOOR_MAX_PARTS_PER_READ} ] && break`,
    '  stem="${f%.part}"',
    '  case "$stem" in',
    `    ''|*[!0-9-]*) rm -rf -- "$f"; echo skip; continue ;;`,
    "  esac",
    '  if [ "${#f}" -gt 45 ] || [ -L "$f" ] || [ ! -f "$f" ]; then rm -rf -- "$f"; echo skip; continue; fi',
    `  size=$(wc -c < "$f" | tr -d ' ')`,
    '  echo "part $f $size"',
    `  head -c ${PART_MESSAGE_MAX_BYTES + 1} -- "$f"`,
    "  echo",
    "done",
    "echo end",
  ].join("\n");
}

/** The fixed acknowledgement script for `queue`: `take:<name>` removes, `refuse:<name>` renames. */
export function doorAckScript(queue: string = DOOR_QUEUE): string {
  return [
    `cd ${shellQuoted(queue)} 2>/dev/null || exit 0`,
    'for a in "$@"; do',
    '  case "$a" in',
    '    take:*) rm -f -- "${a#take:}" ;;',
    '    refuse:*) mv -f -- "${a#refuse:}" "${a#refuse:}.refused" ;;',
    "  esac",
    "done",
    "echo done",
  ].join("\n");
}

/**
 * The command dipo runs to read the queue; it names no file in the box. Where the box has
 * `timeout`, the read script runs under it for `DOOR_READ_SECONDS`, inside the box.
 */
export function doorReadCommand(queue: string = DOOR_QUEUE): [string, ...string[]] {
  return [
    "/bin/sh",
    "-c",
    `if command -v timeout >/dev/null 2>&1; then exec timeout ${DOOR_READ_SECONDS} /bin/sh -c "$1"; fi; exec /bin/sh -c "$1"`,
    "dipo-door-read",
    doorReadScript(queue),
  ];
}

/** The command dipo runs to take or refuse the named queue files. */
export function doorAckCommand(
  take: readonly string[],
  refuse: readonly string[],
  queue: string = DOOR_QUEUE,
): [string, ...string[]] {
  for (const name of [...take, ...refuse]) {
    if (!PART_NAME.test(name)) {
      throw new BoxError("box.refused", `${JSON.stringify(name)} is not a queue file name.`);
    }
  }
  return [
    "/bin/sh",
    "-c",
    doorAckScript(queue),
    "dipo-door-ack",
    ...take.map((name) => `take:${name}`),
    ...refuse.map((name) => `refuse:${name}`),
  ];
}

// ---------------------------------------------------------------------------------------------
// The text checks.

/**
 * Terminal escape sequences, removed whole so no rest of one shows: CSI (also its one-byte C1
 * form), OSC up to BEL or ST, DCS, SOS, PM and APC up to ST, and any other escape with the
 * character after it (a whole code point, so an astral character never leaves half of itself). An
 * unterminated string sequence runs to the end of the text.
 */
const ESCAPE_SEQUENCES =
  // oxlint-disable-next-line no-control-regex -- control characters are what this removes
  /\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)|\u009d[\s\S]*?(?:\u0007|\u009c|$)|\u001b[PX^_][\s\S]*?(?:\u001b\\|$)|[\u0090\u0098\u009e\u009f][\s\S]*?(?:\u009c|$)|\u001b[\s\S]?/gu;

/**
 * Characters removed after the sequences: C0 controls but tab and newline, DEL, C1 controls, the
 * bidirectional marks, embeddings, overrides and isolates (U+061C, U+200E, U+200F, U+202A to
 * U+202E, U+2066 to U+2069), invisible characters that hide text (zero-width space, word joiner
 * and the invisible operators, the byte-order mark, the interlinear annotation marks, the soft
 * hyphen, the combining grapheme joiner, the Mongolian vowel separator, the Hangul fillers U+115F,
 * U+1160 and U+3164, the zero-width joiner and non-joiner, and the variation selectors U+FE00 to
 * U+FE0F and U+E0100 to U+E01EF) and the tag characters (U+E0000 to U+E007F), which can carry
 * hidden text. Door messages are short status texts: a hidden-text channel matters more than an
 * emoji sequence that falls apart.
 */
const UNSAFE_CHARACTERS =
  // oxlint-disable-next-line no-control-regex, no-misleading-character-class -- these characters are what this removes, one by one
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u{61c}\u{200b}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{feff}\u{fff9}-\u{fffb}\u00ad\u{34f}\u{115f}\u{1160}\u{180e}\u{200c}\u{200d}\u{3164}\u{fe00}-\u{fe0f}]|[\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

/**
 * `text` cleaned of terminal control characters and other unsafe characters, so it can be stored
 * and shown as plain text: line ends become `\n` (also U+2028 and U+2029), lone surrogates become
 * U+FFFD, escape sequences go whole and the characters of `UNSAFE_CHARACTERS` go. Tab and newline
 * stay. Idempotent.
 */
export function cleanDoorText(text: string): string {
  return text
    .toWellFormed()
    .replace(/\r\n?|[\u{2028}\u{2029}]/gu, "\n")
    .replace(ESCAPE_SEQUENCES, "")
    .replace(UNSAFE_CHARACTERS, "")
    .toWellFormed();
}

/**
 * Every string value inside `value` (object values, array items) cleaned with `cleanDoorText`.
 * Object keys are kept as they are: `doorKeysClean` refuses a value whose keys cleaning would change.
 */
export function cleanDoorStrings(value: unknown): unknown {
  if (typeof value === "string") return cleanDoorText(value);
  if (Array.isArray(value)) return value.map(cleanDoorStrings);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cleanDoorStrings(item)]),
    );
  }
  return value;
}

/** True when no object key inside `value` holds anything `cleanDoorText` would change. */
export function doorKeysClean(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(doorKeysClean);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).every(
      ([key, item]) => cleanDoorText(key) === key && doorKeysClean(item),
    );
  }
  return true;
}

/** Why the door refused a message. */
export type DoorRefusal = "tooBig" | "notText" | "empty" | "badName" | "badFrame";

/** A part message after its checks: plain text, at least one visible character. */
export const PartMessageSchema = z.string().trim().min(1).max(PART_MESSAGE_MAX_BYTES);

export type PartMessageCheck =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly refusal: DoorRefusal; readonly detail: string };

/**
 * The checks of one part message: `size` (the queue file's size in bytes) within the limit, `bytes`
 * strict UTF-8, then cleaned and parsed with `PartMessageSchema`.
 */
export function checkPartMessage(bytes: Uint8Array, size: number): PartMessageCheck {
  if (size > PART_MESSAGE_MAX_BYTES || bytes.length > PART_MESSAGE_MAX_BYTES) {
    return {
      ok: false,
      refusal: "tooBig",
      detail: `the message has ${Math.max(size, bytes.length)} bytes; at most ${PART_MESSAGE_MAX_BYTES} are allowed`,
    };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, refusal: "notText", detail: "the message is not UTF-8 text" };
  }
  const parsed = PartMessageSchema.safeParse(cleanDoorText(text));
  if (!parsed.success) {
    return { ok: false, refusal: "empty", detail: "the message holds no text once cleaned" };
  }
  return { ok: true, message: parsed.data };
}

// ---------------------------------------------------------------------------------------------
// Reading the queue.

/** One checked part message as a read found it. */
export interface DoorMessage {
  /** The queue file's name, `<seconds>-<pid>.part`. */
  readonly name: string;
  readonly message: string;
}

/** One refused queue file; `name` is null for a file the read script removed (`skip`). */
export interface DoorRefused {
  readonly name: string | null;
  readonly refusal: DoorRefusal;
  readonly detail: string;
}

/** What one read of the queue found. */
export interface DoorRead {
  readonly parts: readonly DoorMessage[];
  readonly refused: readonly DoorRefused[];
  /** True when the output ended with the read's `end` line and nothing after it. */
  readonly complete: boolean;
}

const NEWLINE = 0x0a;

/**
 * Pure: the frames of one read's output, checked. A frame dipo cannot read ends the parse, and so
 * does a frame past `DOOR_MAX_PARTS_PER_READ` frames in all (parts, skips and refusals), which the
 * read script never prints.
 */
export function parseDoorRead(output: Uint8Array): DoorRead {
  const parts: DoorMessage[] = [];
  const refused: DoorRefused[] = [];
  const header = new TextDecoder();
  let at = 0;
  let frames = 0;
  for (;;) {
    const end = output.indexOf(NEWLINE, at);
    if (end < 0 || end - at > MAX_HEADER) {
      if (at < output.length) {
        refused.push({
          name: null,
          refusal: "badFrame",
          detail: "a frame header is cut or too long",
        });
      }
      return { parts, refused, complete: false };
    }
    const line = header.decode(output.subarray(at, end));
    at = end + 1;
    if (line === "end") return { parts, refused, complete: at === output.length };
    frames += 1;
    if (frames > DOOR_MAX_PARTS_PER_READ) {
      refused.push({
        name: null,
        refusal: "badFrame",
        detail: `the read printed more than ${DOOR_MAX_PARTS_PER_READ} frames`,
      });
      return { parts, refused, complete: false };
    }
    if (line === "skip") {
      refused.push({
        name: null,
        refusal: "badName",
        detail: "a queue entry that is not a plain file with a part name was removed",
      });
      continue;
    }
    const frame = /^part ([0-9-]{1,40}\.part) ([0-9]{1,12})$/.exec(line);
    if (frame === null) {
      refused.push({
        name: null,
        refusal: "badFrame",
        detail: "a frame header has the wrong format",
      });
      return { parts, refused, complete: false };
    }
    const name = frame[1] ?? "";
    const size = Number(frame[2]);
    const length = Math.min(size, PART_MESSAGE_MAX_BYTES + 1);
    if (at + length >= output.length || output[at + length] !== NEWLINE) {
      refused.push({ name, refusal: "badFrame", detail: "a frame's bytes do not match its size" });
      return { parts, refused, complete: false };
    }
    const checked = checkPartMessage(output.subarray(at, at + length), size);
    at += length + 1;
    if (checked.ok) parts.push({ name, message: checked.message });
    else refused.push({ name, refusal: checked.refusal, detail: checked.detail });
  }
}

/** How dipo runs its fixed commands in one box. */
export interface DoorExec {
  readonly boxes: Pick<BoxPort, "execLive">;
  readonly box: string;
  readonly clock: Clock;
  /** The deadline of one call; `DOOR_EXEC_TIMEOUT_MS` by default. */
  readonly timeoutMs?: number;
}

function doorFailure(message: string): BoxError {
  return new BoxError("box.doorFailed", message);
}

/**
 * Runs `command` in the box with its stdin closed and reads its output up to `maxBytes` within
 * the deadline. Past either, the exec client is killed and the call fails with `box.doorFailed`.
 */
async function boundedExec(
  exec: DoorExec,
  command: readonly [string, ...string[]],
  maxBytes: number,
): Promise<{ readonly code: number | null; readonly stdout: Uint8Array }> {
  const child = exec.boxes.execLive(exec.box, command);
  child.stdin.end();
  // Drained so the command never blocks on its error output; nothing of it is kept.
  child.stderr.pipeTo(new WritableStream()).catch(() => {});
  let timer: TimerHandle | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = exec.clock.setTimeout(
      () => reject(doorFailure("a door command in the box passed its deadline.")),
      exec.timeoutMs ?? DOOR_EXEC_TIMEOUT_MS,
    );
  });
  deadline.catch(() => {});
  const reader = child.stdout.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let ok = false;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      received += value.length;
      if (received > maxBytes) {
        throw doorFailure(`a door command in the box printed more than ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
    const exit = await Promise.race([child.exited, deadline]);
    ok = true;
    const stdout = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      stdout.set(chunk, offset);
      offset += chunk.length;
    }
    return { code: exit.code, stdout };
  } finally {
    if (timer !== undefined) exec.clock.clearTimeout(timer);
    if (!ok) {
      child.kill("SIGKILL");
      reader.cancel().catch(() => {});
    }
  }
}

/** Reads the queue once (`doorReadCommand`); fails with `box.doorFailed` when the read fails. */
export async function readDoor(exec: DoorExec, queue: string = DOOR_QUEUE): Promise<DoorRead> {
  const result = await boundedExec(exec, doorReadCommand(queue), DOOR_READ_MAX_BYTES);
  if (result.code !== 0) throw doorFailure(`the door read in the box exited ${result.code}.`);
  return parseDoorRead(result.stdout);
}

/** Removes the taken queue files and renames the refused ones; nothing when both are empty. */
export async function ackDoor(
  exec: DoorExec,
  take: readonly string[],
  refuse: readonly string[],
  queue: string = DOOR_QUEUE,
): Promise<void> {
  if (take.length === 0 && refuse.length === 0) return;
  const result = await boundedExec(exec, doorAckCommand(take, refuse, queue), ACK_MAX_BYTES);
  if (result.code !== 0) throw doorFailure(`the door acknowledgement exited ${result.code}.`);
}

/**
 * Installs `dipo-part` in a running box (at box creation): dipo writes the script into a stage
 * folder of its own, copies that one file to `DIPO_PART_PATH` and makes it executable there.
 */
export async function installDipoPart(
  deps: { readonly boxes: Pick<BoxPort, "copyIn" | "exec">; readonly tmpRoot: string },
  box: string,
): Promise<void> {
  const stage = await mkdtemp(join(deps.tmpRoot, DOOR_STAGE_PREFIX));
  try {
    const file = join(stage, "dipo-part");
    await writeFile(file, dipoPartScript(), { mode: 0o755 });
    await chmod(file, 0o755);
    await deps.boxes.copyIn(box, file, DIPO_PART_PATH);
    const made = await deps.boxes.exec(box, ["/bin/chmod", "0755", DIPO_PART_PATH]);
    if (made.code !== 0) {
      throw new BoxError(
        "box.failed",
        `dipo-part could not be made executable (exit ${made.code}).`,
      );
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Polling the boxes.

/** One part the door took, as `onPart` gets it. */
export interface DoorPart {
  readonly runId: string;
  readonly box: string;
  /** The part's number in the run, from 1. */
  readonly n: number;
  /** The queue file's name in the box. */
  readonly name: string;
  /** The checked, cleaned message: text only, never an instruction. */
  readonly message: string;
  /** When dipo read it, on the engine clock. */
  readonly at: number;
}

/** One line of `DOOR_RECORD_FILE`. */
export type DoorRecordLine =
  | {
      readonly kind: "part";
      readonly at: number;
      readonly n: number;
      readonly name: string;
      readonly message: string;
    }
  | {
      readonly kind: "refused";
      readonly at: number;
      readonly name: string | null;
      readonly refusal: DoorRefusal;
      readonly detail: string;
    };

export interface BoxDoorDeps {
  /**
   * The reads; with `list`, a failed scheduled read is logged only while the backend lists the
   * box as running.
   */
  readonly boxes: Pick<BoxPort, "execLive"> & Partial<Pick<BoxPort, "list">>;
  readonly clock: Clock;
  /** How often a box's queue is read; `DOOR_POLL_MS` by default. */
  readonly pollMs?: number;
  readonly timeoutMs?: number;
  /**
   * A part the door took (DIPO-273 delivers it). The queue file is removed only once this
   * resolves, so the worker's `dipo-part` waits until then; a rejection leaves it queued and the
   * next read hands the same part again.
   */
  readonly onPart?: (part: DoorPart) => Promise<void> | void;
  /** A message the door refused, after it was recorded. */
  readonly onRefused?: (runId: string, refused: DoorRefused) => void;
  /**
   * True while the run goes on (tracked, nothing decided for it yet). With it, no read of a run
   * for which it is false starts: `read` returns null and a scheduled read waits for the next poll.
   */
  readonly live?: (runId: string) => boolean;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
  readonly info?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

interface OpenDoor {
  readonly runId: string;
  readonly box: string;
  readonly runDir: string;
  /** Queue file names recorded in the run directory, with their part number. */
  readonly recorded: Map<string, number>;
  /** Queue file names whose `onPart` resolved. */
  readonly handled: Set<string>;
  /** The bad frames recorded already, by name (or detail): each is recorded and warned about once. */
  readonly badFrames: Set<string>;
  parts: number;
  timer: TimerHandle | null;
  reading: Promise<DoorRead> | null;
  closed: boolean;
}

/** The parts of a run's record file, by queue file name, and the highest part number. */
function readRecord(runDir: string): { recorded: Map<string, number>; parts: number } {
  const recorded = new Map<string, number>();
  let parts = 0;
  let text = "";
  try {
    text = readFileSync(join(runDir, DOOR_RECORD_FILE), "utf8");
  } catch {
    return { recorded, parts };
  }
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      const value = JSON.parse(line) as Partial<{ kind: string; name: string; n: number }>;
      if (value.kind === "part" && typeof value.name === "string" && typeof value.n === "number") {
        recorded.set(value.name, value.n);
        parts = Math.max(parts, value.n);
      }
    } catch {
      // A torn last line from a crash: its part is read again from the box.
    }
  }
  return { recorded, parts };
}

/** Reads the door of every box that runs a session, until it is closed (see the file comment). */
export class BoxDoor {
  readonly #deps: BoxDoorDeps;
  readonly #open = new Map<string, OpenDoor>();

  constructor(deps: BoxDoorDeps) {
    this.#deps = deps;
  }

  /** The runs whose door is read now. */
  get open(): readonly string[] {
    return [...this.#open.keys()];
  }

  /** Starts reading the door of `runId`'s box `box`; a door open already keeps its state. */
  start(runId: string, box: string, runDir: string): void {
    if (this.#open.has(runId)) return;
    const { recorded, parts } = readRecord(runDir);
    const door: OpenDoor = {
      runId,
      box,
      runDir,
      recorded,
      handled: new Set(),
      badFrames: new Set(),
      parts,
      timer: null,
      reading: null,
      closed: false,
    };
    this.#open.set(runId, door);
    this.#schedule(door);
  }

  /** Stops reading the door of `runId`. */
  stop(runId: string): void {
    const door = this.#open.get(runId);
    if (door === undefined) return;
    door.closed = true;
    if (door.timer !== null) this.#deps.clock.clearTimeout(door.timer);
    door.timer = null;
    this.#open.delete(runId);
  }

  /** Stops every door. */
  close(): void {
    for (const runId of this.#open.keys()) this.stop(runId);
  }

  /**
   * Reads the door of `runId` now (DIPO-273 reads it before a story done), or waits for the read
   * that runs. Null when the run's door is not open. Rejects with `box.doorFailed` when the box
   * cannot be read.
   */
  read(runId: string): Promise<DoorRead> | null {
    const door = this.#open.get(runId);
    if (door === undefined) return null;
    // A read in flight is waited for; a new one starts only while the run goes on.
    if (door.reading === null && this.#deps.live?.(runId) === false) return null;
    door.reading ??= this.#read(door).finally(() => {
      door.reading = null;
    });
    return door.reading;
  }

  #schedule(door: OpenDoor): void {
    if (door.closed) return;
    door.timer = this.#deps.clock.setTimeout(() => {
      door.timer = null;
      void (this.read(door.runId) ?? Promise.resolve(null))
        .catch(async (error: unknown) => {
          // A read the end of the session cut is no door fault (see the file comment).
          if (!(await this.#boxRuns(door))) return;
          // A box between two sessions cannot be read: the next read tries again.
          this.#deps.info?.("the box door could not be read", {
            run: door.runId,
            box: door.box,
            reason: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => this.#schedule(door));
    }, this.#deps.pollMs ?? DOOR_POLL_MS);
  }

  /**
   * After a failed read: false when the door was stopped, the run ended, or the backend lists the
   * box as anything but running. A list that fails says nothing, so the failure counts.
   */
  async #boxRuns(door: OpenDoor): Promise<boolean> {
    if (door.closed || this.#deps.live?.(door.runId) === false) return false;
    const list = this.#deps.boxes.list;
    if (list === undefined) return true;
    let state: string | undefined;
    try {
      state = (await list.call(this.#deps.boxes)).find((box) => box.name === door.box)?.state;
    } catch {
      return true;
    }
    return state === "running" && !door.closed && this.#deps.live?.(door.runId) !== false;
  }

  #exec(door: OpenDoor): DoorExec {
    return {
      boxes: this.#deps.boxes,
      box: door.box,
      clock: this.#deps.clock,
      ...(this.#deps.timeoutMs === undefined ? {} : { timeoutMs: this.#deps.timeoutMs }),
    };
  }

  #record(door: OpenDoor, line: DoorRecordLine): void {
    appendFileSync(join(door.runDir, DOOR_RECORD_FILE), `${JSON.stringify(line)}\n`, {
      mode: 0o600,
    });
  }

  async #read(door: OpenDoor): Promise<DoorRead> {
    const exec = this.#exec(door);
    const read = await readDoor(exec);
    const at = this.#deps.clock.now();
    const take: string[] = [];
    const refuse: string[] = [];
    for (const refused of read.refused) {
      if (refused.refusal === "badFrame") {
        // A bad frame stays in the box and comes back on every read: it is recorded once.
        const key = refused.name ?? refused.detail;
        if (door.badFrames.has(key)) continue;
        door.badFrames.add(key);
      }
      this.#record(door, { kind: "refused", at, ...refused });
      this.#deps.warn?.("the box door refused a message", {
        run: door.runId,
        box: door.box,
        refusal: refused.refusal,
        detail: refused.detail,
      });
      this.#deps.onRefused?.(door.runId, refused);
      // A frame dipo could not read is left in the box: its bytes may not be what the name says.
      if (refused.name !== null && refused.refusal !== "badFrame") refuse.push(refused.name);
    }
    for (const part of read.parts) {
      let n = door.recorded.get(part.name);
      if (n === undefined) {
        door.parts += 1;
        n = door.parts;
        this.#record(door, { kind: "part", at, n, name: part.name, message: part.message });
        door.recorded.set(part.name, n);
        this.#deps.info?.("the box door took a part", { run: door.runId, box: door.box, part: n });
      }
      if (!door.handled.has(part.name)) {
        try {
          await this.#deps.onPart?.({
            runId: door.runId,
            box: door.box,
            n,
            name: part.name,
            message: part.message,
            at,
          });
        } catch (error) {
          this.#deps.warn?.("handing on a part from the box door failed; it stays queued", {
            run: door.runId,
            part: n,
            reason: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        door.handled.add(part.name);
      }
      take.push(part.name);
    }
    await ackDoor(exec, take, refuse);
    for (const name of take) door.handled.delete(name);
    return read;
  }
}
