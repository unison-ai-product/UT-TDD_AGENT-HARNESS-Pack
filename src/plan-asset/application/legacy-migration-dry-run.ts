import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parseStrictMarkdownTable } from "../../disposition/adapters/strict-markdown-table.ts";
import {
  resolveCanonicalTarget,
  type TargetRegistry,
} from "../../disposition/domain/target-resolver.ts";
import { type Role, VALID_ROLES } from "../../schema/index.ts";
import {
  buildLegacyPlanInventory,
  type LegacyPlanCollisionGroup,
  type LegacyPlanInventoryItem,
} from "../adapters/legacy-plan-inventory.ts";
import {
  loadRoleContractRegistry,
  type RoleContractRegistry,
} from "../adapters/role-contract-registry.ts";
import { validateMigrationFields } from "../domain/legacy-migration.ts";
import {
  MIGRATION_REVIEW_PLAN_ID,
  REVIEWED_REKEY_DECISIONS,
} from "./legacy-migration-decision-manifest.ts";

export type MigrationPreviewDecision = "migrated" | "rekeyed" | "rejected" | "pending";

export interface MigrationDecisionProposal {
  readonly legacyPlanId: string;
  readonly decision: MigrationPreviewDecision;
  readonly resolvedAlias: string | null;
  readonly collisionGroup: string | null;
  readonly lossFields: readonly string[];
  readonly reason: string;
  readonly reviewPlanId: string | null;
}

export interface MigrationDryRunFinding {
  readonly ruleId: string;
  readonly legacyPlanId: string | null;
  readonly message: string;
}

export interface MigrationDryRunRecord extends MigrationDecisionProposal {
  readonly sourcePath: string;
  readonly assetId: string;
  readonly sourceCommit: string;
  readonly sourceBlobOid: string;
  readonly sourceContentDigest: string;
  readonly delegationTargets: readonly DelegationTarget[];
  readonly findings: readonly MigrationDryRunFinding[];
}

export interface DelegationTarget {
  readonly role: Role;
  readonly slotLabel: string;
  readonly contractRef: string;
}

export interface MigrationDryRunReport {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly repositoryIdentity: string;
  readonly sourceCommit: string;
  readonly inventoryDigest: string;
  readonly reportDigest: string;
  readonly total: number;
  readonly emitted: number;
  readonly decisionCounts: Readonly<Record<MigrationPreviewDecision, number>>;
  readonly collisionGroups: number;
  readonly collisionItems: number;
  readonly records: readonly MigrationDryRunRecord[];
  readonly findings: readonly MigrationDryRunFinding[];
}

export interface MigrationDecisionPort {
  decide(
    item: LegacyPlanInventoryItem,
    collision: LegacyPlanCollisionGroup | null,
  ): MigrationDecisionProposal;
}

export class LegacyMigrationDryRun {
  private readonly decisions: MigrationDecisionPort;

  constructor(decisions: MigrationDecisionPort = new ReviewedDecisionManifest()) {
    this.decisions = decisions;
  }

  run(repoRoot: string): MigrationDryRunReport | { readonly ok: false; readonly ruleId: string } {
    const inventory = buildLegacyPlanInventory(repoRoot);
    if (!inventory.ok) return { ok: false, ruleId: inventory.error.ruleId };
    const collisionByPlan = new Map(
      inventory.value.collisionGroups.flatMap((group) =>
        group.planIds.map((planId) => [planId, group] as const),
      ),
    );
    const headArtifacts = HeadTargetRegistry.load(repoRoot);
    const roleContracts = loadRoleContractRegistry(repoRoot);
    const records = inventory.value.items.map((item) =>
      record({
        item,
        proposal: this.decisions.decide(item, collisionByPlan.get(item.legacyPlanId) ?? null),
        headArtifacts,
        roleContracts,
      }),
    );
    const findings = [
      ...manifestFindings(inventory.value.collisionGroups),
      ...targetSlotFindings(repoRoot),
      ...records.flatMap((item) => item.findings),
    ];
    if (new Set(records.map((item) => item.legacyPlanId)).size !== inventory.value.items.length) {
      findings.push(
        finding("plan-migration-preview-not-bijective", null, "inventory/preview bijection failed"),
      );
    }
    const decisionCounts = counts(records);
    const projection = {
      schemaVersion: 1 as const,
      repositoryIdentity: inventory.value.repositoryIdentity,
      sourceCommit: inventory.value.sourceCommit,
      inventoryDigest: inventory.value.inventoryDigest,
      records,
      findings,
    };
    return Object.freeze({
      ...projection,
      ok: findings.length === 0,
      reportDigest: sha256(canonical(projection)),
      total: inventory.value.items.length,
      emitted: records.length,
      decisionCounts,
      collisionGroups: inventory.value.collisionGroups.length,
      collisionItems: inventory.value.collisionGroups.flatMap((group) => group.planIds).length,
    });
  }
}

