// The Ready gate (DIPO-30; 0012 section 3, R26 from 0014 section 4): one passing story, and per
// rule a fixture that fails only that rule with the exact message.

import { describe, expect, it } from "bun:test";

import {
  evaluateGate,
  gateMessage,
  gateText,
  GATE_RULES,
  type GateInput,
  type GateMode,
  type GateResult,
} from "../../src/gate";
import {
  ACTIVE_TASKS,
  block,
  BRANCH,
  config,
  DEFAULT_CONFIG,
  description,
  ID,
  input,
  OUTCOME,
  PASSING_BLOCK,
  PASSING_STORY,
} from "./fixtures";

const prefix = (rule: string) => `ready ${ID} failed ${rule}: `;
const messages = (result: GateResult) => result.failures.map((failure) => failure.message);

const UNKNOWNS = ["unknowns: []"];
const PLAN = [
  "test_plan:",
  "  entries:",
  '    - kind: "automated"',
  '      check: "the export writes one line per row"',
];
const withBlock = (...lines: string[]) => description(block(...lines));

interface PlanEntry {
  readonly kind: "automated" | "manual";
  readonly check: string;
  readonly expect?: string;
}

/** A description whose field block has the given test plan entries (R29, DIPO-251). */
const withPlan = (...entries: PlanEntry[]) =>
  withBlock(
    `branch: "${BRANCH}"`,
    ...UNKNOWNS,
    "test_plan:",
    "  entries:",
    ...entries.flatMap((entry) => [
      `    - kind: "${entry.kind}"`,
      `      check: ${JSON.stringify(entry.check)}`,
      ...(entry.expect === undefined ? [] : [`      expect: ${JSON.stringify(entry.expect)}`]),
    ]),
  );
const automated = (check: string): PlanEntry => ({ kind: "automated", check });

/** The R29 warning for entry `n` naming `name`; R29 warns and never fails (2026-10-22). */
const uncovered = (n: number, name: string) =>
  `ready ${ID} warning R29: test plan entry #${n} names ${name}, which no Reference covers; add it to the References or drop it from the plan`;
/** The R29 warning for a bare name when the base file list is unknown. */
const unknownBase = (n: number, name: string) =>
  `ready ${ID} warning R29: test plan entry #${n} names ${name}; the base file list is unknown, so only a Reference file of that name covers it; add it to the References or drop it from the plan`;
const warnings = (result: GateResult) => (result.warnings ?? []).map((warning) => warning.message);

/** The R30 reason for the phrase and the part it misses. */
const R30_OLD = "what the old barrier caught and a test for each";
const R30_BYPASS = "the bypass forms to test (wrappers, quoting, indirection, chaining)";
const R30_CLOSED = "a fail-closed test against the real path";
const barrier = (phrase: string, part: string) =>
  `${prefix("R30")}title or outcome names a security barrier ("${phrase}") and no criterion covers ${part}; add a criterion for it`;

interface Case {
  readonly name: string;
  readonly input: GateInput;
  readonly mode?: GateMode;
  readonly expected: readonly string[];
}

const SPIKE_STORY = {
  type: "spike",
  description: withBlock(`branch: "${BRANCH}"`, ...UNKNOWNS),
  acceptanceCriteria: [
    { index: 1, checked: false, text: "docs/decisions/0018-export-format.md records the format" },
  ],
  references: ["docs/decisions/"],
};

