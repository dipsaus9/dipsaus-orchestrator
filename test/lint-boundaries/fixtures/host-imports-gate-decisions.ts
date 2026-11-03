// Fixture: the worker host has no gate logic, also not the stored gate decisions (0005).
import { storeGateDecision } from "../gate-decisions";
import { findPassingDecision } from "../gate-decisions/decisions";

export const leaked = [storeGateDecision, findPassingDecision];
