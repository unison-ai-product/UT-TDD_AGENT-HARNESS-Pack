import { stringify } from "yaml";
import { parseLegacyPlanSource } from "../plan-asset/adapters/legacy-plan-inventory.ts";
import { canonicalPlanContentDigest } from "./diff-fence.ts";
import type { PlanAdmissionRequest } from "./policy.ts";

/** Receiptを除く、admission適用後のPLAN本文を一意に構成する。 */
export function bindPlanSourceToAdmission(input: {
  source: string;
  planId: string;
  admission: PlanAdmissionRequest;
}): { source: string; contentDigest: string } {
  const parsed = parseLegacyPlanSource(input.source);
  if (!parsed || parsed.planId !== input.planId)
    throw new Error("plan-revision-source-plan-id-mismatch");
  const admission = input.admission;
  // Receipt is an output of the ledger transaction, never part of its content preimage.
  const {
    admission_receipt: _priorReceipt,
    workflow_phase: _priorWorkflowPhase,
    status: _priorStatus,
    sub_doc: _priorSubDoc,
    github_issue_id: _priorGithubIssueId,
    supersedes: _priorSupersedes,
    ...sourceFrontmatter
  } = parsed.frontmatter;
  const frontmatter = {
    ...sourceFrontmatter,
    kind: admission.kind,
    layer: admission.layer,
    drive: admission.drive,
    route_signal: admission.routeSignal,
    route_mode: admission.routeMode,
    ...(admission.workflowPhase ? { workflow_phase: admission.workflowPhase } : {}),
    ...(admission.status ? { status: admission.status } : {}),
    ...(admission.subDoc ? { sub_doc: admission.subDoc } : {}),
    ...(admission.issue ? { github_issue_id: admission.issue.issueId } : {}),
    ...(admission.supersedes ? { supersedes: [...admission.supersedes] } : {}),
  };
  const source = `---\n${stringify(frontmatter)}---\n${parsed.body}`;
  const contentDigest = canonicalPlanContentDigest(source);
  if (!contentDigest) throw new Error("plan-revision-source-invalid");
  return { source, contentDigest };
}
