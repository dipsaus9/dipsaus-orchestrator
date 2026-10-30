// Fixture: the worker host has no gate logic, also not the stored gate decisions (0006 decision 8).
import { storeGateDecision } from "../gate-decisions";
import { findPassingDecision } from "../gate-decisions/decisions";

export const leaked = [storeGateDecision, findPassingDecision];