const CASES: readonly Case[] = [
  {
    name: "R01a status is not Refined",
    input: input({ status: "Ready" }),
    expected: [`${prefix("R01a")}status is Ready; only Refined stories can be made Ready`],
  },
  {
    name: "R01a story is not an active task",
    input: input({}, { activeTasks: ACTIVE_TASKS.filter((task) => task.id !== ID) }),
    expected: [`${prefix("R01a")}status is Refined; only Refined stories can be made Ready`],
  },
  {
    name: "R01b status is not Ready",
    input: input(),
    mode: "pickup",
    expected: [`${prefix("R01b")}status is Refined; only Ready stories can be picked up`],
  },
  {
    name: "R02 unknown field",
    input: input({ description: withBlock(`branch: "${BRANCH}"`, 'owner: "me"') }),
    expected: [`${prefix("R02")}structured fields are invalid: Unrecognized key: "owner" (line 5)`],
  },
  {
    name: "R03 subtasks",
    input: input({ subtasks: ["DIPO-7.1", "DIPO-7.2"] }),
    expected: [
      `${prefix("R03")}story has subtasks DIPO-7.1, DIPO-7.2; milestones group work, subtasks are not used`,
    ],
  },
  {
    name: "R04 empty title",
    input: input({ title: "   " }),
    expected: [`${prefix("R04")}title is empty or longer than 100 characters`],
  },
  {
    name: "R04 title of 101 characters",
    input: input({ title: "x".repeat(101) }),
    expected: [`${prefix("R04")}title is empty or longer than 100 characters`],
  },
  {
    name: "R05 missing outcome",
    input: input({
      description: `Context only.\n\n${block(`branch: "${BRANCH}"`, ...UNKNOWNS, ...PLAN)}`,
    }),
    expected: [
      `${prefix("R05")}outcome line is missing, duplicated, or shorter than 20 characters`,
    ],
  },
  {
    name: "R05 duplicated outcome",
    input: input({ description: `${OUTCOME}\n${description()}` }),
    expected: [
      `${prefix("R05")}outcome line is missing, duplicated, or shorter than 20 characters`,
    ],
  },
  {
    name: "R05 outcome of 19 characters",
    input: input({ description: description(undefined, `Outcome:  ${"o".repeat(19)}  `) }),
    expected: [
      `${prefix("R05")}outcome line is missing, duplicated, or shorter than 20 characters`,
    ],
  },
  {
    name: "R06 type not configured",
    input: input({ type: "story" }),
    expected: [
      `${prefix("R06")}type is missing or not one of feature, bug, enhancement, task, chore, docs, spike`,
    ],
  },
  {
    name: "R07 milestone does not exist",
    input: input({ milestone: "m-9" }),
    expected: [`${prefix("R07")}milestone is missing or does not exist`],
  },
  {
    name: "R08 no criteria",
    input: input({ acceptanceCriteria: [] }),
    expected: [`${prefix("R08")}no acceptance criteria; add at least one with --ac`],
  },
  {
    name: "R09 checked and short criteria",
    input: input({
      acceptanceCriteria: [
        { index: 1, checked: true, text: "The export writes a header line first" },
        { index: 2, checked: false, text: " 123456789 " },
        { index: 3, checked: false, text: "1234567890" },
      ],
    }),
    expected: [
      `${prefix("R09")}criterion #1 is checked or shorter than 10 characters`,
      `${prefix("R09")}criterion #2 is checked or shorter than 10 characters`,
    ],
  },
  {
    name: "R10 vague phrases",
    input: input({
      acceptanceCriteria: [
        { index: 1, checked: false, text: "The export Works Well, etc." },
        { index: 2, checked: false, text: "The export fetches rows properly" },
      ],
    }),
    expected: [
      `${prefix("R10")}criterion #1 contains vague phrase "works well"`,
      `${prefix("R10")}criterion #1 contains vague phrase "etc"`,
      `${prefix("R10")}criterion #2 contains vague phrase "properly"`,
    ],
  },
  {
    name: "R11 no scope",
    input: input({ references: [] }),
    expected: [`${prefix("R11")}no declared scope; add at least one path with --ref`],
  },
  {
    name: "R13 dependency is not active",
    input: input({ dependencies: ["DIPO-3", "DIPO-4", "DIPO-99"] }),
    expected: [`${prefix("R13")}dependency DIPO-99 is not an active task`],
  },
  {
    name: "R14 cycle",
    input: input(
      {},
      {
        activeTasks: [
          ...ACTIVE_TASKS.filter((task) => task.id !== "DIPO-4"),
          { id: "DIPO-4", dependencies: ["DIPO-5"] },
          { id: "DIPO-5", dependencies: ["DIPO-3", ID] },
        ],
      },
    ),
    expected: [`${prefix("R14")}dependency cycle: DIPO-7 -> DIPO-4 -> DIPO-5 -> DIPO-7`],
  },
  {
    name: "R15 open unknown",
    input: input({
      description: withBlock(
        `branch: "${BRANCH}"`,
        "unknowns:",
        '  - q: "Which delimiter?"',
        '    status: "open"',
        '  - q: "Which encoding?"',
        '    status: "resolved"',
        '    answer: " "',
        '  - q: "Quote every field?"',
        '    status: "resolved"',
        '    answer: "Only when needed."',
        ...PLAN,
      ),
    }),
    expected: [`${prefix("R15")}2 unknowns open or resolved without an answer: Which delimiter?…`],
  },
  {
    name: "R15 unknowns list missing",
    input: input({ description: withBlock(`branch: "${BRANCH}"`, ...PLAN) }),
    expected: [`${prefix("R15")}unknowns list is missing; add unknowns: [] to the field block`],
  },
  {
    name: "R16 no tier",
    input: input({ labels: ["export"] }),
    expected: [`${prefix("R16")}needs exactly one tier from S, M, L, found none`],
  },
  {
    name: "R16 two tiers",
    input: input({ labels: ["tier:S", "tier:M"] }),
    expected: [`${prefix("R16")}needs exactly one tier from S, M, L, found S, M`],
  },
  {
    name: "R16 tier outside the office set",
    input: input({ labels: ["tier:XL"] }),
    expected: [`${prefix("R16")}needs exactly one tier from S, M, L, found XL`],
  },
  {
    name: "R17 role not in the roster",
    input: input({ labels: ["tier:M", "role:designer"] }),
    expected: [`${prefix("R17")}role designer is not in the roster`],
  },
  {
    name: "R18 branch of another id",
    input: input({ description: withBlock('branch: "DIPO-8/export-rows"', ...UNKNOWNS, ...PLAN) }),
    expected: [
      `${prefix("R18")}branch "DIPO-8/export-rows" must be DIPO-7/<slug> with a lowercase hyphenated slug`,
    ],
  },
  {
    name: "R18 branch missing",
    input: input({ description: withBlock(...UNKNOWNS, ...PLAN) }),
    expected: [`${prefix("R18")}branch "" must be DIPO-7/<slug> with a lowercase hyphenated slug`],
  },
  {
    name: "R19 branch used by another task",
    input: input(
      {},
      {
        activeTasks: [...ACTIVE_TASKS, { id: "DIPO-9", dependencies: [], branch: BRANCH }],
      },
    ),
    expected: [`${prefix("R19")}branch "${BRANCH}" is already used by DIPO-9`],
  },
  {
    name: "R20 test plan missing",
    input: input({ description: withBlock(`branch: "${BRANCH}"`, ...UNKNOWNS) }),
    expected: [
      `${prefix("R20")}test plan is missing, empty, or entry 0 is incomplete; add entries or not_applicable with a reason`,
    ],
  },
  {
    name: "R20 incomplete entries",
    input: input({
      description: withBlock(
        `branch: "${BRANCH}"`,
        ...UNKNOWNS,
        "test_plan:",
        "  entries:",
        '    - kind: "automated"',
        '      check: "the export writes one line per row"',
        '    - kind: "manual"',
        '      check: "open the CSV in a spreadsheet"',
        '    - kind: "automated"',
        '      check: "too short"',
      ),
    }),
    expected: [
      `${prefix("R20")}test plan is missing, empty, or entry 2 is incomplete; add entries or not_applicable with a reason`,
      `${prefix("R20")}test plan is missing, empty, or entry 3 is incomplete; add entries or not_applicable with a reason`,
    ],
  },
  {
    name: "R20 not applicable without a reason",
    input: input({
      description: withBlock(
        `branch: "${BRANCH}"`,
        ...UNKNOWNS,
        "test_plan:",
        '  not_applicable: "n/a"',
      ),
    }),
    expected: [
      `${prefix("R20")}test plan is missing, empty, or entry 0 is incomplete; add entries or not_applicable with a reason`,
    ],
  },
  {
    name: "R21 flagged without a manual entry",
    input: input({ labels: ["tier:M", "test-before-merge"] }),
    expected: [`${prefix("R21")}flagged test-before-merge but the test plan has no manual entry`],
  },
  {
    name: "R22 spike without its ADR",
    input: input({
      ...SPIKE_STORY,
      acceptanceCriteria: [{ index: 1, checked: false, text: "The export format is decided" }],
    }),
    expected: [
      `${prefix("R22")}spike must name its ADR (docs/decisions/NNNN-name.md) in a criterion and cover it in scope`,
    ],
  },
  {
    name: "R22 spike scope does not cover its ADR",
    input: input({ ...SPIKE_STORY, references: ["docs/decisions/0019-other.md", "docs/decision"] }),
    expected: [
      `${prefix("R22")}spike must name its ADR (docs/decisions/NNNN-name.md) in a criterion and cover it in scope`,
    ],
  },
  {
    name: "R23 spike with a test plan",
    input: input({
      ...SPIKE_STORY,
      description: withBlock(`branch: "${BRANCH}"`, ...UNKNOWNS, ...PLAN),
    }),
    expected: [
      `${prefix("R23")}spike cannot have a test plan or be flagged test-before-merge; it ships no behavior`,
    ],
  },
  {
    name: "R23 flagged spike",
    input: input({ ...SPIKE_STORY, labels: ["tier:M", "test-before-merge"] }),
    expected: [
      `${prefix("R23")}spike cannot have a test plan or be flagged test-before-merge; it ships no behavior`,
    ],
  },
  {
    name: "R24 non-code role",
    input: input(
      { labels: ["tier:M", "role:designer"] },
      {
        roster: [
          { name: "developer", code: true },
          { name: "designer", code: false },
        ],
      },
    ),
    expected: [`${prefix("R24")}design story scope must be docs/design/DIPO-7/ only`],
  },
  {
    name: "R25 design input without its dependency",
    input: input({ dependencies: ["DIPO-3"] }),
    expected: [`${prefix("R25")}input docs/design/DIPO-4/ needs DIPO-4 as a dependency`],
  },
  {
    name: "R26 contract over the limit",
    input: input({ implementationPlan: "i".repeat(11_774) }),
    expected: [`${prefix("R26")}story contract is 12001 characters; the limit is 12000`],
  },
  {
    name: "R30 security story without the criteria parts",
    input: input({ title: "Replace the deny rule for gh" }),
    expected: [
      barrier("deny rule", R30_OLD),
      barrier("deny rule", R30_BYPASS),
      barrier("deny rule", R30_CLOSED),
    ],
  },
];

