import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeLayerPairGate } from "../../src/gate/static.ts";
import { loadPairDocs } from "../../src/vmodel/lint.ts";
import { removeTestTree } from "./temp-tree.ts";

const roots: string[] = [];
export function cleanupTraceFixtures(): void {
  for (const dir of roots.splice(0)) removeTestTree(dir);
}

/** 読み取り専用の複製元の権限を引き継がないよう、内容だけを書き写す (missing は最初から書かない)。 */
function writeTree(from: string, to: string, rel: string, missing: string): void {
  mkdirSync(join(to, rel), { recursive: true });
  for (const entry of readdirSync(join(from, rel), { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) writeTree(from, to, child, missing);
    else if (child !== missing) writeFileSync(join(to, child), readFileSync(join(from, child)));
  }
}

/** (h): trace の対象文書 1 つだけを欠落させた、実 repo の design / test-design の複製。 */
export function copyDocsWithout(realRoot: string, missingDoc: string): string {
  const dir = mkdtempSync(join(tmpdir(), "planret-s7-h-"));
  roots.push(dir);
  for (const base of ["docs/design/harness", "docs/test-design/harness"]) {
    writeTree(realRoot, dir, base, missingDoc);
  }
  return dir;
}

/** layer-pair の判定そのもの (trace を含まない)。 */
export function layerPairOk(root: string, gate: "G1" | "G3", layer: "L1" | "L3"): boolean {
  return analyzeLayerPairGate(loadPairDocs(root), gate, {
    layer,
    l10PairPath: "docs/test-design/harness/L10-ux-validation-test-design.md",
  }).ok;
}
