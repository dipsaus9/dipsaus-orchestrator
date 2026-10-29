// The stored run profile (0007 section 4, 0013 section 4): one current profile per office with the
// previous one it replaced, and a `scans` row per detection run. Every writer here runs inside the
// caller's transaction; readers are plain office reads.

import type { OfficeHandle } from "../db/office";

import { type CapabilityMark, effectiveProfile, type ScanMarks } from "./confirm";
import type { Candidate } from "./detect/types";
import {
  CAPABILITIES,
  type CapabilityName,
  type CommandSpec,
  type ConformanceLevel,
  type Confidence,
  type Deviation,
  type Resolution,
  type RunProfile,
  type Source,
  type Toolchain,
} from "./detect";
import { readMarks } from "./marks";

/** What starts a scan (0007 section 4). */
export type ScanTrigger = "start" | "run" | "test" | "rescan";

export interface StoredProfile {
  readonly profileId: number;
  readonly scannedAt: number;
  /** The `_base` commit the profile was scanned at. */
  readonly commit: string;
  readonly previousProfileId: number | null;
  /**
   * The effective profile: what code detected with the maintainer's confirmations laid over it
   * (DIPO-310, `confirm.ts`). Pending proposals are never in it, so nothing runs them.
   */
  readonly profile: RunProfile;
  /** What code detected alone, as stored. */
  readonly code: RunProfile;
  /** Per capability: code's resolution, the confirmation in force, stale, the pending proposal. */
  readonly marks: Readonly<Record<CapabilityName, CapabilityMark>>;
  /** The maintainer marked the product as having nothing to start. */
  readonly nothingToStart: boolean;
  /** Why the test command refuses (0013 section 2); null when it may run. */
  readonly testRefusal: string | null;
}

interface ProfileRow {
  profile_id: number;
  scanned_at: number;
  commit_sha: string;
  fingerprint: string;
  toolchain: string;
  conformance: string;
  deviations: string;
  run_refusal: string | null;
  previous_profile_id: number | null;
}

interface CapabilityRow {
  capability: string;
  status: "resolved" | "conflict" | "unresolved";
  commands: string | null;
  working_dir: string | null;
  source: string | null;
  confidence: string | null;
  evidence: string | null;
  candidates: string | null;
}

const json = (value: unknown) => JSON.stringify(value);
const bit = (value: boolean) => (value ? 1 : 0);

function capabilityOf(row: CapabilityRow | undefined): Resolution<CommandSpec> {
  if (row === undefined || row.status === "unresolved") return { status: "unresolved" };
  if (row.status === "conflict") {
    return {
      status: "conflict",
      candidates: JSON.parse(row.candidates ?? "[]") as Candidate<CommandSpec>[],
    };
  }
  return {
    status: "resolved",
    value: {
      commands: JSON.parse(row.commands ?? "[]") as string[][],
      cwd: row.working_dir ?? ".",
    },
    source: row.source as Source,
    confidence: row.confidence as Confidence,
    evidence: row.evidence ?? "",
  };
}

function profileOf(
  office: OfficeHandle,
  row: ProfileRow,
  marks: ScanMarks = readMarks(office),
): StoredProfile {
  const code = codeProfileOf(office, row);
  const effective = effectiveProfile(code, marks);
  return {
    profileId: row.profile_id,
    scannedAt: row.scanned_at,
    commit: row.commit_sha,
    previousProfileId: row.previous_profile_id,
    profile: effective.profile,
    code,
    marks: effective.marks,
    nothingToStart: effective.nothingToStart,
    testRefusal: effective.testRefusal,
  };
}