describe("evaluateGate", () => {
  it("passes the fixture story in ready mode and its Ready twin in pickup mode", () => {
    expect(evaluateGate(input(), "ready")).toEqual({ mode: "ready", passed: true, failures: [] });
    expect(evaluateGate(input({ status: "Ready" }), "pickup")).toEqual({
      mode: "pickup",
      passed: true,
      failures: [],
    });
  });

  it("passes a spike that names and covers its ADR", () => {
    expect(evaluateGate(input(SPIKE_STORY), "ready").failures).toEqual([]);
    expect(
      evaluateGate(
        input({ ...SPIKE_STORY, references: ["docs/decisions/0018-export-format.md"] }),
        "ready",
      ).failures,
    ).toEqual([]);
  });

  it("covers every rule with a failing fixture", () => {
    const covered = new Set(
      CASES.flatMap((c) => evaluateGate(c.input, c.mode ?? "ready").failures.map((f) => f.rule)),
    );
    covered.add("R12"); // its own table below
    covered.add("R29"); // warns only, never fails: its own block below
    expect([...covered].toSorted()).toEqual([...GATE_RULES].toSorted());
  });

  for (const c of CASES) {
    it(`fails only ${c.name}`, () => {
      const result = evaluateGate(c.input, c.mode ?? "ready");
      expect(messages(result)).toEqual([...c.expected]);
      expect(result.passed).toBe(false);
    });
  }

  it("passes a story labelled dropped whose criterion names the task notes: R27 and R28 are removed (0012)", () => {
    const story = {
      labels: ["tier:M", "dropped", "on-hold"],
      acceptanceCriteria: [
        { index: 1, checked: false, text: "Writes the task notes by the maintainer" },
      ],
    };
    expect(messages(evaluateGate(input(story), "ready"))).toEqual([]);
    expect(messages(evaluateGate(input({ ...story, status: "Ready" }), "pickup"))).toEqual([]);
  });

  it("passes a story contract of exactly prompt.contractMax characters", () => {
    expect(evaluateGate(input({ implementationPlan: "i".repeat(11_773) }), "ready").passed).toBe(
      true,
    );
  });

  it("reports every failure together, in rule order", () => {
    const result = evaluateGate(
      input({
        status: "Done",
        title: "",
        type: "",
        acceptanceCriteria: [{ index: 1, checked: true, text: "Looks good" }],
        references: ["/abs"],
        labels: [],
      }),
      "ready",
    );
    expect(result.passed).toBe(false);
    expect(result.failures.map((failure) => failure.rule)).toEqual([
      "R01a",
      "R04",
      "R06",
      "R09",
      "R10",
      "R12",
      "R16",
    ]);
  });

  it("reports a self dependency as inactive and as a cycle", () => {
    const result = evaluateGate(input({ dependencies: ["DIPO-3", "DIPO-4", ID] }), "ready");
    expect(messages(result)).toEqual([
      `${prefix("R13")}dependency DIPO-7 is not an active task`,
      `${prefix("R14")}dependency cycle: DIPO-7 -> DIPO-7`,
    ]);
  });

  it("ignores a cycle that does not run through the story", () => {
    const result = evaluateGate(
      input(
        {},
        {
          activeTasks: [
            { id: ID, dependencies: [] },
            { id: "DIPO-3", dependencies: ["DIPO-4"] },
            { id: "DIPO-4", dependencies: ["DIPO-3"] },
          ],
        },
      ),
      "ready",
    );
    expect(result.failures).toEqual([]);
  });

  it("takes the story's own dependencies over its active-task entry", () => {
    const result = evaluateGate(
      input(
        { dependencies: ["DIPO-3", "DIPO-4"] },
        {
          activeTasks: [
            { id: ID, dependencies: [] },
            { id: "DIPO-3", dependencies: [ID] },
            { id: "DIPO-4", dependencies: [] },
          ],
        },
      ),
      "ready",
    );
    expect(messages(result)).toEqual([
      `${prefix("R14")}dependency cycle: DIPO-7 -> DIPO-3 -> DIPO-7`,
    ]);
  });
});

