import type { HarnessDb } from "./index.ts";

/** SQLite固有の原子境界。applicationはこの実装を直接参照しない。 */
const transactionDepth = new WeakMap<HarnessDb, number>();

export function runSqliteTransaction<T>(db: HarnessDb, work: () => T): T {
  const depth = transactionDepth.get(db) ?? 0;
  const savepoint = `ut_tdd_projection_${depth}`;
  if (depth === 0) db.exec("BEGIN IMMEDIATE");
  else db.exec(`SAVEPOINT ${savepoint}`);
  transactionDepth.set(db, depth + 1);
  try {
    const result = work();
    if (depth === 0) db.exec("COMMIT");
    else db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    if (depth === 0) db.exec("ROLLBACK");
    else {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    }
    throw error;
  } finally {
    if (depth === 0) transactionDepth.delete(db);
    else transactionDepth.set(db, depth);
  }
}