function codeProfileOf(office: OfficeHandle, row: ProfileRow): RunProfile {
  const params = { profile: row.profile_id };
  const capabilityRows = office.all<CapabilityRow>(
    `select capability, status, commands, working_dir, source, confidence, evidence, candidates
       from run_capabilities where office_id = $office_id and profile_id = $profile`,
    params,
  );
  const byName = new Map(capabilityRows.map((c) => [c.capability, c]));
  const capabilities = Object.fromEntries(
    CAPABILITIES.map((name) => [name, capabilityOf(byName.get(name))]),
  ) as Record<CapabilityName, Resolution<CommandSpec>>;
  const extraScripts = office.all<{ name: string; command: string }>(
    `select name, command from run_extra_scripts
       where office_id = $office_id and profile_id = $profile order by rowid`,
    params,
  );
  const envFiles = office
    .all<{ path: string; example: string | null; present: number; ignored: number }>(
      `select path, example, present, ignored from run_env_files
         where office_id = $office_id and profile_id = $profile order by rowid`,
      params,
    )
    .map((f) => ({
      example: f.example,
      path: f.path,
      present: f.present === 1,
      ignored: f.ignored === 1,
    }));

  return {
    fingerprint: row.fingerprint,
    toolchain: JSON.parse(row.toolchain) as Toolchain,
    capabilities,
    extraScripts,
    envFiles,
    conformance: {
      level: row.conformance as ConformanceLevel,
      deviations: JSON.parse(row.deviations) as Deviation[],
    },
    runRefusal: row.run_refusal,
  };
}

const PROFILE_COLUMNS = `profile_id, scanned_at, commit_sha, fingerprint, toolchain, conformance,
  deviations, run_refusal, previous_profile_id`;

/**
 * The office's current run profile, or null before its first scan. `marks` replaces the stored
 * marks, for a confirm command that shows the profile before and after its write.
 */
export function currentProfile(office: OfficeHandle, marks?: ScanMarks): StoredProfile | null {
  const row = office.get<ProfileRow>(
    `select ${PROFILE_COLUMNS} from run_profiles where office_id = $office_id and current = 1`,
  );
  return row === null ? null : profileOf(office, row, marks);
}

/** A stored profile by id, or null. */
export function storedProfile(office: OfficeHandle, profileId: number): StoredProfile | null {
  const row = office.get<ProfileRow>(
    `select ${PROFILE_COLUMNS} from run_profiles
       where office_id = $office_id and profile_id = $profile`,
    { profile: profileId },
  );
  return row === null ? null : profileOf(office, row);
}

/**
 * The commands of the current profile's verify, resolved by code or confirmed by the maintainer
 * (DIPO-173, DIPO-310); null when it is neither.
 */
export function verifyCommands(office: OfficeHandle): CommandSpec | null {
  const verify = currentProfile(office)?.profile.capabilities.verify;
  return verify?.status === "resolved" ? verify.value : null;
}

/** The current profile's fingerprint, without reading the rest; null before the first scan. */
export function currentFingerprint(office: OfficeHandle): string | null {
  return (
    office.get<{ fingerprint: string }>(
      "select fingerprint from run_profiles where office_id = $office_id and current = 1",
    )?.fingerprint ?? null
  );
}

function nextId(office: OfficeHandle, table: "run_profiles" | "scans", column: string): number {
  const row = office.get<{ last: number | null }>(
    `select max(${column}) as last from ${table} where office_id = $office_id`,
  );
  return (row?.last ?? 0) + 1;
}

/**
 * Stores `profile` as the office's current profile, the one it replaces as its previous. Returns
 * the new profile id. Runs inside the caller's transaction.
 */
