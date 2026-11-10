// The Composer (DIPO-457): Enter adds a line, Ctrl-S sends, Esc cancels, and the rows show the last
// lines of the draft with the cursor.

import { describe, expect, it } from "bun:test";

import { composerKey, composerRows, editDraft } from "./composer";

describe("editDraft", () => {
  it("adds a line on Enter, erases on Backspace and keeps a paste's line breaks", () => {
    expect(editDraft("a", "\r", { return: true } as never)).toBe("a\n");
    expect(editDraft("ab", "", { backspace: true } as never)).toBe("a");
    expect(editDraft("", "x\r\ny\rz", {} as never)).toBe("x\ny\nz");
    expect(editDraft("a", "s", { ctrl: true } as never)).toBeNull();
  });
});

describe("the Composer", () => {
  it("adds a line on Enter and sends on Ctrl-S", () => {
    expect(composerKey("a", "\r", { return: true } as never)).toEqual({
      kind: "edit",
      draft: "a\n",
    });
    expect(composerKey("a", "s", { ctrl: true } as never)).toEqual({ kind: "send" });
  });

  it("cancels on Esc and leaves other control keys alone", () => {
    expect(composerKey("a", "", { escape: true } as never)).toEqual({ kind: "cancel" });
    expect(composerKey("a", "e", { ctrl: true } as never)).toEqual({ kind: "other" });
  });

  it("shows the last rows with a prompt on the first and the cursor on the last", () => {
    expect(composerRows("one\ntwo", 40)).toEqual(["> one", "  two_"]);
    const long = Array.from({ length: 9 }, (_, i) => `l${i}`).join("\n");
    expect(composerRows(long, 40, 3)).toEqual(["  l6", "  l7", "  l8_"]);
  });
});

const read = (draft: string, input: string, key: object) =>
  composerKey(draft, input, key as never, true);

describe("the Composer where Enter sends (DIPO-479)", () => {
  it("sends on Enter and makes a new line on Shift+Enter, Option+Enter and a trailing backslash", () => {
    expect(read("a", "\r", { return: true })).toEqual({ kind: "send" });
    expect(read("a", "\r", { return: true, shift: true })).toEqual({ kind: "edit", draft: "a\n" });
    expect(read("a", "\r", { return: true, meta: true })).toEqual({ kind: "edit", draft: "a\n" });
    expect(read("a", "[27;2;13~", {})).toEqual({ kind: "edit", draft: "a\n" });
    expect(read("a\\", "\r", { return: true })).toEqual({ kind: "edit", draft: "a\n" });
  });

  it("does not send on Ctrl-S and still cancels on Esc", () => {
    expect(read("a", "s", { ctrl: true })).toEqual({ kind: "other" });
    expect(read("a", "", { escape: true })).toEqual({ kind: "cancel" });
  });
});
