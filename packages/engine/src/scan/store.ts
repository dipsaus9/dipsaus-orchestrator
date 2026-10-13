// The stored run profile (0007 section 4, 0013 section 4): one current profile per office with the
// previous one it replaced, and a `scans` row per detection run. Every writer here runs inside the
// caller's transaction; readers are plain office reads.

import type { OfficeHandle } from "../db/office";

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

/** What starts a scan (0007 section 4). */
export type ScanTrigger = "start" | "run" | "test" | "rescan";

export interface StoredProfile {
  readonly profileId: number;
  readonly scannedAt: number;
  /** The `_base` commit the profile was scanned at. */
  readonly commit: string;
  readonly previousProfileId: number | null;
  readonly profile: RunProfile;
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

function profileOf(office: OfficeHandle, row: ProfileRow): StoredProfile {
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
  const devPorts = office
    .all<{
      dir: string;
      port: number;
      source: string;
      confidence: string;
      evidence: string;
      fixed_in_code: number;
      honours_port: number;
    }>(
      `select dir, port, source, confidence, evidence, fixed_in_code, honours_port from run_ports
         where office_id = $office_id and profile_id = $profile order by rowid`,
      params,
    )
    .map((p) => ({
      port: p.port,
      dir: p.dir,
      source: p.source as Source,
      confidence: p.confidence as Confidence,
      evidence: p.evidence,
      fixedInCode: p.fixed_in_code === 1,
      honoursPort: p.honours_port === 1,
    }));
  return {
    profileId: row.profile_id,
    scannedAt: row.scanned_at,
    commit: row.commit_sha,
    previousProfileId: row.previous_profile_id,
    profile: {
      fingerprint: row.fingerprint,
      toolchain: JSON.parse(row.toolchain) as Toolchain,
      capabilities,
      extraScripts,
      envFiles,
      devPorts,
      conformance: {
        level: row.conformance as ConformanceLevel,
        deviations: JSON.parse(row.deviations) as Deviation[],
      },
      runRefusal: row.run_refusal,
    },
  };
}

const PROFILE_COLUMNS = `profile_id, scanned_at, commit_sha, fingerprint, toolchain, conformance,
  deviations, run_refusal, previous_profile_id`;

/** The office's current run profile, or null before its first scan. */
export function currentProfile(office: OfficeHandle): StoredProfile | null {
  const row = office.get<ProfileRow>(
    `select ${PROFILE_COLUMNS} from run_profiles where office_id = $office_id and current = 1`,
  );
  return row === null ? null : profileOf(office, row);
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
  for (const port of profile.devPorts) {
    office.run(
      `insert into run_ports (office_id, profile_id, dir, port, source, confidence, evidence,
         fixed_in_code, honours_port)
       values ($office_id, $profile, $dir, $port, $source, $confidence, $evidence, $fixed, $honours)`,
      {
        profile: profileId,
        dir: port.dir,
        port: port.port,
        source: port.source,
        confidence: port.confidence,
        evidence: port.evidence,
        fixed: bit(port.fixedInCode),
        honours: bit(port.honoursPort),
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

/**
 * Why `run` must refuse the office (0013 section 2 and its 2026-10-11 amendment): the refusal of
 * the current profile, which names the script to add, or null when verify resolved. An office
 * that was never scanned is refused too. Reads the database only; no model is asked.
 */
export function verifyResolved(office: OfficeHandle): string | null {
  const row = office.get<{ run_refusal: string | null }>(
    "select run_refusal from run_profiles where office_id = $office_id and current = 1",
  );
  if (row === null) {
    return "Verify is unresolved: the office has no run profile yet. Run `dipo office rescan`.";
  }
  return row.run_refusal;
}
