// The reviewer's recordings replayed (DIPO-145; 0019 sections 4 and 5, 0017 section 2): every
// committed recording of the review kind, derived now and live once the maintainer captured the
// `review-*-live` scenarios, parses into the review report schema or gives its error, through the
// adapter's parser as a review run starts it.

import { describe, expect, it } from "bun:test";

import type { Recording } from "@dipsaus-orchestrator/testkit";

import { initialState } from "../../src/workers/claude-cli/interpret";
import { result as claudeResult } from "../../src/workers/claude-cli/result";
import {
  parseReviewReport,
  REVIEW_REPORT_JSON_SCHEMA,
} from "../../src/workers/claude-cli/report-schema";
import { REVIEW_SUMMARY_MAX, type ReviewReport } from "../../src/workers/types";
import { loadRecording, plannedModel, recordingNames, replay, reportKind } from "./replay";

type Json = Record<string, unknown>;

function stdout(recording: Recording): Json[] {
  return recording.lines
    .filter((line) => line.ch === "stdout" && typeof line.data === "object")
    .map((line) => line.data as Json);
}

function lastResult(recording: Recording): Json {
  const result = stdout(recording)
    .filter((message) => message["type"] === "result")
    .at(-1);
  if (result === undefined) throw new Error(`${recording.name}: no result`);
  return result;
}

async function reviewOf(name: string): Promise<ReviewReport | undefined> {
  return (await replay(loadRecording(name))).result.review;
}

const REVIEW = recordingNames().filter((name) => reportKind(loadRecording(name)) === "review");

describe("review recordings", () => {
  it("include an approval, a blocked verdict and an invalid report", () => {
    for (const name of ["review-approved", "review-blocked", "review-invalid"]) {
      expect(REVIEW).toContain(name);
    }
  });

  for (const name of REVIEW) {
    describe(name, () => {
      const recording = loadRecording(name);

      it("parses into the review report schema or its error, as the replay reads it", async () => {
        const read = parseReviewReport(lastResult(recording)["structured_output"]);
        const run = await replay(recording);
        const turn = run.events.findLast((event) => event.t === "turn");
        if (turn?.t !== "turn") throw new Error("no turn");
        // A review session never carries a worker report.
        expect(turn.report).toBeNull();
        expect(run.result.report).toBeNull();
        if (read.ok) {
          expect(turn.review).toEqual(read.report);
          expect(turn.problem).toBeUndefined();
          expect(run.result.review).toEqual(read.report);
          expect(run.result.outcome).toBe("done");
          expect(read.report.summary.length).toBeLessThanOrEqual(REVIEW_SUMMARY_MAX);
        } else {
          expect(read.error).toContain("review report schema");
          expect(turn.review).toBeUndefined();
          expect(turn.problem).toEqual({ kind: "report", detail: read.error });
          expect(run.result.review).toBeUndefined();
          expect(run.result.retry).toBe("report-feedback");
          expect(run.result.park?.reason).toBe("worker-failed");
          expect(run.result.park?.detail).toContain("no valid review report");
        }
        // The reviewer is never resumed.
        expect(run.result.resumable).toBe(false);
      });

      it("carries the result's report in the StructuredOutput tool use and its streamed deltas", () => {
        const report = lastResult(recording)["structured_output"];
        const messages = stdout(recording);
        const inputs = messages
          .filter((message) => message["type"] === "assistant")
          .flatMap((message) => (message["message"] as Json)["content"] as Json[])
          .filter((block) => block["type"] === "tool_use" && block["name"] === "StructuredOutput")
          .map((block) => block["input"]);
        expect(inputs).toEqual([report]);
        const streamed = messages
          .map((message) => (message["type"] === "stream_event" ? message["event"] : undefined))
          .map((event) => (event as Json | undefined)?.["delta"] as Json | undefined)
          .filter((delta) => delta?.["type"] === "input_json_delta")
          .map((delta) => delta?.["partial_json"])
          .join("");
        expect(JSON.parse(streamed)).toEqual(report);
      });

      it("ran with the reviewer's tools and no skill", () => {
        const init = stdout(recording).find(
          (message) => message["type"] === "system" && message["subtype"] === "init",
        );
        const listed = (init?.["tools"] ?? []) as string[];
        const tools = listed.filter((tool) => tool !== "StructuredOutput");
        expect(tools.toSorted()).toEqual(["Bash", "Glob", "Grep", "Read"]);
        expect(init?.["skills"] ?? []).toEqual([]);
      });

      it("passes the skills check a review run's parser applies at system/init", async () => {
        const state = initialState({
          plannedModel: plannedModel(recording),
          reportKind: "review",
          refuseSkills: true,
        });
        const run = await replay(recording, { state });
        expect(run.events.some((event) => event.t === "startRefused")).toBe(false);
      });
    });
  }
});

