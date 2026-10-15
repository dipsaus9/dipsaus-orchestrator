// The `now` text shared by the overview and the live agent detail (DIPO-81): phase words, the
// newest line (verify first in the verify phase), the age, and the asking case.

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
  it("names each known phase in words and shows an unknown one as is", () => {
    expect(
      ["setup", "build", "verify", "review", "test", "merge", "deploy"].map(phaseWord),
    ).toEqual([
      "setting up",
      "building",
      "running verify",
      "reviewing",
      "testing",
      "merging",
      "deploy",
    ]);
  });

  it("shows the newest worker line as stored, with its age", () => {
    const text = boardNow({
      view: view("build", "busy", "2026-10-14T10:03:48.000Z"),
      worker: "[tool] Edit src/retry.ts",
      verify: "FAIL x",
      question: undefined,
      now: NOW,
      dot: "·",
    });
    expect(text).toBe("building · [tool] Edit src/retry.ts · 12s ago");
  });

  it("leads with the verify line in the verify phase, and says no output yet without any", () => {
    const options = { question: undefined, now: NOW, dot: "-" };
    expect(boardNow({ ...options, view: view("verify"), worker: "w", verify: "FAIL x" })).toBe(
      "running verify - FAIL x",
    );
    expect(boardNow({ ...options, view: view("verify"), worker: "w", verify: null })).toBe(
      "running verify - w",
    );
    expect(boardNow({ ...options, view: view("setup"), worker: null, verify: null })).toBe(
      "setting up - no output yet",
    );
  });

  it("says asking you with the open question", () => {
    const asking = view("review", "asking");
    const question = {
      question: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C19",
      work: asking.work,
      kind: "permission",
      text: "Bash(docker compose up)",
      askedAt: "2026-10-14T10:00:00.000Z",
    } as QuestionView;
    const options = { view: asking, worker: "w", verify: null, now: NOW, dot: "·" };
    expect(boardNow({ ...options, question })).toBe(
      "asking you · permission: Bash(docker compose up)",
    );
    expect(boardNow({ ...options, question: undefined })).toBe("asking you");
  });

  it("keeps the detail's now line as it was", () => {
    const options = { ended: undefined, now: NOW, dot: "·" };
    expect(nowLine({ ...options, view: view("verify"), worker: "w", verify: "FAIL x" })).toBe(
      "now  busy > · verify · verify: FAIL x",
    );
    expect(nowLine({ ...options, view: view("verify"), worker: null, verify: null })).toBe(
      "now  busy > · verify",
    );
    expect(nowLine({ ...options, view: view("build"), worker: null, verify: null })).toBe(
      "now  busy > · build · no output yet",
    );
  });
});
