import type { ForwardEvent, ForwardReduction, ForwardSubject } from "../domain/types.ts";
import type {
  ForwardProjectionPort,
  ForwardProjectionResult,
} from "../ports/forward-projection.ts";

export class InMemoryForwardProjection implements ForwardProjectionPort {
  readonly writes: ForwardEvent[] = [];
  private readonly values = new Map<string, ForwardReduction>();
  private readonly options: { readonly unavailable?: boolean };
  constructor(options: { readonly unavailable?: boolean } = {}) {
    this.options = options;
  }
  isAvailable(): boolean {
    return !this.options.unavailable;
  }
  project(
    subject: ForwardSubject,
    event: ForwardEvent,
    reduction: ForwardReduction,
  ): ForwardProjectionResult {
    if (!this.isAvailable())
      return { ok: false, ruleId: "forward-ledger-unavailable", exitCode: 3 };
    const previous = this.values.get(key(subject));
    if (previous?.eventDigests.includes(event.digest)) return { ok: true, replayed: true };
    this.values.set(key(subject), reduction);
    this.writes.push(event);
    return { ok: true, replayed: false };
  }
  read(
    subject: ForwardSubject,
  ): ForwardReduction | { readonly ok: false; readonly ruleId: string; readonly exitCode: 3 } {
    if (!this.isAvailable())
      return { ok: false, ruleId: "forward-ledger-unavailable", exitCode: 3 };
    return (
      this.values.get(key(subject)) ?? {
        ok: false,
        ruleId: "forward-ledger-unavailable",
        exitCode: 3,
      }
    );
  }
}
function key(subject: ForwardSubject): string {
  return `${subject.subjectId}:${subject.subjectRevision}:${subject.sourceCommit}`;
}
