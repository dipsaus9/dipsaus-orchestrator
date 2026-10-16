// Fixture: the engine entry re-exports the Claude CLI adapter, so engine code never imports it.
import { packageName } from "../index";
import * as entry from "..";
import * as engine from "@dipsaus-orchestrator/engine";

export const used: unknown[] = [packageName, entry, engine];
