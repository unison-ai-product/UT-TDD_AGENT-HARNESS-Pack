import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeL14CloseAudit,
  l14CloseAuditMessages,
  loadL14CloseAuditDocs,
} from "../src/lint/l14-close-audit.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const compliant = `# A-TEST

## L14 Close System Foundation Audit Matrix

| Item | Audit question | Current evidence | Gap / boundary | Next action | Status |
|---|---|---|---|---|---|
| workflow-definition | Workflow docs are coherent to L14. | \`docs/process/forward/L08-L14-verification-phase.md\`, \`docs/process/forward/overview.md\`, \`src/gate/right-arm-static.ts\`, \`tests/release-consumer-gates.test.ts\`, \`plans-archive-20261102:src/lint/roadmap-registry.ts\`, \`plans-archive-20261102:tests/roadmap.test.ts\` | none | keep doctor wired | \`closed\` |
| system-foundation | Core gates prove system foundation. | \`src/doctor/index.ts\`, \`tests/doctor.test.ts\`, \`src/lint/runtime-portability.ts\`, \`tests/runtime-portability.test.ts\`, \`package.json\` | none | keep doctor wired | \`closed\` |
| claude-codex-parity | Claude and Codex both work. | \`AGENTS.md\`, \`CLAUDE.md\`, \`.claude/CLAUDE.md\`, \`src/lint/codex-hook-adapter.ts\`, \`tests/codex-hook-adapter.test.ts\`, \`tests/runtime-hook-entrypoints.test.ts\` | Codex hosted/API tools cannot be repo-hook intercepted | keep hosted/API Codex preflight visible | \`partial\` |
| clean-distribution-package | Clean package can install. | \`src/setup/index.ts\`, \`tests/setup.test.ts\`, \`tests/distribution-acceptance.test.ts\`, \`docs/templates/adapter/.claude/settings.json\`, \`docs/templates/adapter/.codex/hooks.json\`, \`README.md\`, \`LICENSE\` | signed tarball signature is not published | record signature | \`external_required\` |
| version-up-nonbreaking | Version bump is nonbreaking. | \`src/setup/index.ts\`, \`tests/setup.test.ts\`, \`docs/process/modes/version-up.md\` | multi-version consumer upgrade is not proven | run tag-pin rollback smoke | \`external_required\` |
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
| release-publication-boundary | Release publication is controlled. | \`tests/l14-close-audit.test.ts\` | signed tarball signature is not published | record signature | \`external_required\` |
| green-evidence-integrity | Green evidence is trustworthy. | \`tests/l14-close-audit.test.ts\`, \`plans-archive-20261102:src/lint/green-command-digest.ts\`, \`plans-archive-20261102:tests/green-command-digest.test.ts\`, \`.ut-tdd/audit/A-155-green-command-digest-rebind-2026-07-01.md\`, \`.ut-tdd/audit/A-156-pack-repo-default-and-digest-rebind-2026-07-01.md\` | review Green evidence is moving to custody receipt and merge gate | retire the digest lint and strict flag; keep review Green evidence owned by the custody receipt and merge gate | \`partial\` |
`;

