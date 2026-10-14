// Fixture: tui may import contract, client and client/node (0009 section 2).
import { packageName } from "@dipsaus-orchestrator/client";
import { systemClock } from "@dipsaus-orchestrator/client/node";
import { CONTRACT_VERSION } from "@dipsaus-orchestrator/contract";

export const allowed = [packageName, systemClock, CONTRACT_VERSION];
