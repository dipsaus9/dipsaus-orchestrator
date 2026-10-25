import { describe, expect, it } from "bun:test";
import { z } from "zod";

import {
  checkVersioning,
  CONTRACT_VERSION,
  contractCommands,
  contractReads,
  describeContract,
  findCommand,
  commandsDescribe,
} from "./index";
import { readFixtures } from "./fixtures";

function shippedNames(list: readonly { name: string; since?: number }[]): string[] {
  return list.filter((d) => d.since !== undefined).map((d) => d.name);
}

describe("command and read definitions", () => {
  for (const definition of [...contractCommands, ...contractReads]) {
    it(`${definition.name} carries since or provisional`, () => {
      expect(checkVersioning(definition)).toBeUndefined();
    });
  }

  it("fails a definition with neither since nor provisional", () => {
    // Built outside the type system on purpose: the types already forbid this shape.
    const definition = { name: "office.bogus", args: z.object({}), result: z.object({}) };
    expect(checkVersioning(definition)).toBe("carries neither since nor provisional");
  });

  it("fails a definition with both, a false provisional or a future since", () => {
    expect(checkVersioning({ since: 0, provisional: true })).toBe(
      "carries both since and provisional",
    );
    expect(checkVersioning({ provisional: false })).toBeDefined();
    expect(checkVersioning({ since: -1 })).toBeDefined();
    expect(checkVersioning({ since: CONTRACT_VERSION.minor + 1 })).toBeDefined();
  });

  it("defines office.purge with confirm and irreversible", () => {
    const purge = findCommand("office.purge");
    expect(purge?.confirm).toBe(true);
    expect(purge?.irreversible).toBe(true);
  });

  it("marks the commands of 0005 section 4 that ask first", () => {
    const confirmed = contractCommands.filter((d) => d.confirm).map((d) => d.name);
    expect(confirmed.toSorted()).toEqual(
      [
        "daemon.stop",
        "office.forget",
        "office.purge",
        "office.setPrivacy",
        "gate.reject",
        "work.stop",
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

  it("describes every non-provisional command and read with JSON Schema", () => {
    const described = commandsDescribe.result.parse(describeContract());
    expect(described.commands.map((entry) => entry.name)).toEqual(shippedNames(contractCommands));
    expect(described.reads.map((entry) => entry.name)).toEqual(shippedNames(contractReads));
    const open = described.commands.find((entry) => entry.name === "office.open");
    expect(open?.args).toMatchObject({ type: "object", required: ["path"] });
    expect(open?.confirm).toBe(false);
    expect(open?.irreversible).toBe(false);
  });

  it("lists office.purge since minor 1 with confirm, irreversible and its result (DIPO-76)", () => {
    const entry = describeContract().commands.find((command) => command.name === "office.purge");
    expect(entry).toMatchObject({
      name: "office.purge",
      since: 1,
      level: "software",
      confirm: true,
      irreversible: true,
      args: { type: "object", required: ["office"] },
    });
    const result = entry?.result as { properties?: object; required?: string[] } | undefined;
    expect(Object.keys(result?.properties ?? {}).toSorted()).toEqual(
      ["directory", "office", "path", "rows"].toSorted(),
    );
    expect(result?.required?.toSorted()).toEqual(["office", "path", "rows"]);
    // `from` since the 0005 amendment of 2026-10-14, optional as on `office.forget`.
    const args = entry?.args as { properties?: object; required?: string[] } | undefined;
    expect(Object.keys(args?.properties ?? {}).toSorted()).toEqual(["from", "office"]);
    expect(args?.required).toEqual(["office"]);
  });

  it("lists story.hold and story.drop since minor 1; drop is irreversible when deleteBranch is set (DIPO-160)", () => {
    const commands = describeContract().commands;
    const drop = commands.find((command) => command.name === "story.drop");
    expect(drop).toMatchObject({
      since: 1,
      level: "office",
      confirm: true,
      irreversible: false,
      irreversibleWhen: ["deleteBranch"],
    });
    const hold = commands.find((command) => command.name === "story.hold");
    expect(hold).toMatchObject({ since: 1, confirm: false, irreversible: false });
    // Only a command that declares it carries the key.
    expect(hold).not.toHaveProperty("irreversibleWhen");
  });

  it("lists work.resume as needing confirmation when budget is set (DIPO-155)", () => {
    const commands = describeContract().commands;
    const resume = commands.find((command) => command.name === "work.resume");
    expect(resume).toMatchObject({ since: 1, confirm: false, confirmWhen: ["budget"] });
    const args = resume?.args as { properties?: object } | undefined;
    expect(Object.keys(args?.properties ?? {}).toSorted()).toEqual(["budget", "note", "story"]);
    // Only a command that declares it carries the key.
    const drop = commands.find((command) => command.name === "story.drop");
    expect(drop).not.toHaveProperty("confirmWhen");
  });

  it("lists work.discard since minor 1 with confirm and irreversible (DIPO-161)", () => {
    const entry = describeContract().commands.find((command) => command.name === "work.discard");
    expect(entry).toMatchObject({
      name: "work.discard",
      since: 1,
      level: "office",
      confirm: true,
      irreversible: true,
      args: { type: "object", required: ["story", "note"] },
    });
    expect(entry).not.toHaveProperty("irreversibleWhen");
  });

  it("leaves provisional definitions out", () => {
    const provisional = contractCommands.find((definition) => definition.provisional === true);
    if (provisional === undefined) throw new Error("no provisional command left to check");
    const names = describeContract().commands.map((entry) => entry.name);
    expect(names).not.toContain(provisional.name);
  });

  it("lists office.init since minor 1 with its result shape (DIPO-36)", () => {
    const entry = describeContract().commands.find((command) => command.name === "office.init");
    expect(entry).toMatchObject({
      name: "office.init",
      since: 1,
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
