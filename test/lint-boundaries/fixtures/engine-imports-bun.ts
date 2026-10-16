// Fixture: engine code reaches Bun-specific APIs only through engine/src/platform (0004).
import { file } from "bun";

export const leaked = file;
