import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import {
  assertWithinUtTdd,
  openReadOnlyHarnessDb,
  type ReadOnlyHarnessDb,
} from "../../state-db/index.ts";
import * as planLedgerSchema from "./schema.ts";
import { LEDGER_SCHEMA_VERSION } from "./schema.ts";

export interface PlanRevisionDigestSelector {
  readonly alias: string;
  readonly assetId: string;
  readonly revision: number;
}

export type PlanRevisionDigestQueryResult =
  | Readonly<{
      ok: true;
      alias: string;
      assetId: string;
      revision: number;
      canonicalPayloadDigest: string;
    }>
  | Readonly<{
      ok: false;
      reason:
        | "invalid_input"
        | "alias_binding_mismatch"
        | "revision_not_found"
        | "ledger_unavailable"
        | "ledger_integrity_mismatch";
    }>;

export type PlanRevisionDigestQueryTestHook = (context: {
  readonly tryWrite: () => number;
}) => void;

let testHook: PlanRevisionDigestQueryTestHook | undefined;

/** Test-only seam; normal production callers leave it unset. */
export function setPlanRevisionDigestQueryTestHook(
  hook: PlanRevisionDigestQueryTestHook | undefined,
): void {
  testHook = hook;
}

const unavailable = (): PlanRevisionDigestQueryResult => ({
  ok: false,
  reason: "ledger_unavailable",
});

export function readPlanRevisionCanonicalPayloadDigest(
  selector: PlanRevisionDigestSelector,
): PlanRevisionDigestQueryResult {
  if (
    selector === null ||
    typeof selector !== "object" ||
    typeof selector.alias !== "string" ||
    selector.alias.length === 0 ||
    typeof selector.assetId !== "string" ||
    selector.assetId.length === 0 ||
    !Number.isSafeInteger(selector.revision) ||
    selector.revision <= 0
  )
    return { ok: false, reason: "invalid_input" };

  const repoRoot = process.cwd();
  const databasePath = join(repoRoot, ".ut-tdd", "ledger", "harness-ledger.db");
  try {
    assertWithinUtTdd(databasePath, repoRoot);
  } catch {
    return unavailable();
  }
  if (
    !existsSync(databasePath) ||
    hasWalOrShmSidecar(databasePath) ||
    !hasRollbackJournalHeader(databasePath)
  )
    return unavailable();

  let database: ReadOnlyHarnessDb | undefined;
  let result: PlanRevisionDigestQueryResult = unavailable();
  try {
    database = openReadOnlyHarnessDb(databasePath, { repoRoot });
    database.beginReadTransaction();
    result = readWithinSnapshot(database, selector);
    database.commitReadTransaction();
  } catch {
    result = unavailable();
  } finally {
    try {
      database?.close();
    } catch {
      result = unavailable();
    }
  }

  return hasWalOrShmSidecar(databasePath) ? unavailable() : result;
}

function readWithinSnapshot(
  database: ReadOnlyHarnessDb,
  selector: PlanRevisionDigestSelector,
): PlanRevisionDigestQueryResult {
  if (database.userVersion() !== LEDGER_SCHEMA_VERSION) return unavailable();
  if (!planLedgerSchema.validatePlanLedgerReadOnly(database)) {
    return { ok: false, reason: "ledger_integrity_mismatch" };
  }
  testHook?.({ tryWrite: () => tryWriteProbe(database) });

  const activeBindings = database
    .prepare("SELECT asset_id FROM plan_aliases WHERE alias = ? AND valid_to_revision IS NULL")
    .all(selector.alias);
  if (activeBindings.length !== 1 || activeBindings[0]?.asset_id !== selector.assetId) {
    return { ok: false, reason: "alias_binding_mismatch" };
  }

  const revision = database
    .prepare(
      "SELECT canonical_payload_digest FROM plan_revisions WHERE asset_id = ? AND revision = ?",
    )
    .get(selector.assetId, selector.revision);
  if (!revision) return { ok: false, reason: "revision_not_found" };
  if (typeof revision.canonical_payload_digest !== "string") {
    return { ok: false, reason: "ledger_integrity_mismatch" };
  }

  return Object.freeze({
    ok: true,
    alias: selector.alias,
    assetId: selector.assetId,
    revision: selector.revision,
    canonicalPayloadDigest: `sha256:${revision.canonical_payload_digest}`,
  });
}

function tryWriteProbe(database: ReadOnlyHarnessDb): number {
  try {
    database.prepare("CREATE TABLE ut_tdd_ro_probe(x INTEGER)").run();
    return 0;
  } catch (error) {
    if (typeof error === "object" && error !== null && "errcode" in error) {
      const errcode = error.errcode;
      return typeof errcode === "number" ? errcode : -1;
    }
    return -1;
  }
}

function hasWalOrShmSidecar(databasePath: string): boolean {
  return existsSync(`${databasePath}-wal`) || existsSync(`${databasePath}-shm`);
}

function hasRollbackJournalHeader(databasePath: string): boolean {
  let descriptor: number;
  try {
    descriptor = openSync(databasePath, "r");
  } catch {
    return false;
  }
  try {
    const header = Buffer.alloc(100);
    return (
      readSync(descriptor, header, 0, header.length, 0) === header.length &&
      header[18] === 1 &&
      header[19] === 1
    );
  } catch {
    return false;
  } finally {
    closeSync(descriptor);
  }
}
