// The stored confirmations, pending proposals and the nothing-to-start mark of an office (migration
// 52, DIPO-310). Writers run inside the caller's transaction; readers are plain office reads.

import type { OfficeHandle } from "../db/office";

import type { Confirmation, Proposal, ScanMarks } from "./confirm";
import type { CapabilityName, CommandSpec, Confidence } from "./detect";

interface ConfirmationRow {
  capability: string;
  source: "inferred" | "maintainer";
  commands: string;
  working_dir: string;
  evidence: string;
  fingerprint: string;
  confirmed_at: number;
}

interface ProposalRow {
  capability: string;
  commands: string;
  working_dir: string;
  model_confidence: string;
  evidence: string;
  fingerprint: string;
  run_id: string | null;
  proposed_at: number;
}

const specOf = (commands: string, cwd: string): CommandSpec => ({
  commands: JSON.parse(commands) as string[][],
  cwd,
});

/** Every mark of the office. */
export function readMarks(office: OfficeHandle): ScanMarks {
  const confirmations = office
    .all<ConfirmationRow>(
      `select capability, source, commands, working_dir, evidence, fingerprint, confirmed_at
         from capability_confirmations where office_id = $office_id order by capability`,
    )
    .map((row): Confirmation => ({
      capability: row.capability as CapabilityName,
      source: row.source,
      spec: specOf(row.commands, row.working_dir),
      evidence: row.evidence,
      fingerprint: row.fingerprint,
      confirmedAt: row.confirmed_at,
    }));
  const proposals = office
    .all<ProposalRow>(
      `select capability, commands, working_dir, model_confidence, evidence, fingerprint, run_id,
              proposed_at
         from capability_proposals where office_id = $office_id order by capability`,
    )
    .map((row): Proposal => ({
      capability: row.capability as CapabilityName,
      spec: specOf(row.commands, row.working_dir),
      modelConfidence: row.model_confidence as Confidence,
      evidence: JSON.parse(row.evidence) as string[],
      fingerprint: row.fingerprint,
      runId: row.run_id,
      proposedAt: row.proposed_at,
    }));
  const mark = office.get<{ nothing_to_start: number }>(
    "select nothing_to_start from office_scan_marks where office_id = $office_id",
  );
  return { confirmations, proposals, nothingToStart: mark?.nothing_to_start === 1 };
}

/** Stores a confirmation, replacing the capability's earlier one. */
export function writeConfirmation(office: OfficeHandle, confirmation: Confirmation): void {
  office.run(
    `insert into capability_confirmations (office_id, capability, source, commands, working_dir,
       evidence, fingerprint, confirmed_at)
     values ($office_id, $capability, $source, $commands, $cwd, $evidence, $fingerprint, $at)
     on conflict (office_id, capability) do update set source = excluded.source,
       commands = excluded.commands, working_dir = excluded.working_dir,
       evidence = excluded.evidence, fingerprint = excluded.fingerprint,
       confirmed_at = excluded.confirmed_at`,
    {
      capability: confirmation.capability,
      source: confirmation.source,
      commands: JSON.stringify(confirmation.spec.commands),
      cwd: confirmation.spec.cwd,
      evidence: confirmation.evidence,
      fingerprint: confirmation.fingerprint,
      at: confirmation.confirmedAt,
    },
  );
}

/** Removes the capability's confirmation; true when there was one. */
export function deleteConfirmation(office: OfficeHandle, capability: CapabilityName): boolean {
  return (
    office.run(
      "delete from capability_confirmations where office_id = $office_id and capability = $capability",
      { capability },
    ).changes > 0
  );
}

/** Stores a pending proposal, replacing the capability's earlier one. */
export function writeProposal(office: OfficeHandle, proposal: Proposal): void {
  office.run(
    `insert into capability_proposals (office_id, capability, commands, working_dir, confidence,
       model_confidence, evidence, fingerprint, run_id, proposed_at)
     values ($office_id, $capability, $commands, $cwd, 'low', $model, $evidence, $fingerprint,
             $run, $at)
     on conflict (office_id, capability) do update set commands = excluded.commands,
       working_dir = excluded.working_dir, model_confidence = excluded.model_confidence,
       evidence = excluded.evidence, fingerprint = excluded.fingerprint, run_id = excluded.run_id,
       proposed_at = excluded.proposed_at`,
    {
      capability: proposal.capability,
      commands: JSON.stringify(proposal.spec.commands),
      cwd: proposal.spec.cwd,
      model: proposal.modelConfidence,
      evidence: JSON.stringify(proposal.evidence),
      fingerprint: proposal.fingerprint,
      run: proposal.runId,
      at: proposal.proposedAt,
    },
  );
}

/** Removes the capability's pending proposal; true when there was one. */
export function deleteProposal(office: OfficeHandle, capability: CapabilityName): boolean {
  return (
    office.run(
      "delete from capability_proposals where office_id = $office_id and capability = $capability",
      { capability },
    ).changes > 0
  );
}

/** Sets or clears the nothing-to-start mark. */
export function writeNothingToStart(office: OfficeHandle, value: boolean, at: number): void {
  office.run(
    `insert into office_scan_marks (office_id, nothing_to_start, marked_at)
     values ($office_id, $value, $at)
     on conflict (office_id) do update set nothing_to_start = excluded.nothing_to_start,
       marked_at = excluded.marked_at`,
    { value: value ? 1 : 0, at },
  );
}
