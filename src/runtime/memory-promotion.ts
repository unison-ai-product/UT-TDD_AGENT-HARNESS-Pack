export interface MemoryPromotionEvent {
  event_type: string;
  outcome?: "ok" | "error";
}

export interface MemoryPromotionDecision {
  should_nudge: boolean;
  reason:
    | "state_change_without_memory_write"
    | "memory_written"
    | "no_state_change"
    | "already_nudged";
}

/** Pure, sanitized-event-only decision used by Stop summary. */
export function evaluateMemoryPromotion(events: MemoryPromotionEvent[]): MemoryPromotionDecision {
  if (events.some((event) => event.event_type === "memory_promotion_missed")) {
    return { should_nudge: false, reason: "already_nudged" };
  }
  const changed = events.some(
    (event) =>
      (event.event_type === "commit" || event.event_type === "plan_switch") &&
      event.outcome === "ok",
  );
  if (!changed) return { should_nudge: false, reason: "no_state_change" };
  const memoryWritten = events.some(
    (event) => event.event_type === "memory_write" && event.outcome === "ok",
  );
  return memoryWritten
    ? { should_nudge: false, reason: "memory_written" }
    : { should_nudge: true, reason: "state_change_without_memory_write" };
}
