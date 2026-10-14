import { describe, expect, it } from "bun:test";

import { OfficeId } from "@dipsaus-orchestrator/contract";

import { parseTuiArgs } from "./options";

describe("dipo tui options", () => {
  it("defaults to colour, Unicode glyphs and the alternate screen", () => {
    expect(parseTuiArgs([], {})).toEqual({
      color: true,
      ascii: false,
      inline: false,
      office: null,
    });
  });

  it("honours NO_COLOR, --no-color, --ascii, --inline and --office", () => {
    expect(parseTuiArgs([], { NO_COLOR: "1" })).toMatchObject({ color: false });
    expect(parseTuiArgs([], { NO_COLOR: "" })).toMatchObject({ color: true });
    expect(
      parseTuiArgs(
        ["--no-color", "--ascii", "--inline", "--office", "off_01J9ZK5Q8W3V4X6Y7Z8A9B0CAA"],
        {},
      ),
    ).toEqual({
      color: false,
      ascii: true,
      inline: true,
      office: OfficeId.parse("off_01J9ZK5Q8W3V4X6Y7Z8A9B0CAA"),
    });
  });

  it("refuses unknown arguments and a bad office id", () => {
    expect(parseTuiArgs(["--wide"], {})).toBe('unknown argument "--wide"');
    expect(parseTuiArgs(["--office", "nope"], {})).toBe("--office needs an office id (off_...)");
  });
});
