// Fixture: the main client entry is runtime-free, so it never imports a `node:` module (0004).
import { readFileSync } from "node:fs";

export const read = readFileSync;
