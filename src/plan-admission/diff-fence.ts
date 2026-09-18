import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { parseLegacyPlanSource } from "../plan-asset/adapters/legacy-plan-inventory.ts";
import { type Frontmatter, frontmatterSchema } from "../schema/frontmatter.ts";

export interface PlanBlob {
  path: string;
  content: string;
}

export type PlanChange =
  | { kind: "added"; path: string }
  | { kind: "modified"; path: string }
  | { kind: "deleted"; path: string }
  | { kind: "renamed"; from: string; path: string };

export interface AdmissionReceiptProjection {
  commandId: string;
  receiptId: string;
  receiptDigest: string;
  decisionDigest: string;
  binding: {
    path: string;
    planId: string;
    assetId: string;
    revision: number;
    contentDigest: string;
  };
}

export interface AdmissionReceiptPort {
  lookup(commandId: string): AdmissionReceiptProjection | undefined;
}

export interface AdmissionDiffFinding {
  path: string;
  code:
    | "plan-admission-direct-delete"
    | "plan-admission-receipt-missing"
    | "plan-admission-legacy-direct-edit"
    | "plan-admission-receipt-stale"
    | "plan-admission-frontmatter-invalid"
    | "plan-admission-binding-mismatch"
    | "plan-admission-ledger-mismatch";
}

export function canonicalPlanContentDigest(content: string): string | undefined {
  const parsed = parseLegacyPlanSource(content);
  if (!parsed) return undefined;
  const frontmatter = { ...parsed.frontmatter };
  delete frontmatter.admission_receipt;
  return `sha256:${createHash("sha256")
    .update(`${stringify(frontmatter)}---\n${parsed.body}`)
    .digest("hex")}`;
}

export function analyzePlanAdmissionDiff(input: {
  base: readonly PlanBlob[];
  head: readonly PlanBlob[];
  changes: readonly PlanChange[];
  receipts: AdmissionReceiptPort;
}): { ok: boolean; findings: readonly AdmissionDiffFinding[] } {
  const base = new Map(input.base.map((blob) => [blob.path, blob]));
  const head = new Map(input.head.map((blob) => [blob.path, blob]));
  const findings: AdmissionDiffFinding[] = [];
  for (const change of input.changes) {
    if (!isPlanPath(change.path)) continue;
    if (change.kind === "deleted") {
      findings.push({ path: change.path, code: "plan-admission-direct-delete" });
      continue;
    }
    const current = head.get(change.path);
    if (!current) {
      findings.push({ path: change.path, code: "plan-admission-frontmatter-invalid" });
      continue;
    }
    const parsed = parseFrontmatter(current.content);
    if (!parsed) {
      findings.push({ path: change.path, code: "plan-admission-frontmatter-invalid" });
      continue;
    }
    const receipt = parsed.admission_receipt;
    const prior = change.kind === "renamed" ? base.get(change.from) : base.get(change.path);
    if (!receipt) {
      findings.push({
        path: change.path,
        code: prior ? "plan-admission-legacy-direct-edit" : "plan-admission-receipt-missing",
      });
      continue;
    }
    const previous = prior ? parseFrontmatter(prior.content)?.admission_receipt : undefined;
    if (
      previous?.receipt_id === receipt.receipt_id &&
      previous?.receipt_digest === receipt.receipt_digest
    ) {
      findings.push({ path: change.path, code: "plan-admission-receipt-stale" });
      continue;
    }
    const digest = canonicalPlanContentDigest(current.content);
    if (
      !digest ||
      receipt.binding.path !== change.path ||
      receipt.binding.plan_id !== parsed.plan_id ||
      receipt.binding.content_digest !== digest
    ) {
      findings.push({ path: change.path, code: "plan-admission-binding-mismatch" });
      continue;
    }
    const projection = input.receipts.lookup(receipt.command_id);
    if (
      !projection ||
      projection.receiptId !== receipt.receipt_id ||
      projection.receiptDigest !== receipt.receipt_digest ||
      projection.decisionDigest !== receipt.decision_digest ||
      projection.binding.path !== receipt.binding.path ||
      projection.binding.planId !== receipt.binding.plan_id ||
      projection.binding.assetId !== receipt.binding.asset_id ||
      projection.binding.revision !== receipt.binding.revision ||
      projection.binding.contentDigest !== receipt.binding.content_digest
    ) {
      findings.push({ path: change.path, code: "plan-admission-ledger-mismatch" });
    }
  }
  return { ok: findings.length === 0, findings };
}

function isPlanPath(path: string): boolean {
  return /^docs\/plans\/PLAN-[A-Za-z0-9-]+\.md$/.test(path);
}

function parseFrontmatter(content: string): Frontmatter | undefined {
  const parsed = parseLegacyPlanSource(content);
  const result = frontmatterSchema.safeParse(parsed?.frontmatter);
  return result.success ? result.data : undefined;
}
