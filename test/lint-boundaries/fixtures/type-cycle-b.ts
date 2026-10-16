// Fixture: the other half of the type-only cycle with type-cycle-a.ts.
import type { A } from "./type-cycle-a";

export interface B {
  readonly a: A | null;
}
