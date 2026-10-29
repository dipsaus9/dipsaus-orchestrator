// Fixture: placed in the engine's domain or composition layer (0004), it imports values from
// the layers below it and its own.
import { systemClock } from "../platform/clock";
import { RunControl } from "../run/control";

export const used: unknown[] = [systemClock, RunControl];