export function targetSlotFindings(repoRoot: string): MigrationDryRunFinding[] {
  const catalogPath = "docs/governance/vmodel-document-catalog.md";
  const ledgerPath = "docs/governance/vmodel-item-target-ledger.md";
  const catalog = parseStrictMarkdownTable(headBytes(repoRoot, catalogPath), {
    subjectId: catalogPath,
    expectedHeaders: [
      "doc_type_id",
      "layer",
      "sub_doc",
      "category",
      "requirement_class",
      "applicability",
      "default_status",
      "source_doc_family",
      "authoring_source_path",
      "projection_table",
      "profile_controlled",
      "skip_reason_required",
    ],
  });
  const ledger = parseStrictMarkdownTable(headBytes(repoRoot, ledgerPath), {
    subjectId: ledgerPath,
    expectedHeaders: [
      "edge_id",
      "item_id",
      "項目名",
      "category_id",
      "source_ref",
      "source_digest",
      "target_status",
      "target_kind",
      "target_ref",
      "判断理由",
      "plan_id",
    ],
  });
  if (!catalog.ok || !ledger.ok) {
    return [
      finding(
        "plan-target-slot-registry-invalid",
        null,
        "HEAD target slot authoring table is invalid",
      ),
    ];
  }
  const registry: TargetRegistry = {
    aliases: {},
    pathAliases: {},
    trackedPaths: new Set(),
    familyMembers: {},
    targetSlots: new Set(catalog.rows.map((row) => row.doc_type_id)),
  };
  return ledger.rows.flatMap((row) => {
    if (row.target_kind !== "target_slot") return [];
    const result = resolveCanonicalTarget({ kind: "target_slot", ref: row.target_ref }, registry);
    return result.ok
      ? []
      : result.findings.map((item) =>
          finding(item.ruleId, row.plan_id || null, `${row.edge_id}: ${item.message}`),
        );
  });
}

function headBytes(repoRoot: string, path: string): Uint8Array {
  return execFileSync("git", ["-C", repoRoot, "show", `HEAD:${path}`]);
}

class ReviewedDecisionManifest implements MigrationDecisionPort {
  private readonly rekeys = new Map<string, string>(REVIEWED_REKEY_DECISIONS);
  decide(item: LegacyPlanInventoryItem, collision: LegacyPlanCollisionGroup | null) {
    if (collision) {
      if (this.rekeys.get(item.legacyPlanId) === collision.numericCore)
        return {
          legacyPlanId: item.legacyPlanId,
          decision: "rekeyed" as const,
          resolvedAlias: item.legacyPlanId,
          collisionGroup: collision.numericCore,
          lossFields: [],
          reason: "reviewed numeric-prefix collision keeps the unique full legacy alias",
          reviewPlanId: MIGRATION_REVIEW_PLAN_ID,
        };
      return {
        legacyPlanId: item.legacyPlanId,
        decision: "pending" as const,
        resolvedAlias: null,
        collisionGroup: collision.numericCore,
        lossFields: [],
        reason: "numeric prefix collision requires reviewed rekey decision",
        reviewPlanId: MIGRATION_REVIEW_PLAN_ID,
      };
    }
    return {
      legacyPlanId: item.legacyPlanId,
      decision: "migrated" as const,
      resolvedAlias: item.legacyPlanId,
      collisionGroup: null,
      lossFields: [],
      reason: "lossless HEAD migration preview",
      reviewPlanId: null,
    };
  }
}

function record(input: {
  readonly item: LegacyPlanInventoryItem;
  readonly proposal: MigrationDecisionProposal;
  readonly headArtifacts: HeadTargetRegistry;
  readonly roleContracts: RoleContractRegistry;
}): MigrationDryRunRecord {
  const { item, proposal, headArtifacts, roleContracts } = input;
  const delegation = delegationProjection(item, roleContracts, headArtifacts);
  const findings: MigrationDryRunFinding[] = [
    ...artifactFindings(item, headArtifacts),
    ...delegation.findings,
  ];
  if (proposal.legacyPlanId !== item.legacyPlanId) {
    findings.push(
      finding(
        "plan-migration-preview-id-mismatch",
        item.legacyPlanId,
        "decision targets another PLAN",
      ),
    );
  }
  if (validateMigrationFields(proposal)) {
    findings.push(
      finding("plan-migration-decision-invalid", item.legacyPlanId, "decision field matrix failed"),
    );
  }
  if (proposal.decision === "pending") {
    findings.push(
      finding(
        "plan-migration-decision-pending",
        item.legacyPlanId,
        "reviewed decision is required",
      ),
    );
  }
  return Object.freeze({
    ...proposal,
    sourcePath: item.sourcePath,
    assetId: item.assetId,
    sourceCommit: item.sourceCommit,
    sourceBlobOid: item.sourceBlobOid,
    sourceContentDigest: item.sourceContentDigest,
    delegationTargets: delegation.targets,
    findings: Object.freeze(findings),
  });
}

