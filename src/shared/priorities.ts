import type { Task } from "./types";

// Completed work and pins the user did not accept keep their existing slots.
// Only the remaining slots receive the proposed order.
export function applyProposedOrder(
  current: Task[],
  requested: Task[],
  accepted: Set<string>,
) {
  const fixed = new Set(
    current
      .filter((t) => t.status === "done" || (t.pinned && !accepted.has(t.id)))
      .map((t) => t.id),
  );
  const requestedIds = new Set(requested.map((t) => t.id));
  const movable = [
    ...requested,
    ...current.filter((t) => !requestedIds.has(t.id)),
  ].filter((t) => !fixed.has(t.id));
  let index = 0;
  return current.map((t) => (fixed.has(t.id) ? t : movable[index++]));
}