export function insertProfile(
  office: OfficeHandle,
  profile: RunProfile,
  at: { readonly scannedAt: number; readonly commit: string },
): number {
  const previous = office.get<{ profile_id: number }>(
    "select profile_id from run_profiles where office_id = $office_id and current = 1",
  );
  const profileId = nextId(office, "run_profiles", "profile_id");
  office.run("update run_profiles set current = 0 where office_id = $office_id and current = 1");
  office.run(
    `insert into run_profiles (office_id, ${PROFILE_COLUMNS}, current)
     values ($office_id, $profile, $at, $commit, $fingerprint, $toolchain, $conformance,
             $deviations, $refusal, $previous, 1)`,
    {
      profile: profileId,
      at: at.scannedAt,
      commit: at.commit,
      fingerprint: profile.fingerprint,
      toolchain: json(profile.toolchain),
      conformance: profile.conformance.level,
      deviations: json(profile.conformance.deviations),
      refusal: profile.runRefusal,
      previous: previous?.profile_id ?? null,
    },
  );
  for (const name of CAPABILITIES) {
    const capability = profile.capabilities[name];
    office.run(
      `insert into run_capabilities (office_id, profile_id, capability, status, commands,
         working_dir, source, confidence, evidence, candidates)
       values ($office_id, $profile, $name, $status, $commands, $cwd, $source, $confidence,
               $evidence, $candidates)`,
      {
        profile: profileId,
        name,
        status: capability.status,
        commands: capability.status === "resolved" ? json(capability.value.commands) : null,
        cwd: capability.status === "resolved" ? capability.value.cwd : null,
        source: capability.status === "resolved" ? capability.source : null,
        confidence: capability.status === "resolved" ? capability.confidence : null,
        evidence: capability.status === "resolved" ? capability.evidence : null,
        candidates: capability.status === "conflict" ? json(capability.candidates) : null,
      },
    );
  }
  for (const file of profile.envFiles) {
    office.run(
      `insert into run_env_files (office_id, profile_id, path, example, present, ignored)
       values ($office_id, $profile, $path, $example, $present, $ignored)`,
      {
        profile: profileId,
        path: file.path,
        example: file.example,
        present: bit(file.present),
        ignored: bit(file.ignored),
      },
    );
  }

  for (const script of profile.extraScripts) {
    office.run(
      `insert into run_extra_scripts (office_id, profile_id, name, command)
       values ($office_id, $profile, $name, $command)`,
      { profile: profileId, name: script.name, command: script.command },
    );
  }
  return profileId;
}

export interface ScanRecord {
  readonly trigger: ScanTrigger;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly fingerprint: string | null;
  readonly commit: string | null;
  readonly result: "stored" | "unchanged" | "failed";
  readonly profileId: number | null;
  readonly diff: readonly string[] | null;
  readonly error: string | null;
}

/** Records one scan; returns its id. Runs inside the caller's transaction. */
export function insertScan(office: OfficeHandle, scan: ScanRecord): number {
  const scanId = nextId(office, "scans", "scan_id");
  office.run(
    `insert into scans (office_id, scan_id, trigger, started_at, finished_at, fingerprint,
       commit_sha, result, profile_id, diff, error)
     values ($office_id, $scan, $trigger, $started, $finished, $fingerprint, $commit, $result,
             $profile, $diff, $error)`,
    {
      scan: scanId,
      trigger: scan.trigger,
      started: scan.startedAt,
      finished: scan.finishedAt,
      fingerprint: scan.fingerprint,
      commit: scan.commit,
      result: scan.result,
      profile: scan.profileId,
      diff: scan.diff === null ? null : json(scan.diff),
      error: scan.error,
    },
  );
  return scanId;
}

/** The refusal of an office that was never scanned. */
export const NO_PROFILE_REFUSAL =
  "Verify is unresolved: the office has no run profile yet. Run `dipo office rescan`.";

/**
 * Why `run` must refuse the office (0013 section 2 and its 2026-10-11 amendment): the refusal of
 * the current effective profile, which names the script to add and the fallback command
 * (`dipo office infer`, DIPO-310), or null when verify resolved or is confirmed (stale or not). An
 * office that was never scanned is refused too. Reads the database only; no model is asked.
 */
export function verifyResolved(office: OfficeHandle): string | null {
  const current = currentProfile(office);
  return current === null ? NO_PROFILE_REFUSAL : current.profile.runRefusal;
}

/**
 * Why the test command (`dipo test`, 0013 section 2 and its amendment of 2026-10-22) must refuse
 * the office: install unresolved, or `dev` unresolved while the product is not marked as having
 * nothing to start; the refusal names the fallback command. Null when it may run. A seam for the
 * test command's story (DIPO-309), which is not on main yet.
 */
export function testCommandRefusal(office: OfficeHandle): string | null {
  const current = currentProfile(office);
  return current === null
    ? "The office has no run profile yet. Run `dipo office rescan`."
    : current.testRefusal;
}
