import { describe, expect, it } from "bun:test";

import {
  AgentId,
  ClientFrame,
  contractCommands,
  contractEvents,
  contractReads,
  Cursor,
  DatabaseUnavailableDetails,
  engineError,
  GateId,
  GENERIC_ERROR_CODES,
  isRetryableErrorCode,
  OFFICE_ERROR_CODES,
  OfficeId,
  packageName,
  QuestionId,
  RequestId,
  RETRYABLE_ERROR_CODES,
  RoleId,
  RunId,
  ServerFrame,
  SOFTWARE_ERROR_CODES,
  StoryId,
  StoryKey,
  TestId,
} from "./index";
import {
  clientFrameFixtures,
  commandFixtures,
  eventFixtures,
  ids,
  malformedClientFrames,
  malformedServerFrames,
  readFixtures,
  serverFrameFixtures,
} from "../test/fixtures";

describe("contract", () => {
  it("names its package", () => {
    expect(packageName).toBe("@dipsaus-orchestrator/contract");
  });
});

describe("ids", () => {
  const cases = [
    {
      name: "OfficeId",
      schema: OfficeId,
      good: [ids.office],
      bad: [ids.run, "off_123", `off_${"8".repeat(26)}`],
    },
    {
      name: "StoryId",
      schema: StoryId,
      good: ["DIPO-2", "DRAFT-3", "DIPO-2.1", "task-7"],
      bad: ["DIPO", "2", "DIPO-x", ""],
    },
    { name: "StoryKey", schema: StoryKey, good: [ids.storyKey], bad: [ids.office, "sto_"] },
    { name: "RunId", schema: RunId, good: [ids.run], bad: [ids.agent] },
    { name: "AgentId", schema: AgentId, good: [ids.agent], bad: [ids.run] },
    {
      name: "RoleId",
      schema: RoleId,
      good: ["developer", "code-reviewer"],
      bad: ["Developer", "", "1dev"],
    },
    { name: "GateId", schema: GateId, good: [ids.gate], bad: [ids.question] },
    { name: "QuestionId", schema: QuestionId, good: [ids.question], bad: [ids.gate] },
    { name: "TestId", schema: TestId, good: [ids.test], bad: [ids.gate] },
    // Bare ULID; I, L, O and U are not Crockford base32.
    {
      name: "RequestId",
      schema: RequestId,
      good: [ids.request],
      bad: [ids.office, "01J9ZK5Q8W3V4X6Y7Z8A9B0C1I", "01J9ZK5Q8W"],
    },
  ];

  for (const { name, schema, good, bad } of cases) {
    it(`${name} accepts its format and rejects others`, () => {
      for (const value of good) expect(schema.safeParse(value).success).toBe(true);
      for (const value of bad) expect(schema.safeParse(value).success).toBe(false);
    });
  }

  it("Cursor names the software stream or one office stream", () => {
    expect(Cursor.safeParse({ stream: "software", seq: 0 }).success).toBe(true);
    expect(Cursor.safeParse({ stream: `office:${ids.office}`, seq: 3 }).success).toBe(true);
    expect(Cursor.safeParse({ stream: "office:DIPO", seq: 3 }).success).toBe(false);
    expect(Cursor.safeParse({ stream: "software", seq: -1 }).success).toBe(false);
    expect(Cursor.safeParse({ stream: "software", seq: 1.5 }).success).toBe(false);
  });
});

describe("frames", () => {
  for (const [name, frame] of Object.entries(clientFrameFixtures)) {
    it(`client frame "${name}" parses`, () => {
      expect(ClientFrame.parse(frame)).toBeDefined();
    });
  }

  for (const [name, frame] of Object.entries(serverFrameFixtures)) {
    it(`server frame "${name}" parses`, () => {
      expect(ServerFrame.parse(frame)).toBeDefined();
    });
  }

  for (const [name, frame] of Object.entries(malformedClientFrames)) {
    it(`malformed client frame "${name}" fails`, () => {
      expect(ClientFrame.safeParse(frame).success).toBe(false);
    });
  }

  for (const [name, frame] of Object.entries(malformedServerFrames)) {
    it(`malformed server frame "${name}" fails`, () => {
      expect(ServerFrame.safeParse(frame).success).toBe(false);
    });
  }

  it("defaults confirmed to false on a command", () => {
    const frame = ClientFrame.parse(clientFrameFixtures["command"]);
    expect(frame.kind === "command" && frame.confirmed).toBe(false);
  });
});

