// Fixture: the worker host has no merge gate or other run-state code, also not through the
// run-state barrel (0006 decision 8).
import { openMergeGate } from "../run-state";

export const leaked = openMergeGate;
