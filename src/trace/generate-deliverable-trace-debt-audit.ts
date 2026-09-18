import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeArtifactOwnership } from "../lint/artifact-ownership.ts";
import {
  analyzeDeliverablePlanTrace,
  loadDeliverablePlanTraceInput,
} from "../lint/deliverable-plan-trace.ts";

const repoRoot = process.cwd();
const input = loadDeliverablePlanTraceInput(repoRoot);
const orphanPaths = analyzeDeliverablePlanTrace({
  artifactFiles: input.artifactFiles,
  tracedPaths: input.tracedPaths,
  baseline: new Map(),
})
  .findings.filter((finding) => finding.kind === "orphan-deliverable")
  .map((finding) => finding.artifactPath);
const duplicatePaths = analyzeArtifactOwnership({
  ownersByPath: input.ownersByPath,
  baseline: new Set(),
}).findings.map((finding) => finding.artifactPath);
const owner = "PLAN-REVERSE-450-test-traceability-detector-backfill";
const promoteBy = "2026-08-31";
const rows = [
  ...orphanPaths.map(
    (path) =>
      `| \`${path}\` | orphan-deliverable | \`${owner}\` | W3/W4 機械生成の棚卸し: 過去の未追跡成果物 | ${promoteBy} |`,
  ),
  ...duplicatePaths.map(
    (path) =>
      `| \`${path}\` | duplicate-artifact-ownership | \`${owner}\` | W2 機械生成の棚卸し: 複数 PLAN による generates 宣言 | ${promoteBy} |`,
  ),
];
const content = `# deliverable trace debt 監査台帳

## 目的

PLAN-L7-450 W2/W3/W4 の縮小専用 baseline 台帳。\`scripts/\`、\`.claude/\`、\`tests/**/*.test.ts\` の
PLAN \`generates\` 未宣言成果物と複数 PLAN 所有を、解析器の実測集合から固定する。台帳外の追加と、
既に解消された行の残留を \`deliverable-plan-trace\` hard gate が fail-close する。新規行の手書き追加は許可しない。

## 再生成

\`node src/trace/generate-deliverable-trace-debt-audit.ts\` が \`loadDeliverablePlanTraceInput\` と
\`artifact-ownership\` と同じ PLAN \`generates\` 実測集合からこのファイルを機械生成する。台帳は
orphan と duplicate ownership を別集合として双方向突合し、remediation owner は
\`${owner}\`、\`promote_by\` は台帳無期限化を防ぐ期限である。

| 成果物パス | 負債種別 | 担当 PLAN | 根拠 | 解消期限 |
| --- | --- | --- | --- | --- |
${rows.join("\n")}
`;
writeFileSync(
  join(repoRoot, "docs", "governance", "deliverable-trace-debt-audit.md"),
  content,
  "utf8",
);
