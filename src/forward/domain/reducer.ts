import { createHash } from "node:crypto";
import { canonicalJson } from "../../plan-asset/domain/evidence-canonical.ts";
import { edgeFor, type ForwardState } from "./transition-policy.ts";
import type { ForwardError, ForwardEvent, ForwardReduction } from "./types.ts";

export function reduceForward(events: readonly ForwardEvent[]): ForwardReduction | ForwardError {
  let state: ForwardState = "proposed";
  const seenEvents = new Set<string>();
  const seenCommands = new Set<string>();
  const digests: string[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const current = events[index];
    if (current.sequence !== index + 1) return failure("forward-sequence-invalid");
    if (current.fromState !== state) return failure("forward-transition-illegal");
    if (seenEvents.has(current.eventId) || seenCommands.has(current.commandId))
      return failure("forward-command-conflict");
    if (current.toState !== edgeFor(state, current.event)?.to)
      return failure("forward-transition-illegal");
    if (current.digest !== eventDigest(current)) return failure("forward-event-digest-mismatch");
    seenEvents.add(current.eventId);
    seenCommands.add(current.commandId);
    digests.push(current.digest);
    state = current.toState;
  }
  const digest = digestOf({ state, eventDigests: digests });
  return {
    ok: true,
    state,
    digest,
    stateDigest: digest,
    events: Object.freeze([...events]),
    eventDigests: Object.freeze(digests),
  };
}

export function eventDigest(event: Omit<ForwardEvent, "digest"> | ForwardEvent): string {
  const { digest: _ignored, ...withoutDigest } = event as ForwardEvent;
  return digestOf(withoutDigest);
}

export function stateDigest(state: ForwardState, events: readonly ForwardEvent[]): string {
  return digestOf({ state, eventDigests: events.map((event) => event.digest) });
}

export function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function failure(ruleId: string): ForwardError {
  return { ok: false, ruleId, exitCode: 1 };
}
