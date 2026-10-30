// Fixture: the worker host does not read run records, also not through the records barrel
// (0006 decision 8).
import { findRun } from "../records";

export const leaked = findRun;
