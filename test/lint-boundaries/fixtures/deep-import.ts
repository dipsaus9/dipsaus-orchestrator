// Fixture: no package may deep-import another package's src (0004).
import { packageName } from "@dipsaus-orchestrator/contract/src/index";

export const leaked = packageName;
