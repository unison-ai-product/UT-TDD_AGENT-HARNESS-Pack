import type {
  ForwardError,
  ForwardEvent,
  ForwardReduction,
  ForwardSubject,
} from "../domain/types.ts";

export type ForwardProjectionResult =
  | { readonly ok: true; readonly replayed: boolean }
  | ForwardError;

export interface ForwardProjectionPort {
  project(
    subject: ForwardSubject,
    event: ForwardEvent,
    reduction: ForwardReduction,
  ): ForwardProjectionResult;
  read(subject: ForwardSubject): ForwardReduction | ForwardError;
  isAvailable(): boolean;
}
