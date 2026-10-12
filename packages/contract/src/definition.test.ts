import { describe, expect, it } from "bun:test";
import { z } from "zod";

import {
  checkVersioning,
  CONTRACT_VERSION,
  contractCommands,
  contractReads,
  defineCommand,
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
        "gate.reject",
        "work.stop",
        "work.discard",
        "story.drop",
        "work.reassign",
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

  it("describes office.purge with confirm and irreversible once it ships", () => {
    const purge = findCommand("office.purge");
    if (purge === undefined) throw new Error("office.purge is not defined");
    const { provisional: _provisional, ...rest } = purge;
    const shipped = defineCommand({ ...rest, since: 0 });
    const [entry] = describeContract([shipped], []).commands;
    expect(entry).toMatchObject({
      name: "office.purge",
      since: 0,
      confirm: true,
      irreversible: true,
    });
  });

  it("leaves provisional definitions out", () => {
    const names = describeContract().commands.map((entry) => entry.name);
    expect(names).not.toContain("office.purge");
    expect(names).not.toContain("office.init");
  });
});