describe("commands, reads and events", () => {
  for (const definition of contractCommands) {
    it(`command ${definition.name} has fixtures that parse`, () => {
      const fixture = commandFixtures[definition.name];
      expect(fixture).toBeDefined();
      definition.args.parse(fixture?.args);
      definition.result.parse(fixture?.result);
    });
  }

  for (const definition of contractReads) {
    it(`read ${definition.name} has fixtures that parse`, () => {
      const fixture = readFixtures[definition.name];
      expect(fixture).toBeDefined();
      definition.args.parse(fixture?.args);
      definition.result.parse(fixture?.result);
    });
  }

  for (const definition of contractEvents) {
    it(`event ${definition.type} has data that parses`, () => {
      expect(Object.hasOwn(eventFixtures, definition.type)).toBe(true);
      definition.data.parse(eventFixtures[definition.type]);
    });
  }

  it("has no fixture without a definition", () => {
    const commands = new Set(contractCommands.map((d) => d.name));
    const reads = new Set(contractReads.map((d) => d.name));
    const events = new Set(contractEvents.map((d) => d.type));
    expect(Object.keys(commandFixtures).filter((name) => !commands.has(name))).toEqual([]);
    expect(Object.keys(readFixtures).filter((name) => !reads.has(name))).toEqual([]);
    expect(Object.keys(eventFixtures).filter((type) => !events.has(type))).toEqual([]);
  });

  it("names each command, read and event once", () => {
    const names = [...contractCommands.map((d) => d.name), ...contractReads.map((d) => d.name)];
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(contractEvents.map((d) => d.type)).size).toBe(contractEvents.length);
  });

  it("reports a tool the daemon did not find as absent", () => {
    const status = contractReads.find((d) => d.name === "daemon.status");
    const result = status?.result.parse(readFixtures["daemon.status"]?.result) as { tools: object };
    expect(Object.keys(result.tools).toSorted()).toEqual(["backlog", "claude", "gh", "git"]);
    const relative = { ...(readFixtures["daemon.status"]?.result as object), tools: { rg: "rg" } };
    expect(status?.result.safeParse(relative).success).toBe(false);
  });
});

describe("errors", () => {
  it("exports every generic code of 0005 section 10", () => {
    expect(([...GENERIC_ERROR_CODES] as string[]).toSorted()).toEqual(
      [
        "args.invalid",
        "capability.missing",
        "confirmation.required",
        "database.unavailable",
        "internal",
        "not.permitted",
        "office.unknown",
        "request.reused",
        "request.timedOut",
        "story.ambiguous",
        "story.unknown",
        "stream.resetRequired",
      ].toSorted(),
    );
    expect(([...RETRYABLE_ERROR_CODES] as string[]).toSorted()).toEqual(
      ["engine.recovering", "run.hostAlive", "scheduling.off", "git.fetchFailed"].toSorted(),
    );
  });

  it("exports the office-level codes of minor 1 (DIPO-71, DIPO-48, DIPO-59, DIPO-163, DIPO-155, DIPO-310)", () => {
    expect([...OFFICE_ERROR_CODES]).toEqual([
      "config.invalid",
      "backlog.unreadable",
      "run.refused",
      "question.closed",
      "gate.notWaitingOnMaintainer",
      "gate.handMergeOnly",
      "gate.noteRequired",
      "story.notSteerable",
      "resume.topUpRequired",
      "resume.topUpTooSmall",
      "resume.noteRequired",
      "resume.notResumable",
      "resume.capReached",
      "story.notParked",
      "scan.noProfile",
      "scan.noProposal",
      "scan.resolvedByCode",
      "scan.notConflict",
      "scan.noCandidate",
      "scan.notConfirmed",
      "scan.invalidCommand",
      "scan.staleProposal",
      "story.notTestable",
      "test.notInReview",
      "test.refused",
      "test.startFailed",
      "test.closed",
    ]);
  });

  it("marks only engine.recovering, scheduling.off, run.hostAlive and git.fetchFailed retryable", () => {
    const retryable = [
      ...GENERIC_ERROR_CODES,
      ...RETRYABLE_ERROR_CODES,
      ...SOFTWARE_ERROR_CODES,
      ...OFFICE_ERROR_CODES,
      "x.y",
    ]
      .filter((code) => engineError(code, "m").retryable)
      .toSorted();
    expect(retryable).toEqual([
      "engine.recovering",
      "git.fetchFailed",
      "run.hostAlive",
      "scheduling.off",
    ]);
    expect(isRetryableErrorCode("internal")).toBe(false);
    expect(engineError("story.notSteerable", "m").retryable).toBe(false);
  });

  it("keeps details only when given", () => {
    expect(engineError("internal", "m")).toEqual({
      code: "internal",
      message: "m",
      retryable: false,
    });
    expect(engineError("args.invalid", "m", { path: ["x"] }).details).toEqual({ path: ["x"] });
  });

  it("parses database.unavailable details with known and unknown reasons (DIPO-111)", () => {
    expect(engineError("database.unavailable", "m").retryable).toBe(false);
    expect(
      DatabaseUnavailableDetails.parse({ reason: "migration", backup: "/s/backups/pre-v3.db" }),
    ).toEqual({ reason: "migration", backup: "/s/backups/pre-v3.db" });
    expect(DatabaseUnavailableDetails.parse({ reason: "later" })).toEqual({ reason: "later" });
    expect(DatabaseUnavailableDetails.safeParse({}).success).toBe(false);
  });
});
