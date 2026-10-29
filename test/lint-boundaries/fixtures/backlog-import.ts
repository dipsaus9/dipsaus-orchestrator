// Fixture: the engine reaches stories only through the StoryStore (0010), so every form of an
// import of the Backlog.md implementation is reported. The paths resolve from engine/src/<dir>/.
import { runBacklog } from "../backlog/runner";
import type { BacklogCli } from "../backlog/runner";

export { backlogStoryStore } from "../backlog/store";
export * from "../backlog";
export type PlainModule = typeof import("../backlog/plain");
export const lazy = () => import("../backlog/list");
export const required: unknown = require("../backlog/slug");
export const leaked: [typeof runBacklog, BacklogCli | undefined] = [runBacklog, undefined];
