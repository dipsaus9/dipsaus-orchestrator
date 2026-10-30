import { describe, expect, it } from "bun:test";

import { contractCommands, contractReads, describeContract, commandsDescribe } from "./index";
import { readFixtures } from "../test/fixtures";

describe("command and read definitions", () => {
  it("marks the commands of 0005 section 4 that ask first", () => {
    const confirmed = contractCommands.filter((d) => d.confirm).map((d) => d.name);
    expect(confirmed.toSorted()).toEqual(
      [
        "daemon.stop",
        "office.forget",
        "office.setPrivacy",
        "gate.reject",
        "work.discard",
        "story.drop",
      ].toSorted(),
    );
  });
});

describe("commands.describe", () => {
  it("parses a fixture with a read entry", () => {
    const result = commandsDescribe.result.parse(readFixtures["commands.describe"]?.result);
    expect(result.reads.map((entry) => entry.name)).toEqual(["daemon.status"]);
  });

  it("describes every command and read with JSON Schema and no version (0005)", () => {
    const described = commandsDescribe.result.parse(describeContract());
    expect(described.commands.map((entry) => entry.name)).toEqual(
      contractCommands.map((d) => d.name),
    );
    expect(described.reads.map((entry) => entry.name)).toEqual(contractReads.map((d) => d.name));
    for (const entry of [...described.commands, ...described.reads]) {
      expect(entry).not.toHaveProperty("since");
    }
    const open = described.commands.find((entry) => entry.name === "office.open");
    expect(open?.args).toMatchObject({ type: "object", required: ["path"] });
    expect(open?.confirm).toBe(false);
    expect(open?.irreversible).toBe(false);
  });

  it("lists story.park and story.drop; drop is irreversible when deleteBranch is set (DIPO-160, DIPO-344)", () => {
    const commands = describeContract().commands;
    const drop = commands.find((command) => command.name === "story.drop");
    expect(drop).toMatchObject({
      level: "office",
      confirm: true,
      irreversible: false,
      irreversibleWhen: ["deleteBranch"],
    });
    const park = commands.find((command) => command.name === "story.park");
    expect(park).toMatchObject({ confirm: false, irreversible: false });
    const args = park?.args as { required?: string[] } | undefined;
    expect(args?.required?.toSorted()).toEqual(["note", "story"]);
    // Only a command that declares it carries the key.
    expect(park).not.toHaveProperty("irreversibleWhen");
  });

  it("lists work.resume as needing confirmation when budget is set (DIPO-155)", () => {
    const commands = describeContract().commands;
    const resume = commands.find((command) => command.name === "work.resume");
    expect(resume).toMatchObject({ confirm: false, confirmWhen: ["budget"] });
    const args = resume?.args as { properties?: object } | undefined;
    expect(Object.keys(args?.properties ?? {}).toSorted()).toEqual(["budget", "note", "story"]);
    // Only a command that declares it carries the key.
    const drop = commands.find((command) => command.name === "story.drop");
    expect(drop).not.toHaveProperty("confirmWhen");
  });

  it("lists work.discard with confirm and irreversible (DIPO-161)", () => {
    const entry = describeContract().commands.find((command) => command.name === "work.discard");
    expect(entry).toMatchObject({
      name: "work.discard",
      level: "office",
      confirm: true,
      irreversible: true,
      args: { type: "object", required: ["story", "note"] },
    });
    expect(entry).not.toHaveProperty("irreversibleWhen");
  });

  it("lists office.init with its result shape (DIPO-36)", () => {
    const entry = describeContract().commands.find((command) => command.name === "office.init");
    expect(entry).toMatchObject({
      name: "office.init",
      level: "software",
      confirm: false,
      irreversible: false,
      args: { type: "object", required: ["office"] },
    });
    const result = entry?.result as { properties?: object } | undefined;
    expect(Object.keys(result?.properties ?? {}).toSorted()).toEqual(
      ["branch", "leftAlone", "office", "pr", "waiting"].toSorted(),
    );
  });
});
