import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeL14CloseAudit,
  l14CloseAuditMessages,
  loadL14CloseAuditDocs,
} from "../src/lint/l14-close-audit";

const compliant = `# A-TEST

## L14 Close System Foundation Audit Matrix

| Item | Audit question | Current evidence | Gap / boundary | Next action | Status |
|---|---|---|---|---|---|
| workflow-definition | Workflow docs are coherent to L14. | \`docs/process/forward/L08-L14-verification-phase.md\`, \`docs/process/forward/overview.md\`, \`src/lint/roadmap-registry.ts\`, \`tests/roadmap.test.ts\` | none | keep doctor wired | \`closed\` |
| system-foundation | Core gates prove system foundation. | \`src/doctor/index.ts\`, \`tests/doctor.test.ts\`, \`src/lint/runtime-portability.ts\`, \`tests/runtime-portability.test.ts\`, \`package.json\` | none | keep doctor wired | \`closed\` |
| claude-codex-parity | Claude and Codex both work. | \`AGENTS.md\`, \`CLAUDE.md\`, \`.claude/CLAUDE.md\`, \`src/lint/codex-hook-adapter.ts\`, \`tests/codex-hook-adapter.test.ts\`, \`tests/runtime-hook-entrypoints.test.ts\` | Codex hosted/API tools cannot be repo-hook intercepted | keep hosted/API Codex preflight visible | \`partial\` |
| clean-distribution-package | Clean package can install. | \`src/setup/index.ts\`, \`tests/setup.test.ts\`, \`tests/distribution-acceptance.test.ts\`, \`docs/plans/PLAN-L7-157-distribution-clean-pull.md\`, \`docs/templates/adapter/.claude/settings.json\`, \`docs/templates/adapter/.codex/hooks.json\`, \`README.md\`, \`LICENSE\` | clean public repo and signed tarball are not published | require PO approval | \`external_required\` |
| version-up-nonbreaking | Version bump is nonbreaking. | \`src/setup/index.ts\`, \`tests/setup.test.ts\`, \`docs/process/modes/version-up.md\`, \`docs/plans/PLAN-REVERSE-140-forward-convergence-version-up-backfill.md\`, \`docs/plans/PLAN-L7-141-web-dashboard-component-derived.md\`, \`docs/plans/PLAN-L7-146-serverless-readonly-share.md\` | released tag does not exist | run tag-pin rollback smoke | \`external_required\` |
| brownfield-onboarding | Existing project is preserved. | \`src/setup/index.ts\`, \`tests/setup.test.ts\`, \`docs/templates/adapter/AGENTS.md\`, \`docs/templates/adapter/CLAUDE.md\`, \`docs/templates/adapter/.claude/settings.json\` | none | keep setup tests | \`closed\` |
| cross-project-test-workflow | Tests work outside dogfood repo. | \`tests/distribution-acceptance.test.ts\`, \`tests/runtime-portability.test.ts\`, \`src/setup/index.ts\`, \`.github/workflows/harness-check.yml\` | true external repo not mutated | run after publication | \`partial\` |
| l1-l2-mock-roundtrip | L2 mock feeds back into L1. | \`docs/design/harness/L2-screen/wireframe.md\`, \`docs/design/harness/L2-screen/screen-list.md\`, \`src/lint/screen-impl-pair-freeze.ts\`, \`src/lint/doc-consistency.ts\`, \`tests/screen-impl-pair-freeze.test.ts\`, \`tests/projection-writer.test.ts\` | prototype review not run | require L1 back-prop when high-fi exists | \`partial\` |
| l10-ux-close | L10 UX close is explicit. | \`docs/design/harness/L10-ux/visual-design.md\`, \`.ut-tdd/evidence/g10-ux/20260629-ux-minimum.json\`, \`src/lint/g10-ux-workflow.ts\`, \`tests/g10-ux-workflow.test.ts\`, \`tests/screen-impl-pair-freeze.test.ts\` | none | keep G10 workflow gate | \`closed\` |
| l11-uat-boundary | L11 UAT boundary is explicit. | \`tests/l14-close-audit.test.ts\` | PO UAT not run locally | require PO UAT evidence | \`human_required\` |
| l12-release-acceptance-boundary | L12 acceptance boundary is explicit. | \`tests/l14-close-audit.test.ts\` | approved release target and human signoff are missing | require release acceptance evidence | \`human_required\` |
| l13-post-deploy-boundary | L13 post-deploy boundary is explicit. | \`tests/l14-close-audit.test.ts\` | public consumer deployment is not available | after publication record post-deploy observation | \`external_required\` |
| l14-ops-feedback-boundary | L14 operational feedback boundary is explicit. | \`tests/l14-close-audit.test.ts\` | real operations data from a released consumer project is not available | feed post-release operations into feedback_events | \`partial\` |
| drive-model-bookbinding | Drive models merge back to V-model. | \`docs/design/harness/L4-basic-design/function.md\`, \`docs/process/modes/README.md\`, \`src/lint/forward-convergence.ts\`, \`tests/forward-convergence.test.ts\`, \`src/lint/drive-model-passage.ts\` | none | keep convergence lint | \`closed\` |
| l8-l14-right-arm | Right arm is locally closed. | \`tests/l14-close-audit.test.ts\` | PO final signoff and post-deploy evidence are external | PO signoff after post-deploy evidence | \`human_required\` |
| release-publication-boundary | Release publication is controlled. | \`tests/l14-close-audit.test.ts\` | clean GitHub repo, tag push, and signed tarball are not published | perform only after PO approval and record checksums plus signature | \`external_required\` |
| green-evidence-integrity | Green evidence is trustworthy. | \`tests/l14-close-audit.test.ts\`, \`src/lint/green-command-digest.ts\`, \`tests/green-command-digest.test.ts\`, \`docs/plans/PLAN-L7-132-green-command-digest-integrity.md\`, \`docs/plans/PLAN-L7-174-green-command-digest-correction.md\` | historical digest mismatch remains | correct before hardening | \`partial\` |
`;