describe("open dependencies (DIPO-179)", () => {
  const open = [
    { id: "DIPO-3", status: "Ready" },
    { id: "DIPO-4", status: "Refined" },
  ];

  it("lists the open dependencies of a passing story without changing its verdict", () => {
    const result = evaluateGate(input({ waitingOn: open }), "ready");
    expect(result.passed).toBe(true);
    expect(result.waitingOn).toEqual(open);
  });

  it("lists the open dependencies of a failing story next to its failures", () => {
    const result = evaluateGate(
      input({ milestone: "m-9", waitingOn: [{ id: "DIPO-3" }] }),
      "ready",
    );
    expect(result.passed).toBe(false);
    expect(messages(result)).toEqual([`${prefix("R07")}milestone is missing or does not exist`]);
    expect(result.waitingOn).toEqual([{ id: "DIPO-3" }]);
  });

  it("leaves waitingOn out when no dependency is open", () => {
    expect(evaluateGate(input({ waitingOn: [] }), "ready")).not.toHaveProperty("waitingOn");
    expect(evaluateGate(input(), "ready")).not.toHaveProperty("waitingOn");
  });
});

describe("R12 scope paths", () => {
  const bad = [
    "/etc/passwd",
    "src/../secrets",
    "..",
    "https://example.com/x",
    "src/my file.ts",
    "src/\tfile.ts",
    "src/*.ts",
    "src/?.ts",
    "src/[ab].ts",
    "src/a]",
    ".",
    "",
    "backlog",
    "backlog/tasks/dipo-1.md",
  ];
  for (const path of bad) {
    it(`rejects ${JSON.stringify(path)}`, () => {
      const result = evaluateGate(input({ references: ["packages/export/", path] }), "ready");
      expect(messages(result)).toEqual([
        `${prefix("R12")}scope path "${path}" is not a valid repo-relative path`,
      ]);
    });
  }

  it("accepts repo-relative paths, dotted names and a backlog-like prefix", () => {
    const result = evaluateGate(
      input({
        references: [
          "src/",
          "./src/a.ts",
          "src/..hidden",
          ".github/workflows/ci.yml",
          "backlogs/x",
        ],
      }),
      "ready",
    );
    expect(result.failures).toEqual([]);
  });
});

const criterion = (text: string) =>
  input({ acceptanceCriteria: [{ index: 1, checked: false, text }] });

