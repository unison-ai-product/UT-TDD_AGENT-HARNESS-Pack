import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeDesignDocCrossIntegrity,
  analyzeTypedSpecTraceClosure,
  collectSpecIrProjection,
  deriveSpecRagClosureEntries,
} from "../src/state-db/spec-ir-projections.ts";
import { removeTestTree } from "./support/temp-tree.ts";

function writeGovernanceDoc(root: string, name: string, body: string): void {
  const dir = join(root, "docs", "governance");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body, "utf8");
}

function writeMarkdown(root: string, relativePath: string, body: string): void {
  const path = join(root, relativePath);
  mkdirSync(path.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
  writeFileSync(path, body, "utf8");
}

describe("spec IR projections", () => {
  it("builds deterministic spec IR rows and routes orphan findings as non-ready candidates", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-spec-ir-"));
    try {
      writeMarkdown(
        root,
        "docs/design/harness/L6-function-design/function-spec.md",
        [
          "---",
          "layer: L6",
          "sub_doc: function-spec",
          "---",
          "# Spec IR fixture",
          "```yaml",
          "spec:",
          "  defines:",
          "    - id: FUNC-ORPHAN",
          "      kind: function",
          "      traces_from: [REQUIREMENT-MISSING]",
          "```",
        ].join("\n"),
      );

      const projection = collectSpecIrProjection(root, "2026-07-08T00:00:00.000Z");

      expect(projection.spec_defs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            owner_path: "docs/design/harness/L6-function-design/function-spec.md",
            layer: "L6",
            sub_doc: "function-spec",
            source_hash: expect.stringMatching(/^sha256:/),
          }),
        ]),
      );
      expect(projection.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "spec-ir-orphan-relation",
            evidence_path: "docs/design/harness/L6-function-design/function-spec.md",
          }),
        ]),
      );
      expect(projection.detector_route_candidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            detector_id: "spec-ir-integrity",
            filing_target_id: "routeFiling:feature_addition",
            target_layer: "L6",
            target_sub_doc: "function-spec",
            candidate_status: "non_ready",
          }),
        ]),
      );
    } finally {
      removeTestTree(root);
    }
  });

  it("joins document scale profile rows with the V-model document catalog", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-spec-ir-document-scale-profile-"));
    try {
      writeGovernanceDoc(
        root,
        "vmodel-document-catalog.md",
        [
          "# V-model document catalog",
          "",
          "| doc_type_id | layer | sub_doc | category | requirement_class | applicability | default_status | source_doc_family | authoring_source_path | projection_table | profile_controlled | skip_reason_required |",
          "|---|---|---|---|---|---|---|---|---|---|---|---|",
          "| DOC-L4-REPORT | L4 | report | deliverable | product-select | profile_controlled | skipped | vmodel-product-select | docs/governance/document-system-map.md#1b | document_catalog_entries | true | true |",
        ].join("\n"),
      );
      writeGovernanceDoc(
        root,
        "vmodel-document-scale-profiles.md",
        [
          "# V-model document scale profiles",
          "",
          "| profile_id | doc_type_id | decision | detail_override | status_override | reason | required_plan_id |",
          "|---|---|---|---|---|---|---|",
          "| enterprise | DOC-L4-REPORT | adopt | detailed | required | enterprise profile requires report/audit output design. | PLAN-L4-999-report-slot |",
        ].join("\n"),
      );

      const projection = collectSpecIrProjection(root, "2026-07-09T00:00:00.000Z");

      expect(projection.document_scale_profile_entries).toEqual([
        expect.objectContaining({
          profile_id: "enterprise",
          doc_type_id: "DOC-L4-REPORT",
          decision: "adopt",
          detail_override: "detailed",
          status_override: "required",
          required_plan_id: null,
          source_path: "docs/governance/vmodel-document-scale-profiles.md",
        }),
      ]);
      expect(projection.document_scale_profile_reviews).toEqual([
        expect.objectContaining({
          profile_id: "enterprise",
          doc_type_id: "DOC-L4-REPORT",
          decision: "adopt",
          catalog_layer: "L4",
          catalog_sub_doc: "report",
          requirement_class: "product-select",
          catalog_default_status: "skipped",
          catalog_profile_controlled: 1,
          catalog_skip_reason_required: 1,
        }),
      ]);
    } finally {
      removeTestTree(root);
    }
  });

  it("turns malformed document scale profile rows into integrity findings", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-spec-ir-document-scale-profile-bad-"));
    try {
      writeGovernanceDoc(
        root,
        "vmodel-document-catalog.md",
        [
          "# V-model document catalog",
          "",
          "| doc_type_id | layer | sub_doc | category | requirement_class | applicability | default_status | source_doc_family | authoring_source_path | projection_table | profile_controlled | skip_reason_required |",
          "|---|---|---|---|---|---|---|---|---|---|---|---|",
          "| DOC-L4-REPORT | L4 | report | deliverable | product-select | profile_controlled | skipped | vmodel-product-select | docs/governance/document-system-map.md#1b | document_catalog_entries | true | true |",
        ].join("\n"),
      );
      writeGovernanceDoc(
        root,
        "vmodel-document-scale-profiles.md",
        [
          "# V-model document scale profiles",
          "",
          "| profile_id | doc_type_id | decision | detail_override | status_override | reason | required_plan_id |",
          "|---|---|---|---|---|---|---|",
          "| poc | DOC-L4-REPORT | skip | compact | skipped |  | PLAN-L4-999-missing |",
          "| enterprise | DOC-L4-MISSING | adopt | detailed | required | missing catalog row fixture. |  |",
        ].join("\n"),
      );

      const projection = collectSpecIrProjection(root, "2026-07-09T00:00:00.000Z");

      expect(projection.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "document-scale-profile-detail-unknown" }),
          expect.objectContaining({ kind: "document-scale-profile-reason-missing" }),
          expect.objectContaining({ kind: "document-scale-profile-catalog-reason-missing" }),
          expect.objectContaining({ kind: "document-scale-profile-catalog-missing" }),
        ]),
      );
    } finally {
      removeTestTree(root);
    }
  });

  it("detects duplicate typed spec definitions across design documents", () => {
    const defs = [
      {
        spec_id: "VMS-DUP",
        spec_kind: "contract",
        layer: "L4",
        sub_doc: "data",
        owner_artifact_id: "a",
        owner_path: "docs/design/harness/L4-basic-design/data.md",
        section_anchor: "spec.defines:VMS-DUP",
        title: "VMS-DUP contract",
        lifecycle_status: "active",
        plan_id: "",
        source_path: "docs/design/harness/L4-basic-design/data.md",
        source_hash: "sha256:a",
        indexed_at: "2026-07-09T00:00:00.000Z",
      },
      {
        spec_id: "VMS-DUP",
        spec_kind: "contract",
        layer: "L4",
        sub_doc: "function",
        owner_artifact_id: "b",
        owner_path: "docs/design/harness/L4-basic-design/function.md",
        section_anchor: "spec.defines:VMS-DUP",
        title: "VMS-DUP contract duplicate",
        lifecycle_status: "active",
        plan_id: "",
        source_path: "docs/design/harness/L4-basic-design/function.md",
        source_hash: "sha256:b",
        indexed_at: "2026-07-09T00:00:00.000Z",
      },
    ];

    const result = analyzeDesignDocCrossIntegrity({
      defs,
      relations: [],
      catalog_entries: [],
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "design-doc-duplicate-definition",
          subject_id: "VMS-DUP",
        }),
      ]),
    );
  });

  it("detects design document dependency cycles while ignoring same-document self references", () => {
    const indexedAt = "2026-07-09T00:00:00.000Z";
    const defs = [
      {
        spec_id: "VMS-A",
        spec_kind: "contract",
        layer: "L4",
        sub_doc: "data",
        owner_artifact_id: "a",
        owner_path: "docs/design/harness/L4-basic-design/data.md",
        section_anchor: "spec.defines:VMS-A",
        title: "A",
        lifecycle_status: "active",
        plan_id: "",
        source_path: "docs/design/harness/L4-basic-design/data.md",
        source_hash: "sha256:a",
        indexed_at: indexedAt,
      },
      {
        spec_id: "VMS-B",
        spec_kind: "contract",
        layer: "L4",
        sub_doc: "function",
        owner_artifact_id: "b",
        owner_path: "docs/design/harness/L4-basic-design/function.md",
        section_anchor: "spec.defines:VMS-B",
        title: "B",
        lifecycle_status: "active",
        plan_id: "",
        source_path: "docs/design/harness/L4-basic-design/function.md",
        source_hash: "sha256:b",
        indexed_at: indexedAt,
      },
      {
        spec_id: "VMS-C",
        spec_kind: "contract",
        layer: "L4",
        sub_doc: "function",
        owner_artifact_id: "c",
        owner_path: "docs/design/harness/L4-basic-design/function.md",
        section_anchor: "spec.defines:VMS-C",
        title: "C",
        lifecycle_status: "active",
        plan_id: "",
        source_path: "docs/design/harness/L4-basic-design/function.md",
        source_hash: "sha256:c",
        indexed_at: indexedAt,
      },
    ];
    const relations = [
      {
        relation_id: "r1",
        from_spec_id: "VMS-A",
        to_spec_id: "VMS-B",
        relation_kind: "traces_to",
        plan_id: "",
        status: "active",
        source: "docs/design/harness/L4-basic-design/data.md",
        evidence_path: "VMS-B",
        indexed_at: indexedAt,
      },
      {
        relation_id: "r2",
        from_spec_id: "VMS-B",
        to_spec_id: "VMS-A",
        relation_kind: "traces_to",
        plan_id: "",
        status: "active",
        source: "docs/design/harness/L4-basic-design/function.md",
        evidence_path: "VMS-A",
        indexed_at: indexedAt,
      },
      {
        relation_id: "r3",
        from_spec_id: "VMS-B",
        to_spec_id: "VMS-C",
        relation_kind: "traces_to",
        plan_id: "",
        status: "active",
        source: "docs/design/harness/L4-basic-design/function.md",
        evidence_path: "VMS-C",
        indexed_at: indexedAt,
      },
    ];

    const result = analyzeDesignDocCrossIntegrity({
      defs,
      relations,
      catalog_entries: [],
    });

    expect(result.dependency_cycles).toHaveLength(1);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "design-doc-dependency-cycle",
          subject_id:
            "docs/design/harness/L4-basic-design/data.md -> docs/design/harness/L4-basic-design/function.md -> docs/design/harness/L4-basic-design/data.md",
        }),
      ]),
    );
  });

  it("projects typed spec.defines declarations and declaration trace edges", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-spec-ir-typed-"));
    try {
      writeGovernanceDoc(
        root,
        "vmodel-typed-spec-definitions.md",
        [
          "---",
          "title: Typed spec fixture",
          "status: confirmed",
          "typed_spec_phase_owner: L6",
          "---",
          "",
          "# Typed spec fixture",
          "",
          "```yaml",
          "spec:",
          "  defines:",
          "    - id: VMS-101",
          "      kind: typed-source",
          "      traces_to: [VMS-102]",
          "      tests: [TVMS-101]",
          "    - id: VMS-102",
          "      kind: typed-projection",
          "      traces_from: [VMS-101]",
          "      tests: [TVMS-102]",
          "    - id: TVMS-101",
          "      kind: unit-oracle",
          "      traces_from: [VMS-101]",
          "    - id: TVMS-102",
          "      kind: unit-oracle",
          "      traces_from: [VMS-102]",
          "```",
          "",
          "| spec_id | ledger_sources | v_phase |",
          "| --- | --- | --- |",
          "| VMS-101 | docs/governance/vmodel-typed-spec-definitions.md | L6 |",
          "| VMS-102 | docs/governance/vmodel-typed-spec-definitions.md | L7 |",
          "| TVMS-101 | docs/governance/vmodel-typed-spec-definitions.md | L7 |",
          "| TVMS-102 | docs/governance/vmodel-typed-spec-definitions.md | L7 |",
          "",
          "VMS-101 body anchor.",
          "VMS-102 body anchor.",
          "TVMS-101 body anchor.",
          "TVMS-102 body anchor.",
        ].join("\n"),
      );

      const projection = collectSpecIrProjection(root, "2026-07-08T00:00:00.000Z");

      expect(projection.spec_defs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            spec_id: "VMS-101",
            spec_kind: "typed-source",
            section_anchor: "spec.defines:VMS-101",
            owner_artifact_id: "VMS-101",
            source_path: "docs/governance/vmodel-typed-spec-definitions.md",
          }),
          expect.objectContaining({
            spec_id: "TVMS-101",
            spec_kind: "unit-oracle",
            section_anchor: "spec.defines:TVMS-101",
          }),
        ]),
      );
      expect(projection.spec_relations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from_spec_id: "VMS-101",
            to_spec_id: "VMS-102",
            relation_kind: "traces_to",
          }),
          expect.objectContaining({
            from_spec_id: "VMS-101",
            to_spec_id: "TVMS-101",
            relation_kind: "tests",
          }),
          expect.objectContaining({
            from_spec_id: "TVMS-101",
            to_spec_id: "VMS-101",
            relation_kind: "traces_from",
          }),
          expect.objectContaining({
            from_spec_id: "VMS-102",
            to_spec_id: "TVMS-102",
            relation_kind: "tests",
          }),
        ]),
      );
      expect(projection.findings).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "typed-spec-trace-reverse-missing" }),
          expect.objectContaining({ kind: "typed-spec-test-backlink-missing" }),
          expect.objectContaining({ kind: "typed-spec-test-missing" }),
          expect.objectContaining({ kind: "typed-spec-body-missing" }),
          expect.objectContaining({ kind: "typed-spec-ledger-row-missing" }),
          expect.objectContaining({ kind: "typed-spec-phase-direction-invalid" }),
          expect.objectContaining({ kind: "typed-spec-owned-source-mismatch" }),
          expect.objectContaining({ kind: "typed-spec-owner-phase-missing" }),
          expect.objectContaining({ kind: "typed-spec-phase-layer-mismatch" }),
        ]),
      );
    } finally {
      removeTestTree(root);
    }
  });

  it("derives spec RAG closure entries from typed spec relations", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-spec-rag-"));
    try {
      writeGovernanceDoc(
        root,
        "vmodel-typed-spec-definitions.md",
        [
          "# Typed spec RAG fixture",
          "",
          "```yaml",
          "spec:",
          "  defines:",
          "    - id: VMS-301",
          "      kind: typed-source",
          "      traces_to: [VMS-302]",
          "      tests: [TVMS-301]",
          "    - id: VMS-302",
          "      kind: typed-projection",
          "      traces_from: [VMS-301]",
          "      tests: [TVMS-302]",
          "    - id: VMS-303",
          "      kind: typed-source",
          "    - id: TVMS-301",
          "      kind: unit-oracle",
          "      traces_from: [VMS-301]",
          "    - id: TVMS-302",
          "      kind: unit-oracle",
          "      traces_from: [VMS-302]",
          "```",
        ].join("\n"),
      );
      const projection = collectSpecIrProjection(root, "2026-07-08T00:00:00.000Z");
      const traceClosure = analyzeTypedSpecTraceClosure({
        defs: projection.spec_defs,
        relations: projection.spec_relations,
      });
      const entries = deriveSpecRagClosureEntries({
        defs: projection.spec_defs,
        relations: projection.spec_relations,
        closureFindings: traceClosure.findings,
        indexedAt: "2026-07-08T00:00:00.000Z",
      });

      expect(entries.find((entry) => entry.spec_id === "VMS-301")).toMatchObject({
        rag: "green",
        closure_status: "closed",
        requires_test: 1,
        finding_count: 0,
      });
      expect(entries.find((entry) => entry.spec_id === "VMS-303")).toMatchObject({
        rag: "red",
        closure_status: "missing_test",
        requires_test: 1,
        test_count: 0,
      });
    } finally {
      removeTestTree(root);
    }
  });

  it("turns typed spec trace closure gaps into integrity findings", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-spec-ir-typed-closure-"));
    try {
      writeGovernanceDoc(
        root,
        "vmodel-typed-spec-definitions.md",
        [
          "# Typed spec closure bad fixture",
          "",
          "```yaml",
          "spec:",
          "  defines:",
          "    - id: VMS-201",
          "      kind: typed-source",
          "      traces_to: [VMS-202]",
          "      tests: [TVMS-201]",
          "    - id: VMS-202",
          "      kind: typed-projection",
          "    - id: TVMS-201",
          "      kind: unit-oracle",
          "```",
        ].join("\n"),
      );

      const projection = collectSpecIrProjection(root, "2026-07-08T00:00:00.000Z");

      expect(projection.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "typed-spec-trace-reverse-missing",
            subject_id: "VMS-201:traces_to:VMS-202",
          }),
          expect.objectContaining({
            kind: "typed-spec-test-backlink-missing",
            subject_id: "VMS-201:tests:TVMS-201",
          }),
          expect.objectContaining({
            kind: "typed-spec-test-missing",
            subject_id: "VMS-202",
          }),
        ]),
      );
    } finally {
      removeTestTree(root);
    }
  });

  it("turns typed spec ledger, body, and phase drift into integrity findings", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-spec-ir-typed-ledger-"));
    try {
      writeGovernanceDoc(
        root,
        "vmodel-typed-spec-definitions.md",
        [
          "# Typed spec ledger bad fixture",
          "",
          "```yaml",
          "spec:",
          "  defines:",
          "    - id: VMS-301",
          "      kind: typed-source",
          "      traces_from: [VMS-302]",
          "      tests: [TVMS-301]",
          "    - id: VMS-302",
          "      kind: typed-projection",
          "      tests: [TVMS-302]",
          "    - id: TVMS-301",
          "      kind: unit-oracle",
          "      traces_from: [VMS-301]",
          "    - id: TVMS-302",
          "      kind: unit-oracle",
          "      traces_from: [VMS-302]",
          "```",
          "",
          "| spec_id | ledger_sources | v_phase |",
          "| --- | --- | --- |",
          "| VMS-301 | docs/plans/PLAN-L6-301.md | L6 |",
          "| VMS-302 | docs/plans/PLAN-L7-302.md | L7 |",
          "| VMS-302 | docs/plans/PLAN-L7-302.md | L7 |",
          "| TVMS-301 | docs/test-design/harness/L7-unit-test-design.md | L7 |",
          "| TVMS-999 | docs/test-design/harness/L7-unit-test-design.md | L7 |",
          "",
          "VMS-301 body anchor.",
          "VMS-302 body anchor.",
          "TVMS-301 body anchor.",
        ].join("\n"),
      );

      const projection = collectSpecIrProjection(root, "2026-07-08T00:00:00.000Z");

      expect(projection.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "typed-spec-ledger-row-missing",
            subject_id: "TVMS-302",
          }),
          expect.objectContaining({ kind: "typed-spec-body-missing", subject_id: "TVMS-302" }),
          expect.objectContaining({ kind: "typed-spec-ledger-unknown-id", subject_id: "TVMS-999" }),
          expect.objectContaining({
            kind: "typed-spec-ledger-duplicate-id",
            subject_id: "VMS-302",
          }),
          expect.objectContaining({
            kind: "typed-spec-phase-direction-invalid",
            subject_id: "VMS-301:traces_from:VMS-302",
          }),
        ]),
      );
    } finally {
      removeTestTree(root);
    }
  });

  it("turns centralized typed spec declarations into owned artifact mismatch findings", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-spec-ir-typed-owned-"));
    try {
      writeGovernanceDoc(
        root,
        "vmodel-typed-spec-definitions.md",
        [
          "# Typed spec ownership bad fixture",
          "",
          "```yaml",
          "spec:",
          "  defines:",
          "    - id: VMS-501",
          "      kind: typed-source",
          "```",
          "",
          "| spec_id | ledger_sources | v_phase |",
          "| --- | --- | --- |",
          "| VMS-501 | docs/plans/PLAN-L6-501.md | L6 |",
          "",
          "VMS-501 body anchor.",
        ].join("\n"),
      );

      const projection = collectSpecIrProjection(root, "2026-07-08T00:00:00.000Z");

      expect(projection.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "typed-spec-owned-source-mismatch",
            subject_id: "VMS-501",
            evidence_path: "docs/governance/vmodel-typed-spec-definitions.md",
          }),
        ]),
      );
    } finally {
      removeTestTree(root);
    }
  });

  it("turns typed spec v_phase and owner artifact layer drift into integrity findings", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-spec-ir-typed-phase-layer-"));
    try {
      writeGovernanceDoc(
        root,
        "vmodel-typed-spec-definitions.md",
        [
          "---",
          "title: Typed spec phase layer bad fixture",
          "status: confirmed",
          "typed_spec_phase_owner: L5",
          "---",
          "",
          "# Typed spec phase/layer bad fixture",
          "",
          "```yaml",
          "spec:",
          "  defines:",
          "    - id: VMS-601",
          "      kind: typed-source",
          "```",
          "",
          "| spec_id | ledger_sources | v_phase |",
          "| --- | --- | --- |",
          "| VMS-601 | docs/governance/vmodel-typed-spec-definitions.md | L6 |",
          "",
          "VMS-601 body anchor.",
        ].join("\n"),
      );

      const projection = collectSpecIrProjection(root, "2026-07-08T00:00:00.000Z");

      expect(projection.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "typed-spec-phase-layer-mismatch",
            subject_id: "VMS-601:v_phase:L6:owner:L5",
            evidence_path: "docs/governance/vmodel-typed-spec-definitions.md",
          }),
        ]),
      );
    } finally {
      removeTestTree(root);
    }
  });

  it("projects V-model agent contracts as authoring source contracts", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-spec-ir-agent-contract-"));
    try {
      writeGovernanceDoc(root, "vmodel-document-catalog.md", "# Document catalog\n");
      writeGovernanceDoc(root, "vmodel-typed-spec-definitions.md", "# Typed spec\n");
      writeGovernanceDoc(
        root,
        "vmodel-agent-contracts.md",
        [
          "# Agent contracts",
          "",
          "```yaml",
          "agent_contracts:",
          "  - contract_id: VAGENT-101",
          "    target_path: docs/governance/vmodel-typed-spec-definitions.md",
          "    defines: [VMS-101]",
          "    read_first:",
          "      - docs/governance/vmodel-document-catalog.md",
          "    done_when:",
          "      - doctor:typed-spec-trace-closure",
          "```",
        ].join("\n"),
      );

      const projection = collectSpecIrProjection(root, "2026-07-08T00:00:00.000Z");

      expect(projection.agent_contracts).toEqual([
        expect.objectContaining({
          agent_contract_id: "VAGENT-101",
          target_path: "docs/governance/vmodel-typed-spec-definitions.md",
          defines: "VMS-101",
          read_first: "docs/governance/vmodel-document-catalog.md",
          done_when: "doctor:typed-spec-trace-closure",
          source_path: "docs/governance/vmodel-agent-contracts.md",
        }),
      ]);
      expect(projection.findings).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: expect.stringMatching(/^agent-contract-/) }),
        ]),
      );
    } finally {
      removeTestTree(root);
    }
  });

  it("turns malformed V-model agent contracts into integrity findings", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-spec-ir-agent-contract-bad-"));
    try {
      writeGovernanceDoc(root, "vmodel-typed-spec-definitions.md", "# Typed spec\n");
      writeGovernanceDoc(
        root,
        "vmodel-agent-contracts.md",
        [
          "# Agent contracts",
          "",
          "```yaml",
          "agent_contracts:",
          "  - contract_id: VAGENT-201",
          "    target_path: docs/governance/vmodel-typed-spec-definitions.md",
          "    defines: [VMS-201]",
          "    read_first:",
          "      - docs/governance/missing-first.md",
          "    done_when:",
          "      - python tools/build.py detect",
          "```",
        ].join("\n"),
      );

      const projection = collectSpecIrProjection(root, "2026-07-08T00:00:00.000Z");

      expect(projection.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "agent-contract-read-first-missing",
            subject_id: "VAGENT-201:docs/governance/missing-first.md",
          }),
          expect.objectContaining({
            kind: "agent-contract-done-when-invalid",
            subject_id: "VAGENT-201:python tools/build.py detect",
          }),
        ]),
      );
    } finally {
      removeTestTree(root);
    }
  });

  it("turns malformed typed spec declarations into integrity findings", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-spec-ir-typed-bad-"));
    try {
      writeGovernanceDoc(
        root,
        "vmodel-typed-spec-definitions.md",
        [
          "# Typed spec bad fixture",
          "",
          "```yaml",
          "spec:",
          "  defines:",
          "    - id: bad id",
          "      traces_to: [MISSING-001]",
          "    - id: DUP-001",
          "      kind: one",
          "    - id: DUP-001",
          "      kind: two",
          "```",
        ].join("\n"),
      );

      const projection = collectSpecIrProjection(root, "2026-07-08T00:00:00.000Z");

      expect(projection.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "typed-spec-invalid-id" }),
          expect.objectContaining({ kind: "typed-spec-kind-missing" }),
          expect.objectContaining({ kind: "typed-spec-duplicate-id" }),
          expect.objectContaining({ kind: "spec-ir-orphan-relation" }),
        ]),
      );
    } finally {
      removeTestTree(root);
    }
  });

  it("scopes invalid sub_doc findings to design document catalog rows", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-spec-ir-subdoc-scope-"));
    try {
      writeMarkdown(
        root,
        "docs/design/harness/L6-function-design/not-a-design-subdoc.md",
        [
          "---",
          "layer: L6",
          "sub_doc: not-a-design-subdoc",
          "status: confirmed",
          "---",
          "",
          "# Invalid design subdoc fixture",
          "## 日本語見出し",
        ].join("\n"),
      );

      const projection = collectSpecIrProjection(root, "2026-07-09T00:00:00.000Z");
      const invalidSubDocFindings = projection.findings.filter(
        (finding) => finding.kind === "spec-ir-invalid-subdoc",
      );

      expect(invalidSubDocFindings).toHaveLength(1);
      expect(invalidSubDocFindings[0]).toEqual(
        expect.objectContaining({
          subject_id: expect.stringContaining("not-a-design-subdoc.md-document"),
          evidence_path: "docs/design/harness/L6-function-design/not-a-design-subdoc.md",
        }),
      );
    } finally {
      removeTestTree(root);
    }
  });

  it("excludes meta docs from sub_doc validation", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-spec-ir-detector-scope-"));
    try {
      writeMarkdown(
        root,
        "docs/design/harness/L6-function-design/README.md",
        ["---", "layer: L6", "doc_type: index", "status: confirmed", "---", "", "# Index"].join(
          "\n",
        ),
      );
      writeMarkdown(
        root,
        "docs/design/harness/L3-functional/roadmap.md",
        [
          "---",
          "layer: L3",
          "doc_type: verification-roadmap",
          "status: confirmed",
          "---",
          "",
          "# Roadmap",
        ].join("\n"),
      );
      const projection = collectSpecIrProjection(root, "2026-07-13T00:00:00.000Z");

      expect(
        projection.findings.filter((finding) => finding.kind === "spec-ir-invalid-subdoc"),
      ).toEqual([]);
      expect(projection.spec_defs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            owner_path: "docs/design/harness/L6-function-design/README.md",
            spec_kind: "design_meta_doc",
          }),
          expect.objectContaining({
            owner_path: "docs/design/harness/L3-functional/roadmap.md",
            spec_kind: "design_meta_doc",
          }),
        ]),
      );
    } finally {
      removeTestTree(root);
    }
  });

  it("resolves document references from typed relations and ignores retired sources", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-spec-ir-relation-scope-"));
    try {
      const referencePath = "docs/governance/reference-fixture.md";
      const schedulePath = "docs/governance/vmodel-upgrade-schedule.md";
      const activationPath = "docs/governance/vmodel-activation-profiles.md";
      const planPath = "docs/plans/PLAN-L7-66-reference-fixture.md";
      for (const path of [referencePath, schedulePath, activationPath, planPath]) {
        writeMarkdown(root, path, "# Reference fixture");
      }
      writeMarkdown(
        root,
        "docs/design/harness/L6-function-design/function-spec.md",
        [
          "# Function fixture",
          "```yaml",
          "spec:",
          "  defines:",
          "    - id: FUNC-REFERENCE",
          "      kind: function",
          "      traces_from:",
          ...[referencePath, schedulePath, activationPath, planPath].map(
            (path) => "        - " + path,
          ),
          "```",
        ].join("\n"),
      );

      const projection = collectSpecIrProjection(root, "2026-07-09T00:00:00.000Z");
      const reference = projection.spec_defs.find((def) => def.owner_path === referencePath);
      expect(reference?.spec_kind).toBe("reference_doc");
      expect(projection.spec_relations).toEqual([
        expect.objectContaining({
          from_spec_id: "FUNC-REFERENCE",
          to_spec_id: reference?.spec_id,
          relation_kind: "traces_from",
          evidence_path: referencePath,
        }),
      ]);
      expect(
        projection.findings.filter((finding) => finding.kind === "spec-ir-orphan-relation"),
      ).toHaveLength(3);
      for (const path of [schedulePath, activationPath, planPath]) {
        expect(projection.spec_defs.some((def) => def.owner_path === path)).toBe(false);
      }
    } finally {
      removeTestTree(root);
    }
  });

  it("keeps unicode-derived section spec IDs distinct when ASCII sanitization would collide", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-spec-ir-unicode-id-"));
    try {
      writeMarkdown(
        root,
        "docs/design/harness/L6-function-design/unicode-section-fixture.md",
        [
          "---",
          "layer: L6",
          "sub_doc: function-spec",
          "status: confirmed",
          "---",
          "",
          "# Unicode section fixture",
          "",
          "## 設計",
          "",
          "## 試験",
        ].join("\n"),
      );

      const projection = collectSpecIrProjection(root, "2026-07-09T00:00:00.000Z");
      const sectionIds = projection.spec_defs
        .filter(
          (def) =>
            def.owner_path ===
              "docs/design/harness/L6-function-design/unicode-section-fixture.md" &&
            def.spec_kind === "section" &&
            ["設計", "試験"].includes(def.title),
        )
        .map((def) => def.spec_id);

      expect(sectionIds).toHaveLength(2);
      expect(new Set(sectionIds).size).toBe(2);
      expect(sectionIds.every((id) => /--[a-f0-9]{12}$/.test(id))).toBe(true);
    } finally {
      removeTestTree(root);
    }
  });
});
