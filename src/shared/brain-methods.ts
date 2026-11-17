// Keep desktop and browser clients on the same Company Brain API surface.
export const brainAppMethods = [
  "brain.overview",
  "brain.page",
  "brain.source",
  "brain.source.draft",
  "brain.source.decide",
  "brain.search",
  "brain.correct",
  "brain.suggestion.decide",
] as const;
