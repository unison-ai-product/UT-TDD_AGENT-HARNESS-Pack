import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyProposalDocumentCoverage, classifyTask } from "../src/task/classify";
import {
  BASELINE_DOCUMENT_PACK,
  KIND_PATTERNS,
  PROPOSAL_COVERAGE_GUARDRAILS,
  RISK_TERMS,
} from "../src/task/classify-policy";
import { DOCUMENT_PACKS } from "../src/task/proposal-coverage-data";
import { doc, LEVEL_RANK } from "../src/task/proposal-document-pack-types";
import { DOCUMENT_PACKS_CORE } from "../src/task/proposal-document-packs-core";
import { DOCUMENT_PACKS_OPERATIONS } from "../src/task/proposal-document-packs-operations";
import {
  RESEARCH_ADOPTION_BY_PATTERN,
  RESEARCH_REJECTION_KEYWORDS,
} from "../src/task/proposal-research-data";
import { MODEL_IDS, PROPOSAL_SUBAGENT_LANES } from "../src/team/model-policy";

describe("U-FR-L1-39: classifyTask public surface", () => {
  it("loads proposal coverage rules from the externalized data catalog", () => {
    expect(DOCUMENT_PACKS.length).toBeGreaterThan(0);
    expect(DOCUMENT_PACKS.length).toBe(
      DOCUMENT_PACKS_CORE.length + DOCUMENT_PACKS_OPERATIONS.length,
    );
    expect(DOCUMENT_PACKS.map((pack) => pack.pattern)).toContain("agent-orchestration");
    expect(LEVEL_RANK.G3).toBeGreaterThan(LEVEL_RANK.G2);
    expect(doc("x", "docs/x.md", "reason")).toEqual({
      id: "x",
      path: "docs/x.md",
      reason: "reason",
    });
    expect(RESEARCH_ADOPTION_BY_PATTERN["agent-orchestration"]?.disposition).toBe(
      "ut-tdd-specific",
    );
    expect(RESEARCH_REJECTION_KEYWORDS.map((entry) => entry.decision.pattern)).toContain(
      "llm-minimal-design-claim",
    );
    expect(KIND_PATTERNS.map((entry) => entry.kind)).toContain("refactor");
    expect(RISK_TERMS).toContain("authentication");
    expect(BASELINE_DOCUMENT_PACK.pattern).toBe("baseline");
    expect(PROPOSAL_COVERAGE_GUARDRAILS).toContain(
      "cheap-subagents-cannot-close-risk-or-shrink-coverage",
    );
  });

  it("infers kind from task verbs (most-specific pattern wins)", () => {
    expect(classifyTask({ text: "refactor the projection writer" }).kind).toBe("refactor");
    expect(classifyTask({ text: "fix the failing doctor gate" }).kind).toBe("troubleshoot");
    expect(classifyTask({ text: "add a new endpoint for telemetry" }).kind).toBe("add-feature");
    expect(classifyTask({ text: "design the L4 architecture for search" }).kind).toBe("design");
    expect(classifyTask({ text: "spike a PoC for browser verification" }).kind).toBe("poc");
    expect(classifyTask({ text: "reverse the as-is design of legacy state" }).kind).toBe("reverse");
    expect(classifyTask({ text: "ponder the universe" }).kind).toBe("unknown");
  });

  it("classifies the drive from text and file evidence", () => {
    expect(classifyTask({ text: "alter the db schema" }).drive).toBe("db");
    expect(classifyTask({ text: "build the frontend ui dashboard" }).drive).toBe("frontend");
    expect(classifyTask({ text: "wire the agent tool routing" }).drive).toBe("agent");
    const fallback = classifyTask({ text: "implement the service layer" });
    expect(fallback.drive).toBe("fullstack");
    expect(fallback.drive_confidence).toBeLessThan(0.7);
  });

  it("flags escalation-sensitive areas with a warn finding", () => {
    const result = classifyTask({ text: "change the authentication and payment flow" });
    expect(result.risk_flags).toContain("authentication");
    expect(result.risk_flags).toContain("payment");
    expect(result.findings.some((f) => f.code === "escalation-risk")).toBe(true);
  });

  it("surfaces signal-to-mode routing at the task entry point", () => {
    const additive = classifyTask({ text: "new_requirement add payment support" });
    expect(additive.route.mode).toBe("add-feature");
    expect(additive.route.recommended_command).toBe("ut-tdd task classify");
    expect(additive.route.requires_human_approval).toBe(true);
    expect(additive.route.approval_status).toBe("policy_missing");
    expect(additive.route.escalation_boundaries).toContain("payment");

    const unknown = classifyTask({ text: "ponder the universe" });
    expect(unknown.route.mode).toBeNull();
    expect(unknown.route.exit_code).toBe(2);
  });

  it("does not flag the legitimate word 'author' as an auth risk", () => {
    const result = classifyTask({ text: "author the design doc for the catalog" });
    expect(result.risk_flags).toEqual([]);
    expect(result.findings.some((f) => f.code === "escalation-risk")).toBe(false);
  });

  it("matches risk terms as whole words, not substrings of innocent words", () => {
    // "reproduction"⊃"production", "schematic"⊃"schema", "secretary"⊃"secret".
    for (const text of [
      "investigate the crash reproduction steps",
      "update the schematic diagram for the parser",
      "the secretary dashboard needs a new column",
    ]) {
      const result = classifyTask({ text });
      expect(result.risk_flags).toEqual([]);
      expect(result.findings.some((f) => f.code === "escalation-risk")).toBe(false);
    }
  });

  it("keeps safety-relevant plural risk terms flagged", () => {
    const result = classifyTask({ text: "rotate the credentials and process payments" });
    expect(result.risk_flags).toContain("credential");
    expect(result.risk_flags).toContain("payment");
    expect(result.findings.some((f) => f.code === "escalation-risk")).toBe(true);
  });

  it("scales size with affected-file count", () => {
    const small = classifyTask({ text: "tweak one file", affected_files: ["a.ts"] });
    const large = classifyTask({
      text: "broad change",
      affected_files: Array.from({ length: 14 }, (_, i) => `f${i}.ts`),
      dependencies: ["x", "y", "z"],
    });
    expect(small.size).toBe("S");
    expect(large.size).toBe("L");
  });

  it("is deterministic and always reports a difficulty", () => {
    const input = { text: "add authentication to the api", affected_files: ["api.ts"] };
    const a = classifyTask(input);
    const b = classifyTask(input);
    expect(a).toEqual(b);
    expect(a.difficulty).toBeTruthy();
  });

  it("derives required design docs from proposal patterns additively", () => {
    const result = classifyProposalDocumentCoverage({
      text: "Build a customer screen with API integration and DB schema migration.",
    });
    expect(result.granularity).toBe("G4");
    expect(result.patterns).toEqual(expect.arrayContaining(["screen-ui", "api-if", "data-db"]));
    expect(result.required_design_docs.map((d) => d.id)).toEqual(
      expect.arrayContaining(["screen-list", "screen-flow", "external-if", "if-detail", "data"]),
    );
    expect(result.required_test_docs.map((d) => d.id)).toEqual(
      expect.arrayContaining(["acceptance-test-design", "integration-test-design"]),
    );
    expect(result.escalators).toContain("risk_flags");
    expect(result.escalators).toContain("multi_pattern_union");
    expect(result.research_adoption.map((r) => r.pattern)).toEqual(
      expect.arrayContaining(["screen-ui", "api-if", "data-db"]),
    );
    expect(result.research_adoption.find((r) => r.pattern === "screen-ui")?.disposition).toBe(
      "incorporate",
    );
  });

  it("does not let proposal shrinkage wording remove required documents", () => {
    const result = classifyProposalDocumentCoverage({
      text: "This is a minor screen change, skip wireframe because it is not needed.",
    });
    expect(result.patterns).toContain("screen-ui");
    expect(result.required_design_docs.map((d) => d.id)).toEqual(
      expect.arrayContaining(["screen-list", "screen-flow", "wireframe", "ui-element"]),
    );
    expect(result.findings.map((f) => f.code)).toContain("llm-shrinkage-ignored");
    expect(result.research_rejections.map((r) => r.pattern)).toContain("llm-minimal-design-claim");
  });

  it("routes uncertain proposal text to discovery-level coverage", () => {
    const result = classifyProposalDocumentCoverage({
      text: "Research an unknown feasibility hypothesis before deciding the design.",
    });
    expect(result.granularity).toBe("G5");
    expect(result.patterns).toContain("discovery");
    expect(result.required_evidence).toEqual(
      expect.arrayContaining(["hypothesis", "poc_evidence", "s4_decision"]),
    );
  });

  it("always includes the cross-layer proposal coverage routing test design", () => {
    const result = classifyProposalDocumentCoverage({
      text: "Rename a local helper.",
    });
    expect(result.required_test_docs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "proposal-document-coverage-routing",
          path: "docs/test-design/harness/proposal-document-coverage-routing.md",
        }),
      ]),
    );
  });

  it("returns existing document paths for representative coverage patterns", () => {
    const scenarios = [
      "Build a screen UI form with UX journey, frontend tokens, API, DB schema, backend function and common component.",
      "Add batch CSV report output with async queue, dead-letter retry and email notification.",
      "Add security privacy permissions, audit log, monitoring, NFR, release rollback and migration plan.",
      "Create a test plan, acceptance test, system test, regression procedure and operational test coverage.",
      "Research discovery for workflow gate, agent orchestration, provider handover and team run.",
    ];
    const missing = scenarios.flatMap((text) => {
      const coverage = classifyProposalDocumentCoverage({ text });
      return [...coverage.required_design_docs, ...coverage.required_test_docs]
        .map((document) => document.path)
        .filter((path) => !existsSync(path));
    });

    expect([...new Set(missing)].sort()).toEqual([]);
  });

  it("covers batch/report and NFR use cases with separate research adoption", () => {
    const result = classifyProposalDocumentCoverage({
      text: "Add a scheduled CSV export batch report with performance and audit log requirements.",
    });
    expect(result.patterns).toEqual(expect.arrayContaining(["batch-report", "nfr-quality"]));
    expect(result.granularity).toBe("G4");
    expect(result.required_design_docs.map((d) => d.id)).toEqual(
      expect.arrayContaining(["internal-processing", "physical-data", "nfr", "nfr-grade"]),
    );
    expect(result.research_adoption.find((r) => r.pattern === "batch-report")?.disposition).toBe(
      "incorporate",
    );
    expect(result.research_adoption.find((r) => r.pattern === "nfr-quality")?.disposition).toBe(
      "reference",
    );
  });

  it("incorporates test-design templates as traceable oracle coverage", () => {
    const result = classifyProposalDocumentCoverage({
      text: "Create a test plan, test design, test case specification, UAT and regression test coverage.",
    });
    expect(result.patterns).toContain("test-design");
    expect(result.required_test_docs.map((d) => d.id)).toEqual(
      expect.arrayContaining([
        "operational-test-design",
        "acceptance-test-design",
        "unit-test-design",
        "integration-test-design",
        "system-test-design",
      ]),
    );
    expect(result.required_evidence).toEqual(
      expect.arrayContaining(["test_level_matrix", "oracle_matrix", "requirements_traceability"]),
    );
    expect(result.research_adoption.find((r) => r.pattern === "test-design")?.disposition).toBe(
      "incorporate",
    );
  });

  it("keeps UI/UX templates as reference evidence tied to screen and acceptance coverage", () => {
    const result = classifyProposalDocumentCoverage({
      text: "Use UX research, user journey map, persona, Figma prototype and usability test scenarios for a new screen.",
    });
    expect(result.patterns).toEqual(expect.arrayContaining(["screen-ui", "ux-research-usability"]));
    expect(result.required_design_docs.map((d) => d.id)).toEqual(
      expect.arrayContaining(["screen-flow", "wireframe", "nfr-grade"]),
    );
    expect(result.required_evidence).toEqual(
      expect.arrayContaining(["user_journey_map", "usability_test_plan", "ux_findings_trace"]),
    );
    expect(
      result.research_adoption.find((r) => r.pattern === "ux-research-usability")?.disposition,
    ).toBe("reference");
  });

  it("separates UT-TDD-specific workflow/agent coverage from external template adoption", () => {
    const result = classifyProposalDocumentCoverage({
      text: "Design an agent team run gate classifier for Codex and Claude handover.",
    });
    expect(result.patterns).toEqual(
      expect.arrayContaining(["workflow-gate", "agent-orchestration"]),
    );
    expect(result.research_adoption.find((r) => r.pattern === "workflow-gate")?.disposition).toBe(
      "ut-tdd-specific",
    );
    expect(
      result.research_adoption.find((r) => r.pattern === "agent-orchestration")?.not_incorporated,
    ).toContain("generic AI prompt template");
  });

  it("excludes marketing/vendor-only research inputs from design coverage", () => {
    const result = classifyProposalDocumentCoverage({
      text: "Use a vendor SDK sample and landing page SEO template as the proposal basis.",
    });
    expect(result.research_rejections.map((r) => r.pattern)).toEqual(
      expect.arrayContaining(["marketing-site-template", "vendor-specific-format"]),
    );
    expect(result.research_rejections.every((r) => r.disposition === "exclude")).toBe(true);
  });

  it("separates report output from generic batch coverage", () => {
    const result = classifyProposalDocumentCoverage({
      text: "Design a PDF report output and CSV export with sort, grouping, encoding and sample output validation.",
    });
    expect(result.patterns).toEqual(expect.arrayContaining(["batch-report", "report-output"]));
    expect(result.required_evidence).toEqual(
      expect.arrayContaining(["output_layout", "sort_and_grouping_rules", "format_encoding"]),
    );
    expect(result.research_adoption.find((r) => r.pattern === "report-output")?.disposition).toBe(
      "incorporate",
    );
  });

  it("requires async job and notification message coverage for queue-based delivery", () => {
    const result = classifyProposalDocumentCoverage({
      text: "Add an async message queue job that sends email notifications with retry, dead-letter and delivery failure handling.",
    });
    expect(result.patterns).toEqual(
      expect.arrayContaining(["async-job-flow", "notification-message"]),
    );
    expect(result.required_design_docs.map((d) => d.id)).toEqual(
      expect.arrayContaining(["external-if", "if-detail", "internal-processing"]),
    );
    expect(result.required_evidence).toEqual(
      expect.arrayContaining(["message_contract", "retry_dead_letter_policy", "recipient_rules"]),
    );
  });

  it("forces security/privacy and audit/observability work to G4 coverage", () => {
    const result = classifyProposalDocumentCoverage({
      text: "Change authentication authorization role permissions for PII and add audit log monitoring with redaction.",
    });
    expect(result.granularity).toBe("G4");
    expect(result.patterns).toEqual(
      expect.arrayContaining(["security-privacy", "error-observability-audit"]),
    );
    expect(result.required_evidence).toEqual(
      expect.arrayContaining(["role_permission_matrix", "audit_log_schema", "redaction_policy"]),
    );
    expect(result.required_gates).toEqual(
      expect.arrayContaining(["security-privacy-review", "error-observability-audit-review"]),
    );
  });

  it("treats session, token, RBAC, MFA, tenant, incident, and on-call terms as risk coverage", () => {
    const result = classifyProposalDocumentCoverage({
      text: "Update session token handling, RBAC, MFA and tenant isolation with redaction, incident response and on-call runbook.",
    });
    expect(result.granularity).toBe("G4");
    expect(result.patterns).toEqual(
      expect.arrayContaining([
        "security-privacy",
        "error-observability-audit",
        "ops-release-migration",
      ]),
    );
    expect(result.risk_flags).toEqual(
      expect.arrayContaining(["session", "token", "rbac", "mfa", "tenant", "incident"]),
    );
    expect(result.required_evidence).toEqual(
      expect.arrayContaining(["role_permission_matrix", "redaction_policy", "cutover_checklist"]),
    );
  });

  it("adds common component and release migration coverage for reusable runtime changes", () => {
    const result = classifyProposalDocumentCoverage({
      text: "Introduce a shared common component library with release deployment cutover rollback and migration rehearsal.",
    });
    expect(result.patterns).toEqual(
      expect.arrayContaining(["common-component", "ops-release-migration"]),
    );
    expect(result.required_design_docs.map((d) => d.id)).toEqual(
      expect.arrayContaining(["module-decomposition", "handover-mechanism", "physical-data"]),
    );
    expect(result.required_evidence).toEqual(
      expect.arrayContaining(["component_api_contract", "release_plan", "migration_rehearsal"]),
    );
  });

  it("matches Japanese template terms for report, async, notification, shared component, and operations", () => {
    const result = classifyProposalDocumentCoverage({
      text: "帳票設計とCSV出力、非同期キュー、メール通知、共通コンポーネント、移行ロールバックの運用を設計する。",
    });
    expect(result.patterns).toEqual(
      expect.arrayContaining([
        "batch-report",
        "report-output",
        "async-job-flow",
        "notification-message",
        "common-component",
        "ops-release-migration",
      ]),
    );
    expect(result.granularity).toBe("G4");
  });

  it("recommends mini/spark subagents for cheap parallel work without letting them shrink coverage", () => {
    const result = classifyProposalDocumentCoverage({
      text: "Rename a local docs helper and update README wording.",
    });
    expect(result.recommended_subagents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "docs",
          tier: "T2-mini",
          model: MODEL_IDS.codex.mini,
          parallelizable: true,
          parallel_slots: PROPOSAL_SUBAGENT_LANES["T2-mini"].max_parallel,
          closing_authority: false,
          ownership: PROPOSAL_SUBAGENT_LANES["T2-mini"].ownership,
        }),
        expect.objectContaining({
          role: "se",
          tier: "T2-spark",
          model: MODEL_IDS.codex.spark,
          parallelizable: true,
          parallel_slots: PROPOSAL_SUBAGENT_LANES["T2-spark"].max_parallel,
          closing_authority: false,
          ownership: PROPOSAL_SUBAGENT_LANES["T2-spark"].ownership,
        }),
      ]),
    );
    expect(result.guardrails).toContain("cheap-subagents-cannot-close-risk-or-shrink-coverage");
  });

  it("keeps risky work on gated high-tier judgement instead of cheap subagents", () => {
    const result = classifyProposalDocumentCoverage({
      text: "Change authentication permissions for PII migration and production rollout.",
    });
    expect(result.granularity).toBe("G4");
    expect(result.recommended_subagents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "qa",
          tier: "T0-frontier",
          model: MODEL_IDS.codex.frontier,
          parallelizable: false,
          parallel_slots: 1,
          closing_authority: true,
          ownership: PROPOSAL_SUBAGENT_LANES["T0-frontier"].ownership,
        }),
      ]),
    );
    expect(result.recommended_subagents.some((a) => a.tier === "T2-spark")).toBe(false);
  });

  it("keeps proposal subagent recommendation metadata stable", () => {
    const result = classifyProposalDocumentCoverage({
      text: "Research screen templates and API test design coverage.",
    });
    expect(result.recommended_subagents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "docs",
          tier: "T2-mini",
          parallel_slots: 4,
          closing_authority: false,
          guard: expect.stringContaining("cannot reduce required coverage"),
        }),
        expect.objectContaining({
          role: "se",
          tier: "T1-worker",
          parallel_slots: 2,
          closing_authority: false,
          ownership: expect.stringContaining("disjoint"),
        }),
      ]),
    );
  });
});
