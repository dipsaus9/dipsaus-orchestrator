// Role files for run tests (DIPO-477): a story runs as the role file its role label names, so a
// test base reads the seeded developer role and the stories carry its label.

import { DEVELOPER_SEED } from "../../src/prompts/templates";
import type { Role } from "../../src/roles/parse";

/** The developer role file office init seeds (0017): the bundled instructions, no model or effort. */
export const DEVELOPER_FILE: Role = {
  name: "developer",
  purpose: "Implements one story in this repository.",
  instructions: DEVELOPER_SEED.trim(),
};

/** The role label of the seeded developer role. */
export const DEVELOPER_LABEL = "role:developer";