const hits = (text: string) =>
  evaluateGate(criterion(text), "ready")
    .failures.filter((failure) => failure.rule === "R10")
    .map((failure) => failure.message.slice(failure.message.indexOf('"')));

describe("R10 word matches", () => {
  it("never matches inside a longer word", () => {
    expect(hits("The worker fetches every row")).toEqual([]);
    expect(hits("Rows are improperly quoted no more")).toEqual([]);
    expect(hits("Writes the etc2 directory listing")).toEqual([]);
    expect(hits("Writes the éetc directory listing")).toEqual([]);
    expect(hits("Writes the etcé directory listing")).toEqual([]);
  });

  it("matches at text edges, next to punctuation and in any case", () => {
    expect(hits("etc. are written to the file")).toEqual(['"etc"']);
    expect(hits("Writes header, rows, ETC")).toEqual(['"etc"']);
    expect(hits("Writes (etc) after the rows")).toEqual(['"etc"']);
    expect(hits("Writes_etc_ after the rows")).toEqual(['"etc"']);
    expect(hits("The export WORKS WELL today")).toEqual(['"works well"']);
  });

  it("ignores a phrase inside a path token (DIPO-170)", () => {
    expect(hits("Writes the file /etc/zprofile")).toEqual([]);
    expect(hits("Writes the file at /etc/zprofile, then the rows")).toEqual([]);
    expect(hits("Writes the file at etc/zprofile")).toEqual(['"etc"']);
  });

  it("ignores a phrase inside a run that looks like a path (DIPO-218)", () => {
    expect(hits("Writes /etc/zprofile,")).toEqual([]);
    expect(hits("Writes ~/etc/x")).toEqual([]);
    expect(hits("Writes ./etc/x")).toEqual([]);
    expect(hits("Writes ../etc/x")).toEqual([]);
    expect(hits("Writes packages/etc/")).toEqual([]);
    expect(hits("Writes src/etc.ts")).toEqual([]);
    expect(hits("Writes (src/etc.ts)")).toEqual([]);
  });

  it("matches a phrase inside a slash run that is prose (DIPO-218)", () => {
    expect(hits("Writes etc/zprofile")).toEqual(['"etc"']);
    expect(hits("Writes TBD/later etc")).toEqual(['"etc"']);
    expect(hits("Writes and/or,etc")).toEqual(['"etc"']);
  });

  it("ignores a phrase inside a code span (DIPO-170)", () => {
    expect(hits("Writes the file at `/etc/zprofile`")).toEqual([]);
    expect(hits("Writes `etc` and `works well` as named")).toEqual([]);
  });

  it("still matches a phrase next to a path but outside it (DIPO-170)", () => {
    expect(hits("Writes /etc/zprofile, etc after the rows")).toEqual(['"etc"']);
    expect(hits("Writes `/etc/zprofile` and etc after the rows")).toEqual(['"etc"']);
    expect(hits("Writes /etc/zprofile and the rows properly")).toEqual(['"properly"']);
  });

  it("matches a phrase after an unclosed backtick (DIPO-170)", () => {
    expect(hits("Writes `etc after the rows")).toEqual(['"etc"']);
    expect(hits("Writes `/etc/zprofile after the rows etc")).toEqual(['"etc"']);
  });

  it("masks code spans and path tokens in the original text (DIPO-170)", () => {
    // A masked span does not join the words around it into a phrase.
    expect(hits("The export works`x`well today")).toEqual([]);
    // A code span ends a run, so etc is its own run and is matched (DIPO-221).
    expect(hits("Writes etc`a/b` to the rows")).toEqual(['"etc"']);
  });

  it("matches a banned phrase glued to a code span that holds a path (DIPO-221)", () => {
    expect(hits("Writes etc`a/b.ts` to the rows")).toEqual(['"etc"']);
    expect(hits("Writes `a/b.ts`etc to the rows")).toEqual(['"etc"']);
    expect(hits("Writes `a/b.ts` to the rows")).toEqual([]);
    expect(hits("Writes src/etc.ts")).toEqual([]);
  });

  it("keeps the DIPO-170 results for an unclosed backtick and a code span between words (DIPO-221)", () => {
    expect(hits("Writes `etc after the rows")).toEqual(['"etc"']);
    expect(hits("The export works`x`well today")).toEqual([]);
  });
});

describe("characters", () => {
  it("counts NFC code points after trimming", () => {
    const decomposed = "é".repeat(100);
    expect(evaluateGate(input({ title: `  ${decomposed}  ` }), "ready").failures).toEqual([]);
    expect(evaluateGate(input({ title: "😀".repeat(100) }), "ready").failures).toEqual([]);
    expect(messages(evaluateGate(input({ title: "😀".repeat(101) }), "ready"))).toEqual([
      `${prefix("R04")}title is empty or longer than 100 characters`,
    ]);
  });
});

