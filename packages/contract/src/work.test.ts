import { describe, expect, it } from "bun:test";

import {
  contractCommands,
  contractReads,
  DaemonState,
  FieldBlock,
  GateKind,
  GateView,
  Health,
  KNOWN_HEALTH,
  KNOWN_PARK_REASONS,
  KNOWN_PHASES,
  KNOWN_SIGNALS,
  KNOWN_SKIP_REASONS,
  KNOWN_TIERS,
  Lifecycle,
  LIFECYCLES,
  officeCommands,
  OfficeSummary,
  officeReads,
  ParkReason,
  Phase,
  QueueColumn,
  QuestionView,
  Signal,
  SkipReason,
  StoryView,
  TestView,
  Tier,
  Usage,
  UsageTotals,
  WorkRef,
  WorkView,
} from "./index";
import {
  gateView,
  invalidFieldBlocks,
  officeSummary,
  parkedStoryView,
  questionView,
  refinedStoryView,
  storyView,
  testView,
  usage,
  validFieldBlock,
  waitingStoryView,
  workRef,
  workView,
} from "./fixtures";

describe("closed enums", () => {
  it("Lifecycle has the exact states of 0005 and 0012", () => {
    expect([...LIFECYCLES]).toEqual([
      "Draft",
      "Refined",
      "Ready",
      "In Progress",
      "In Review",
      "Done",
      "Parked",
      "Removed",
    ]);
    expect(Lifecycle.options).toEqual([...LIFECYCLES]);
  });

  it("an unknown lifecycle fails", () => {
    expect(Lifecycle.safeParse("Waiting").success).toBe(false);
    expect(Lifecycle.safeParse("in progress").success).toBe(false);
  });

  it("DaemonState has the exact states of 0006 and an unknown one fails", () => {
    expect(DaemonState.options).toEqual(["starting", "recovering", "running", "draining", "safe"]);
    expect(DaemonState.safeParse("sleeping").success).toBe(false);
  });
});

describe("open enums", () => {
  const cases = [
    { name: "Tier", schema: Tier, known: KNOWN_TIERS, size: 3 },
    { name: "ParkReason", schema: ParkReason, known: KNOWN_PARK_REASONS, size: 11 },
    { name: "SkipReason", schema: SkipReason, known: KNOWN_SKIP_REASONS, size: 7 },
    { name: "Phase", schema: Phase, known: KNOWN_PHASES, size: 6 },
    { name: "Signal", schema: Signal, known: KNOWN_SIGNALS, size: 7 },
    { name: "Health", schema: Health, known: KNOWN_HEALTH, size: 8 },
  ];

  for (const { name, schema, known, size } of cases) {
    it(`${name} exports ${size} known values, accepts them and any other string`, () => {
      expect(known.length as number).toBe(size);
      for (const value of known) expect(schema.parse(value)).toBe(value);
      expect(schema.parse("added-in-a-later-minor")).toBe("added-in-a-later-minor");
      expect(schema.safeParse(5).success).toBe(false);
    });
  }

  it("names the eleven park reasons of 0001, 0005 and 0008", () => {
    expect(([...KNOWN_PARK_REASONS] as string[]).toSorted()).toEqual(
      [
        "ambiguous-spec",
        "verify-failing",
        "conflict",
        "scope-violation",
        "review-blocked",
        "budget-exceeded",
        "on-hold",
        "stopped",
        "interrupted",
        "needs-permission",
        "worker-failed",
      ].toSorted(),
    );
  });

  it("names the phases and health states of 0009", () => {
    expect([...KNOWN_PHASES]).toEqual(["setup", "build", "verify", "review", "test", "merge"]);
    expect([...KNOWN_HEALTH]).toEqual([
      "lost",
      "asking",
      "limited",
      "paused",
      "looping",
      "stuck",
      "quiet",
      "busy",
    ]);
  });

  it("queue columns and gate kinds are open too", () => {
    expect(QueueColumn.parse("triage")).toBe("triage");
    expect(GateKind.parse("design")).toBe("design");
  });
});

