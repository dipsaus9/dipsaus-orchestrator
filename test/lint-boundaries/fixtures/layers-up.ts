// Fixture: placed in a base-layer directory of the engine (0004, DIPO-318), its value imports from
// the domain and the composition layer are refused; a type-only import crosses, as do imports
// from its own layer.
import { RunControl } from "../run/control";
import type { StoredRun } from "../records/run-records";
import { systemClock } from "../platform/clock";

export const lazy = () => import("../create/create-engine");
export const used: unknown[] = [RunControl, systemClock];
export type Used = StoredRun;
