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
});
