<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
// `dipo idea` and `dipo note dismiss` (DIPO-454): `dipo idea "<text>"` hands a quick idea to the
// audit with `idea.quick`; `dipo idea accept|dismiss <idea>` sends `idea.accept` or `idea.dismiss`
// for the id the desk prints, or a prefix of 8 or more of its characters, without asking, and
// prints where the accepted idea is filed; `dipo note dismiss <note>` sends `note.dismiss`.
=======
// `dipo idea "<text>"`, `dipo idea accept|dismiss <idea>` and `dipo note dismiss <note>`
// (DIPO-454): the quick idea goes to the audit as `idea.add`; accept and dismiss send `idea.accept`
// or `idea.dismiss` for the id the desk prints, or a prefix of 8 or more of its characters, without
// asking, and accept prints where the draft is filed; `note dismiss` sends `note.dismiss`. The
// old `dipo propose` is gone.
>>>>>>> de146a854c2be9713e40505688960f87444be951

import { describe, expect, it } from "bun:test";

import { type OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { DaemonControl, DaemonSession } from "./daemon-commands";
import {
  type FakeWorkspace,
  type FakeWorkspaceOptions,
  fakeWorkspace,
} from "../test/support/fake-workspace";
import { HELP, main, type CliDeps } from "./index";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as OfficeId;
const IDEA = "3f".repeat(32);
<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
const NOTE = "4e".repeat(32);
=======
>>>>>>> de146a854c2be9713e40505688960f87444be951
const IN_OFFICE = {
  repository: {
    mainWorktree: "/work/app",
    commonDir: "/work/app/.git",
    office: OFFICE,
    backlog: true,
  },
};

const NO_LIFECYCLE: DaemonControl = {
  inspect: () => Promise.reject(new Error("inspect must not be called")),
  start: () => Promise.reject(new Error("start must not be called")),
  stop: () => Promise.reject(new Error("stop must not be called")),
  restart: () => Promise.reject(new Error("restart must not be called")),
};

type Sent = { name: string; args: unknown; office: unknown };

function fake(reply: (sent: Sent) => unknown, workspace: FakeWorkspaceOptions = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const sent: Sent[] = [];
  const ws: FakeWorkspace = fakeWorkspace({ cwd: "/work/app", ...IN_OFFICE, ...workspace });
  const deps: CliDeps = {
    writeLine: (line) => out.push(line),
    writeError: (line) => err.push(line),
    runDaemon: async () => {
      throw new Error("runDaemon must not be called");
    },
    connectDaemon: async () =>
      ({
        command: (async (definition: { name: string }, args: unknown, options: unknown) => {
          const message = {
            name: definition.name,
            args,
            office: (options as { office?: unknown } | undefined)?.office,
          };
          sent.push(message);
          return reply(message);
        }) as DaemonSession["command"],
        close: () => undefined,
      }) as unknown as DaemonSession,
    daemon: NO_LIFECYCLE,
    clock: new ManualClock(),
    clientChecks: [],
    stamp: undefined,
    runtime: { bun: "1.4.2", os: "linux", arch: "arm64" },
    workspace: ws,
  };
  return { deps, out, err, sent, ws };
}

<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
describe('dipo idea "<text>" (criterion 5)', () => {
  it("hands the text to the audit as a quick idea with idea.quick, without asking", async () => {
    const ctx = fake(() => ({ ok: true, changed: true, result: { idea: IDEA, held: true } }));
    const text = "Cap the PR poll retry\nIt retries at once, without a limit.";
    expect(await main(["idea", text], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([{ name: "idea.quick", args: { text }, office: OFFICE }]);
    expect(ctx.ws.questions).toEqual([]);
    expect(ctx.out).toEqual([
      "held idea 3f3f3f3f3f3f: dipo audits it now, and it reaches dipo desk only if it passes",
    ]);
  });

  it("names the story it is about with --story, takes --office, and says when it was held already", async () => {
    const other = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C2E";
    const ctx = fake(() => ({ ok: true, changed: false, result: { idea: IDEA, held: false } }));
    expect(
      await main(["idea", "Show the spend", "--story", "DIPO-12", "--office", other], ctx.deps),
    ).toBe(0);
    expect(ctx.sent).toEqual([
      { name: "idea.quick", args: { text: "Show the spend", story: "DIPO-12" }, office: other },
    ]);
    expect(ctx.out).toEqual([
      "idea 3f3f3f3f3f3f was held already; dipo ideas shows how its audit went",
    ]);
  });

  it("reads a quoted idea that starts with accept as an idea, not as a decision", async () => {
    const ctx = fake(() => ({ ok: true, changed: true, result: { idea: IDEA, held: true } }));
    expect(await main(["idea", "accept drafts from the TUI"], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([
      { name: "idea.quick", args: { text: "accept drafts from the TUI" }, office: OFFICE },
    ]);
  });

  it("needs the idea as one argument, and a story id after --story", async () => {
    const ctx = fake(() => ({}));
    expect(await main(["idea"], ctx.deps)).toBe(2);
    expect(await main(["idea", "two", "words"], ctx.deps)).toBe(2);
    expect(await main(["idea", "   "], ctx.deps)).toBe(2);
    expect(await main(["idea", "An idea", "--story"], ctx.deps)).toBe(2);
    expect(await main(["idea", "An idea", "--story", "not a story"], ctx.deps)).toBe(2);
    expect(await main(["idea", "An idea", "--yes"], ctx.deps)).toBe(2);
    expect(ctx.sent).toEqual([]);
  });
});

describe("dipo idea accept (criterion 2)", () => {
=======
describe("dipo idea accept", () => {
>>>>>>> de146a854c2be9713e40505688960f87444be951
  it("sends idea.accept for the id, without asking, and prints the backlog PR the flush opened", async () => {
    const pr = "https://github.com/acme/app/pull/12";
    const ctx = fake(() => ({
      ok: true,
      changed: true,
      result: {
        idea: IDEA,
        state: "accepted",
        draft: "DRAFT-4",
        flush: { state: "opened", branch: "dipo/backlog-20261030T080300", pr },
      },
    }));
    expect(await main(["idea", "accept", IDEA], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([{ name: "idea.accept", args: { idea: IDEA }, office: OFFICE }]);
    expect(ctx.ws.questions).toEqual([]);
    expect(ctx.out).toEqual([
      `accepted idea 3f3f3f3f3f3f: Backlog draft DRAFT-4 is on the new backlog PR ${pr}`,
    ]);
  });

  // DIPO-401: the line follows what the flush did, and promises no PR it did not open.
  it.each([
    [
      { state: "updated", branch: "dipo/backlog-1", pr: "https://github.com/acme/app/pull/12" },
      "Backlog draft DRAFT-4 was added to the backlog PR https://github.com/acme/app/pull/12",
    ],
    [
      { state: "pushed", branch: "dipo/backlog-1" },
      "Backlog draft DRAFT-4 is pushed on dipo/backlog-1; its backlog PR is not open yet, and dipo opens or updates it at the next backlog change",
    ],
    [{ state: "merged" }, "Backlog draft DRAFT-4 is on the base already"],
    [
      { state: "held", branch: "dipo/backlog-1", reason: "the backlog PR has auto-merge on" },
      "Backlog draft DRAFT-4 waits for the next backlog PR: the backlog PR has auto-merge on",
    ],
    [
      { state: "waiting", branch: "dipo/backlog-1", reason: "pushing to origin failed" },
      "Backlog draft DRAFT-4 is on dipo/backlog-1 and waits: pushing to origin failed",
    ],
    [
      { state: "waiting", reason: "the flush did not apply it" },
      "Backlog draft DRAFT-4 waits: the flush did not apply it",
    ],
    [
      { state: "failed", reason: "git fetch failed." },
      "the planning lane could not file Backlog draft DRAFT-4, it stays journaled: git fetch failed.",
    ],
    [
      { state: "closed", reason: "the Backlog CLI exited 1." },
      "Backlog draft DRAFT-4 was not filed: the Backlog CLI exited 1.",
    ],
  ])("says what the flush did: %o", async (flush, text) => {
    const ctx = fake(() => ({
      ok: true,
      changed: true,
      result: { idea: IDEA, state: "accepted", draft: "DRAFT-4", flush },
    }));
    expect(await main(["idea", "accept", IDEA], ctx.deps)).toBe(0);
    expect(ctx.out).toEqual([`accepted idea 3f3f3f3f3f3f: ${text}`]);
  });

<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
  it("takes a prefix in any case and --office, and names a draft filed earlier", async () => {
    const other = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C2E";
=======
  it("names the draft it filed earlier when no flush ran", async () => {
>>>>>>> de146a854c2be9713e40505688960f87444be951
    const ctx = fake(() => ({
      ok: true,
      changed: false,
      result: { idea: IDEA, state: "accepted", draft: "DRAFT-4" },
    }));
<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
    expect(await main(["idea", "accept", "3F3F3F3F", "--office", other], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([{ name: "idea.accept", args: { idea: "3f3f3f3f" }, office: other }]);
    expect(ctx.out).toEqual([
      "idea 3f3f3f3f3f3f was accepted already: filed as Backlog draft DRAFT-4 through the backlog PR",
=======
    expect(await main(["idea", "accept", IDEA], ctx.deps)).toBe(0);
    expect(ctx.out).toEqual([
      "idea 3f3f3f3f3f3f was accepted already: filed as Backlog draft DRAFT-4 through the backlog PR",
    ]);
  });

  it("takes a prefix in any case and --office, and says when the draft waits for the lane", async () => {
    const other = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C2E";
    const ctx = fake(() => ({
      ok: true,
      changed: false,
      result: { idea: IDEA, state: "accepted" },
    }));
    expect(await main(["idea", "accept", "3F3F3F3F", "--office", other], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([{ name: "idea.accept", args: { idea: "3f3f3f3f" }, office: other }]);
    expect(ctx.out).toEqual([
      "idea 3f3f3f3f3f3f was accepted already: dipo files it as a Backlog draft through the backlog PR",
>>>>>>> de146a854c2be9713e40505688960f87444be951
    ]);
  });

  it("prints the engine's refusal and exits 1", async () => {
    const ctx = fake(() => ({
      ok: false,
      error: { code: "idea.notOpen", message: "it was dismissed", retryable: false },
    }));
    expect(await main(["idea", "accept", IDEA], ctx.deps)).toBe(1);
    expect(ctx.err.join("\n")).toContain("it was dismissed");
  });
});

<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
describe("dipo idea dismiss (criterion 3)", () => {
  it("sends idea.dismiss and says nothing is filed and it is kept as dismissed", async () => {
=======
describe("dipo idea dismiss", () => {
  it("sends idea.dismiss and says nothing is filed and the idea is kept as dismissed", async () => {
>>>>>>> de146a854c2be9713e40505688960f87444be951
    const ctx = fake(() => ({
      ok: true,
      changed: true,
      result: { idea: IDEA, state: "dismissed" },
    }));
    expect(await main(["idea", "dismiss", IDEA.slice(0, 10)], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([
      { name: "idea.dismiss", args: { idea: IDEA.slice(0, 10) }, office: OFFICE },
    ]);
    expect(ctx.out).toEqual([
      "dismissed idea 3f3f3f3f3f3f; nothing is filed, and dipo keeps it as dismissed by you",
    ]);
  });
});

<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
=======
describe("dipo idea <text> (criterion 5)", () => {
  it("hands the text to the audit as idea.add, with the story it names", async () => {
    const ctx = fake(() => ({ ok: true, changed: true, result: { idea: IDEA, held: true } }));
    expect(await main(["idea", "Show the spend per tier", "--story", "DIPO-12"], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([
      {
        name: "idea.add",
        args: { text: "Show the spend per tier", story: "DIPO-12" },
        office: OFFICE,
      },
    ]);
    expect(ctx.out).toEqual([
      "handed idea 3f3f3f3f3f3f to the audit; if it passes, it reaches your desk as a proposed story (dipo ideas shows it meanwhile)",
    ]);
  });

  it("joins unquoted words, keeps a quoted accept as text, and says when the idea is held already", async () => {
    const ctx = fake(() => ({ ok: true, changed: false, result: { idea: IDEA, held: false } }));
    expect(await main(["idea", "cap", "the", "retries"], ctx.deps)).toBe(0);
    expect(await main(["idea", "accept the old flag once more"], ctx.deps)).toBe(0);
    expect(ctx.sent.map((sent) => sent.args)).toEqual([
      { text: "cap the retries" },
      { text: "accept the old flag once more" },
    ]);
    expect(ctx.out).toEqual([
      "idea 3f3f3f3f3f3f is held already; dipo ideas shows where it stands",
      "idea 3f3f3f3f3f3f is held already; dipo ideas shows where it stands",
    ]);
  });

  it("prints the engine's refusal of an unknown story and exits 1", async () => {
    const ctx = fake(() => ({
      ok: false,
      error: { code: "story.unknown", message: "No story has the id DIPO-99.", retryable: false },
    }));
    expect(await main(["idea", "x", "--story", "DIPO-99"], ctx.deps)).toBe(1);
    expect(ctx.err.join("\n")).toContain("DIPO-99");
  });
});

>>>>>>> de146a854c2be9713e40505688960f87444be951
describe("dipo note dismiss (criterion 4)", () => {
  it("sends note.dismiss for a decision note", async () => {
    const ctx = fake(() => ({
      ok: true,
      changed: true,
<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
      result: { note: NOTE, state: "dismissed" },
    }));
    expect(await main(["note", "dismiss", NOTE.slice(0, 12)], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([
      { name: "note.dismiss", args: { note: NOTE.slice(0, 12) }, office: OFFICE },
    ]);
    expect(ctx.out).toEqual([
      "dismissed decision note 4e4e4e4e4e4e; add it to the decision record by hand if you agree",
    ]);
  });

  it("needs dismiss and one note id of 8 or more hex characters", async () => {
    const ctx = fake(() => ({}));
    expect(await main(["note"], ctx.deps)).toBe(2);
    expect(await main(["note", "accept", NOTE], ctx.deps)).toBe(2);
    expect(await main(["note", "dismiss"], ctx.deps)).toBe(2);
    expect(await main(["note", "dismiss", "4e4e"], ctx.deps)).toBe(2);
    expect(await main(["note", "dismiss", NOTE, NOTE], ctx.deps)).toBe(2);
    expect(ctx.sent).toEqual([]);
  });
});

describe("the old dipo propose (criterion 4)", () => {
  it("is gone, from the commands and the help", async () => {
    const ctx = fake(() => ({}));
    expect(await main(["propose", "accept", IDEA], ctx.deps)).toBe(2);
    expect(ctx.sent).toEqual([]);
    expect(HELP).not.toContain("dipo propose");
    expect(HELP).toContain('dipo idea "<text>" [--story <id>] [--office <id>]');
    expect(HELP).toContain("dipo idea accept|dismiss <idea> [--office <id>]");
    expect(HELP).toContain("dipo note dismiss <note> [--office <id>]");
=======
      result: { note: IDEA, state: "dismissed" },
    }));
    expect(await main(["note", "dismiss", IDEA.slice(0, 8)], ctx.deps)).toBe(0);
    expect(ctx.sent).toEqual([
      { name: "note.dismiss", args: { note: IDEA.slice(0, 8) }, office: OFFICE },
    ]);
    expect(ctx.out[0]).toContain("dismissed decision note 3f3f3f3f3f3f");
  });
});

describe("dipo idea and note usage", () => {
  it("needs a text, or accept or dismiss and one idea id of 8 or more hex characters", async () => {
    const ctx = fake(() => ({}));
    expect(await main(["idea"], ctx.deps)).toBe(2);
    expect(await main(["idea", "accept"], ctx.deps)).toBe(2);
    expect(await main(["idea", "accept", "3f3f"], ctx.deps)).toBe(2);
    expect(await main(["idea", "accept", "prp_01J"], ctx.deps)).toBe(2);
    expect(await main(["idea", "accept", IDEA, IDEA], ctx.deps)).toBe(2);
    expect(await main(["idea", "accept", IDEA, "--yes"], ctx.deps)).toBe(2);
    expect(await main(["idea", "dismiss", IDEA, "--story", "DIPO-1"], ctx.deps)).toBe(2);
    expect(await main(["idea", "x", "--story"], ctx.deps)).toBe(2);
    expect(await main(["idea", "x".repeat(2_001)], ctx.deps)).toBe(2);
    expect(await main(["note"], ctx.deps)).toBe(2);
    expect(await main(["note", "dismiss"], ctx.deps)).toBe(2);
    expect(await main(["note", "dismiss", "xyz"], ctx.deps)).toBe(2);
    expect(ctx.sent).toEqual([]);
  });

  it("is in the help, and dipo propose is gone", async () => {
    expect(HELP).toContain('dipo idea "<text>" [--story <id>] [--office <id>]');
    expect(HELP).toContain("dipo idea accept|dismiss <idea> [--office <id>]");
    expect(HELP).toContain("dipo note dismiss <note> [--office <id>]");
    expect(HELP).not.toContain("dipo propose");
    const ctx = fake(() => ({}));
    expect(await main(["propose", "accept", IDEA], ctx.deps)).not.toBe(0);
    expect(ctx.sent).toEqual([]);
>>>>>>> de146a854c2be9713e40505688960f87444be951
  });
});
