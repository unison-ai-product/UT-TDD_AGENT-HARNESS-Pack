import type { ForwardEvent, ForwardSubject } from "../domain/types.ts";
import type {
  ForwardLedgerAppend,
  ForwardLedgerLoad,
  ForwardLedgerPort,
} from "../ports/forward-ledger.ts";

export class InMemoryForwardLedger implements ForwardLedgerPort {
  readonly appended: ForwardEvent[] = [];
  private readonly events = new Map<string, ForwardEvent[]>();
  private readonly options: { readonly unavailable?: boolean };
  constructor(options: { readonly unavailable?: boolean } = {}) {
    this.options = options;
  }
  isAvailable(): boolean {
    return !this.options.unavailable;
  }
  reconstruct(subject: ForwardSubject): ForwardLedgerLoad {
    if (!this.isAvailable())
      return { ok: false, ruleId: "forward-ledger-unavailable", exitCode: 3 };
    return { ok: true, events: Object.freeze([...(this.events.get(key(subject)) ?? [])]) };
  }
  findByCommand(subject: ForwardSubject, commandId: string): ForwardEvent | null {
    return (
      (this.events.get(key(subject)) ?? []).find((event) => event.commandId === commandId) ?? null
    );
  }
  append(event: ForwardEvent): ForwardLedgerAppend {
    if (!this.isAvailable())
      return { ok: false, ruleId: "forward-ledger-unavailable", exitCode: 3 };
    const bucket = this.events.get(key(event)) ?? [];
    const existing = bucket.find((candidate) => candidate.commandId === event.commandId);
    if (existing)
      return existing.digest === event.digest
        ? { ok: true, replayed: true, event: existing }
        : { ok: false, ruleId: "forward-command-conflict", exitCode: 1 };
    bucket.push(event);
    this.events.set(key(event), bucket);
    this.appended.push(event);
    return { ok: true, replayed: false, event };
  }
}
function key(subject: ForwardSubject): string {
  return `${subject.subjectId}:${subject.subjectRevision}:${subject.sourceCommit}`;
}
