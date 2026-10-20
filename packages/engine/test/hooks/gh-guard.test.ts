// The gh check of the Bash hook (DIPO-195 AC #1, #2): gh's own help and version pass, every other
// simple command whose program is gh is refused, alone, inside a compound command and behind a
// wrapper; the DIPO_TMP and TMPDIR check still runs first in the composed check.

import { describe, expect, it } from "bun:test";

import { bashRefusal, GH_REFUSAL, ghRefusal } from "../../src/hooks";

const ALLOWED = [
  "gh --version",
  "gh help",
  "gh help pr",
  "gh help pr view",
  "gh pr view --help",
  "gh api --help",
  "gh pr view --help && gh api --help",
  "echo gh pr view 12",
  "gh --version | cat",
  // Redirections are not gh's arguments: a help form with its output redirected is still one.
  "gh pr view --help 2>&1",
  "gh --version 2>&1 | head",
  "gh pr view --help > help.txt",
  "gh api --help >help.txt",
  "timeout 10 gh --version",
];

const REFUSED = [
  "gh api -h",
  "gh",
  "gh --help",
  "gh pr view 12",
  "gh pr create --title x --help",
  "gh --help && gh auth token",
  "gh pr view --help; gh pr list",
  "gh --version --help",
  "gh help --help",
  "gh pr view --web --help",
  "/usr/local/bin/gh pr list",
  "time gh pr list",
  "env GH_HOST=x gh pr list",
  "env -C /x gh pr list",
  "sudo gh pr list",
  "xargs gh pr view --help",
  "bash -c 'gh pr list'",
  "eval 'gh pr list'",
  "echo done && if true; then gh pr list; fi",
  "echo $(gh pr list)",
  "cat <<'EOF' | bash\ngh pr list\nEOF",
  "gh pr list <<< x",
  // The Claude CLI strips timeout and stdbuf before matching, so the old Bash(gh *) rule caught these.
  "timeout 10 gh pr list",
  "timeout -s KILL 5 gh pr list",
  "stdbuf -oL gh pr list",
  "gh pr view 12 2>&1",
  "gh pr view 12 > out.txt",
  "gh pr view > --help",
  // The words come without quotes: a quoted `<` or `2>` in the middle is a real argument that can
  // hide a flag taking --help as its value, so only trailing redirections are dropped.
  "gh pr comment '<' -b --help",
  "gh gist create '<' -d --help",
  "gh search repos foo '<' -- --help",
  "gh pr view \\> -- --help",
  'gh pr view "2>" -b --help',
  "gh pr view --help '>' -b",
];

describe("ghRefusal", () => {
  it("allows gh's own version and help forms", () => {
    for (const command of ALLOWED) expect([command, ghRefusal(command)]).toEqual([command, null]);
  });

  it("refuses every other gh call, alone or inside a compound command", () => {
    for (const command of REFUSED)
      expect([command, ghRefusal(command)]).toEqual([command, GH_REFUSAL]);
  });

  it("names the code host and the forms allowed in the reason", () => {
    expect(GH_REFUSAL).toContain("the engine handles the code host");
    expect(GH_REFUSAL).toContain("gh --version");
  });
});

describe("bashRefusal", () => {
  it("refuses a gh call and a temp variable write with their own reasons", () => {
    expect(bashRefusal("gh pr view 12")).toBe(GH_REFUSAL);
    expect(bashRefusal("TMPDIR=/x bun test")).toContain("TMPDIR");
    expect(bashRefusal("gh pr view --help")).toBeNull();
    expect(bashRefusal("bun run verify")).toBeNull();
  });
});
