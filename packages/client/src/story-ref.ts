// A story reference as the maintainer types it (0005): a story key, or a Backlog.md id in any case.
// Every command that names a story, in the CLI and the TUI, reads it here.

import { StoryId, StoryKey, type StoryRefValue } from "@dipsaus-orchestrator/contract";

/** `text` as a story key or an upper-cased story id; null for anything else. */
export function storyRef(text: string): StoryRefValue | null {
  const key = StoryKey.safeParse(text);
  if (key.success) return key.data;
  const id = StoryId.safeParse(text.toUpperCase());
  return id.success ? id.data : null;
}