function createAuditFixture(content: string = compliant): string {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-l14-audit-fixture-"));
  const evidencePaths = new Set(
    [...compliant.matchAll(/`([^`]+)`/g)]
      .map((match) => match[1] ?? "")
      .filter(
        (path) =>
          !path.startsWith("docs/plans/") &&
          ([".ut-tdd/", ".claude/", ".codex/", "docs/", "src/", "tests/", ".github/"].some(
            (prefix) => path.startsWith(prefix),
          ) ||
            ["package.json", "LICENSE", "README.md", "AGENTS.md", "CLAUDE.md"].includes(path)),
      ),
  );
  for (const path of evidencePaths) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "fixture evidence\n");
  }
  const auditPath = join(root, ".ut-tdd", "audit", "A-143-l14-close-system-foundation-audit.md");
  mkdirSync(dirname(auditPath), { recursive: true });
  writeFileSync(auditPath, content);
  return root;
}

describe("l14-close-audit", () => {
  it("U-L14CLOSE-001: accepts the complete L14 close audit inventory", () => {
    const root = createAuditFixture();
    try {
      const result = analyzeL14CloseAudit([{ file: "A.md", content: compliant }], root);

      expect(result.ok).toBe(true);
      expect(result.rows).toHaveLength(17);
      expect(l14CloseAuditMessages(result)[0]).toContain("OK");
    } finally {
      removeTestTree(root);
    }
  });

  it("U-L14CLOSE-002: fails when an expected audit item is missing", () => {
    const root = createAuditFixture();
    try {
      const content = compliant.replace(
        "| green-evidence-integrity | Green evidence is trustworthy. | `tests/l14-close-audit.test.ts`, `plans-archive-20261102:src/lint/green-command-digest.ts`, `plans-archive-20261102:tests/green-command-digest.test.ts`, `.ut-tdd/audit/A-155-green-command-digest-rebind-2026-07-01.md`, `.ut-tdd/audit/A-156-pack-repo-default-and-digest-rebind-2026-07-01.md` | review Green evidence is moving to custody receipt and merge gate | retire the digest lint and strict flag; keep review Green evidence owned by the custody receipt and merge gate | `partial` |\n",
        "",
      );
      const result = analyzeL14CloseAudit([{ file: "A.md", content }], root);

      expect(result.ok).toBe(false);
      expect(result.violations).toContainEqual({
        file: "A.md",
        item: "green-evidence-integrity",
        reason: "missing_expected_item",
      });
    } finally {
      removeTestTree(root);
    }
  });

  it("U-L14CLOSE-003: fails open rows without a next action", () => {
    const root = createAuditFixture();
    try {
      const content = compliant.replace(
        "retire the digest lint and strict flag; keep review Green evidence owned by the custody receipt and merge gate | `partial`",
        "none | `partial`",
      );
      const result = analyzeL14CloseAudit([{ file: "A.md", content }], root);

      expect(result.ok).toBe(false);
      expect(result.violations).toContainEqual({
        file: "A.md",
        item: "green-evidence-integrity",
        reason: "open_without_next_action",
      });
    } finally {
      removeTestTree(root);
    }
  });

  it("U-L14CLOSE-004: fails evidence paths that do not exist", () => {
    const root = createAuditFixture();
    try {
      const content = compliant.replace(
        "`docs/process/forward/L08-L14-verification-phase.md`",
        "`docs/missing.md`",
      );
      const result = analyzeL14CloseAudit([{ file: "A.md", content }], root);

      expect(result.ok).toBe(false);
      expect(result.violations).toContainEqual({
        file: "A.md",
        item: "workflow-definition",
        reason: "missing_evidence_path",
      });
    } finally {
      removeTestTree(root);
    }
  });

  it("U-L14CLOSE-005: loads and validates the isolated A-143 audit item order", () => {
    const root = createAuditFixture();
    try {
      const docs = loadL14CloseAuditDocs(root);
      const result = analyzeL14CloseAudit(docs, root);

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
    } finally {
      removeTestTree(root);
    }
  });

  it("U-L14CLOSE-006: fails when item-specific required evidence is omitted", () => {
    const root = createAuditFixture();
    try {
      const content = compliant.replace(
        "`.ut-tdd/audit/A-155-green-command-digest-rebind-2026-07-01.md`, ",
        "",
      );
      const result = analyzeL14CloseAudit([{ file: "A.md", content }], root);

      expect(result.ok).toBe(false);
      expect(result.violations).toContainEqual({
        file: "A.md",
        item: "green-evidence-integrity",
        reason: "missing_required_evidence_path",
      });
    } finally {
      removeTestTree(root);
    }
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
      removeTestTree(root);
    }
  });

  it("U-L14CLOSE-008: fails boundary rows that drop the required external or human marker", () => {
    const root = createAuditFixture();
    try {
      const content = compliant.replace(
        "signed tarball signature is not published",
        "release work remains",
      );
      const result = analyzeL14CloseAudit([{ file: "A.md", content }], root);

      expect(result.ok).toBe(false);
      expect(result.violations).toContainEqual({
        file: "A.md",
        item: "clean-distribution-package",
        reason: "missing_boundary_marker",
      });
    } finally {
      removeTestTree(root);
    }
  });
});
