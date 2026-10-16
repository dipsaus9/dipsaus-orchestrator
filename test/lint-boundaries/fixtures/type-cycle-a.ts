// Fixture: a cycle through `import type` only; erased at runtime, so `ignoreTypes` allows it.
import type { B } from "./type-cycle-b";

export interface A {
  readonly b: B | null;
}
