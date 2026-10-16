// Fixture: one half of a runtime import cycle; `import/no-cycle` reports it (DIPO-113).
import { b } from "./cycle-b";

export const a = (): unknown => b;
