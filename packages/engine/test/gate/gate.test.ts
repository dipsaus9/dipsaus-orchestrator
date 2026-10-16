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
  description,
  ID,
  input,
  OUTCOME,
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
    expect([...covered].toSorted()).toEqual([...GATE_RULES].toSorted());
  });

  for (const c of CASES) {
    it(`fails only ${c.name}`, () => {
      const result = evaluateGate(c.input, c.mode ?? "ready");
      expect(messages(result)).toEqual([...c.expected]);
      expect(result.passed).toBe(false);
    });
  }

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
