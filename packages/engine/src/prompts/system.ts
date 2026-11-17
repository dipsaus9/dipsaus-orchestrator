// The system file (0014): the L1 worker contract for the run kind, for a story run its role
// kind's section (DIPO-504), then the L2 role's instructions. It is byte-identical for every story
// with the same kind, role kind, role text and engine version: no story data goes in, so it holds
// no id, date, path or count, and its prefix caches across runs.

import type { RoleKind } from "@dipsaus-orchestrator/contract";

import {
  CONTRACT_TEMPLATES,
  KIND_SECTIONS,
  normaliseNewlines,
  type ContractKind,
} from "./templates";

/**
 * The rendered L1+L2 file for `kind` and the role's instructions `role`, ending in one newline: a
 * story run's role file (DIPO-477), or an engine role of `ROLE_TEMPLATES`. A story run (`implement-box`)
 * puts the section of its role's kind `roleKind` between the two; no kind is a code role.
 */
export function renderSystemFile(
  kind: ContractKind,
  role: string,
  roleKind: RoleKind | null = null,
): string {
  const section = kind === "implement-box" ? KIND_SECTIONS[roleKind ?? "code"] : "";
  const parts = [CONTRACT_TEMPLATES[kind], section, role]
    .map((part) => normaliseNewlines(part).trim())
    .filter((part) => part !== "");
  return `${parts.join("\n\n")}\n`;
}
