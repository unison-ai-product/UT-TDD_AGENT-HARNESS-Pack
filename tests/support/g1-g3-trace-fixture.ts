import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeTestTree } from "./temp-tree.ts";

export const G1_G3_REQUIRED_DOC_CASES = [
  {
    gate: "G1",
    doctorGate: "G1-trace",
    missingPath: "docs/design/harness/L1-requirements/screen-requirements.md",
    traceMessage: "g1-trace - OK (business=1, screens=1, p0Fr=1)",
  },
  {
    gate: "G3",
    doctorGate: "G3-trace",
    missingPath: "docs/design/harness/L3-functional/business-detail.md",
    traceMessage: "g3-trace - OK (frL1=1, l3Fr=1, ac=1, at=1, l1Nfr=15, l3Nfr=15)",
  },
] as const;

const frontmatter = (layer: string, pairArtifact: string): string =>
  `---\nlayer: ${layer}\nstatus: confirmed\npair_artifact: ${pairArtifact}\n---\n`;

const g1Docs: Array<[string, string]> = [
  [
    "docs/design/harness/L1-requirements/business-requirements.md",
    frontmatter("L1", "docs/test-design/harness/L14-operational-test-design.md") +
      "| **BR-01** | fixture |\n",
  ],
  [
    "docs/design/harness/L1-requirements/functional-requirements.md",
    frontmatter("L1", "docs/test-design/harness/L14-operational-test-design.md") +
      "| **FR-L1-01** | P0 |\n",
  ],
  [
    "docs/design/harness/L1-requirements/screen-requirements.md",
    frontmatter("L1", "docs/test-design/harness/L14-operational-test-design.md") +
      [
        "## §1 screens",
        "| PM-01 | fixture |",
        "## §2 end",
        "### §5.1 business trace",
        "| **BR-01** | PM-01 |",
        "### §5.3 P0 trace",
        "| **FR-L1-01** | PM-01 |",
        "### §5.4 end",
        "### §5.5 screen trace",
        "| **PM-01** | BR-01 / FR-L1-01 |",
        "### §5.6 end",
      ].join("\n") +
      "\n",
  ],
];

const l1NfrIds = [1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 17];
const nfrRows = l1NfrIds
  .map((id) => `| **NFR-${String(id).padStart(2, "0")}** | covered |`)
  .join("\n");
const g3Docs: Array<[string, string]> = [
  [
    "docs/design/harness/L1-requirements/functional-requirements.md",
    frontmatter("L1", "docs/test-design/harness/L14-operational-test-design.md") +
      "| **FR-L1-01** | fixture |\n",
  ],
  [
    "docs/design/harness/L3-functional/functional-requirements.md",
    frontmatter("L3", "docs/test-design/harness/L12-acceptance-test-design.md") +
      "### FR-01: fixture\n#### AC-FR-01-01\n",
  ],
  [
    "docs/design/harness/L3-functional/business-detail.md",
    frontmatter("L3", "docs/test-design/harness/L12-acceptance-test-design.md") +
      "# Business detail fixture\n",
  ],
  [
    "docs/design/harness/L3-functional/nfr-grade.md",
    frontmatter("L3", "docs/test-design/harness/L12-acceptance-test-design.md") + nfrRows + "\n",
  ],
  [
    "docs/test-design/harness/L12-acceptance-test-design.md",
    frontmatter("L3", "docs/design/harness/L3-functional/") + "| **AT-FR-01-01** | fixture |\n",
  ],
];

export function createTraceGateFixture(gate: "G1" | "G3", missingPath?: string): string {
  const root = mkdtempSync(join(tmpdir(), "ut-trace-gate-"));
  try {
    const files = gate === "G1" ? g1Docs : g3Docs;
    for (const [relativePath, content] of files) {
      if (relativePath === missingPath) continue;
      const target = join(root, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
    const l14 = join(root, "docs/test-design/harness/L14-operational-test-design.md");
    mkdirSync(dirname(l14), { recursive: true });
    writeFileSync(
      l14,
      frontmatter("L1", "docs/design/harness/L1-requirements/") + "fixture\n",
      "utf8",
    );
    return root;
  } catch (error) {
    removeTestTree(root);
    throw error;
  }
}
