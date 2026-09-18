// PLAN-L7-245: 設計 doc frontmatter の sub_doc 実値 ↔ VALID_SUB_DOCS (schema) ↔
// document-system-map.md の 3 者突合を fail-close で検証する。
// 2026-07-13 spec-ir triage cluster A (18 件、L6-function-design 配下の schema 外/未宣言 sub_doc) の
// 再発防止レグレッション網。
import { describe, expect, it } from "vitest";
import {
  analyzeSubDocSchemaIntegrity,
  L4_MAP_CATALOG_EXEMPT,
  L6_BUCKET_POLICY_MARKER,
  loadSubDocSchemaIntegrityInput,
  parseDesignDocFrontmatter,
  parseL4MapCatalog,
  type SubDocSchemaIntegrityInput,
  subDocSchemaIntegrityMessages,
} from "../src/lint/sub-doc-schema-integrity.ts";
import { VALID_SUB_DOCS } from "../src/schema/index.ts";
import { headSnapshotRoot } from "./support/workspace-roots.ts";

const SCHEMA = {
  L6: ["function-spec", "class-design", "edge-case", "screen-spec"],
  L4: ["data", "function", "architecture"],
} as const;

const L4_MAP_FIXTURE = [
  "### §1b 外部設計 標準成果物カタログ",
  "",
  "| 標準成果物 | L4 sub_doc slug | 区分 | 備考 |",
  "|---|---|---|---|",
  "| データ | `data` | ① 必須 | ... |",
  "| 業務処理 | `function` | ① 必須 | ... |",
  "",
  `${L6_BUCKET_POLICY_MARKER} は本 doc の別節に記載する。`,
  "",
  "## §1c 次節",
].join("\n");

function baseInput(
  overrides: Partial<SubDocSchemaIntegrityInput> = {},
): SubDocSchemaIntegrityInput {
  return {
    docs: [],
    schema: SCHEMA as unknown as Record<string, readonly string[]>,
    mapDocText: L4_MAP_FIXTURE,
    ...overrides,
  };
}

describe("parseDesignDocFrontmatter (U-SDSI-001..003)", () => {
  it("U-SDSI-001: layer/sub_doc/doc_type を frontmatter から抽出する", () => {
    const content = [
      "---",
      "layer: L6",
      "sub_doc: function-spec",
      "status: confirmed",
      "---",
      "# body",
    ].join("\n");
    const fm = parseDesignDocFrontmatter("docs/design/harness/L6-function-design/x.md", content);
    expect(fm).toEqual({
      path: "docs/design/harness/L6-function-design/x.md",
      layer: "L6",
      subDoc: "function-spec",
      docType: undefined,
    });
  });

  it("U-SDSI-002: sub_doc 未宣言なら subDoc は undefined", () => {
    const content = ["---", "layer: L6", "status: confirmed", "---"].join("\n");
    const fm = parseDesignDocFrontmatter("p.md", content);
    expect(fm.subDoc).toBeUndefined();
  });

  it("U-SDSI-003: doc_type: index はメタ doc として抽出される", () => {
    const content = ["---", "layer: L2", "doc_type: index", "---"].join("\n");
    const fm = parseDesignDocFrontmatter("p.md", content);
    expect(fm.docType).toBe("index");
  });
});

describe("parseL4MapCatalog (U-SDSI-004..005)", () => {
  it("U-SDSI-004: §1b table の backtick slug 列を抽出する", () => {
    expect(parseL4MapCatalog(L4_MAP_FIXTURE)).toEqual(["data", "function"]);
  });

  it("U-SDSI-005: §1b 見出しが無ければ空配列", () => {
    expect(parseL4MapCatalog("見出しなし")).toEqual([]);
  });
});

describe("analyzeSubDocSchemaIntegrity — doc↔schema leg (U-SDSI-006..010)", () => {
  it("U-SDSI-006: 有効な sub_doc 宣言は checked に数えられ violation 0", () => {
    const r = analyzeSubDocSchemaIntegrity(
      baseInput({
        docs: [
          {
            path: "docs/design/harness/L6-function-design/a.md",
            layer: "L6",
            subDoc: "function-spec",
          },
        ],
      }),
    );
    expect(r.checked).toBe(1);
    expect(r.violations.filter((v) => v.kind !== "l4_map_catalog_drift")).toEqual([]);
  });

  it("U-SDSI-007: sub_doc 未宣言 (agent-slots.md 型) は undeclared_sub_doc violation", () => {
    const r = analyzeSubDocSchemaIntegrity(
      baseInput({
        docs: [{ path: "docs/design/harness/L6-function-design/agent-slots.md", layer: "L6" }],
      }),
    );
    const v = r.violations.find((x) => x.kind === "undeclared_sub_doc");
    expect(v).toBeDefined();
    expect(r.ok).toBe(false);
  });

  it("U-SDSI-008: schema 外 sub_doc (skill-index 型) は invalid_sub_doc violation", () => {
    const r = analyzeSubDocSchemaIntegrity(
      baseInput({
        docs: [
          {
            path: "docs/design/harness/L6-function-design/skill-index.md",
            layer: "L6",
            subDoc: "skill-index",
          },
        ],
      }),
    );
    const v = r.violations.find((x) => x.kind === "invalid_sub_doc");
    expect(v).toBeDefined();
    expect(v?.detail).toContain("skill-index");
  });

  it("U-SDSI-009: doc_type: index / verification-roadmap のメタ doc は検証対象外 (skippedMeta)", () => {
    const r = analyzeSubDocSchemaIntegrity(
      baseInput({
        docs: [
          { path: "docs/design/harness/L2-screen/README.md", layer: "L2", docType: "index" },
          {
            path: "docs/design/harness/L3-functional/roadmap.md",
            layer: "L3",
            docType: "verification-roadmap",
          },
        ],
      }),
    );
    expect(r.skippedMeta).toBe(2);
    expect(r.checked).toBe(0);
  });

  it("U-SDSI-010: layer が VALID_SUB_DOCS 対象外 (L10 等) の doc は無視される", () => {
    const r = analyzeSubDocSchemaIntegrity(
      baseInput({ docs: [{ path: "docs/design/harness/L10-ux/visual-design.md", layer: "L10" }] }),
    );
    expect(r.checked).toBe(0);
    expect(r.violations).toEqual([]);
  });
});

