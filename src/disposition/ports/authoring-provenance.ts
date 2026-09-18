import type { AuthoringReceipt } from "../domain/authoring-provenance.ts";

export interface AuthoringProvenancePort {
  receipts(paths: readonly string[]): readonly AuthoringReceipt[];
}