describe("views", () => {
  const cases = [
    { name: "WorkRef", schema: WorkRef, value: workRef },
    { name: "StoryView running", schema: StoryView, value: storyView },
    { name: "StoryView parked", schema: StoryView, value: parkedStoryView },
    { name: "StoryView waiting", schema: StoryView, value: waitingStoryView },
    { name: "StoryView refined", schema: StoryView, value: refinedStoryView },
    { name: "WorkView", schema: WorkView, value: workView },
    { name: "GateView", schema: GateView, value: gateView },
    { name: "QuestionView", schema: QuestionView, value: questionView },
    { name: "TestView", schema: TestView, value: testView },
    { name: "Usage", schema: Usage, value: usage },
  ];

  for (const { name, schema, value } of cases) {
    it(`${name} fixture parses`, () => {
      expect(schema.parse(value)).toEqual(value as never);
    });
  }

  it("parses an unknown health, park reason, tier and phase in views", () => {
    expect(WorkView.safeParse({ ...workView, health: "dozing", phase: "design" }).success).toBe(
      true,
    );
    expect(
      StoryView.safeParse({
        ...parkedStoryView,
        tier: "XL",
        parked: { ...parkedStoryView.parked, reason: "waiting-on-vendor" },
      }).success,
    ).toBe(true);
  });

  it("fails a view with an unknown lifecycle", () => {
    expect(StoryView.safeParse({ ...storyView, lifecycle: "Waiting" }).success).toBe(false);
  });

  it("splits cache tokens into creation and reads", () => {
    expect(Object.keys(UsageTotals.shape)).toEqual(
      expect.arrayContaining(["cacheCreateTokens", "cacheReadTokens"]),
    );
    expect(Object.keys(UsageTotals.shape)).not.toContain("cacheTokens");
  });

  it("counts the budget in tokens only", () => {
    const dollars = { ...usage, budget: { ...usage.budget, unit: "usd" } };
    expect(Usage.safeParse(dollars).success).toBe(false);
    const { budgetShare: _share, ...withoutShare } = usage;
    expect(Usage.safeParse(withoutShare).success).toBe(false);
  });

  it("keeps a permission question apart from a question", () => {
    expect(QuestionView.safeParse({ ...questionView, kind: "question" }).success).toBe(true);
    expect(QuestionView.safeParse({ ...questionView, kind: "poll" }).success).toBe(false);
  });

  it("OfficeSummary takes day usage and evidence", () => {
    const summary = {
      ...officeSummary,
      dayUsage: {
        tokens: 1_200_000,
        limit: 4_000_000,
        share: 0.3,
        alert: false,
        estimatedCost: 3.1,
      },
      evidence: { dayUsage: "claimed" },
    };
    expect(OfficeSummary.parse(summary)).toEqual(summary as never);
  });
});

describe("office commands and reads", () => {
  const provisional = [
    "work.steer",
    "work.pause",
    "work.resume",
    "work.reassign",
    "work.discard",
    "story.hold",
    "story.drop",
    "gate.approve",
    "gate.reject",
    "test.start",
    "test.record",
    "office.usage",
    "office.digest",
  ];

  it("defines every command and read of this story", () => {
    expect(officeCommands.map((d): string => d.name).toSorted()).toEqual(
      [
        "work.run",
        "work.answer",
        "work.steer",
        "work.pause",
        "work.resume",
        "work.reassign",
        "work.stop",
        "work.discard",
        "story.hold",
        "story.drop",
        "gate.approve",
        "gate.reject",
        "test.start",
        "test.record",
      ].toSorted(),
    );
    expect(officeReads.map((d): string => d.name).toSorted()).toEqual(
      [
        "office.snapshot",
        "story.detail",
        "work.outputRange",
        "office.usage",
        "office.digest",
      ].toSorted(),
    );
    const names = [...contractCommands, ...contractReads].map((d) => d.name);
    for (const definition of [...officeCommands, ...officeReads]) {
      expect(names).toContain(definition.name);
    }
  });

  for (const definition of [...officeCommands, ...officeReads]) {
    if (provisional.includes(definition.name)) {
      it(`${definition.name} is provisional with no since`, () => {
        expect(definition.provisional).toBe(true);
        expect(definition.since).toBeUndefined();
      });
    } else {
      it(`${definition.name} ships with since 1.0`, () => {
        expect(definition.since).toBe(0);
        expect(definition.provisional).toBeUndefined();
      });
    }
  }

  it("marks office commands as office-level", () => {
    for (const definition of officeCommands) expect(definition.level).toBe("office");
  });

  it("marks only work.discard irreversible among the office commands", () => {
    expect(officeCommands.filter((d) => d.irreversible).map((d) => d.name)).toEqual([
      "work.discard",
    ]);
  });

  it("test.record needs a note on fail", () => {
    const record = officeCommands.find((d) => d.name === "test.record");
    expect(
      record?.args.safeParse({ test: "tst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D", result: "fail" }).success,
    ).toBe(false);
    expect(
      record?.args.safeParse({ test: "tst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D", result: "pass" }).success,
    ).toBe(true);
  });

  it("work.run reports an unknown skip reason without failing", () => {
    const run = officeCommands.find((d) => d.name === "work.run");
    const result = {
      started: [],
      skipped: [{ story: "DIPO-31", key: workRef.key, reason: "quota" }],
    };
    expect(run?.result.safeParse(result).success).toBe(true);
  });
});

describe("field block", () => {
  it("parses a valid block", () => {
    expect(FieldBlock.parse(validFieldBlock)).toEqual(validFieldBlock as never);
  });

  it("parses an empty block and not_applicable alone", () => {
    expect(FieldBlock.safeParse({}).success).toBe(true);
    expect(FieldBlock.safeParse({ test_plan: { not_applicable: "Docs only." } }).success).toBe(
      true,
    );
  });

  it("accepts an unknown park reason", () => {
    const block = { park: { ...validFieldBlock.park, reason: "waiting-on-vendor" } };
    expect(FieldBlock.safeParse(block).success).toBe(true);
  });

  for (const [name, block] of Object.entries(invalidFieldBlocks)) {
    it(`fails "${name}"`, () => {
      expect(FieldBlock.safeParse(block).success).toBe(false);
    });
  }

  it("asks to quote a non-string text value", () => {
    const result = FieldBlock.safeParse(invalidFieldBlocks["answer: 5173"]);
    const messages = result.error?.issues.map((issue) => issue.message) ?? [];
    expect(messages.some((message) => message.includes("quote this value"))).toBe(true);
  });
});
