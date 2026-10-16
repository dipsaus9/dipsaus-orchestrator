// Fixture: the other half of the runtime import cycle with cycle-a.ts.
import { a } from "./cycle-a";

export const b = (): unknown => a;