describe("l14-close-audit", () => {
  it("U-L14CLOSE-001: accepts the complete L14 close audit inventory", () => {
    const result = analyzeL14CloseAudit([{ file: "A.md", content: compliant }], process.cwd());

    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(17);
    expect(l14CloseAuditMessages(result)[0]).toContain("OK");
  });

  it("U-L14CLOSE-002: fails when an expected audit item is missing", () => {
    const content = compliant.replace(
      "| green-evidence-integrity | Green evidence is trustworthy. | `tests/l14-close-audit.test.ts`, `src/lint/green-command-digest.ts`, `tests/green-command-digest.test.ts`, `docs/plans/PLAN-L7-132-green-command-digest-integrity.md`, `docs/plans/PLAN-L7-174-green-command-digest-correction.md` | historical digest mismatch remains | correct before hardening | `partial` |\n",
      "",
    );
    const result = analyzeL14CloseAudit([{ file: "A.md", content }], process.cwd());

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      file: "A.md",
      item: "green-evidence-integrity",
      reason: "missing_expected_item",
    });
  });

  it("U-L14CLOSE-003: fails open rows without a next action", () => {
    const content = compliant.replace("correct before hardening | `partial`", "none | `partial`");
    const result = analyzeL14CloseAudit([{ file: "A.md", content }], process.cwd());

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      file: "A.md",
      item: "green-evidence-integrity",
      reason: "open_without_next_action",
    });
  });

  it("U-L14CLOSE-004: fails evidence paths that do not exist", () => {
    const content = compliant.replace(
      "`docs/process/forward/L08-L14-verification-phase.md`",
      "`docs/missing.md`",
    );
    const result = analyzeL14CloseAudit([{ file: "A.md", content }], process.cwd());

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      file: "A.md",
      item: "workflow-definition",
      reason: "missing_evidence_path",
    });
  });

  it("U-L14CLOSE-005: loads and validates the current A-143 audit", () => {
    const docs = loadL14CloseAuditDocs(process.cwd());
    const result = analyzeL14CloseAudit(docs, process.cwd());

    expect(docs.length).toBeGreaterThan(0);
    expect(result.ok).toBe(true);
    expect(result.rows.map((row) => row.item)).toEqual([
      "workflow-definition",
      "system-foundation",
      "claude-codex-parity",
      "clean-distribution-package",
      "version-up-nonbreaking",
      "brownfield-onboarding",
      "cross-project-test-workflow",
      "l1-l2-mock-roundtrip",
      "l10-ux-close",
      "l11-uat-boundary",
      "l12-release-acceptance-boundary",
      "l13-post-deploy-boundary",
      "l14-ops-feedback-boundary",
      "drive-model-bookbinding",
      "l8-l14-right-arm",
      "release-publication-boundary",
      "green-evidence-integrity",
    ]);
  });

  it("U-L14CLOSE-006: fails when item-specific required evidence is omitted", () => {
    const content = compliant.replace(
      ", `docs/plans/PLAN-L7-174-green-command-digest-correction.md`",
      "",
    );
    const result = analyzeL14CloseAudit([{ file: "A.md", content }], process.cwd());

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      file: "A.md",
      item: "green-evidence-integrity",
      reason: "missing_required_evidence_path",
    });
  });

  it("U-L14CLOSE-007: reports missing audit file as a violation", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-l14-audit-"));
    try {
      mkdirSync(join(root, ".ut-tdd", "audit"), { recursive: true });
      writeFileSync(join(root, ".ut-tdd", "audit", ".gitkeep"), "");
      const docs = loadL14CloseAuditDocs(root);
      const result = analyzeL14CloseAudit(docs, root);

      expect(docs).toEqual([]);
      expect(result.ok).toBe(false);
      expect(l14CloseAuditMessages(result)[0]).toContain("A-143 audit not found");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-L14CLOSE-008: fails boundary rows that drop the required external or human marker", () => {
    const content = compliant.replace(
      "clean public repo and signed tarball are not published",
      "release work remains",
    );
    const result = analyzeL14CloseAudit([{ file: "A.md", content }], process.cwd());

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      file: "A.md",
      item: "clean-distribution-package",
      reason: "missing_boundary_marker",
    });
  });
});
