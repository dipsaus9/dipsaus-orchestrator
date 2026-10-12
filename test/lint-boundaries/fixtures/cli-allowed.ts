// Fixture: allowed imports. cli may import daemon, tui and client; tui may import client and contract.
import { packageName as client } from "@dipsaus-orchestrator/client";
import { packageName as contract } from "@dipsaus-orchestrator/contract";
import { packageName as daemon } from "@dipsaus-orchestrator/daemon";

export const allowed = [client, contract, daemon];
