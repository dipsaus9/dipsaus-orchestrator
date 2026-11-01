// The view reads with this engine's own desk sources, reading parks through the Backlog.md store
// (0010), for the tests that register them.

import { viewsFeatureWith } from "../../src/overview/feature";
import { backlogLayout } from "../story-store/backlog";

export const viewsFeature = viewsFeatureWith({ stories: backlogLayout });
