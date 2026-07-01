/**
 * Relation graph source set loader (PLAN-L7-32 §9 discharge, 2026-06-15).
 *
 * repo → RelationGraphSourceSet の I/O 組み立て層。既存 loader を最大限再利用し
 * 重複 I/O / 重複ロジックを避ける:
 *   - sourceFiles / tracedPaths: loadImplPlanTraceInput (src/lint/impl-plan-trace.ts)
 *   - plans:                     loadReviewPlans (src/lint/review-evidence.ts) + yaml frontmatter
 *   - designDocs / pairArtifact: loadPairDocs (src/vmodel/lint.ts)
 *   - testDesignDocs:            docs/test-design/** walk
 *   - tests:                     tests/**\/*.ts walk
 *
 * dbTable node は projection-writer 経由 (rebuildHarnessDb input.relationGraph) で別途供給。
 * CLI loader は doc/source graph に集中し、DB table node はここでは省略 (空配列)。
 *
 * fail-open 原則: 各ディレクトリ不在 / parse 失敗は空集合として扱う (既存 loader と同一方針)。
 * sanitization invariant: raw MCP response / browser trace / secret / credential を行へ複製しない。
 */
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadFrDocs, parseFrRows } from "../lint/fr-registry-audit";
import { loadImplPlanTraceInput } from "../lint/impl-plan-trace";
import type {
  DesignDocInput,
  PlanInput,
  RelationGraphSourceSet,
  RequirementInput,
  SourceFileInput,
  TestDesignDocInput,
  TestFileInput,
} from "../lint/relation-graph";
import { loadReviewPlans } from "../lint/review-evidence";
import { normalizePath } from "../lint/shared";
import { loadPairDocs } from "../vmodel/lint";

// ---- helpers ----------------------------------------------------------------

function walkTs(dir: string, repoRoot: string, acc: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkTs(full, repoRoot, acc);
    } else if (e.endsWith(".ts")) {
      acc.push(normalizePath(relative(repoRoot, full)));
    }
  }
}

function walkMd(dir: string, repoRoot: string, acc: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMd(full, repoRoot, acc);
    } else if (entry.name.endsWith(".md")) {
      acc.push(normalizePath(relative(repoRoot, full)));
    }
  }
}

function walkJson(dir: string, repoRoot: string, acc: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJson(full, repoRoot, acc);
    } else if (entry.name.endsWith(".json")) {
      acc.push(normalizePath(relative(repoRoot, full)));
    }
  }
}

function walkAdapterTemplateFiles(dir: string, repoRoot: string, acc: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkAdapterTemplateFiles(full, repoRoot, acc);
    } else if (
      entry.name.endsWith(".md") ||
      entry.name.endsWith(".json") ||
      entry.name.endsWith(".toml")
    ) {
      acc.push(normalizePath(relative(repoRoot, full)));
    }
  }
}

/**
 * tests/**\/*.ts を走査し、各テストファイルの import 文を解析して
 * "covered src path → test path" の逆引き map を構築する。
 *
 * 解析戦略 (ADR-002「source import graph」):
 *  1. import/require で `../src/...` 形式を静的に正規表現マッチ。
 *  2. マッチ失敗の補助として tests/foo.test.ts → src 配下の foo.ts の basename 一致も使用。
 */