function delegationProjection(
  item: LegacyPlanInventoryItem,
  registry: RoleContractRegistry,
  targets: HeadTargetRegistry,
): { readonly targets: readonly DelegationTarget[]; readonly findings: MigrationDryRunFinding[] } {
  const slots = Array.isArray(item.frontmatter.agent_slots) ? item.frontmatter.agent_slots : [];
  const findings: MigrationDryRunFinding[] = [];
  const projected = slots.flatMap((slot) => {
    if (!slot || typeof slot !== "object") return [];
    const value = slot as Record<string, unknown>;
    if (!VALID_ROLES.includes(value.role as Role) || typeof value.slot_label !== "string") {
      findings.push(
        finding("plan-delegation-role-mismatch", item.legacyPlanId, "invalid role or slot label"),
      );
      return [];
    }
    const role = value.role as Role;
    const contractRef = registry.targets[role];
    if (!targets.hasNonEmpty(contractRef)) {
      findings.push(
        finding(
          "plan-delegation-design-missing",
          item.legacyPlanId,
          `HEAD contract missing: ${contractRef}`,
        ),
      );
    }
    return [Object.freeze({ role, slotLabel: value.slot_label, contractRef })];
  });
  return { targets: Object.freeze(projected), findings };
}

function artifactFindings(
  item: LegacyPlanInventoryItem,
  headArtifacts: HeadTargetRegistry,
): MigrationDryRunFinding[] {
  if (!["confirmed", "completed", "accepted"].includes(String(item.frontmatter.status))) return [];
  const generates = Array.isArray(item.frontmatter.generates) ? item.frontmatter.generates : [];
  return generates.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const path = (entry as Record<string, unknown>).artifact_path;
    if (typeof path !== "string" || !path.trim()) {
      return [
        finding(
          "plan-generated-target-invalid",
          item.legacyPlanId,
          "generated target path is absent",
        ),
      ];
    }
    return headArtifacts.hasNonEmpty(path)
      ? []
      : [
          finding(
            "plan-generated-target-missing",
            item.legacyPlanId,
            `HEAD target is missing or hollow: ${path}`,
          ),
        ];
  });
}

export class HeadTargetRegistry {
  private readonly files: ReadonlyMap<string, number>;

  private constructor(files: ReadonlyMap<string, number>) {
    this.files = files;
  }

  static load(repoRoot: string): HeadTargetRegistry {
    const output = execFileSync("git", ["-C", repoRoot, "ls-tree", "-r", "-l", "HEAD"], {
      encoding: "utf8",
    });
    const files = new Map<string, number>();
    for (const line of output.split(/\r?\n/)) {
      const match = /^\d+\s+\w+\s+[a-f0-9]+\s+(\d+|-)\t(.+)$/.exec(line);
      if (match && match[1] !== "-") files.set(match[2], Number(match[1]));
    }
    return new HeadTargetRegistry(files);
  }

  static from(entries: Iterable<readonly [string, number]>): HeadTargetRegistry {
    return new HeadTargetRegistry(new Map(entries));
  }

  hasNonEmpty(rawPath: string): boolean {
    const path = rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
    const exact = this.files.get(path);
    if (exact !== undefined) return exact > 0;
    const prefix = path.endsWith("/") ? path : `${path}/`;
    return [...this.files].some(([candidate, size]) => candidate.startsWith(prefix) && size > 0);
  }
}

function counts(records: readonly MigrationDryRunRecord[]) {
  const result: Record<MigrationPreviewDecision, number> = {
    migrated: 0,
    rekeyed: 0,
    rejected: 0,
    pending: 0,
  };
  for (const item of records) result[item.decision] += 1;
  return Object.freeze(result);
}

function manifestFindings(
  collisions: readonly LegacyPlanCollisionGroup[],
): MigrationDryRunFinding[] {
  const expected = new Map(
    collisions.flatMap((group) => group.planIds.map((id) => [id, group.numericCore] as const)),
  );
  const reviewed = new Map<string, string>(REVIEWED_REKEY_DECISIONS);
  return [...new Set([...expected.keys(), ...reviewed.keys()])]
    .filter((id) => expected.get(id) !== reviewed.get(id))
    .map((id) =>
      finding(
        "plan-migration-decision-manifest-mismatch",
        id,
        "reviewed collision decision is missing, extra, or bound to another numeric prefix",
      ),
    );
}

function finding(
  ruleId: string,
  legacyPlanId: string | null,
  message: string,
): MigrationDryRunFinding {
  return Object.freeze({ ruleId, legacyPlanId, message });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