describe("office configuration", () => {
  it("takes thresholds, sets and banned phrases from a non-default configuration", () => {
    const result = evaluateGate(
      input(
        {},
        {
          config: config(
            {
              types: ["bug"],
              tiers: ["S"],
              bannedPhrases: ["header line"],
              titleMax: 10,
              outcomeMin: 80,
              criterionMin: 35,
              slugMax: 10,
            },
            100,
          ),
        },
      ),
      "ready",
    );
    expect(messages(result)).toEqual([
      `${prefix("R04")}title is empty or longer than 10 characters`,
      `${prefix("R05")}outcome line is missing, duplicated, or shorter than 80 characters`,
      `${prefix("R06")}type is missing or not one of bug`,
      `${prefix("R09")}criterion #2 is checked or shorter than 35 characters`,
      `${prefix("R10")}criterion #1 contains vague phrase "header line"`,
      `${prefix("R16")}needs exactly one tier from S, found M`,
      `${prefix("R18")}branch "${BRANCH}" must be DIPO-7/<slug> with a lowercase hyphenated slug`,
      `${prefix("R26")}story contract is 259 characters; the limit is 100`,
    ]);
  });

  it("passes a story the defaults reject once the configuration allows it", () => {
    const story = {
      acceptanceCriteria: [{ index: 1, checked: false, text: "Rows are written properly" }],
    };
    expect(evaluateGate(input(story), "ready").passed).toBe(false);
    expect(
      evaluateGate(input(story, { config: config({ bannedPhrases: [] }) }), "ready").passed,
    ).toBe(true);
  });
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

describe("purity", () => {
  const ALLOWED_IMPORTS = [
    /^\.\/[a-z]+$/,
    /^\.\.\/backlog\/fields\/(block|labels)$/,
    /^\.\.\/backlog\/plain$/,
    /^\.\.\/config\/schema$/,
    /^@dipsaus-orchestrator\/contract$/,
  ];

  it("imports nothing that reaches files, processes, clocks, databases or models", async () => {
    const dir = new URL("../../src/gate/", import.meta.url).pathname;
    const files = [...new Bun.Glob("*.ts").scanSync(dir)].toSorted();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await Bun.file(`${dir}${file}`).text();
      const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1] ?? "");
      for (const path of imports) {
        expect({ file, path, allowed: ALLOWED_IMPORTS.some((re) => re.test(path)) }).toEqual({
          file,
          path,
          allowed: true,
        });
      }
      expect(source).not.toMatch(/\b(Bun|process|Date|performance|fetch)\s*[.(]/);
    }
  });

  it("gives the same result for the same input and never changes it", () => {
    const frozen = deepFreeze(
      structuredClone(input({ title: "", references: ["/x"], status: "Done" })),
    );
    const first = evaluateGate(frozen, "ready");
    const second = evaluateGate(frozen, "ready");
    expect(second).toEqual(first);
    expect(first.failures.length).toBeGreaterThan(0);
    expect(PASSING_STORY.status).toBe("Refined");
  });
});

describe("gateText (DIPO-97)", () => {
  it("gives back the message a gate line was built from, for any story id", () => {
    const line = gateMessage("DRAFT-3", "R15", "2 unknowns open: a: b");
    expect(gateText("R15", line)).toBe("2 unknowns open: a: b");
    expect(gateText("R01a", gateMessage(ID, "R01a", "status is Done"))).toBe("status is Done");
  });

  it("returns a line of another shape or another rule as is", () => {
    const line = gateMessage(ID, "R15", "x");
    expect(gateText("R07", line)).toBe(line);
    expect(gateText("R15", "TASK-1 cannot start: too large")).toBe(
      "TASK-1 cannot start: too large",
    );
  });
});

// R29 (DIPO-251): every path and bare test file name of an automated test plan entry is covered by
// a Reference. Three M1 runs on 2026-10-20 had plans their References could not deliver. R29 only
// warns (maintainer decision of 2026-10-22): References are a forecast (0021 section 13).
const r29 = (story: Partial<Parameters<typeof input>[0]>, baseFiles?: readonly string[]) =>
  warnings(evaluateGate(input(story, baseFiles === undefined ? {} : { baseFiles }), "ready"));

