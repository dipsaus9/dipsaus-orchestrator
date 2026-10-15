// The pure parts of a `needs-permission` park's question (DIPO-75; 0008 section 5): the recorded
// tool and action read back from the park detail, the sandbox-bound check (AC #3), the question
// text and the first message of the resumed session.

import { describe, expect, it } from "bun:test";

import {
  OFFICE_CONFIG_FILE,
  parkAnswerMessage,
  parkQuestionText,
  permissionDetail,
  recordedPermission,
  sandboxBinding,
} from "../../src/hooks/park-questions";

const FACTS = { worktree: "/work/trees/DIPO-1", allowedDomains: ["registry.npmjs.org"] };

describe("the recorded permission", () => {
  it("reads the tool and the whole action back from the park detail", () => {
    const permission = { tool: "Bash", action: "curl -s https://x.dev: ok" };
    expect(recordedPermission(permissionDetail(permission))).toEqual(permission);
    expect(recordedPermission("Write: ../outside.txt")).toEqual({
      tool: "Write",
      action: "../outside.txt",
    });
    expect(recordedPermission("no separator")).toBeNull();
    expect(recordedPermission("two words: x")).toBeNull();
    expect(recordedPermission("Bash: ")).toBeNull();
  });
});

function bound(tool: string, action: string): string | null {
  return sandboxBinding({ tool, action }, FACTS);
}

describe("sandbox-bound actions (AC #3)", () => {
  it("marks network commands and hosts outside sandbox.allowedDomains", () => {
    expect(bound("Bash", "docker ps")).toContain("docker");
    expect(bound("Bash", "curl -s https://api.example.com/v1")).toContain("api.example.com");
    expect(bound("Bash", "git push origin main")).toContain("git");
    expect(bound("Bash", "FOO=1 /usr/bin/wget x")).toContain("wget");
    expect(bound("Bash", "bun add left-pad")).toContain("bun");
    expect(bound("Bash", "cd sub && npx tsc")).toContain("npx");
  });

  it("leaves local commands and allowed hosts alone", () => {
    expect(bound("Bash", "bun test")).toBeNull();
    expect(bound("Bash", "ls -la")).toBeNull();
    expect(bound("Bash", "git status")).toBeNull();
    expect(bound("Bash", "curl https://registry.npmjs.org/left-pad")).toBeNull();
    expect(
      sandboxBinding(
        { tool: "Bash", action: "curl https://a.cdn.dev/x" },
        { ...FACTS, allowedDomains: ["*.cdn.dev"] },
      ),
    ).toBeNull();
  });

  it("marks file writes outside the worktree, not inside it", () => {
    expect(bound("Write", "../outside.txt")).toContain("outside the worktree");
    expect(bound("Edit", "/etc/hosts")).toContain("/etc/hosts");
    expect(bound("Write", "create ../outside.txt (the root)")).toContain("../outside.txt");
    expect(bound("Write", "src/a.ts")).toBeNull();
    expect(bound("Write", "/work/trees/DIPO-1/src/a.ts")).toBeNull();
    expect(bound("Read", "/etc/hosts")).toBeNull();
    expect(
      sandboxBinding({ tool: "Write", action: "/x" }, { ...FACTS, worktree: null }),
    ).toBeNull();
  });
});

describe("the question and the resume message", () => {
  it("shows the call, and for a sandbox-bound one says allow once cannot lift it and points to office config", () => {
    const permission = { tool: "Bash", action: "docker ps" };
    expect(parkQuestionText(permission, null)).toBe("Bash(docker ps)");
    const text = parkQuestionText(permission, sandboxBinding(permission, FACTS));
    expect(text).toStartWith("Bash(docker ps). Sandbox-bound: it runs docker");
    expect(text).toContain("cannot lift a sandbox block");
    expect(text).toContain(OFFICE_CONFIG_FILE);
  });

  it("asks for the exact call on allow and says 'do it without <action>' on deny", () => {
    const permission = { tool: "Bash", action: "docker ps" };
    const allow = parkAnswerMessage(permission, "allow", "");
    expect(allow).toContain("allowed this Bash call once: docker ps");
    expect(allow).toContain("character for character");
    expect(allow).not.toContain("The maintainer adds");
    expect(parkAnswerMessage(permission, "deny", "  use the fake  ")).toBe(
      "The maintainer denied Bash: docker ps. Do it without docker ps.\n\nThe maintainer adds: use the fake",
    );
  });
});
