// Fixture: the contract imports nothing but zod and its own files (0004, 0005): Node and Bun
// modules, another npm module and another package are refused, also as a dynamic import and by
// `require`. Zod and a relative path inside the contract pass.
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { z } from "zod";
import { packageName } from "@dipsaus-orchestrator/engine";

import { OfficeId } from "./ids";

export const lazy = () => import("node:path");
export const required: unknown = require("bun");
export const leaked: unknown[] = [readFileSync, YAML, z, packageName, OfficeId];