describe("R29 test plan files inside the References", () => {
  const DAEMON_TEST = "packages/daemon/test/unit/x.test.ts";
  const daemonPlan = withPlan(automated(`(unit) ${DAEMON_TEST}: the poll runs once`));

  it("warns about an uncovered path, naming the entry and the path, and not under a directory Reference", () => {
    expect(r29({ description: daemonPlan })).toEqual([uncovered(1, DAEMON_TEST)]);
    expect(
      r29({ description: daemonPlan, references: ["packages/export/", "packages/daemon/test/"] }),
    ).toEqual([]);
    // The prefix rule works on segment boundaries, with or without the trailing slash.
    expect(r29({ description: daemonPlan, references: ["packages/daemon/test"] })).toEqual([]);
    expect(r29({ description: daemonPlan, references: [DAEMON_TEST] })).toEqual([]);
    expect(r29({ description: daemonPlan, references: ["packages/daemon/te"] })).toEqual([
      uncovered(1, DAEMON_TEST),
    ]);
  });

  it("covers a directory token by a Reference inside it, as two colliding scope paths", () => {
    const plan = withPlan(automated("(unit) every test under packages/export/ passes"));
    expect(r29({ description: plan, references: ["packages/export/rows.ts"] })).toEqual([]);
    expect(r29({ description: plan, references: ["docs/export.md"] })).toEqual([
      uncovered(1, "packages/export/"),
    ]);
  });

  it("covers a bare test file name by a file Reference of that name", () => {
    const plan = withPlan(automated("(unit) plan.test.ts: the plan keeps its order"));
    expect(
      r29({ description: plan, references: ["packages/engine/test/workers/plan.test.ts"] }),
    ).toEqual([]);
  });

  it("covers a bare test file name by a Reference directory that holds a file of that name", () => {
    const plan = withPlan(automated("(unit) plan.test.ts: the plan keeps its order"));
    const references = ["packages/engine/test/workers/"];
    const files = [
      "packages/engine/src/workers/plan.ts",
      "packages/engine/test/workers/plan.test.ts",
    ];
    expect(r29({ description: plan, references }, files)).toEqual([]);
    // A file of that name outside every Reference directory does not cover it.
    expect(r29({ description: plan, references: ["packages/engine/test/run/"] }, files)).toEqual([
      uncovered(1, "plan.test.ts"),
    ]);
  });

  it("warns about an uncovered bare test file name, and says so when the base file list is unknown", () => {
    const plan = withPlan(automated("(unit) plan.test.ts: the plan keeps its order"));
    expect(r29({ description: plan }, ["packages/export/plan.ts"])).toEqual([
      uncovered(1, "plan.test.ts"),
    ]);
    expect(r29({ description: plan, references: ["packages/engine/test/workers/"] })).toEqual([
      unknownBase(1, "plan.test.ts"),
    ]);
    // A known but empty list is not unknown.
    expect(r29({ description: plan }, [])).toEqual([uncovered(1, "plan.test.ts")]);
    // A file Reference of that name covers it without the list.
    expect(r29({ description: plan, references: ["packages/engine/test/plan.test.ts"] })).toEqual(
      [],
    );
  });

  it("exempts a manual entry, a check without a path or test file name, and a spike with no test plan", () => {
    const manual: PlanEntry = {
      kind: "manual",
      check: `Run the daemon and open ${DAEMON_TEST}`,
      expect: "the poll runs once",
    };
    expect(r29({ description: withPlan(manual) })).toEqual([]);
    expect(
      r29({ description: withPlan(automated("the export writes one line per row, and/or more")) }),
    ).toEqual([]);
    expect(evaluateGate(input(SPIKE_STORY), "ready").failures).toEqual([]);
  });

  it("reads paths inside code spans and brackets, once per entry, and numbers entries as the plan does", () => {
    const plan = withPlan(
      automated("the export writes one line per row"),
      automated(
        `(unit) \`${DAEMON_TEST}\` and (${DAEMON_TEST}), then tools/recordings/scenarios.ts.`,
      ),
    );
    expect(r29({ description: plan })).toEqual([
      uncovered(2, DAEMON_TEST),
      uncovered(2, "tools/recordings/scenarios.ts"),
    ]);
  });

  it("checks a ./ path as repo-relative, and leaves absolute, home, URL, glob, parent and backlog paths alone", () => {
    const plan = withPlan(
      automated(
        "./packages/daemon/x.ts, /etc/zprofile, ~/.bun/x.ts, https://example.com/a.html, packages/*/x.ts, ../other/x.ts and backlog/tasks/x.md",
      ),
    );
    expect(r29({ description: plan })).toEqual([uncovered(1, "./packages/daemon/x.ts")]);
    expect(r29({ description: plan, references: ["packages/daemon/"] })).toEqual([]);
  });

  it("reports nothing when the field block fails R02, and warns in both modes without failing", () => {
    // An unknown field fails R02, so the plan below it is not read.
    const invalid = withBlock(
      `branch: "${BRANCH}"`,
      'owner: "me"',
      "test_plan:",
      "  entries:",
      '    - kind: "automated"',
      `      check: "${DAEMON_TEST}"`,
    );
    const invalidResult = evaluateGate(input({ description: invalid }), "ready");
    expect(invalidResult.failures.map((failure) => failure.rule)).toEqual(["R02"]);
    expect(invalidResult).not.toHaveProperty("warnings");

    // An uncovered path passes the gate in both modes, with the warning beside the verdict.
    expect(evaluateGate(input({ description: daemonPlan }), "ready")).toEqual({
      mode: "ready",
      passed: true,
      failures: [],
      warnings: [{ rule: "R29", message: uncovered(1, DAEMON_TEST) }],
    });
    const ready = input({ status: "Ready", description: daemonPlan });
    expect(evaluateGate(ready, "pickup")).toEqual({
      mode: "pickup",
      passed: true,
      failures: [],
      warnings: [{ rule: "R29", message: uncovered(1, DAEMON_TEST) }],
    });

    // A failing story keeps its failures; the warning never adds one.
    const story = input({ labels: ["tier:S", "tier:M"], description: daemonPlan });
    const result = evaluateGate(story, "ready");
    expect(messages(result)).toEqual([
      `${prefix("R16")}needs exactly one tier from S, M, L, found S, M`,
    ]);
    expect(warnings(result)).toEqual([uncovered(1, DAEMON_TEST)]);
    expect(gateText("R29", uncovered(1, DAEMON_TEST))).toBe(
      `test plan entry #1 names ${DAEMON_TEST}, which no Reference covers; add it to the References or drop it from the plan`,
    );
  });
});

