// Fixture: the main client entry never arms a timer through `self` (0017 section 4).
export const timer = self.setTimeout(() => {}, 10);
