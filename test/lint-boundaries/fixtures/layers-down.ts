// Fixture: placed in a layer of the engine at or above run/ (0004), it imports values from the
// layers below it and its own.
import { systemClock } from "../platform/clock";
import { RunControl } from "../run/control";

export const used: unknown[] = [systemClock, RunControl];
