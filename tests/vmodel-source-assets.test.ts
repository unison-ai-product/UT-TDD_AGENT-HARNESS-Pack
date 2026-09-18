import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = process.cwd();

function read(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function clean(value: string): string {
  return value.trim().replace(/^`|`$/g, "");
}

function tableRows(markdown: string, requiredHeaders: string[]): Array<Record<string, string>> {
  const lines = markdown.split(/\r?\n/);
  const rows: Array<Record<string, string>> = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = lines[index];
    const separator = lines[index + 1];
    if (!header.startsWith("|") || !separator.startsWith("|")) continue;
    const headers = header.split("|").slice(1, -1).map(clean);
    if (!requiredHeaders.every((required) => headers.includes(required))) continue;
    let rowIndex = index + 2;
    while (rowIndex < lines.length && lines[rowIndex].startsWith("|")) {
      const values = lines[rowIndex].split("|").slice(1, -1).map(clean);
      rows.push(Object.fromEntries(headers.map((key, column) => [key, values[column] ?? ""])));
      rowIndex += 1;
    }
  }
  return rows;
}

describe("checked Vモデル source assets", () => {
  const disposition = read("docs/governance/vmodel-document-disposition-catalog.md");
  const semanticItems = read("docs/governance/vmodel-semantic-item-catalog.md");
  const edges = read("docs/governance/vmodel-source-target-edges.md");
  const targetCatalog = read("docs/governance/vmodel-document-catalog.md");
  const profiles = read("docs/governance/vmodel-document-scale-profiles.md");
  const itemTargets = read("docs/governance/vmodel-item-target-ledger.md");

  it("U-VMSRC-001: 109 source documents are dispositioned exactly once", () => {
    const rows = tableRows(disposition, [
      "source_id",
      "disposition",
      "target",
      "profile / 判断理由",
    ]);
    const expected = Array.from(
      { length: 109 },
      (_, index) => `ZIP-DOC-${String(index + 1).padStart(3, "0")}`,
    );
    expect(rows.map((row) => row.source_id)).toEqual(expected);
    expect(new Set(rows.map((row) => row.source_id)).size).toBe(109);
    const allowed = new Set(["adopt", "merge", "reference", "defer", "not_applicable", "reject"]);
    expect(rows.filter((row) => !allowed.has(row.disposition))).toEqual([]);
    expect(rows.filter((row) => !row.target || !row["profile / 判断理由"])).toEqual([]);
  });

  it("U-VMSRC-002: 21 categories and 163 semantic items are complete and connected", () => {
    const categories = tableRows(semanticItems, ["category_id", "category_name"]);
    const items = tableRows(semanticItems, ["item_id", "category_id", "source_ref"]);
    expect(categories).toHaveLength(21);
    expect(new Set(categories.map((row) => row.category_id)).size).toBe(21);
    expect(items).toHaveLength(163);
    expect(new Set(items.map((row) => row.item_id)).size).toBe(163);
    const categoryIds = new Set(categories.map((row) => row.category_id));
    const sourceIds = new Set(
      tableRows(disposition, ["source_id", "disposition", "target"]).map((row) => row.source_id),
    );
    expect(items.filter((row) => !categoryIds.has(row.category_id))).toEqual([]);
    expect(
      items.filter((row) => row.source_ref !== "NO-SOURCE" && !sourceIds.has(row.source_ref)),
    ).toEqual([]);
    expect(items.filter((row) => row.source_ref === "NO-SOURCE").map((row) => row.item_id)).toEqual(
      ["iac"],
    );
  });

  it("U-VMSRC-003: typed target edges resolve without silent source omissions", () => {
    const sourceIds = tableRows(disposition, ["source_id", "disposition", "target"]).map(
      (row) => row.source_id,
    );
    const edgeRows = tableRows(edges, ["edge_id", "source_id", "target_type", "target_ref"]);
    const allowedTypes = new Set(["target_slot", "artifact_path", "artifact_family", "plan_alias"]);
    expect(new Set(edgeRows.map((row) => row.edge_id)).size).toBe(edgeRows.length);
    expect(edgeRows.filter((row) => !allowedTypes.has(row.target_type))).toEqual([]);
    const sourcesWithEdges = new Set(edgeRows.map((row) => row.source_id));
    expect(sourceIds.filter((sourceId) => !sourcesWithEdges.has(sourceId))).toEqual([]);

    const targetSlots = new Set(
      tableRows(targetCatalog, ["doc_type_id", "layer", "sub_doc"]).map((row) => row.doc_type_id),
    );
    for (const edge of edgeRows) {
      if (edge.target_type === "target_slot") expect(targetSlots.has(edge.target_ref)).toBe(true);
      if (edge.target_type === "artifact_path" || edge.target_type === "artifact_family") {
        expect(existsSync(resolve(repoRoot, edge.target_ref))).toBe(true);
      }
      if (edge.target_type === "plan_alias") {
        expect(existsSync(resolve(repoRoot, `docs/plans/${edge.target_ref}.md`))).toBe(true);
      }
    }
  });

  it("U-VMSRC-004: profile master has three size and five product definitions", () => {
    const definitions = tableRows(profiles, ["profile_id", "profile_axis", "profile_rank"]);
    expect(definitions).toHaveLength(8);
    expect(definitions.filter((row) => row.profile_axis === "size")).toHaveLength(3);
    expect(definitions.filter((row) => row.profile_axis === "product")).toHaveLength(5);
    const decisions = tableRows(profiles, ["profile_id", "doc_type_id", "decision"]);
    const decisionProfiles = new Set(decisions.map((row) => row.profile_id));
    for (const profile of definitions) expect(decisionProfiles.has(profile.profile_id)).toBe(true);
  });

  it("U-VMSRC-005: Forward FSM uses one exact authored state sequence", () => {
    const adr = read("docs/adr/ADR-008-forward-fsm-plan-asset-v2.md");
    const plan = read("docs/plans/PLAN-L4-23-forward-fsm-plan-asset-v2.md");
    const states = [
      "proposed",
      "planned",
      "pair_freeze_ready",
      "pair_frozen",
      "red_frozen",
      "implementing",
      "implementation_complete",
      "trace_freeze_ready",
      "trace_frozen",
      "review_ready",
      "reviewed",
      "accepted",
      "archived",
    ];
    const contract = YAML.parse(read("docs/process/vmodel-contract.yaml")) as {
      forward_workflow: { states: string[]; exception_states: string[] };
    };
    expect(contract.forward_workflow.states).toEqual(states);
    expect(contract.forward_workflow.exception_states).toEqual([
      "blocked",
      "superseded",
      "rejected",
      "reopened",
    ]);
    for (const state of states) {
      expect(adr).toContain(state);
      expect(plan).toContain(state);
    }
  });

  it("U-VMSRC-006: declarative V-model contract covers L0-L14 and G0.5/G1-G14 exactly once", () => {
    const contract = YAML.parse(read("docs/process/vmodel-contract.yaml")) as {
      forward_workflow: {
        pair_reciprocity_exceptions: string[];
        pair_reciprocity_exception_contracts: Array<{
          layer: string;
          reason: string;
          allowed_pair_layers: string[];
          required_backlinks: string[];
        }>;
      };
      layers: Array<{
        layer: string;
        gate: string;
        pair_layers: string[];
        required_artifacts: string[];
        evidence_families: string[];
        exit_criteria: string;
        defect_routing: string;
        verification_plan_id?: string;
        governance_artifact?: string;
        case_id_prefix?: string;
        evidence_manifest?: string;
      }>;
    };
    const expectedLayers = Array.from({ length: 15 }, (_, index) => `L${index}`);
    const expectedGates = ["G0.5", ...Array.from({ length: 14 }, (_, index) => `G${index + 1}`)];
    expect(contract.layers.map((entry) => entry.layer)).toEqual(expectedLayers);
    expect(contract.layers.map((entry) => entry.gate)).toEqual(expectedGates);
    expect(new Set(contract.layers.map((entry) => entry.layer)).size).toBe(15);
    expect(new Set(contract.layers.map((entry) => entry.gate)).size).toBe(15);
    for (const entry of contract.layers) {
      expect(entry.pair_layers.length).toBeGreaterThan(0);
      expect(entry.required_artifacts.length).toBeGreaterThan(0);
      expect(entry.evidence_families.length).toBeGreaterThan(0);
      expect(entry.exit_criteria).not.toBe("");
      expect(entry.defect_routing).not.toBe("");
      expect(entry.pair_layers.every((layer) => expectedLayers.includes(layer))).toBe(true);
    }
    const byLayer = new Map(contract.layers.map((entry) => [entry.layer, entry]));
    const exceptions = new Set(contract.forward_workflow.pair_reciprocity_exceptions);
    expect(contract.forward_workflow.pair_reciprocity_exception_contracts).toHaveLength(2);
    for (const exception of contract.forward_workflow.pair_reciprocity_exception_contracts) {
      expect(exceptions.has(exception.layer)).toBe(true);
      expect(exception.reason).not.toBe("");
      expect(exception.allowed_pair_layers).toEqual(byLayer.get(exception.layer)?.pair_layers);
      expect(exception.required_backlinks.length).toBeGreaterThan(0);
    }
    for (const entry of contract.layers) {
      if (exceptions.has(entry.layer)) continue;
      for (const pair of entry.pair_layers) {
        expect(byLayer.get(pair)?.pair_layers).toContain(entry.layer);
      }
    }
    for (const entry of contract.layers.filter((layer) => Number(layer.layer.slice(1)) >= 8)) {
      expect(entry.verification_plan_id).toMatch(`PLAN-${entry.layer}-`);
      expect(entry.governance_artifact).toMatch(/^docs\//);
      expect(entry.case_id_prefix).toMatch(/^[A-Z]+-$/);
      expect(entry.evidence_manifest).toMatch(/^\.ut-tdd\/evidence\//);
    }
  });

  it("U-VMSRC-007: all semantic items enter self-audit without false-green", () => {
    const assessment = read("docs/governance/vmodel-semantic-item-self-assessment.md");
    const rows = tableRows(assessment, ["item_id", "source_ref", "state"]);
    expect(rows).toHaveLength(163);
    expect(new Set(rows.map((row) => row.item_id)).size).toBe(163);
    expect(rows.every((row) => row.state === "pending_review")).toBe(true);
    expect(rows.filter((row) => row.state === "verified")).toEqual([]);
  });

  it("U-VMSRC-008: additive L1/L14 delta preserves the prior confirmed freeze", () => {
    const frozen = read("docs/plans/PLAN-L1-06-vmodel-upgrade-requirements.md");
    const delta = read("docs/plans/PLAN-L1-07-vmodel-engine-swap-requirements-delta.md");
    const frozenL1 = read("docs/design/harness/L1-requirements/vmodel-upgrade-requirements.md");
    const frozenL14 = read("docs/test-design/harness/L14-operational-test-design.md");
    const l1 = read("docs/design/harness/L1-requirements/vmodel-engine-swap-requirements-delta.md");
    const l14 = read("docs/test-design/harness/L14-vmodel-engine-swap-operational-test-design.md");
    expect(frozen).toMatch(/^---[\s\S]*?\nstatus: confirmed\n/);
    expect(delta).toMatch(/^---[\s\S]*?\nstatus: confirmed\n/);
    expect(l1).toMatch(/^---[\s\S]*?\nstatus: confirmed\n/);
    expect(l14).toMatch(/^---[\s\S]*?\nstatus: confirmed\n/);
    expect(frozenL1).toMatch(/^---[\s\S]*?\nstatus: confirmed\n/);
    expect(frozenL14).toMatch(/^---[\s\S]*?\nstatus: confirmed\n/);
    expect(l14).toContain("`PLAN-L1-07`のadditive L1 delta");
    expect(l14).not.toContain("PLAN-L1-06再凍結");
    expect(l14).not.toContain("PLAN-L1-06とVUP要件docをconfirmedへ戻さない");
  });

  it("U-VMSRC-009: planned oracle candidates keep kind-qualified unique identities", () => {
    const unitDesign = read("docs/test-design/harness/L7-unit-test-design.md");
    const candidateIds = [...unitDesign.matchAll(/`(CANDIDATE-[A-Z0-9-]+-[0-9]{3})`/g)].map(
      (match) => match[1],
    );
    expect(candidateIds.length).toBeGreaterThan(0);
    expect(new Set(candidateIds).size).toBe(candidateIds.length);
    expect(candidateIds).not.toContain("CANDIDATE-P-FSM-001");
    expect(unitDesign).toContain("| `P-FSM-001` |");
    expect(unitDesign).toContain("| `I-DISP-001` |");
    expect(candidateIds).toContain("CANDIDATE-I-SP-001");
    expect(candidateIds).toContain("CANDIDATE-M-SP-001");
  });

  it("U-VMSRC-010: all 163 semantic items have an explicit non-inferred target decision record", () => {
    const semanticRows = tableRows(semanticItems, ["item_id", "category_id", "source_ref"]);
    const targetRows = tableRows(itemTargets, [
      "edge_id",
      "item_id",
      "source_ref",
      "source_digest",
      "target_status",
      "target_kind",
      "target_ref",
      "判断理由",
      "plan_id",
    ]);
    expect(targetRows).toHaveLength(163);
    expect(new Set(targetRows.map((row) => row.item_id)).size).toBe(163);
    expect(new Set(targetRows.map((row) => row.edge_id)).size).toBe(163);
    expect(targetRows.map((row) => row.item_id).sort()).toEqual(
      semanticRows.map((row) => row.item_id).sort(),
    );
    const semanticSource = new Map(semanticRows.map((row) => [row.item_id, row.source_ref]));
    expect(targetRows.filter((row) => row.source_ref !== semanticSource.get(row.item_id))).toEqual(
      [],
    );
    const allowedStatuses = new Set([
      "pending_review",
      "adopt",
      "merge",
      "reference",
      "defer",
      "not_applicable",
      "reject",
    ]);
    expect(targetRows.filter((row) => !allowedStatuses.has(row.target_status))).toEqual([]);
    expect(targetRows.filter((row) => !/^ITEM-TARGET-[A-Z0-9-]+$/.test(row.edge_id))).toEqual([]);
    expect(targetRows.filter((row) => !/^[a-f0-9]{64}$/.test(row.source_digest))).toEqual([]);
    expect(targetRows.filter((row) => !row.判断理由 || !row.plan_id)).toEqual([]);
    expect(
      targetRows.filter(
        (row) =>
          row.target_status === "pending_review" &&
          (row.target_kind !== "—" || row.target_ref !== "—"),
      ),
    ).toEqual([]);
    expect(
      targetRows.filter(
        (row) =>
          ["adopt", "merge", "reference", "defer"].includes(row.target_status) &&
          (row.target_kind === "—" || row.target_ref === "—"),
      ),
    ).toEqual([]);
  });
});
