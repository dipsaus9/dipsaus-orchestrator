// Fixture: the main client entry never arms a timer through `self` (0017).
export const timer = self.setTimeout(() => {}, 10);