function buildCoveredByMap(
  testFiles: string[],
  srcFiles: string[],
  repoRoot: string,
): Map<string, string[]> {
  // srcPath → coveredByTestPaths
  const covered = new Map<string, string[]>();

  const srcByBasename = new Map<string, string[]>();
  for (const sf of srcFiles) {
    const base = sf.split("/").pop()?.replace(/\.ts$/, "") ?? "";
    const list = srcByBasename.get(base) ?? [];
    list.push(sf);
    srcByBasename.set(base, list);
  }

  for (const testPath of testFiles) {
    let content = "";
    try {
      content = readFileSync(join(repoRoot, testPath), "utf8");
    } catch {
      // fail-open: unreadable test
    }

    // 1. import 解析: `from "../src/..."` / `require("../src/...")`
    const importedSrcPaths = new Set<string>();
    for (const m of content.matchAll(/(?:from|require)\s*\(?\s*["']([^"']+)["']/g)) {
      const spec = m[1];
      if (!spec.includes("src/")) continue;
      // src/ 以降を抽出して正規化
      const srcIdx = spec.indexOf("src/");
      if (srcIdx === -1) continue;
      let rel = spec.slice(srcIdx);
      if (!rel.endsWith(".ts")) rel = `${rel}.ts`;
      const normalized = normalizePath(rel);
      if (srcFiles.includes(normalized)) {
        importedSrcPaths.add(normalized);
      }
    }

    // 2. basename 一致補助: tests/foo.test.ts → src/**/foo.ts
    const testBase =
      testPath
        .split("/")
        .pop()
        ?.replace(/\.test\.ts$/, "") ?? "";
    if (testBase) {
      for (const sf of srcByBasename.get(testBase) ?? []) {
        importedSrcPaths.add(sf);
      }
    }

    for (const srcPath of importedSrcPaths) {
      const list = covered.get(srcPath) ?? [];
      if (!list.includes(testPath)) list.push(testPath);
      covered.set(srcPath, list);
    }
  }
  return covered;
}

// ---- plan frontmatter parse -------------------------------------------------

interface PlanFrontmatter {
  plan_id?: string;
  status?: string;
  generates?: { artifact_path?: string; artifact_type?: string }[];
  dependencies?: { requires?: string[] };
}

/** requirement node の provenance path (FR-L1 SSoT)。change-impact 突合の基準。 */
const FR_REGISTRY_DOC = "docs/design/harness/L1-requirements/functional-requirements.md";

const REFERENCE_DOCS = ["docs/reference/ai-agent-harness-directory-reference.md"] as const;
const GOVERNANCE_DOCS = [
  "docs/governance/README.md",
  "docs/governance/document-system-map.md",
  "docs/governance/repository-structure.md",
] as const;
const ROOT_CANONICAL_DOCS = ["README.md", "AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"] as const;
const ROOT_CONFIG_DOCS = [
  ".claude/settings.json",
  ".codex/config.toml",
  ".codex/hooks.json",
  ".editorconfig",
  ".gitattributes",
  "biome.json",
  "package.json",
  "scripts/ut-tdd",
  "scripts/ut-tdd.ps1",
  "tsconfig.json",
  "vitest.config.ts",
] as const;

function addDesignDocIfAbsent(designDocs: DesignDocInput[], path: string): void {
  if (designDocs.some((d) => d.path === path)) return;
  designDocs.push({
    id: path,
    path,
  });
}

/**
 * FR-L1 レジストリ (SSoT) の登録 FR id 集合を fail-open で読む。
 * relation graph の requirement node 供給に使う (PLAN-L7-32 loader の被覆欠落是正、PLAN-L7-142)。
 */
function loadRegistryFrIds(repoRoot: string): string[] {
  try {
    return parseFrRows(loadFrDocs(repoRoot).l1Functional).map((r) => r.id);
  } catch {
    return [];
  }
}

function parsePlanFrontmatter(content: string): PlanFrontmatter {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  try {
    return (parseYaml(m[1]) as PlanFrontmatter) ?? {};
  } catch {
    return {};
  }
}

/**
 * FR reference IDs を PLAN 本文から抽出する (FR-L1-NN 形式)。
 * derives-from edge 用 (requirement id = FR-L1-NN)。
 */
function extractFrRefs(content: string): string[] {
  const refs = new Set<string>();
  for (const m of content.matchAll(/\bFR-L\d+-\d+\b/g)) {
    refs.add(m[0]);
  }
  return [...refs];
}

// ---- main loader ------------------------------------------------------------

/**
 * 実 repo の docs/plans / src / tests / docs/design / docs/test-design を走査し
 * RelationGraphSourceSet を組み立てる。
 *
 * @param repoRoot  absolute path to repo root (process.cwd() 相当)
 */
export function loadRelationGraphSourceSet(repoRoot: string): RelationGraphSourceSet {
  // 1. sourceFiles: loadImplPlanTraceInput が src/**/*.ts を収集済み
  const implTrace = loadImplPlanTraceInput(repoRoot);
  const srcFiles = implTrace.srcFiles; // repo-relative "/" 正規化済み

  // 2. tests: tests/**/*.ts 走査
  const testPaths: string[] = [];
  try {
    walkTs(join(repoRoot, "tests"), repoRoot, testPaths);
  } catch {
    // fail-open
  }

  // 3. covered-by 逆引き map
  const coveredBy = buildCoveredByMap(testPaths, srcFiles, repoRoot);

  // 4. sourceFiles input
  const sourceFiles: SourceFileInput[] = srcFiles.map((path) => ({
    path,
    tests: coveredBy.get(path) ?? [],
  }));

  // 5. tests input
  const tests: TestFileInput[] = testPaths.map((path) => ({ path }));

  // 6. plans: loadReviewPlans → frontmatter parse で generates + FR refs を取得。
  // loadReviewPlans は docs/plans 不在で throw する (fail-close) ため、loader の fail-open
  // 原則を保つために全体を try/catch で包む (docs/plans 不在 repo = 空 plans)。
  const plans: PlanInput[] = [];
  // plan が derives-from する全 requirement id を集約 (requirement node 供給用、stale-edge 是正)。
  const referencedReqs = new Set<string>();
  try {
    const reviewPlans = loadReviewPlans(repoRoot);
    const plansDir = join(repoRoot, "docs", "plans");
    for (const rp of reviewPlans) {
      let content = "";
      try {
        content = readFileSync(join(plansDir, rp.file), "utf8");
      } catch {
        // fail-open
      }
      const fm = parsePlanFrontmatter(content);
      // archived plan は live graph に edge/node を出さない (historical、generates が削除済 artifact を
      // 指して dangling 化するのを防ぐ)。status は frontmatter から判定 (PLAN-L7-142)。
      if (fm.status === "archived") continue;
      // generates: src/*.ts artifact のみ抽出 (generates edge = plan→source)
      const generatesSrc = (fm.generates ?? [])
        .map((g) => g.artifact_path ?? "")
        .filter((p) => p.startsWith("src/") && p.endsWith(".ts"));
      // requirements: frontmatter dependencies.requires の FR-L1-NN + 本文 FR refs
      const fmRequires = (fm.dependencies?.requires ?? []).filter((r) => /^FR-L\d+-\d+$/.test(r));
      const bodyRefs = extractFrRefs(content);
      const allRefs = [...new Set([...fmRequires, ...bodyRefs])];
      for (const r of allRefs) referencedReqs.add(r);
      plans.push({
        id: rp.plan_id,
        path: `docs/plans/${rp.file}`,
        generates: generatesSrc.length > 0 ? generatesSrc : undefined,
        requirements: allRefs.length > 0 ? allRefs : undefined,
      });
    }
  } catch {
    // fail-open: docs/plans 不在は空 plans
  }

  // requirement node 供給 (PLAN-L7-32 loader の被覆欠落是正、PLAN-L7-142):
  // FR-L1 レジストリ (SSoT) ∪ plan が実参照する FR id。前者で SSoT 完全性、後者で
  // derives-from edge の端点を確実に実在化 (body-ref など未登録 FR でも dangling を出さない)。
  const requirementIds = [...new Set([...loadRegistryFrIds(repoRoot), ...referencedReqs])];
  const requirements: RequirementInput[] = requirementIds.map((id) => ({
    id,
    path: FR_REGISTRY_DOC,
  }));

  // 7. designDocs: loadPairDocs → PairDoc を DesignDocInput に写像
  const designDocs: DesignDocInput[] = [];
  try {
    const pairDocs = loadPairDocs(repoRoot);
    for (const d of pairDocs) {
      if (!d.path.startsWith("docs/design/")) continue;
      // pairs edge は design → test-design node。pairArtifact が docs/test-design/ を指す時のみ張る。
      // L2-screen 等の self / wireframe (docs/design 配下の mock) は vmodel 上の正当な group/self pair
      // だが test-design node ではないため、test-design への pairs edge にすると dangling 化する
      // (PLAN-L7-142、loader が vmodel の self/group-pair を盲目変換していた是正)。
      const pairs = d.pairArtifact?.startsWith("docs/test-design/") ? d.pairArtifact : undefined;
      designDocs.push({
        id: d.path, // path を安定 ID として使用
        path: d.path,
        pairs,
      });
    }
  } catch {
    // fail-open
  }

  // 8. testDesignDocs: docs/test-design/**/*.md 走査
  const processDocs: string[] = [];
  walkMd(join(repoRoot, "docs", "process"), repoRoot, processDocs);
  for (const path of processDocs) {
    addDesignDocIfAbsent(designDocs, path);
  }

  const agentDocs: string[] = [];
  walkMd(join(repoRoot, ".claude", "agents"), repoRoot, agentDocs);
  for (const path of agentDocs) {
    addDesignDocIfAbsent(designDocs, path);
  }

  const commandDocs: string[] = [];
  walkMd(join(repoRoot, ".claude", "commands"), repoRoot, commandDocs);
  for (const path of commandDocs) {
    addDesignDocIfAbsent(designDocs, path);
  }

  const skillDocs: string[] = [];
  walkMd(join(repoRoot, "docs", "skills"), repoRoot, skillDocs);
  for (const path of skillDocs) {
    addDesignDocIfAbsent(designDocs, path);
  }

  const adapterTemplateDocs: string[] = [];
  walkAdapterTemplateFiles(
    join(repoRoot, "docs", "templates", "adapter"),
    repoRoot,
    adapterTemplateDocs,
  );
  for (const path of adapterTemplateDocs) {
    addDesignDocIfAbsent(designDocs, path);
  }

  const adrDocs: string[] = [];
  walkMd(join(repoRoot, "docs", "adr"), repoRoot, adrDocs);
  for (const path of adrDocs) {
    addDesignDocIfAbsent(designDocs, path);
  }

  const governanceDocs: string[] = [];
  walkMd(join(repoRoot, "docs", "governance"), repoRoot, governanceDocs);
  for (const path of governanceDocs) {
    addDesignDocIfAbsent(designDocs, path);
  }

  const reviewDocs: string[] = [];
  walkMd(join(repoRoot, ".ut-tdd", "review"), repoRoot, reviewDocs);
  for (const path of reviewDocs) {
    addDesignDocIfAbsent(designDocs, path);
  }

  const auditDocs: string[] = [];
  walkMd(join(repoRoot, ".ut-tdd", "audit"), repoRoot, auditDocs);
  for (const path of auditDocs) {
    addDesignDocIfAbsent(designDocs, path);
  }

  const evidenceDocs: string[] = [];
  walkJson(join(repoRoot, ".ut-tdd", "evidence"), repoRoot, evidenceDocs);
  for (const path of evidenceDocs) {
    addDesignDocIfAbsent(designDocs, path);
  }

  for (const path of REFERENCE_DOCS) {
    addDesignDocIfAbsent(designDocs, path);
  }

  for (const path of GOVERNANCE_DOCS) {
    addDesignDocIfAbsent(designDocs, path);
  }

  for (const path of ROOT_CANONICAL_DOCS) {
    try {
      statSync(join(repoRoot, path));
      addDesignDocIfAbsent(designDocs, path);
    } catch {
      // fail-open: optional root canonical docs may be absent in fixtures.
    }
  }

  for (const path of ROOT_CONFIG_DOCS) {
    try {
      statSync(join(repoRoot, path));
      addDesignDocIfAbsent(designDocs, path);
    } catch {
      // fail-open: optional root config may be absent.
    }
  }

  const testDesignDocs: TestDesignDocInput[] = [];
  try {
    const tdDir = join(repoRoot, "docs", "test-design");
    const paths: string[] = [];
    walkMd(tdDir, repoRoot, paths);
    for (const path of paths) {
      testDesignDocs.push({ id: path, path });
    }
  } catch {
    // fail-open
  }

  return {
    requirements,
    sourceFiles,
    tests,
    plans,
    designDocs,
    testDesignDocs,
    // dbTables: 省略 (projection-writer 経由で供給)
    dbTables: [],
  };
}
