// Fixture: the main client entry is runtime-free, so it never imports `bun` (0004).
import { connect } from "bun";

export const open = connect;
