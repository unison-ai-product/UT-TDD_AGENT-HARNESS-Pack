import { describe, expect, it } from "vitest";
import { loadRoleContractRegistry } from "../../src/plan-asset/adapters/role-contract-registry.ts";
import { REVIEWED_REKEY_DECISIONS } from "../../src/plan-asset/application/legacy-migration-decision-manifest.ts";
import {
  HeadTargetRegistry,
  LegacyMigrationDryRun,
  type MigrationDecisionPort,
  targetSlotFindings,
} from "../../src/plan-asset/application/legacy-migration-dry-run.ts";
import { headPlanDocCount } from "./head-plan-doc-count.ts";

describe("legacy migration dry-run", () => {
  it("U-PA-038: proves exact files and directory families against non-empty HEAD blobs", () => {
    const registry = HeadTargetRegistry.from([
      ["docs/process/forward/README.md", 10],
      ["docs/empty.md", 0],
    ]);
    expect(registry.hasNonEmpty("docs/process/forward/")).toBe(true);
    expect(registry.hasNonEmpty("docs/process/forward")).toBe(true);
    expect(registry.hasNonEmpty("docs/empty.md")).toBe(false);
    expect(registry.hasNonEmpty("docs/missing/")).toBe(false);
  });

  it("U-PA-039: re-verifies snapshot OID and content digest from the bound HEAD object", () => {
    const result = new LegacyMigrationDryRun().run(process.cwd());
    if (!("records" in result)) throw new Error(result.ruleId);
    const sample = result.records[0];
    const oid = git(["rev-parse", `${result.sourceCommit}:${sample.sourcePath}`]).trim();
    const bytes = execFileSync("git", ["-C", process.cwd(), "cat-file", "blob", oid]);
    expect(oid).toBe(sample.sourceBlobOid);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sample.sourceContentDigest);
  });

  it("U-PA-040: resolves every delegation slot to a non-empty role contract at HEAD", () => {
    const result = new LegacyMigrationDryRun().run(process.cwd());
    if (!("records" in result)) throw new Error(result.ruleId);
    const targets = result.records.flatMap((record) => record.delegationTargets);
    expect(targets.length).toBeGreaterThan(0);
    const contracts = loadRoleContractRegistry(process.cwd());
    expect(new Set(Object.keys(contracts.targets))).toEqual(
      new Set(["po", "tl", "qa", "aim", "uiux", "se", "docs"]),
    );
    expect(targets.every((target) => target.role in contracts.targets)).toBe(true);
    for (const contractRef of new Set(targets.map((target) => target.contractRef))) {
      expect(
        Number(git(["cat-file", "-s", `${result.sourceCommit}:${contractRef}`]).trim()),
      ).toBeGreaterThan(0);
    }
  });

  it("U-PA-041: resolves every authored target_slot against the HEAD document catalog", () => {
    expect(targetSlotFindings(process.cwd())).toEqual([]);
  });

  it("U-PA-034: emits an exactly-once HEAD-bound record for every inventory item", () => {
    const result = new LegacyMigrationDryRun().run(process.cwd());
    if (!("records" in result)) throw new Error(result.ruleId);
    expect(result.total).toBe(headPlanDocCount(process.cwd()));
    expect(result.emitted).toBe(result.total);
    expect(new Set(result.records.map((item) => item.legacyPlanId)).size).toBe(result.total);
    expect(new Set(result.records.map((item) => item.sourceCommit))).toEqual(
      new Set([result.sourceCommit]),
    );
    expect(result.reportDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("U-PA-035: applies every explicit reviewed rekey decision", () => {
    const result = new LegacyMigrationDryRun().run(process.cwd());
    if (!("records" in result)) throw new Error(result.ruleId);
    const reviewedItems = REVIEWED_REKEY_DECISIONS.length;
    const reviewedGroups = new Set(REVIEWED_REKEY_DECISIONS.map(([, group]) => group)).size;
    expect(result.collisionGroups).toBe(reviewedGroups);
    expect(result.collisionItems).toBe(reviewedItems);
    expect(result.decisionCounts).toEqual({
      migrated: headPlanDocCount(process.cwd()) - reviewedItems,
      rekeyed: reviewedItems,
      rejected: 0,
      pending: 0,
    });
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("U-PA-036: detects a decision manifest that targets another inventory identity", () => {
    const wrong: MigrationDecisionPort = {
      decide(item) {
        return {
          legacyPlanId: `${item.legacyPlanId}-wrong`,
          decision: "migrated",
          resolvedAlias: item.legacyPlanId,
          collisionGroup: null,
          lossFields: [],
          reason: "fixture",
          reviewPlanId: null,
        };
      },
    };
    const result = new LegacyMigrationDryRun(wrong).run(process.cwd());
    if (!("records" in result)) throw new Error(result.ruleId);
    expect(result.ok).toBe(false);
    expect(
      result.findings.some((item) => item.ruleId === "plan-migration-preview-id-mismatch"),
    ).toBe(true);
  });

  it("U-PA-037: is deterministic for the same HEAD and decision port", () => {
    const first = new LegacyMigrationDryRun().run(process.cwd());
    const second = new LegacyMigrationDryRun().run(process.cwd());
    expect(second).toEqual(first);
  });
});

function git(args: readonly string[]): string {
  return execFileSync("git", ["-C", process.cwd(), ...args], { encoding: "utf8" });
}

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
