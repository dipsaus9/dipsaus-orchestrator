// Fixture: placed in commands/ (0004, DIPO-395). views/ is in the same layer, so its value import
// passes; run/ and create/ are higher layers, so only types come from them.
import type { Run } from "../run/run";
import { view } from "../views/view";

export type { Engine } from "../create/create-engine";

export const used: unknown[] = [view];
export type Used = Run;
