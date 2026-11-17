// DIPO-504: the system file of a later session.

import { describe, expect, it } from "bun:test";

import { DEVELOPER_SEED, renderSystemFile } from "../../src/prompts";
import { sessionSystemFile } from "../../src/run/resume";
const role = (kind?: "design" | "docs" | null) => ({
  roleFile: {
    instructions: "# Role: writer",
    model: null,
    effort: null,
    ...(kind === undefined ? {} : { kind }),
  },
});

describe("sessionSystemFile (DIPO-504)", () => {
  it("renders the code section for a run with no stored kind and the stored kind's otherwise", () => {
    const code = renderSystemFile("implement-box", "# Role: writer", "code");
    expect(sessionSystemFile(role())).toBe(code);
    expect(sessionSystemFile(role(null))).toBe(code);
    expect(sessionSystemFile({ roleFile: null })).toBe(
      renderSystemFile("implement-box", DEVELOPER_SEED, "code"),
    );
    expect(sessionSystemFile(role("design"))).toBe(
      renderSystemFile("implement-box", "# Role: writer", "design"),
    );
    expect(sessionSystemFile(role("docs"))).not.toBe(code);
  });
});
