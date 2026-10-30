// Fixture: what engine/src/questions may import: the worker contract, views and run signals.
import { activeSignals } from "../records/signals";
import type { HostOp } from "../workers/types";

export const allowed: [unknown, HostOp | null] = [activeSignals, null];
