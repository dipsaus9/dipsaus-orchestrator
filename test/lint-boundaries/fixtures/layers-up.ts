// Fixture: placed in platform/, the engine's lowest layer (0004, DIPO-318), its value imports from
// run/ and create/, higher layers, are refused; a type-only import crosses, as do imports from its
// own layer.
import { RunControl } from "../run/control";
import type { StoredRun } from "../records/run-records";
import { systemClock } from "../platform/clock";

export const lazy = () => import("../create/create-engine");
export const used: unknown[] = [RunControl, systemClock];
export type Used = StoredRun;
