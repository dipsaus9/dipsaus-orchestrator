// Fixture: placed in workers/ (0004, DIPO-395), a base layer: box/ and worktree/ are both above
// it, so both value imports are refused.
import { box } from "../box/box";
import { worktree } from "../worktree/worktree";

export const used: unknown[] = [box, worktree];
