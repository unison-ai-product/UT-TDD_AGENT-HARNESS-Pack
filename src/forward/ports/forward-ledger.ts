import type { ForwardError, ForwardEvent, ForwardSubject } from "../domain/types.ts";

export type ForwardLedgerLoad =
  | { readonly ok: true; readonly events: readonly ForwardEvent[] }
  | ForwardError;
export type ForwardLedgerAppend =
  | { readonly ok: true; readonly replayed: boolean; readonly event: ForwardEvent }
  | ForwardError;

export interface ForwardLedgerPort {
  reconstruct(subject: ForwardSubject): ForwardLedgerLoad;
  findByCommand(subject: ForwardSubject, commandId: string): ForwardEvent | null;
  append(event: ForwardEvent): ForwardLedgerAppend;
  isAvailable(): boolean;
}
