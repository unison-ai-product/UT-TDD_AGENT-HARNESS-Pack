/**
 * sub-doc-catalog-drift — 要件 §G.1 の `VALID_SUB_DOCS` 表と schema 正本
 * (`src/schema/index.ts` の `VALID_SUB_DOCS`) の layer×sub-doc 集合を fail-close で照合する
 * (IMP-141 解消の substance 機構)。
 *
 * 背景: 要件 §1.10.G.1 は「正本は `src/schema/index.ts` の `VALID_SUB_DOCS` (本表はそれを mirror)」と
 * 建付けるが、両者の整合を機械検証する gate が無く、L3 slug (`business-requirement` vs `business`) と
 * L4 `screen` 残留の drift が表面化するまで埋もれた (PLAN-L7-97 の plan/lint 単一正本化で露呈)。
 * 本 gate は「doc が現在形で謳う schema↔要件 mirror 関係」を実体で担保し、errata の片肺化を防ぐ。
 *
 * 純関数 (analyzeSubDocCatalogDrift / parseRequirementCatalog) + I/O loader
 * (loadSubDocCatalogDriftInput) を分離 (lint 共通様式、architecture §3.2)。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VALID_SUB_DOCS } from "../schema/index";

export const REQUIREMENTS_DOC_PATH = "docs/governance/ut-tdd-agent-harness-requirements_v1.2.md";

export interface SubDocCatalogDriftInput {
  /** schema 正本 (src/schema/index.ts VALID_SUB_DOCS)。 */
  schema: Record<string, readonly string[]>;
  /** 要件 §G.1 code block から抽出した layer→sub-doc 値。 */
  requirement: Record<string, string[]>;
}

export interface SubDocCatalogDriftResult {
  /** human-readable な drift 記述 (layer 単位)。 */
  drift: string[];
  ok: boolean;
}

/**
 * 要件 md から §G.1 の ```text``` code block を抜き、`L<N>: [...]` を layer→値配列へ parse する。
 * L4 のような複数行 array にも対応 (`[` から `]` まで dotall で捕捉)。`# 件数注記` は除去する。
 */
export function parseRequirementCatalog(reqText: string): Record<string, string[]> {
  const anchor = reqText.indexOf("##### G.1");
  const region = anchor >= 0 ? reqText.slice(anchor) : reqText;
  const blockMatch = region.match(/```text\s*([\s\S]*?)```/);
  const block = blockMatch ? blockMatch[1] : "";
  const cleaned = block.replace(/#[^\n]*/g, "");
  const out: Record<string, string[]> = {};
  for (const m of cleaned.matchAll(/\b(L\d+)\s*:\s*\[([^\]]*)\]/gs)) {
    const layer = m[1];
    const values = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    out[layer] = values;
  }
  return out;
}

/** schema (正本) と要件表の layer×sub-doc 集合差分を drift として返す。 */
export function analyzeSubDocCatalogDrift(
  input: SubDocCatalogDriftInput,
): SubDocCatalogDriftResult {
  const drift: string[] = [];
  const layers = [
    ...new Set<string>([...Object.keys(input.schema), ...Object.keys(input.requirement)]),
  ].sort();
  for (const layer of layers) {
    const schemaVals = input.schema[layer];
    const reqVals = input.requirement[layer];
    if (!schemaVals) {
      drift.push(`${layer}: 要件表に存在するが schema VALID_SUB_DOCS に無い`);
      continue;
    }
    if (!reqVals) {
      drift.push(`${layer}: schema に存在するが要件 §G.1 表に無い`);
      continue;
    }
    const schemaSet = new Set(schemaVals);
    const reqSet = new Set(reqVals);
    const missingInReq = [...schemaSet].filter((v) => !reqSet.has(v)).sort();
    const extraInReq = [...reqSet].filter((v) => !schemaSet.has(v)).sort();
    if (missingInReq.length > 0) {
      drift.push(`${layer}: schema にあり要件表に無い [${missingInReq.join(", ")}]`);
    }
    if (extraInReq.length > 0) {
      drift.push(`${layer}: 要件表にあり schema に無い [${extraInReq.join(", ")}]`);
    }
  }
  return { drift, ok: drift.length === 0 };
}

export function loadSubDocCatalogDriftInput(repoRoot: string): SubDocCatalogDriftInput {
  let reqText = "";
  try {
    reqText = readFileSync(join(repoRoot, REQUIREMENTS_DOC_PATH), "utf8");
  } catch {
    // 要件 doc 不在 → 空文字 (parse 結果が空 = 全 layer drift。実 repo では存在する)
  }
  return {
    schema: VALID_SUB_DOCS as Record<string, readonly string[]>,
    requirement: parseRequirementCatalog(reqText),
  };
}

export function subDocCatalogDriftMessages(r: SubDocCatalogDriftResult): string[] {
  if (r.ok) {
    return ["sub-doc-catalog-drift — OK (要件 §G.1 表 = schema VALID_SUB_DOCS、drift 0)"];
  }
  return [
    `sub-doc-catalog-drift — violation: 要件 §G.1 ↔ schema drift ${r.drift.length} 件: ${r.drift.join("; ")} (schema=正本、要件表を寄せよ — IMP-141)`,
  ];
}