describe("the derived review reports", () => {
  it("review-approved: every criterion met and no finding", async () => {
    const review = await reviewOf("review-approved");
    expect(review?.criteria.every((criterion) => criterion.status === "met")).toBe(true);
    expect(review?.findings).toEqual([]);
  });

  it("review-blocked: an unmet criterion, a quoted blocking finding and a test entry", async () => {
    const review = await reviewOf("review-blocked");
    expect(review?.criteria.map((criterion) => criterion.status)).toEqual(["unmet"]);
    const blocking = review?.findings.filter((finding) => finding.severity === "blocking") ?? [];
    expect(blocking.map((finding) => finding.kind)).toEqual(["correctness", "test"]);
    expect(blocking[0]).toMatchObject({ file: "src/greet.ts", line: 3, criterion: 1 });
    expect(blocking[0]?.quote).toBeDefined();
    expect(blocking[1]?.testEntry).toBe(1);
    expect(review?.findings.some((finding) => finding.severity === "advisory")).toBe(true);
  });

  it("review-invalid: the worker report fails the review schema", () => {
    const read = parseReviewReport(
      lastResult(loadRecording("review-invalid"))["structured_output"],
    );
    expect(read.ok).toBe(false);
    // As an implement session it would have been a valid report.
    expect(lastResult(loadRecording("review-invalid"))["structured_output"]).toMatchObject({
      status: "done",
    });
  });
});

describe("a reviewer that crashed", () => {
  it("is never resumable: the next review is a fresh session", async () => {
    const recording = loadRecording("review-approved");
    const run = await replay(recording);
    const crashed = claudeResult(run.state, { code: null, signal: "SIGKILL" });
    expect(crashed.outcome).toBe("crashed");
    expect(crashed.park?.reason).toBe("worker-failed");
    expect(crashed.resumable).toBe(false);
  });
});

describe("the review report schema", () => {
  const valid = {
    criteria: [{ n: 1, status: "maintainer", evidence: "Needs a manual run." }],
    findings: [{ severity: "blocking", kind: "test", testEntry: 2, text: "No test." }],
    summary: "Fine but untested.",
  };

  it("takes testEntry, the three criterion statuses and the six finding kinds", () => {
    expect(parseReviewReport(valid)).toEqual({ ok: true, report: valid as ReviewReport });
    for (const kind of ["scope", "test", "correctness", "security", "maintainability", "other"]) {
      const finding = { severity: "advisory", kind, text: "x" };
      expect(parseReviewReport({ ...valid, findings: [finding] }).ok).toBe(true);
    }
  });

  it("caps the summary at 1,500 characters, in the parser and in the JSON Schema", () => {
    expect(parseReviewReport({ ...valid, summary: "x".repeat(1_500) }).ok).toBe(true);
    const long = parseReviewReport({ ...valid, summary: "x".repeat(1_501) });
    expect(long.ok).toBe(false);
    expect(!long.ok && long.error).toContain("summary");
    const properties = REVIEW_REPORT_JSON_SCHEMA["properties"] as Json;
    expect((properties["summary"] as Json)["maxLength"]).toBe(1_500);
  });

  it("refuses a worker report, an unknown field, a bad enum and a missing list", () => {
    for (const bad of [
      { status: "done", criteria: [], summary: "x", commitSubject: "y" },
      { ...valid, verdict: "approved" },
      { ...valid, criteria: [{ n: 1, status: "partly", evidence: "" }] },
      { ...valid, findings: [{ severity: "major", kind: "test", text: "x" }] },
      { criteria: [], summary: "x" },
      null,
      undefined,
    ]) {
      expect(parseReviewReport(bad).ok).toBe(false);
    }
    expect(parseReviewReport(undefined)).toEqual({ ok: false, error: "no structured_output" });
  });
});
