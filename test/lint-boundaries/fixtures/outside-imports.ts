// Fixture: a file outside `packages/` is no package (0004): it never imports a package's `src` by
// package specifier, and only the root `test/`, `tools/` and `scripts/` read package files by
// relative path. The relative paths resolve from a top-level folder of the repository.
import { packageName } from "@dipsaus-orchestrator/engine/src/index";
import { createEngine } from "../packages/engine/src/create/create-engine";

export const lazy = () => import("../packages/client/src/index");
export const used: unknown[] = [packageName, createEngine];
