// The pure parts of a `needs-permission` park's question (DIPO-75; 0008 section 5): the recorded
// tool and action read back from the park detail, the question text and the first message of the
// resumed session. The sandbox-bound check went with the Mac sandbox (DIPO-240).

import { describe, expect, it } from "bun:test";

import {
  parkAnswerMessage,
  parkQuestionText,
  permissionDetail,
  recordedPermission,
} from "../../src/hooks/park-questions";

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

describe("the question and the resume message", () => {
  it("shows the call, with no sandbox warning: a box worker has every permission (DIPO-240)", () => {
    const permission = { tool: "Bash", action: "docker ps" };
    expect(parkQuestionText(permission)).toBe("Bash(docker ps)");
  });

  it("lets the worker go ahead on allow, and says 'do it without <action>' on deny", () => {
    const permission = { tool: "Bash", action: "docker ps" };
    const allow = parkAnswerMessage(permission, "allow", "");
    expect(allow).toContain("allows this Bash call: docker ps");
    expect(allow).toContain("it changes no rule or setting");
    expect(allow).not.toContain("once");
    expect(allow).not.toContain("The maintainer adds");
    expect(parkAnswerMessage(permission, "deny", "  use the fake  ")).toBe(
      "The maintainer denied Bash: docker ps. Do it without docker ps.\n\nThe maintainer adds: use the fake",
    );
  });
});
