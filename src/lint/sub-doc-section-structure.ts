/**
 * sub-doc-section-structure — L4 標準成果物 (外部設計) の必須 § 構造を fail-close 検証する
 * (要件 §1.10.G.6.1、document-system-map §1b grounding)。
 *
 * SI 標準成果物カタログ 4 型 (`report`/`batch`/`notification`/`code-value`) は ② プロダクト選択ゆえ
 * harness 自身 (CLI、帳票なし) は産出せず現状 subject 0 だが、downstream 製品の設計文書が作られたとき
 * IPA 共通フレーム外部設計の標準成果物内容 (必須 §) を満たすことを機械強制する。L1 sub-doc §G.6 が
 * 未だ宣言止まりなのに対し、本 gate は L4 標準成果物カタログの substance (必須 §) を実体で担保する。
 *
 * 純関数 (analyzeSubDocSectionStructure) + I/O loader (loadSubDocSectionStructureInput) を分離。
 */
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveVModelRoots } from "../shared/design-root.ts";

/**
 * 要件 §G.6.1 の L4 標準成果物 必須 § (h2 の §名称)。document-system-map §1b の IPA grounding と対。
 * 値 = `## §<N> <名称>` の `<名称>` 部分文字列 (番号は順序逸脱を warning に留めるため緩く扱う)。
 */
export const STANDARD_DELIVERABLE_SECTIONS: Record<string, string[]> = {
  report: ["帳票一覧", "レイアウト", "出力項目定義", "出力条件・タイミング", "関連 doc"],
  batch: [
    "バッチ一覧",
    "ジョブフロー",
    "入出力",
    "処理仕様",
    "実行スケジュール・リカバリ",
    "関連 doc",
  ],
  notification: ["通知一覧", "送信契機", "テンプレート・本文", "宛先・配信制御", "関連 doc"],
  "code-value": ["コード体系", "コード値定義", "利用箇所", "メンテナンス方針", "関連 doc"],
};

export interface SubDocSectionPlan {
  /** Compatibility name: repository-relative document path, not a PLAN identifier. */
  planId: string;
  subDoc: string;
  status: string;
  /** 設計文書本文の h2 header 行 (`## ...`、`###` 以降は除外)。 */
  h2: string[];
}

export interface SubDocSectionStructureInput {
  plans: SubDocSectionPlan[];
  requiredSections: Record<string, string[]>;
}

export interface SubDocSectionStructureViolation {
  planId: string;
  subDoc: string;
  missing: string[];
}

export interface SubDocSectionStructureResult {
  checked: number;
  violations: SubDocSectionStructureViolation[];
  ok: boolean;
}

/** 標準成果物 sub_doc の設計文書が必須 § を h2 として持つか fail-close 判定する。 */
export function analyzeSubDocSectionStructure(
  input: SubDocSectionStructureInput,
): SubDocSectionStructureResult {
  const violations: SubDocSectionStructureViolation[] = [];
  let checked = 0;
  for (const p of input.plans) {
    const required = input.requiredSections[p.subDoc];
    if (!required) continue;
    if (p.status.toLowerCase() === "archived") continue;
    checked += 1;
    const h2Text = p.h2.join("\n");
    const missing = required.filter((name) => !h2Text.includes(name));
    if (missing.length > 0) violations.push({ planId: p.planId, subDoc: p.subDoc, missing });
  }
  return { checked, violations, ok: violations.length === 0 };
}

interface DesignFrontmatter {
  sub_doc?: string;
  status?: string;
}

/** Markdown を frontmatter + body に分割し、body の h2 header 行を返す。CRLF 両対応。 */
export function extractPlanSections(content: string): {
  fm: DesignFrontmatter;
  h2: string[];
} {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  let fm: DesignFrontmatter = {};
  let body = content;
  if (m) {
    try {
      fm = (parseYaml(m[1]) as DesignFrontmatter) ?? {};
    } catch {
      fm = {};
    }
    body = m[2] ?? "";
  }
  const h2 = body
    .split(/\r?\n/)
    .filter((l) => /^##\s+/.test(l) && !/^###/.test(l))
    .map((l) => l.trim());
  return { fm, h2 };
}

export function loadSubDocSectionStructureInput(repoRoot: string): SubDocSectionStructureInput {
  const plans: SubDocSectionPlan[] = [];
  const designRoot = join(repoRoot, resolveVModelRoots(repoRoot).designRoot);
  const files = markdownFiles(designRoot);
  for (const path of files) {
    const content = readFileSync(path, "utf8");
    const { fm, h2 } = extractPlanSections(content);
    const subDoc = typeof fm.sub_doc === "string" ? fm.sub_doc : "";
    if (!Object.hasOwn(STANDARD_DELIVERABLE_SECTIONS, subDoc)) continue;
    plans.push({
      planId: relative(repoRoot, path).replaceAll("\\", "/"),
      subDoc,
      status: typeof fm.status === "string" ? fm.status : "draft",
      h2,
    });
  }
  return { plans, requiredSections: STANDARD_DELIVERABLE_SECTIONS };
}

function markdownFiles(root: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return markdownFiles(path);
      return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
    })
    .sort();
}

export function subDocSectionStructureMessages(r: SubDocSectionStructureResult): string[] {
  if (r.ok) {
    return [
      `sub-doc-section-structure — OK (L4 標準成果物 design docs checked=${r.checked}, 必須 § 欠落 0)`,
    ];
  }
  const sample = r.violations
    .map((v) => `${v.planId}(${v.subDoc}): 欠落 §[${v.missing.join(", ")}]`)
    .join("; ");
  return [
    `sub-doc-section-structure — violation ${r.violations.length} 件: ${sample} (要件 §1.10.G.6.1 の必須 § を h2 として持て)`,
  ];
}
