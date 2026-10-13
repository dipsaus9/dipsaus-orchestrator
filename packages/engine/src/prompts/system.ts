// The system file (0014 sections 1 and 5): the L1 worker contract for the run kind, then the L2
// role. It is byte-identical for every story with the same kind, role and engine version: no
// story data goes in, so it holds no id, date, path or count, and its prefix caches across runs.

import {
  CONTRACT_TEMPLATES,
  normaliseNewlines,
  ROLE_TEMPLATES,
  type BuiltInRole,
  type ContractKind,
} from "./templates";

/** The rendered L1+L2 file for `kind` and `role`, ending in one newline. */
export function renderSystemFile(kind: ContractKind, role: BuiltInRole): string {
  const parts = [CONTRACT_TEMPLATES[kind], ROLE_TEMPLATES[role]].map((part) =>
    normaliseNewlines(part).trim(),
  );
  return `${parts.join("\n\n")}\n`;
}
