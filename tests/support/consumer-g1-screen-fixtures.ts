import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const TEMPLATE_SLOTS = [
  [
    "docs/templates/vmodel/L1-requirements.md",
    "docs/design/L1-requirements/functional-requirements.md",
  ],
  ["docs/templates/vmodel/L2-screen-list.md", "docs/design/L2-screen/screen-list.md"],
  [
    "docs/templates/vmodel/L3-functional-requirements.md",
    "docs/design/L3-functional/functional-requirements.md",
  ],
  [
    "docs/templates/vmodel/L12-acceptance-test-design.md",
    "docs/test-design/L12-acceptance-test-design.md",
  ],
] as const;

export interface ConsumerScreenFixtureOptions {
  requirementRows?: readonly string[];
  screenRows?: readonly string[];
  extraLegacyScreenLabels?: boolean;
}

export function writeFixtureDoc(root: string, relativePath: string, content: string): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function appendRowsToTemplateTable(
  template: string,
  heading: string,
  rows: readonly string[],
): string {
  if (rows.length === 0) return template;
  const lines = template.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim() === heading);
  if (headingIndex < 0) throw new Error(`template heading not found: ${heading}`);
  const headerIndex = lines.findIndex(
    (line, index) => index > headingIndex && line.trimStart().startsWith("|"),
  );
  if (headerIndex < 0) throw new Error(`template table not found: ${heading}`);
  lines.splice(headerIndex + 2, 0, ...rows);
  return lines.join("\n");
}

function addLegacyHarnessDocs(root: string, includeFixedPrefixLabels = false): void {
  const business = [
    "---",
    "layer: L1",
    "status: confirmed",
    "---",
    "# Harness business requirements",
    "| BR-ID | 要求 |",
    "|---|---|",
    "| BR-01 | First requirement |",
    "| BR-02 | Second requirement |",
    "| BR-03 | Third requirement |",
  ].join("\n");
  const screenRows = Array.from({ length: 16 }, (_, index) => {
    const id = `SC-${String(index + 1).padStart(2, "0")}`;
    return `| ${id} | Screen ${id} |`;
  });
  screenRows.push("| SC-20 | Screen SC-20 |");
  const extraLabels = includeFixedPrefixLabels
    ? [
        "| PM-01 | Legacy project screen |",
        "| HM-01 | Legacy harness screen |",
        "| GD-01 | Legacy guide screen |",
      ]
    : [];
  const screen = [
    "---",
    "layer: L1",
    "sub_doc: screen",
    "status: confirmed",
    "---",
    "# Harness screen requirements",
    "## §1 画面一覧",
    "| 画面ID | 名称 |",
    "|---|---|",
    ...screenRows,
    ...extraLabels,
    "## §2 詳細",
    "### §5.1 業務要求トレース",
    "| 要求ID | 画面ID |",
    "|---|---|",
    "| BR-01 | SC-01〜16、SC-20 |",
    "### §5.3 機能要求トレース",
    "### §5.5 画面トレース",
    "| 画面ID | 業務要求 |",
    "|---|---|",
    "| **PM-01** | BR-01 |",
    "### §5.6 詳細",
  ].join("\n");
  writeFixtureDoc(root, "docs/design/L1-requirements/business-requirements.md", business);
  writeFixtureDoc(root, "docs/design/L1-requirements/screen-requirements.md", screen);
}

export function buildConsumerScreenFixture(
  root: string,
  readTemplate: (relativePath: string) => string,
  options: ConsumerScreenFixtureOptions = {},
): string {
  const requirements = options.requirementRows ?? [
    "| REQ-01 | First requirement | details | Must | SC-01〜03, F-01 |",
    "| REQ-02 | Second requirement | details | Must | SC-02, F-02 |",
    "| REQ-03 | Third requirement | details | Must | SC-03, F-03 |",
  ];
  const screens = options.screenRows ?? [
    "| SC-01 | Screen 1 | overview | F-01 | user |",
    "| SC-02 | Screen 2 | overview | F-02 | user |",
    "| SC-03 | Screen 3 | overview | F-03 | user |",
  ];
  const l1Rows = appendRowsToTemplateTable(
    readTemplate(TEMPLATE_SLOTS[0][0]),
    "#### 第4章 機能要求一覧",
    requirements,
  );
  const l2Template = readTemplate(TEMPLATE_SLOTS[1][0]);
  let l2Rows = appendRowsToTemplateTable(l2Template, "#### 第4章 画面一覧", screens);
  if (options.extraLegacyScreenLabels) {
    l2Rows = l2Rows
      .replace(
        "### 構成元: diagrams.yaml `画面遷移図` (semantic item catalog `d_screen` skeleton)",
        "Legacy labels outside the required table: PM-01, HM-01, GD-01.\n\n### 構成元: diagrams.yaml `画面遷移図` (semantic item catalog `d_screen` skeleton)",
      )
      .replace(
        "| signup | SC-001 サインアップ |",
        "| signup | PM-01 Legacy project screen |\n| harness | HM-01 Legacy harness screen |\n| guide | GD-01 Legacy guide screen |\n| signup | SC-001 サインアップ |",
      );
  }
  const l3Rows = appendRowsToTemplateTable(
    readTemplate(TEMPLATE_SLOTS[2][0]),
    "##### 3-1 機能一覧",
    [
      "| F-01 | First function | details | user | REQ-01 |",
      "| F-02 | Second function | details | user | REQ-02 |",
      "| F-03 | Third function | details | user | REQ-03 |",
    ],
  );
  const l12Rows = appendRowsToTemplateTable(
    readTemplate(TEMPLATE_SLOTS[3][0]),
    "#### 第3章 テストケース一覧",
    [
      "| AT-01 | functional | First case | execute | pass | REQ-01, SC-01, F-01 |",
      "| AT-02 | functional | Second case | execute | pass | REQ-02, SC-02, F-02 |",
      "| AT-03 | functional | Third case | execute | pass | REQ-03, SC-03, F-03 |",
    ],
  );

  for (const [, targetPath] of TEMPLATE_SLOTS) {
    const source =
      targetPath === TEMPLATE_SLOTS[0][1]
        ? l1Rows
        : targetPath === TEMPLATE_SLOTS[1][1]
          ? l2Rows
          : targetPath === TEMPLATE_SLOTS[2][1]
            ? l3Rows
            : l12Rows;
    writeFixtureDoc(root, targetPath, source);
  }
  addLegacyHarnessDocs(root, options.extraLegacyScreenLabels);
  return root;
}
