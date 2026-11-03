// Fixture: the worker host does not record itself; the engine does (0005).
import { recordWorkerHost } from "../records/worker-hosts";

export const leaked = recordWorkerHost;
