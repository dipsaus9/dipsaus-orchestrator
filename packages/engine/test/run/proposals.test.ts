// A worker's proposals for the maintainer (DIPO-166; 0020 sections 11c, 12 and 14): each proposal
// DIPO-186 stores emits `proposal.filed`; the desk lists the open ones, spike before follow-up,
// each with `dipo propose accept` and `dipo propose dismiss`; `proposal.accept` journals one lane
// operation that files a Backlog draft with the title, the outcome line, the paths as references
// and the source story, the worker's text marked as the worker's words, cleaned and capped;
// `proposal.dismiss` closes the proposal; both emit `proposal.closed`. Nothing is filed without the
// accept. A lane that journals into the real journal and counts its flushes stands in for git and
// the Backlog CLI; the kind itself runs against the pinned CLI in proposals-lane.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  type DeskItem,
  RequestId,
  RunId,
  SEQUENCE_SAMPLES,
  StoryId,
  type StoryKey,
} from "@dipsaus-orchestrator/contract";

import {
  allEntries,
  type LaneOp,
  type OfficeLane,
  planningLane,
  PROPOSAL_MARKER,
  PROPOSE_KIND,
  proposeTarget,
  type ProposeTarget,
} from "../../src/backlog/lane";
import { insertEntry, recordPrRef, updateEntry } from "../../src/backlog/lane/journal";
import { stateOfficeDirectory } from "../../src/commands/offices";
import { executeCommand } from "../../src/commands/execute";
import { buildRegistry } from "../../src/commands/registry";
import { MemoryRequestTable } from "../../src/commands/requests";
import type { OfficeHandle } from "../../src/db/office";
import { executeRead } from "../../src/reads/execute";
import { ProposalCommands, proposalDraft, type StoredProposal } from "../../src/run/proposals";
import { proposalHash, storeProposals } from "../../src/run/report-data";
import { addStory } from "../../src/records/story-keys";
import { viewsFeature } from "../overview/views-feature";
import { addOffice, openTestState, type TestState } from "../commands/helpers";

const RUN = RunId.parse("run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D");
const BRANCH = "dipo/backlog-20260101T000000";
const PR_URL = "https://github.com/acme/app/pull/7";

interface World {
  readonly dir: string;
  readonly t: TestState;
  readonly office: OfficeHandle;
  readonly ops: LaneOp[];
  readonly flushes: { n: number };
  readonly registry: ReturnType<typeof buildRegistry>;
  readonly key: StoryKey;
}

let w: World;

function fakeLane(office: OfficeHandle, t: TestState, ops: LaneOp[], flushes: { n: number }) {
  return {
    journal: async (op: LaneOp) => {
      ops.push(op);
      return office.immediate(() => insertEntry(office, op, t.clock.now()));
    },
    // The flush pushes every pending entry on one branch and records its backlog PR, as the lane
    // and `BacklogPrs.afterFlush` do.
    flush: async () => {
      flushes.n += 1;
      const committed: number[] = [];
      office.immediate(() => {
        for (const entry of allEntries(office)) {
          if (entry.state !== "pending") continue;
          updateEntry(office, entry.opId, { state: "pushed", branch: BRANCH }, t.clock.now());
          committed.push(entry.opId);
        }
        recordPrRef(office, BRANCH, PR_URL, t.clock.now());
      });
      return {
        branch: BRANCH,
        committed,
        merged: [],
        dropped: [],
        rebuiltFrom: null,
        pushed: true,
        waiting: null,
      };
    },
    stall: () => null,
    heldReason: () => "held",
    office,
    clock: t.clock,
  } as unknown as OfficeLane;
}

beforeEach(() => {
  const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "proposals-"));
  return openTestState(dir).then((t) => {
    const office = addOffice(t);
    const ops: LaneOp[] = [];
    const flushes = { n: 0 };
    const commands = new ProposalCommands({
      lane: () => planningLane(fakeLane(office, t, ops, flushes)),
    });
    const registry = buildRegistry([viewsFeature, commands.feature]);
    const { key } = office.immediate(() =>
      addStory(office, t.ids, { story: StoryId.parse("DIPO-186") }, t.clock.now()),
    );
    w = { dir, t, office, ops, flushes, registry, key };
  });
});