// R30 (DIPO-251, from DIPO-260): a story that adds or replaces a guard, a deny rule, a sandbox
// setting or a permission check names what the old barrier caught, the bypass forms and a
// fail-closed test against the real path. DIPO-195 dropped a deny rule whose replacement missed
// wrappers and quoting the old rule had caught.
const OLD_CRITERION = "A test for each command the old rule caught still refuses it";
const BYPASS_CRITERION =
  "Tests cover the bypass forms: timeout and stdbuf wrappers, quoting and chaining";
const CLOSED_CRITERION = "A fail-closed test runs the check against the real path, not a fake";
const securityStory = (...texts: string[]) =>
  input({
    title: "Replace the gh deny rule with a code check",
    acceptanceCriteria: texts.map((text, i) => ({ index: i + 1, checked: false, text })),
  });
const r30 = (story: GateInput, mode: GateMode = "ready") =>
  messages(evaluateGate(story, mode)).filter((message) => message.includes(" failed R30: "));

describe("R30 security-sensitive stories", () => {
  it("passes a story whose criteria cover all three parts", () => {
    expect(
      evaluateGate(securityStory(OLD_CRITERION, BYPASS_CRITERION, CLOSED_CRITERION), "ready")
        .failures,
    ).toEqual([]);
  });

  it("fails once for each missing part, in part order", () => {
    expect(r30(securityStory(BYPASS_CRITERION, CLOSED_CRITERION))).toEqual([
      barrier("deny rule", R30_OLD),
    ]);
    expect(r30(securityStory(OLD_CRITERION, CLOSED_CRITERION))).toEqual([
      barrier("deny rule", R30_BYPASS),
    ]);
    expect(r30(securityStory(OLD_CRITERION, BYPASS_CRITERION))).toEqual([
      barrier("deny rule", R30_CLOSED),
    ]);
    expect(r30(securityStory("The check is written in TypeScript"))).toEqual([
      barrier("deny rule", R30_OLD),
      barrier("deny rule", R30_BYPASS),
      barrier("deny rule", R30_CLOSED),
    ]);
  });

  it("applies to a phrase in the Outcome and names the first listed phrase that matches", () => {
    const story = input({
      description: description(
        PASSING_BLOCK,
        "Outcome: the worker's permission check moves behind a new guard in the hook.",
      ),
    });
    expect(r30(story)).toEqual([
      barrier("guard", R30_OLD),
      barrier("guard", R30_BYPASS),
      barrier("guard", R30_CLOSED),
    ]);
  });

  it("does not apply to a story that names no security phrase, or names one only in a criterion or a word", () => {
    expect(r30(input())).toEqual([]);
    expect(
      r30(
        input({
          title: "Export rows to CSV",
          acceptanceCriteria: [{ index: 1, checked: false, text: "The guard keeps rows" }],
        }),
      ),
    ).toEqual([]);
    expect(r30(input({ title: "Export the guardrails report" }))).toEqual([]);
  });

  it("applies to the plural forms of the default phrases", () => {
    const plurals: readonly (readonly [string, string])[] = [
      ["Drop the gh deny rules", "deny rules"],
      ["Add guards to the hook", "guards"],
      ["Change the sandbox settings of the box", "sandbox settings"],
      ["Move the permission checks into code", "permission checks"],
    ];
    for (const [title, phrase] of plurals) {
      expect(r30(input({ title }))).toEqual([
        barrier(phrase, R30_OLD),
        barrier(phrase, R30_BYPASS),
        barrier(phrase, R30_CLOSED),
      ]);
    }
  });

  it("exempts a spike, which ships no barrier", () => {
    expect(r30(input({ ...SPIKE_STORY, title: "Decide the sandbox setting for the box" }))).toEqual(
      [],
    );
  });

  it("runs in both modes, a hard rule beside the R29 warning", () => {
    const story = input({
      title: "Replace the gh deny rule with a code check",
      description: withPlan(automated("(unit) packages/daemon/x.test.ts: the hook refuses gh")),
      acceptanceCriteria: [
        { index: 1, checked: false, text: OLD_CRITERION },
        { index: 2, checked: false, text: BYPASS_CRITERION },
      ],
    });
    const result = evaluateGate(story, "ready");
    expect(result.passed).toBe(false);
    expect(messages(result)).toEqual([barrier("deny rule", R30_CLOSED)]);
    expect(warnings(result)).toEqual([uncovered(1, "packages/daemon/x.test.ts")]);
    expect(r30({ ...story, story: { ...story.story, status: "Ready" } }, "pickup")).toEqual([
      barrier("deny rule", R30_CLOSED),
    ]);
  });

  it("reads both phrase lists from the office configuration", () => {
    const story = securityStory(OLD_CRITERION, BYPASS_CRITERION, CLOSED_CRITERION);
    expect(r30({ ...story, config: config({ securityPhrases: [] }) })).toEqual([]);
    expect(
      r30({
        ...story,
        config: config({
          securityCriteriaPhrases: {
            ...DEFAULT_CONFIG.story.securityCriteriaPhrases,
            failClosed: ["against production"],
          },
        }),
      }),
    ).toEqual([barrier("deny rule", R30_CLOSED)]);
    expect(
      r30({
        ...input({ title: "Add a firewall rule" }),
        config: config({ securityPhrases: ["firewall rule"] }),
      }),
    ).toEqual([
      barrier("firewall rule", R30_OLD),
      barrier("firewall rule", R30_BYPASS),
      barrier("firewall rule", R30_CLOSED),
    ]);
  });
});
