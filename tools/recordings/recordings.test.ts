// Unit tests over every committed recording (0017 section 2; DIPO-41 AC #8): no secret shape, no
// redacted decision field, usage numbers equal to the checksum taken at capture, normalised ids,
// and derived recordings that match what `derive.ts` produces from the live ones today.

import { describe, expect, it } from "bun:test";

import { decisionFieldProblems } from "./checks";
import { deriveAll } from "./derive";
import { isRecord, readAllRecordings } from "./format";
import { machineNeedles, scanForSecrets } from "./secrets";
import { stdoutOf, usageChecksum } from "./usage";

const LIVE = [
  "success-single",
  "success-tools-subagent",
  "max-turns",
  "permission-denied",
  "permission-wait",
  "interrupt",
  "resume",
  "worker-park-ambiguous",
  // DIPO-164 and DIPO-145: captured with Claude Code 2.1.302.
  "web",
  "review-approved-live",
  "review-blocked-live",
  "review-invalid-live",
];
const DERIVED = [
  "terminated",
  "crash-truncated",
  "crash-zeroed",
  "init-rejected",
  "start-failed",
  "report-invalid",
  "prompt-too-long",
  "stall",
  "budget-engine-cap",
  "review-approved",
  "review-blocked",
  "review-invalid",
  "web-calls",
];

const recordings = readAllRecordings();
const needles = machineNeedles();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const RAW_ID = /\b(?:msg|toolu|req|srvtoolu)_0[0-9A-Za-z]{10,}/;

describe("committed recordings", () => {
  it("include every live and derived M0 scenario", () => {
    const names = recordings.map((recording) => recording.name);
    for (const name of [...LIVE, ...DERIVED]) expect(names).toContain(name);
    for (const name of LIVE) {
      expect(recordings.find((recording) => recording.name === name)?.meta.source).toBe("live");
    }
  });

  for (const recording of recordings) {
    describe(recording.name, () => {
      it("holds no secret shape, home path, user name or email", () => {
        expect(scanForSecrets(recording.streamText, needles)).toEqual([]);
        expect(scanForSecrets(recording.metaText, needles)).toEqual([]);
      });

      it("has no redacted decision field", () => {
        expect(decisionFieldProblems(recording.lines)).toEqual([]);
      });

      it("keeps usage numbers equal to the checksum taken at capture", () => {
        expect(usageChecksum(stdoutOf(recording.lines))).toBe(recording.meta.usage_checksum);
      });

      it("keeps no hash of the names in system/init lists", () => {
        for (const data of stdoutOf(recording.lines)) {
          if (!isRecord(data) || data.type !== "system" || data.subtype !== "init") continue;
          for (const field of [
            "slash_commands",
            "terminal_slash_commands",
            "agents",
            "skills",
            "plugins",
          ]) {
            expect(JSON.stringify(data[field] ?? null)).not.toContain("sha256:");
          }
        }
      });

      it("holds only normalised ids", () => {
        expect(recording.streamText).not.toMatch(UUID);
        expect(recording.streamText).not.toMatch(RAW_ID);
      });

      it("uses the 0017 envelope and stays small", () => {
        for (const line of recording.lines) {
          expect(["stdout", "stderr", "hook", "exit"]).toContain(line.ch);
          expect(Number.isInteger(line.t) && line.t >= 0).toBe(true);
        }
        expect(recording.lines.filter((line) => line.ch === "exit").length).toBeGreaterThan(0);
        expect(recording.streamText.length).toBeLessThan(200_000);
      });

      if (recording.meta.source === "live") {
        it("records version, flags, date, prompt size and hash", () => {
          const { meta } = recording;
          expect(meta.claude_code_version).toMatch(/^\d+\.\d+\.\d+$/);
          expect(meta.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(meta.prompt_bytes).toBeGreaterThan(0);
          expect(meta.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
          expect(meta.flags).toContain("--include-partial-messages");
          expect(meta.flags).toContain("--include-hook-events");
          expect(meta.flags).toContain("--json-schema");
        });
      }
    });
  }
});

describe("derived recordings", () => {
  it("match what derive.ts produces from the committed live recordings", () => {
    for (const derived of deriveAll()) {
      const committed = recordings.find((recording) => recording.name === derived.name);
      expect(committed?.meta).toEqual(derived.meta);
      expect(committed?.lines).toEqual(derived.lines);
    }
  });

  it("web-calls: the result carries the live web counters, lists the refused fetch and keeps no subagent leftovers (DIPO-164 review)", () => {
    const recording = recordings.find((candidate) => candidate.name === "web-calls");
    const stdout = stdoutOf(recording?.lines ?? []).filter(isRecord);
    const calls = stdout.flatMap((data) => {
      const content = isRecord(data.message) ? data.message.content : undefined;
      return data.type === "assistant" && Array.isArray(content)
        ? content.filter(
            (block) =>
              isRecord(block) &&
              block.type === "tool_use" &&
              (block.name === "WebSearch" || block.name === "WebFetch"),
          )
        : [];
    }) as { id: string; name: string }[];
    const searches = calls.filter((call) => call.name === "WebSearch").length;
    const fetches = calls.filter((call) => call.name === "WebFetch").length;
    expect([searches, fetches]).toEqual([1, 2]);
    const results = stdout.filter((data) => data.type === "result");
    expect(results).toHaveLength(1);
    const result = results[0] as Record<string, any>;
    // The live `web` capture (Claude Code 2.1.302) counts no call in server_tool_use and only the
    // search in modelUsage; the derived recording carries the same numbers.
    const live = stdoutOf(recordings.find((candidate) => candidate.name === "web")?.lines ?? [])
      .filter(isRecord)
      .find((data) => data.type === "result") as Record<string, any> | undefined;
    expect(live?.usage.server_tool_use).toEqual({ web_search_requests: 0, web_fetch_requests: 0 });
    expect(result.usage.server_tool_use).toEqual(live?.usage.server_tool_use);
    const liveSearches = Object.values(live?.modelUsage ?? {}).map(
      (entry: any) => entry.webSearchRequests,
    );
    expect(liveSearches).toEqual([searches]);
    for (const entry of Object.values(result.modelUsage as Record<string, any>)) {
      expect(entry.webSearchRequests).toBe(searches);
    }
    expect(
      result.permission_denials.map((denial: Record<string, unknown>) => [
        denial.tool_name,
        denial.tool_use_id,
      ]),
    ).toEqual([["WebFetch", calls[2]?.id]]);
    expect(result.subagent_stats).toBeUndefined();
    // Every leftover kept on purpose is cited.
    expect(recording?.meta.cites?.some((cite) => cite.includes("background subagent"))).toBe(true);
  });
});
