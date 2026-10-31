// Fixture: placed in workers/claude-cli/ (0004, DIPO-395), which is a layer of its own above
// workers/: box/ is below it, so its value import passes; worktree/ is above it, so its import is
// refused.
import { box } from "../../box/box";
import { worktree } from "../../worktree/worktree";

export const used: unknown[] = [box, worktree];
