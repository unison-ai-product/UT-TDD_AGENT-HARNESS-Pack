import type { HarnessDb } from "../../state-db/index.ts";

export interface LedgerTransactionPort {
  run<T>(work: () => { readonly commit: boolean; readonly value: T }): T;
}

export class ImmediateLedgerTransaction implements LedgerTransactionPort {
  private readonly db: HarnessDb;

  constructor(db: HarnessDb) {
    this.db = db;
  }

  run<T>(work: () => { readonly commit: boolean; readonly value: T }): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec(result.commit ? "COMMIT" : "ROLLBACK");
      return result.value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
