// The `now` text shared by the overview and the live agent detail (DIPO-81, DIPO-352): phase words
// of the five phases, the newest worker line, the age, and a run with an open question.

import { describe, expect, it } from "bun:test";

import type { QuestionView, WorkView } from "@dipsaus-orchestrator/contract";

import { boardNow, nowLine, phaseWord } from "./now";
import { goldenSnapshots, OFFICES } from "./testing/fake-session";

const NOW = Date.parse("2026-10-14T10:04:00.000Z");

function view(phase: string, health = "busy", lastOutputAt?: string): WorkView {
  const base = goldenSnapshots.get(OFFICES.dipsaus)!.work[0]!;
  return {
    ...base,
    phase,
    health,
    ...(lastOutputAt === undefined ? {} : { lastOutputAt }),
  } as WorkView;
}

describe("now text", () => {
  it("names each phase of 0009 in words and shows an unknown one, such as verify, as is", () => {
    expect(["setup", "build", "review", "test", "merge", "verify"].map(phaseWord)).toEqual([
      "setting up",
      "building",
      "reviewing",
      "testing",
      "merging",
      "verify",
    ]);
  });

  it("shows the newest worker line as stored, with its age", () => {
    const text = boardNow({
      view: view("build", "busy", "2026-10-14T10:03:48.000Z"),
      worker: "[tool] Edit src/retry.ts",
      question: undefined,
      now: NOW,
      dot: "·",
    });
    expect(text).toBe("building · [tool] Edit src/retry.ts · 12s ago");
  });

  it("says no output yet without a worker line", () => {
    const options = { question: undefined, now: NOW, dot: "-" };
    expect(boardNow({ ...options, view: view("setup"), worker: null })).toBe(
      "setting up - no output yet",
    );
  });

  it("says asking you with the open question, whatever the health", () => {
    const quiet = view("review", "quiet");
    const question = {
      question: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C19",
      work: quiet.work,
      kind: "permission",
      text: "Bash(docker compose up)",
      askedAt: "2026-10-14T10:00:00.000Z",
    } as QuestionView;
    const options = { view: quiet, worker: "w", now: NOW, dot: "·" };
    expect(boardNow({ ...options, question })).toBe(
      "asking you · permission: Bash(docker compose up)",
    );
    expect(boardNow({ ...options, question: undefined })).toBe("reviewing · w");
  });

  it("shows health, phase and the newest worker line in the detail's now line", () => {
    const options = { ended: undefined, now: NOW, dot: "·" };
    expect(nowLine({ ...options, view: view("build"), worker: "w" })).toBe(
      "now  busy > · build · w",
    );
    expect(nowLine({ ...options, view: view("build", "stuck"), worker: null })).toBe(
      "now  stuck ~ · build · no output yet",
    );
  });
});
