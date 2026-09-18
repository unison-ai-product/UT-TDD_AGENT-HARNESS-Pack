import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LegacyMigrationLedger } from "../../src/plan-asset/ledger/legacy-migration-ledger.ts";
import { migratePlanLedger, openPlanLedger } from "../../src/plan-asset/ledger/schema.ts";
import { openHarnessDb } from "../../src/state-db/index.ts";

describe("legacy migration ledger application", () => {
  it("U-PA-026: atomically observes once and rejects a competing state command", () => {
    withLedger(({ db, ledger }) => {
      expect(ledger.observe(input())).toMatchObject({ ok: true, replayed: false });
      expect(counts(db)).toEqual([1, 1, 1]);
      expect(ledger.observe({ ...input(), commandId: "command:other" })).toMatchObject({
        ok: false,
        ruleId: "plan-migration-state-conflict",
      });
      expect(counts(db)).toEqual([1, 1, 1]);
    });
  });

  it("U-PA-027: replays the same command and rejects a different payload", () => {
    withLedger(({ db, ledger }) => {
      const first = ledger.observe(input());
      expect(ledger.observe({ ...input(), occurredAt: "2026-07-13T01:00:00Z" })).toMatchObject({
        ok: true,
        replayed: true,
        resultRef: first.ok ? first.resultRef : "",
      });
      expect(ledger.observe({ ...input(), reason: "different" })).toMatchObject({
        ok: false,
        ruleId: "plan-migration-command-conflict",
      });
      expect(counts(db)).toEqual([1, 1, 1]);
    });
  });

  it("U-PA-029: rejects without creating a PlanAsset revision or alias", () => {
    withLedger(({ db, ledger }) => {
      expect(ledger.observe(input())).toMatchObject({ ok: true });
      expect(
        ledger.reject({
          legacyPlanId: input().legacyPlanId,
          lossFields: ["frontmatter.unsupported"],
          reason: "lossless migration unavailable",
          reviewPlanId: "PLAN-L7-418-review",
          commandId: "command:reject",
          occurredAt: "2026-07-13T01:00:00Z",
          expectedSequence: 1,
          expectedDecision: "pending",
        }),
      ).toMatchObject({ ok: true, replayed: false });
      expect(counts(db)).toEqual([2, 1, 2]);
      expect(
        ["plan_assets", "plan_revisions", "plan_alias_events", "plan_aliases"].map((table) =>
          count(db, table),
        ),
      ).toEqual([0, 0, 0, 0]);
      expect(migratePlanLedger(db)).toMatchObject({ ok: true });
    });
  });

  it("U-PA-028: atomically adopts a canonical revision and alias", () => {
    withLedger(({ db, ledger }) => {
      expect(ledger.observe(input())).toMatchObject({ ok: true });
      const payload = JSON.stringify({ legacyPlanId: input().legacyPlanId, migrated: true });
      expect(
        ledger.adopt({
          legacyPlanId: input().legacyPlanId,
          decision: "migrated",
          resolvedAlias: input().legacyPlanId,
          collisionGroup: null,
          reviewPlanId: null,
          canonicalPayloadJson: payload,
          canonicalPayloadDigest: sha256(payload),
          bodyDigest: "1".repeat(64),
          sourcePath: "docs/plans/PLAN-L7-1-a.md",
          sourceCommit: "2".repeat(40),
          actor: "migration:test",
          reason: "lossless canonical adoption",
          commandId: "command:adopt",
          occurredAt: "2026-07-13T01:00:00Z",
          expectedSequence: 1,
          expectedDecision: "pending",
        }),
      ).toMatchObject({ ok: true, replayed: false });
      expect(counts(db)).toEqual([2, 1, 2]);
      expect(
        ["plan_assets", "plan_revisions", "plan_alias_events", "plan_aliases"].map((table) =>
          count(db, table),
        ),
      ).toEqual([1, 1, 1, 1]);
      expect(migratePlanLedger(db)).toMatchObject({ ok: true });
    });
  });

  it("U-PA-028: rekeys a collision with explicit review provenance", () => {
    withLedger(({ db, ledger }) => {
      const observed = { ...input(), collisionGroup: "collision:PLAN-L7-1-a" };
      expect(ledger.observe(observed)).toMatchObject({ ok: true });
      expect(
        ledger.adopt({
          ...adoptInput(),
          decision: "rekeyed",
          resolvedAlias: "PLAN-L7-1-a~owner-repository",
          collisionGroup: observed.collisionGroup,
          reviewPlanId: "PLAN-L7-418-review",
        }),
      ).toMatchObject({ ok: true, replayed: false });
      expect(
        db
          .prepare(`SELECT decision, resolved_alias, collision_group, review_plan_id
        FROM legacy_plan_migrations WHERE legacy_plan_id = ?`)
          .get(observed.legacyPlanId),
      ).toMatchObject({
        decision: "rekeyed",
        resolved_alias: "PLAN-L7-1-a~owner-repository",
        collision_group: observed.collisionGroup,
        review_plan_id: "PLAN-L7-418-review",
      });
      expect(migratePlanLedger(db)).toMatchObject({ ok: true });
    });
  });

  it("U-PA-028: rejects decision/provenance mismatches without a delta", () => {
    withLedger(({ db, ledger }) => {
      ledger.observe(input());
      const baseline = countAll(db);
      expect(ledger.adopt({ ...adoptInput(), decision: "rekeyed" })).toMatchObject({
        ok: false,
        ruleId: "plan-migration-decision-invalid",
      });
      expect(countAll(db)).toEqual(baseline);
    });
  });

  it("U-PA-030: rejects migration event/receipt bijection orphans in both directions", () => {
    withLedger(({ db, ledger }) => {
      ledger.observe(input());
      db.exec("DROP TRIGGER trg_append_command_receipts_no_delete");
      db.exec("DELETE FROM append_command_receipts");
      expect(migratePlanLedger(db)).toMatchObject({
        ok: false,
        ruleId: "plan-ledger-unavailable",
      });
    });
    withLedger(({ db, ledger }) => {
      ledger.observe(input());
      db.exec("DROP TRIGGER trg_legacy_plan_migration_events_no_delete");
      db.exec("DELETE FROM legacy_plan_migration_events");
      expect(migratePlanLedger(db)).toMatchObject({
        ok: false,
        ruleId: "plan-ledger-unavailable",
      });
    });
  });

  it("U-PA-033: reconstructs identical state and provenance after file reopen", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "ut-tdd-migration-ledger-"));
    try {
      const firstDb = openPlanLedger({ repoRoot });
      const first = new LegacyMigrationLedger(firstDb);
      first.observe(input());
      const before = first.reconstruct(input().legacyPlanId);
      firstDb.close();
      const reopened = openPlanLedger({ repoRoot });
      const after = new LegacyMigrationLedger(reopened).reconstruct(input().legacyPlanId);
      expect(after).toEqual(before);
      reopened.close();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it.each([
    "migration-event",
    "migration-current",
    "receipt",
  ])("U-PA-032: rolls back observe after %s fault", (boundary) => {
    withLedger(({ db }) => {
      const ledger = new LegacyMigrationLedger(db, undefined, faultAt(boundary));
      expect(() => ledger.observe(input())).toThrow(`fault:${boundary}`);
      expect(countAll(db)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    });
  });

  it.each([
    "plan-asset",
    "plan-revision",
    "alias-event",
    "alias-current",
    "migration-event",
    "migration-current",
    "receipt",
  ])("U-PA-032: rolls back adoption after %s fault", (boundary) => {
    withLedger(({ db, ledger }) => {
      ledger.observe(input());
      const baseline = countAll(db);
      const faulting = new LegacyMigrationLedger(db, undefined, faultAt(boundary));
      expect(() => faulting.adopt(adoptInput())).toThrow(`fault:${boundary}`);
      expect(countAll(db)).toEqual(baseline);
    });
  });
});

function input() {
  return {
    legacyPlanId: "PLAN-L7-1-a",
    assetId: `plan:legacy:${"a".repeat(64)}`,
    collisionGroup: null,
    reason: "inventory observed",
    reviewPlanId: "PLAN-L7-418-review",
    repositoryIdentity: "owner/repository",
    identityAlgorithm: "ut-tdd-plan-legacy-v1",
    identityInputJson: "[]",
    identityDigest: "b".repeat(64),
    identityConfigPath: "ut-tdd.project.json",
    identityConfigBlobOid: "c".repeat(40),
    identityConfigContentDigest: "d".repeat(64),
    identityConfigReceiptDigest: "e".repeat(64),
    sourceDigest: "f".repeat(64),
    commandId: "command:observe",
    occurredAt: "2026-07-13T00:00:00Z",
    expectedSequence: 0 as const,
  };
}

function adoptInput() {
  const payload = JSON.stringify({ legacyPlanId: input().legacyPlanId, migrated: true });
  return {
    legacyPlanId: input().legacyPlanId,
    decision: "migrated" as const,
    resolvedAlias: input().legacyPlanId,
    collisionGroup: null,
    reviewPlanId: null,
    canonicalPayloadJson: payload,
    canonicalPayloadDigest: sha256(payload),
    bodyDigest: "1".repeat(64),
    sourcePath: "docs/plans/PLAN-L7-1-a.md",
    sourceCommit: "2".repeat(40),
    actor: "migration:test",
    reason: "lossless canonical adoption",
    commandId: "command:adopt",
    occurredAt: "2026-07-13T01:00:00Z",
    expectedSequence: 1 as const,
    expectedDecision: "pending" as const,
  };
}

function withLedger(
  run: (fixture: { db: ReturnType<typeof openHarnessDb>; ledger: LegacyMigrationLedger }) => void,
): void {
  const db = openHarnessDb(":memory:");
  try {
    migratePlanLedger(db);
    run({ db, ledger: new LegacyMigrationLedger(db) });
  } finally {
    db.close();
  }
}

function counts(db: ReturnType<typeof openHarnessDb>): readonly number[] {
  return ["legacy_plan_migration_events", "legacy_plan_migrations", "append_command_receipts"].map(
    (table) => count(db, table),
  );
}

function count(db: ReturnType<typeof openHarnessDb>, table: string): number {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0);
}

function countAll(db: ReturnType<typeof openHarnessDb>): readonly number[] {
  return [
    "legacy_plan_migration_events",
    "legacy_plan_migrations",
    "append_command_receipts",
    "plan_assets",
    "plan_revisions",
    "plan_alias_events",
    "plan_aliases",
  ].map((table) => count(db, table));
}

function faultAt(expected: string) {
  return {
    after(boundary: string) {
      if (boundary === expected) throw new Error(`fault:${boundary}`);
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
