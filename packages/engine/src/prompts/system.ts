// The system file (0014): the L1 worker contract for the run kind, then the L2
// role's instructions. It is byte-identical for every story with the same kind, role text and
// engine version: no story data goes in, so it holds no id, date, path or count, and its prefix
// caches across runs.

import { CONTRACT_TEMPLATES, normaliseNewlines, type ContractKind } from "./templates";

/**
 * The rendered L1+L2 file for `kind` and the role's instructions `role`, ending in one newline: a
 * story run's role file (DIPO-477), or an engine role of `ROLE_TEMPLATES`.
 */
export function renderSystemFile(kind: ContractKind, role: string): string {
  const parts = [CONTRACT_TEMPLATES[kind], role].map((part) => normaliseNewlines(part).trim());
  return `${parts.join("\n\n")}\n`;
}
