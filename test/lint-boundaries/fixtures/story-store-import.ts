// Fixture: engine code reaches stories through the StoryStore interface (0010), and a sibling
// module that is merely named `backlog` is not the Backlog.md implementation. The paths resolve
// from engine/src/<dir>/.
import { StoryParseError } from "../story-store";
import type { StoryStore } from "../story-store/store";
import { BacklogMerges } from "./backlog";

export const allowed: [typeof StoryParseError, StoryStore | undefined, typeof BacklogMerges] = [
  StoryParseError,
  undefined,
  BacklogMerges,
];
