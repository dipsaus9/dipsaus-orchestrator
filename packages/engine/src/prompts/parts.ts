// Prompt part measurements (0014 section 2 "Privacy", 0007 sections 4 and 8): per run and agent,
// the sha256, UTF-8 bytes and estimated tokens of each prompt part. No prompt text is stored.

import { createHash } from "node:crypto";

import type { Clock } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import type { Section } from "./contract";

/** Characters per token for the estimate; 0014 measures 3.5 to 4, and reports name it an estimate. */
export const CHARS_PER_TOKEN = 4;

/** The part name of the rendered L1+L2 system file. */
export const SYSTEM_PART = "system";
/** The part name of the whole L4 task message; its sections are `task.<section>`. */
export const TASK_PART = "task";

export interface PromptPart {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly estTokens: number;
}

/** The measurement of one part's text. */
export function measurePart(name: string, text: string): PromptPart {
  const bytes = new TextEncoder().encode(text);
  return {
    name,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    estTokens: Math.ceil(text.length / CHARS_PER_TOKEN),
  };
}

/** The parts of one prompt: the system file, the task message, and each task section. */
export function promptParts(
  systemFile: string,
  taskMessage: string,
  sections: readonly Section[],
): PromptPart[] {
  return [
    measurePart(SYSTEM_PART, systemFile),
    measurePart(TASK_PART, taskMessage),
    ...sections.map((section) => measurePart(`${TASK_PART}.${section.name}`, section.text)),
  ];
}

/** Stores the parts for `run` and `agent`, replacing an earlier measurement of the same part. */
export function recordPromptParts(
  office: OfficeHandle,
  run: string,
  agent: string,
  parts: readonly PromptPart[],
  clock: Clock,
): void {
  const at = clock.now();
  office.immediate(() => {
    for (const part of parts) {
      office.run(
        `insert into prompt_parts (office_id, run_id, agent_id, part, sha256, bytes, est_tokens, recorded_at)
         values ($office_id, $run, $agent, $part, $sha, $bytes, $tokens, $at)
         on conflict (office_id, run_id, agent_id, part) do update set
           sha256 = excluded.sha256, bytes = excluded.bytes, est_tokens = excluded.est_tokens,
           recorded_at = excluded.recorded_at`,
        {
          run,
          agent,
          part: part.name,
          sha: part.sha256,
          bytes: part.bytes,
          tokens: part.estTokens,
          at,
        },
      );
    }
  });
}

interface PromptPartRow {
  readonly part: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly est_tokens: number;
}

/** The stored parts of `run` and `agent`, sorted by name. */
export function promptPartsOf(office: OfficeHandle, run: string, agent: string): PromptPart[] {
  return office
    .all<PromptPartRow>(
      `select part, sha256, bytes, est_tokens from prompt_parts
       where office_id = $office_id and run_id = $run and agent_id = $agent order by part`,
      { run, agent },
    )
    .map((row) => ({
      name: row.part,
      sha256: row.sha256,
      bytes: row.bytes,
      estTokens: row.est_tokens,
    }));
}

/** The part names of stored prompt text (`prompt_texts`): the system file and the first message. */
export type PromptTextPart = "system" | "message";

export interface PromptText {
  readonly part: PromptTextPart;
  readonly text: string;
}

/**
 * Stores the prompt text a session started with for `run` and `agent` (DIPO-137), when the
 * configuration in force turns `privacy.storePrompts` on. With it off, or with no configuration,
 * nothing is stored. A handoff or first session stores `system` and `message`; a resume only its
 * `message`.
 */
export function recordPromptTexts(
  office: OfficeHandle,
  run: string,
  agent: string,
  texts: readonly PromptText[],
  config: { readonly privacy: { readonly storePrompts: boolean } } | undefined,
  clock: Clock,
): void {
  if (config === undefined || !config.privacy.storePrompts) return;
  const at = clock.now();
  office.immediate(() => {
    for (const { part, text } of texts) {
      office.run(
        `insert into prompt_texts (office_id, run_id, agent_id, part, text, recorded_at)
         values ($office_id, $run, $agent, $part, $text, $at)
         on conflict (office_id, run_id, agent_id, part) do update set
           text = excluded.text, recorded_at = excluded.recorded_at`,
        { run, agent, part, text, at },
      );
    }
  });
}

/** The stored prompt texts of `run` and `agent`, the system file first; empty when none. */
export function promptTextsOf(office: OfficeHandle, run: string, agent: string): PromptText[] {
  return office.all<PromptText>(
    `select part, text from prompt_texts
      where office_id = $office_id and run_id = $run and agent_id = $agent
      order by case part when 'system' then 0 else 1 end`,
    { run, agent },
  );
}
