import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GitAuthoringProvenance } from "../../src/disposition/adapters/git-authoring-provenance.ts";
import { buildTrackedTargetRegistry } from "../../src/disposition/adapters/tracked-target-registry.ts";
import { loadTrackedCatalogInput } from "../../src/disposition/adapters/tracked-vmodel-loader.ts";
import { resolveCanonicalTarget } from "../../src/disposition/domain/target-resolver.ts";

const paths = [
  "docs/governance/vmodel-source-manifest.md",
  "docs/governance/vmodel-document-disposition-catalog.md",
  "docs/governance/vmodel-semantic-item-catalog.md",
  "docs/governance/vmodel-source-target-edges.md",
  "docs/governance/vmodel-item-target-ledger.md",
];

describe("tracked target registry", () => {
  it("resolves every authored source target against tracked canonical assets", () => {
    const bundle = Object.fromEntries(paths.map((path) => [path, readFileSync(path)]));
    const input = loadTrackedCatalogInput(
      bundle,
      new GitAuthoringProvenance(process.cwd()).receipts(paths),
    );
    const families = input.sourceTargetEdges
      .filter((edge) => edge.targetType === "artifact_family")
      .map((edge) => edge.targetRef);
    const registry = buildTrackedTargetRegistry(process.cwd(), families);
    const failures = input.sourceTargetEdges.flatMap((edge) => {
      const result = resolveCanonicalTarget(
        { kind: edge.targetType, ref: edge.targetRef },
        registry,
      );
      return result.ok ? [] : [{ edge: edge.edgeId, findings: result.findings }];
    });
    expect(failures).toEqual([]);
    expect(
      createHash("sha256")
        .update(JSON.stringify(input.sourceTargetEdges.map((edge) => edge.edgeId)))
        .digest("hex"),
    ).toMatch(/^[a-f0-9]{64}$/);
  });
});