describe("analyzeSubDocSchemaIntegrity — L4 map catalog leg (U-SDSI-011..013)", () => {
  it("U-SDSI-011: schema にあり map §1b に無い値 (architecture 以外) は drift", () => {
    const r = analyzeSubDocSchemaIntegrity(
      baseInput({ schema: { L4: ["data", "function", "external-if"] } }),
    );
    const v = r.violations.find(
      (x) => x.kind === "l4_map_catalog_drift" && x.subDoc === "external-if",
    );
    expect(v).toBeDefined();
  });

  it("U-SDSI-012: architecture (方式設計、exempt) は §1b 未記載でも drift にしない", () => {
    expect(L4_MAP_CATALOG_EXEMPT.has("architecture")).toBe(true);
    const r = analyzeSubDocSchemaIntegrity(
      baseInput({ schema: { L4: ["data", "function", "architecture"] } }),
    );
    expect(
      r.violations.some((x) => x.kind === "l4_map_catalog_drift" && x.subDoc === "architecture"),
    ).toBe(false);
  });

  it("U-SDSI-013: map にあり schema に無い値も drift (孤児 catalog エントリ)", () => {
    const mapWithExtra = L4_MAP_FIXTURE.replace(
      "| 業務処理 | `function` | ① 必須 | ... |",
      "| 業務処理 | `function` | ① 必須 | ... |\n| 廃止項目 | `legacy-slug` | ② | ... |",
    );
    const r = analyzeSubDocSchemaIntegrity(
      baseInput({ schema: { L4: ["data", "function"] }, mapDocText: mapWithExtra }),
    );
    const v = r.violations.find(
      (x) => x.kind === "l4_map_catalog_drift" && x.subDoc === "legacy-slug",
    );
    expect(v).toBeDefined();
  });
});

describe("analyzeSubDocSchemaIntegrity — L6 bucket policy leg (U-SDSI-014)", () => {
  it("U-SDSI-014: L6 bucket 方針ノートが map から消えたら l6_bucket_policy_missing", () => {
    const r = analyzeSubDocSchemaIntegrity(
      baseInput({ mapDocText: L4_MAP_FIXTURE.replace(L6_BUCKET_POLICY_MARKER, "") }),
    );
    expect(r.violations.some((x) => x.kind === "l6_bucket_policy_missing")).toBe(true);
  });
});

describe("subDocSchemaIntegrityMessages (U-SDSI-015..016)", () => {
  it("U-SDSI-015: ok なら OK メッセージ", () => {
    const r = analyzeSubDocSchemaIntegrity(baseInput());
    expect(subDocSchemaIntegrityMessages(r)[0]).toContain("OK");
  });

  it("U-SDSI-016: violation ありなら PLAN-L7-245 を含む message", () => {
    const r = analyzeSubDocSchemaIntegrity(baseInput({ docs: [{ path: "p.md", layer: "L6" }] }));
    expect(subDocSchemaIntegrityMessages(r)[0]).toContain("PLAN-L7-245");
  });
});

describe("loadSubDocSchemaIntegrityInput real repo (U-SDSI-017..019)", () => {
  it("U-SDSI-017: 実 repo の schema は src/schema の VALID_SUB_DOCS と一致 (正本 single source)", () => {
    const input = loadSubDocSchemaIntegrityInput(headSnapshotRoot());
    expect(input.schema).toBe(VALID_SUB_DOCS);
  });

  it("U-SDSI-018: 実 repo の docs/design/harness 全設計 doc で drift 0 (2026-07-13 cluster A 18 件の回帰網)", () => {
    const input = loadSubDocSchemaIntegrityInput(headSnapshotRoot());
    const r = analyzeSubDocSchemaIntegrity(input);
    if (!r.ok) {
      throw new Error(subDocSchemaIntegrityMessages(r).join("\n"));
    }
    expect(r.ok).toBe(true);
    expect(r.checked).toBeGreaterThan(20);
  });

  it("U-SDSI-019: L6-function-design 配下の旧 bespoke sub_doc (skill-index 等) は現在 function-spec に統一されている", () => {
    const input = loadSubDocSchemaIntegrityInput(headSnapshotRoot());
    const targets = [
      "docs/design/harness/L6-function-design/agent-slots.md",
      "docs/design/harness/L6-function-design/skill-index.md",
      "docs/design/harness/L6-function-design/governance-enforcement.md",
      "docs/design/harness/L6-function-design/memory.md",
    ];
    for (const path of targets) {
      const doc = input.docs.find((d) => d.path === path);
      expect(doc, `${path} should be discovered`).toBeDefined();
      expect(doc?.subDoc).toBe("function-spec");
    }
  });
});