afterEach(() => {
  w.t.state.close();
  rmSync(w.dir, { recursive: true, force: true });
});

const FOLLOW_UP = {
  kind: "follow-up",
  title: "Split RunOutcomes",
  outcome: "RunOutcomes is two modules.",
  why: "It grew past 900 lines.",
  paths: ["packages/engine/src/run/outcomes.ts"],
} as const;
const SPIKE = {
  kind: "spike",
  title: "Choose a queue",
  outcome: "A decision on the queue.",
  why: "Two designs fit.",
} as const;

function store(proposals: Parameters<typeof storeProposals>[1]["proposals"], at = 0): number {
  return w.office.immediate(() =>
    storeProposals(w.office, {
      key: w.key,
      runId: RUN,
      proposals,
      at: w.t.clock.now() + at,
    }),
  );
}

let sequence = 0;
async function send(name: string, args: unknown) {
  sequence += 1;
  return await executeCommand(
    {
      registry: w.registry,
      offices: stateOfficeDirectory(w.t.state),
      clock: w.t.clock,
      ids: w.t.ids,
      softwareRequests: new MemoryRequestTable(w.t.clock),
    },
    {
      requestId: RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${String(sequence).padStart(8, "0")}`),
      name,
      args,
      origin: "cli",
      office: w.office.officeId,
      confirmed: false,
    },
  );
}

async function readDesk(): Promise<DeskItem[]> {
  const reply = await executeRead(
    { registry: w.registry, offices: stateOfficeDirectory(w.t.state), clock: w.t.clock },
    {
      requestId: RequestId.parse("01J9ZK5Q8W3V4X6Y7Z99999999"),
      name: "office.desk",
      args: { office: w.office.officeId },
    },
  );
  if (!reply.ok) throw new Error(`office.desk failed: ${reply.error.code}`);
  return reply.result as DeskItem[];
}

/** The office's change-log entries of `type`, oldest first. */
function logged(type: string): unknown[] {
  return w.office
    .all<{ delta: string }>(
      "select delta from change_log where office_id = $office_id and type = $type order by seq",
      { type },
    )
    .map((row) => JSON.parse(row.delta) as unknown);
}

function stored(hash: string) {
  return w.office.get<{ state: string; decided_by: string | null }>(
    "select state, decided_by from proposals where office_id = $office_id and hash = $hash",
    { hash },
  );
}

describe("proposal.filed (criterion 1)", () => {
  it("is emitted once for each stored proposal, and not for the same proposal again", () => {
    expect(store([FOLLOW_UP, SPIKE])).toBe(2);
    // A later report with the same title and paths stores and emits nothing.
    expect(store([{ ...FOLLOW_UP, why: "Still big." }], 5)).toBe(0);
    expect(logged("proposal.filed")).toEqual([
      {
        proposal: proposalHash(FOLLOW_UP),
        kind: "follow-up",
        key: w.key,
        story: "DIPO-186",
        run: RUN,
        title: "Split RunOutcomes",
      },
      {
        proposal: proposalHash(SPIKE),
        kind: "spike",
        key: w.key,
        story: "DIPO-186",
        run: RUN,
        title: "Choose a queue",
      },
    ]);
  });

  it("carries the worker's title cleaned of terminal sequences and on one line", () => {
    const title = `Fix${SEQUENCE_SAMPLES["CSI, 7-bit"]}\nthe ${SEQUENCE_SAMPLES["OSC"]}flag`;
    store([{ ...SPIKE, title }]);
    expect((logged("proposal.filed")[0] as { title: string }).title).toBe("Fix the flag");
  });
});

describe("the desk's proposals (criterion 2)", () => {
  it("lists open proposals, spike before follow-up, each with dipo propose accept and dismiss", async () => {
    store([FOLLOW_UP]);
    store([SPIKE], 10);
    const items = (await readDesk()).filter((item) => item.kind === "PROPOSAL");
    expect(items.map((item) => item.proposal?.kind)).toEqual(["spike", "follow-up"]);
    expect(items.map((item) => item.actions)).toEqual(
      [proposalHash(SPIKE), proposalHash(FOLLOW_UP)].map((id) => [
        { command: "proposal.accept", cli: `dipo propose accept ${id}` },
        { command: "proposal.dismiss", cli: `dipo propose dismiss ${id}` },
      ]),
    );
  });

  it("no longer lists a proposal once it is accepted or dismissed", async () => {
    store([FOLLOW_UP, SPIKE]);
    expect((await send("proposal.accept", { proposal: proposalHash(FOLLOW_UP) })).ok).toBe(true);
    expect((await send("proposal.dismiss", { proposal: proposalHash(SPIKE) })).ok).toBe(true);
    expect((await readDesk()).filter((item) => item.kind === "PROPOSAL")).toEqual([]);
  });
});

describe("proposal.accept (criterion 3)", () => {
  it("journals one lane-b draft with the title, outcome, paths and source story, then flushes", async () => {
    store([FOLLOW_UP]);
    const hash = proposalHash(FOLLOW_UP);
    // A unique prefix of 8 characters names it.
    const reply = await send("proposal.accept", { proposal: hash.slice(0, 8) });
    // The result says what the flush did with the draft (DIPO-401).
    expect(reply).toMatchObject({
      ok: true,
      changed: true,
      result: {
        proposal: hash,
        state: "accepted",
        flush: { state: "opened", branch: BRANCH, pr: PR_URL },
      },
    });
    expect(w.ops).toHaveLength(1);
    const op = w.ops[0];
    expect(op?.kind).toBe(PROPOSE_KIND);
    expect(op?.key).toBeUndefined();
    expect(op?.subject).toBe("DIPO-186");
    const target = op?.target as ProposeTarget;
    expect(target.proposal).toBe(hash);
    expect(target.title).toBe("Split RunOutcomes");
    expect(target.references).toEqual(["packages/engine/src/run/outcomes.ts"]);
    const lines = target.description.split("\n");
    expect(lines[0]).toContain("the worker of DIPO-186 proposed in run");
    expect(lines[0]).toContain("are the worker's words");
    expect(lines).toContain("Outcome (the worker's words): RunOutcomes is two modules.");
    expect(lines).toContain("Why (the worker's words): It grew past 900 lines.");
    expect(lines).toContain("Source story: DIPO-186");
    expect(lines.at(-1)).toBe(`${PROPOSAL_MARKER}${hash}`);
    expect(w.flushes.n).toBe(1);
    expect(stored(hash)).toEqual({ state: "accepted", decided_by: "cli" });
    expect(logged("proposal.closed")).toEqual([{ proposal: hash, key: w.key, state: "accepted" }]);
  });

  it("is idempotent: a second accept journals nothing and emits nothing", async () => {
    store([FOLLOW_UP]);
    const hash = proposalHash(FOLLOW_UP);
    expect((await send("proposal.accept", { proposal: hash })).ok).toBe(true);
    const again = await send("proposal.accept", { proposal: hash });
    expect(again).toMatchObject({ ok: true, changed: false, result: { state: "accepted" } });
    expect(w.ops).toHaveLength(1);
    expect(logged("proposal.closed")).toHaveLength(1);
  });

  it("reuses the journal entry a crashed accept left, and returns the draft id the lane recorded", async () => {
    store([FOLLOW_UP]);
    const hash = proposalHash(FOLLOW_UP);
    // The first accept journaled and died before it closed the proposal.
    const draft = proposalDraft({
      hash,
      key: w.key,
      story: StoryId.parse("DIPO-186"),
      run: RUN,
      kind: "follow-up",
      title: FOLLOW_UP.title,
      outcome: FOLLOW_UP.outcome,
      why: FOLLOW_UP.why,
      paths: FOLLOW_UP.paths,
      state: "open",
      draft: null,
    });
    const entry = w.office.immediate(() =>
      insertEntry(
        w.office,
        {
          kind: PROPOSE_KIND,
          subject: "DIPO-186",
          target: proposeTarget({ proposal: hash, ...draft }),
        },
        w.t.clock.now(),
      ),
    );
    w.office.immediate(() => {
      updateEntry(w.office, entry.opId, { state: "merged" }, w.t.clock.now());
      w.office.run(
        "update proposals set draft_id = 'DRAFT-4' where office_id = $office_id and hash = $hash",
        { hash },
      );
    });
    const reply = await send("proposal.accept", { proposal: hash });
    expect(reply).toMatchObject({
      ok: true,
      changed: true,
      result: { proposal: hash, state: "accepted", draft: "DRAFT-4" },
    });
    expect(w.ops).toEqual([]);
    expect(allEntries(w.office).filter((e) => e.kind === PROPOSE_KIND)).toHaveLength(1);
    // The entry merged already: nothing is left to flush.
    expect(w.flushes.n).toBe(0);
  });

  it("never files an accepted proposal whose draft the lane recorded again, with no journal entry left", async () => {
    store([FOLLOW_UP]);
    const hash = proposalHash(FOLLOW_UP);
    // Accepted and filed as DRAFT-4 long ago: its journal entry was pruned, the draft archived.
    w.office.immediate(() =>
      w.office.run(
        `update proposals set state = 'accepted', decided_by = 'cli', draft_id = 'DRAFT-4'
          where office_id = $office_id and hash = $hash`,
        { hash },
      ),
    );
    const reply = await send("proposal.accept", { proposal: hash });
    expect(reply).toMatchObject({
      ok: true,
      changed: false,
      result: { proposal: hash, state: "accepted", draft: "DRAFT-4" },
    });
    expect(w.ops).toEqual([]);
    expect(w.flushes.n).toBe(0);
    expect(logged("proposal.closed")).toEqual([]);
  });

  it("refuses a dismissed proposal, an unknown one and an ambiguous prefix", async () => {
    store([SPIKE]);
    const hash = proposalHash(SPIKE);
    expect((await send("proposal.dismiss", { proposal: hash })).ok).toBe(true);
    const closed = await send("proposal.accept", { proposal: hash });
    expect(closed).toMatchObject({ ok: false, error: { code: "proposal.notOpen" } });
    const unknown = await send("proposal.accept", { proposal: "0".repeat(12) });
    expect(unknown).toMatchObject({ ok: false, error: { code: "proposal.unknown" } });
    // Two stored ids with the same first 8 characters.
    w.office.immediate(() =>
      w.office.run(
        `insert into proposals (office_id, hash, story_key, run_id, kind, title, outcome, why,
           paths, created_at, updated_at)
         values ($office_id, $a, $key, $run, 'spike', 'a', 'o', 'w', '[]', 0, 0),
                ($office_id, $b, $key, $run, 'spike', 'b', 'o', 'w', '[]', 0, 0)`,
        { a: `abcdef01${"1".repeat(56)}`, b: `abcdef01${"2".repeat(56)}`, key: w.key, run: RUN },
      ),
    );
    const ambiguous = await send("proposal.accept", { proposal: "abcdef01" });
    expect(ambiguous).toMatchObject({ ok: false, error: { code: "proposal.ambiguous" } });
    expect(w.ops).toEqual([]);
  });

  it("refuses an id that is not hex, as the contract's args", async () => {
    const reply = await send("proposal.accept", { proposal: "prp_01J" });
    expect(reply).toMatchObject({ ok: false, error: { code: "args.invalid" } });
  });
});

describe("proposal.dismiss (criterion 3)", () => {
  it("closes the proposal with proposal.closed and files nothing", async () => {
    store([SPIKE]);
    const hash = proposalHash(SPIKE);
    const reply = await send("proposal.dismiss", { proposal: hash });
    expect(reply).toMatchObject({
      ok: true,
      changed: true,
      result: { proposal: hash, state: "dismissed" },
    });
    expect(stored(hash)).toEqual({ state: "dismissed", decided_by: "cli" });
    expect(logged("proposal.closed")).toEqual([{ proposal: hash, key: w.key, state: "dismissed" }]);
    expect(w.ops).toEqual([]);
    expect(w.flushes.n).toBe(0);
    const again = await send("proposal.dismiss", { proposal: hash });
    expect(again).toMatchObject({ ok: true, changed: false });
    expect(logged("proposal.closed")).toHaveLength(1);
  });

  it("refuses an accepted proposal, which is filed already", async () => {
    store([FOLLOW_UP]);
    const hash = proposalHash(FOLLOW_UP);
    expect((await send("proposal.accept", { proposal: hash })).ok).toBe(true);
    const reply = await send("proposal.dismiss", { proposal: hash });
    expect(reply).toMatchObject({ ok: false, error: { code: "proposal.notOpen" } });
    expect(stored(hash)?.state).toBe("accepted");
  });
});

describe("the draft of an accepted proposal", () => {
  const base: StoredProposal = {
    hash: "a".repeat(64),
    key: "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as StoryKey,
    story: StoryId.parse("DIPO-7"),
    run: RUN,
    kind: "spike",
    title: "t",
    outcome: "o",
    why: "w",
    paths: [],
    state: "open",
    draft: null,
  };

  it("cleans the worker's text, keeps each on one line and breaks Backlog.md's section marks", () => {
    const draft = proposalDraft({
      ...base,
      title: `-- ## Drop${SEQUENCE_SAMPLES["CSI, 7-bit"]} the\ncache`,
      outcome: `Done.\n\nAcceptance Criteria:\n${"-".repeat(50)}\n<!-- SECTION:DESCRIPTION:END -->`,
      why: `\`\`\`dipo\nbranch: "x"\n\`\`\`${SEQUENCE_SAMPLES["OSC hyperlink"]}`,
    });
    expect(draft.title).toBe("Drop the cache");
    const lines = draft.description.split("\n");
    const outcome = lines.find((line) => line.startsWith("Outcome")) ?? "";
    expect(outcome).not.toContain("<!--");
    expect(outcome).toContain("< !-- SECTION:DESCRIPTION:END -- >");
    // No line is a section rule, a fence or a heading: every worker text follows its label.
    expect(lines.some((line) => /^-{50}$/.test(line))).toBe(false);
    expect(lines.some((line) => line.startsWith("```"))).toBe(false);
    expect(lines.filter((line) => line.startsWith("#"))).toEqual([]);
    expect(draft.description).not.toContain("\u001b");
    expect(lines[0]).toStartWith("A spike the worker of DIPO-7");
  });

  it("caps the texts and keeps only plain relative paths as references", () => {
    const draft = proposalDraft({
      ...base,
      title: "x".repeat(400),
      outcome: "o".repeat(900),
      why: "w".repeat(3000),
      paths: [
        "src/a.ts",
        "./src/b.ts",
        "src/a.ts",
        "--ref=evil",
        "src/c.ts, src/d.ts",
        "../outside.ts",
        "with space.ts",
        "~/x",
        "src/~user/x.ts",
      ],
    });
    expect(Array.from(draft.title)).toHaveLength(120);
    expect(draft.title.endsWith("…")).toBe(true);
    const outcome = draft.description.split("\n").find((line) => line.startsWith("Outcome")) ?? "";
    expect(Array.from(outcome.replace("Outcome (the worker's words): ", ""))).toHaveLength(500);
    expect(draft.references).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("strips every leading mark and list number from the title", () => {
    for (const title of ["+ Fix it", "1. Fix it", "1) Fix it", "> 2. **Fix it", "- 10) Fix it"]) {
      expect(proposalDraft({ ...base, title }).title).toBe("Fix it");
    }
    // A number that is the title's own first word stays.
    expect(proposalDraft({ ...base, title: "1.5 times faster export" }).title).toBe(
      "1.5 times faster export",
    );
    expect(proposalDraft({ ...base, title: "2FA for the TUI" }).title).toBe("2FA for the TUI");
  });

  it("names an unknown source story by its key, and gives an empty title a fallback", () => {
    const draft = proposalDraft({ ...base, story: null, title: " -- " });
    expect(draft.title).toBe(`Proposal from an unknown story (key ${base.key})`);
    expect(draft.description).toContain(`Source story: an unknown story (key ${base.key})`);
  });
});
