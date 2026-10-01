import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkG9SystemWorkflow, checkG10UxWorkflow } from "../src/doctor/workflow-quality.ts";
import {
  analyzeLayerPairGate,
  evaluateStaticGate,
  readCoverageSummary,
} from "../src/gate/static.ts";
import {
  analyzeG1Trace,
  g1TraceMessages,
  g1TraceOk,
  loadG1TraceDocs,
} from "../src/lint/g1-trace.ts";
import { analyzeG3Trace, g3TraceMessages, g3TraceOk, loadDocs } from "../src/lint/g3-trace.ts";
import { loadGateConfirmDocs, parseGateStatuses } from "../src/lint/gate-confirm.ts";
import { buildNodeGeneration } from "../src/runtime/node-bootstrap.ts";
import type { PairDoc } from "../src/vmodel/lint.ts";
import {
  loadCompiledRightArmRegistry,
  VMODEL_CONTRACT_PATH,
} from "../src/vmodel-contract/adapters/yaml-contract-loader.ts";

const GATE_ASSETS = [
  "docs/governance/gate-design.md",
  "docs/process/gates.md",
  "docs/process/vmodel-contract.yaml",
] as const;

const CONSUMER_TEMPLATE_SLOTS = [
  [
    "docs/templates/vmodel/L1-requirements.md",
    "docs/design/L1-requirements/functional-requirements.md",
  ],
  ["docs/templates/vmodel/L2-screen-list.md", "docs/design/L2-screen/screen-list.md"],
  [
    "docs/templates/vmodel/L3-functional-requirements.md",
    "docs/design/L3-functional/functional-requirements.md",
  ],
  ["docs/templates/vmodel/L4-data.md", "docs/design/L4-basic-design/data.md"],
  ["docs/templates/vmodel/L4-architecture.md", "docs/design/L4-basic-design/architecture.md"],
  ["docs/templates/vmodel/L4-external-if.md", "docs/design/L4-basic-design/external-if.md"],
  ["docs/templates/vmodel/L4-function.md", "docs/design/L4-basic-design/function.md"],
  ["docs/templates/vmodel/L4-ui-standard.md", "docs/design/L4-basic-design/ui-standard.md"],
  ["docs/templates/vmodel/L4-security.md", "docs/design/L4-basic-design/security.md"],
  ["docs/templates/vmodel/L5-physical-data.md", "docs/design/L5-detailed-design/physical-data.md"],
  [
    "docs/templates/vmodel/L5-module-decomposition.md",
    "docs/design/L5-detailed-design/module-decomposition.md",
  ],
  ["docs/templates/vmodel/L6-function-spec.md", "docs/design/L6-function-design/function-spec.md"],
  ["docs/templates/vmodel/L7-unit-test-design.md", "docs/test-design/L7-unit-test-design.md"],
] as const;

const roots: string[] = [];
let buildOutputRoot: string | undefined;

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-release-consumer-gates-"));
  roots.push(root);
  return root;
}

function writeGateDefinition(root: string, content: string): void {
  const path = join(root, "docs", "governance", "gate-design.md");
  mkdirSync(join(root, "docs", "governance"), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function writeFixtureDoc(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function writeConsumerGateFixture(
  root: string,
  options: { omitRequiredSlot?: boolean; omitWireframe?: boolean } = {},
): void {
  const repositoryRoot = process.cwd();
  for (const [templatePath, targetPath] of CONSUMER_TEMPLATE_SLOTS) {
    const template = readFileSync(join(repositoryRoot, templatePath), "utf8");
    const testDesign = targetPath.startsWith("docs/test-design/");
    const pairArtifact = testDesign ? "docs/design/" : "docs/test-design/L7-unit-test-design.md";
    const adapted = template
      .replace(/^status: .*$/m, "status: confirmed")
      .replace(/^pair_artifact: .*$/m, `pair_artifact: ${pairArtifact}`)
      .replace(/^plan: .*$/m, "plan: docs/plans/PLAN-CONSUMER-01.md");
    writeFixtureDoc(root, targetPath, adapted);
  }

  const l1Template = readFileSync(
    join(repositoryRoot, "docs/templates/vmodel/L1-requirements.md"),
    "utf8",
  );
  const l3Template = readFileSync(
    join(repositoryRoot, "docs/templates/vmodel/L3-functional-requirements.md"),
    "utf8",
  );
  const l1Adapt = () =>
    l1Template
      .replace(/^status: .*$/m, "status: confirmed")
      .replace(/^pair_artifact: .*$/m, `pair_artifact: docs/test-design/L7-unit-test-design.md`)
      .replace(/^plan: .*$/m, "plan: docs/plans/PLAN-CONSUMER-01.md");
  const l3Adapt = () =>
    l3Template
      .replace(/^status: .*$/m, "status: confirmed")
      .replace(/^pair_artifact: .*$/m, "pair_artifact: docs/test-design/L7-unit-test-design.md")
      .replace(/^plan: .*$/m, "plan: docs/plans/PLAN-CONSUMER-01.md");
  if (!options.omitRequiredSlot) {
    writeFixtureDoc(
      root,
      "docs/design/L1-requirements/business-requirements.md",
      `${l1Adapt()}\n| **BR-01** | Consumer goal |\n`,
    );
  }
  writeFixtureDoc(
    root,
    "docs/design/L1-requirements/functional-requirements.md",
    `${l1Adapt()}\n| **FR-L1-01** | Consumer function | P0 |\n`,
  );
  writeFixtureDoc(
    root,
    "docs/design/L1-requirements/screen-requirements.md",
    `${l1Adapt()}\n\n## §1 画面一覧\nPM-01\n## §2 次\n### §5.1 業務要求トレース\n| **BR-01** | PM-01 |\n### §5.3 機能要求トレース\n| **FR-L1-01** | PM-01 |\n### §5.4 次\n### §5.5 画面トレース\n| **PM-01** | BR-01 / FR-L1-01 |\n### §5.6 次\n`,
  );
  for (const path of ["business-detail.md", "nfr-grade.md"]) {
    let content = l3Adapt();
    if (path === "business-detail.md") content += "\n";
    else {
      content += `\n${[1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 17].map((n) => `| **NFR-${String(n).padStart(2, "0")}** | covered |`).join("\n")}\n`;
    }
    writeFixtureDoc(root, `docs/design/L3-functional/${path}`, content);
  }
  writeFixtureDoc(
    root,
    "docs/design/L3-functional/functional-requirements.md",
    `${l3Adapt()}\n### FR-01: Consumer function\n#### AC-FR-01-01\n`,
  );

  const l10 = readFileSync(
    join(repositoryRoot, "docs/templates/vmodel/L10-ux-validation.md"),
    "utf8",
  )
    .replace(/^status: .*$/m, "status: confirmed")
    .replace(/^pair_artifact: .*$/m, "pair_artifact: docs/design/L2-screen/")
    .replace(/^plan: .*$/m, "plan: docs/plans/PLAN-CONSUMER-01.md");
  writeFixtureDoc(root, "docs/test-design/L10-ux-validation-test-design.md", l10);
  const l12 = readFileSync(
    join(repositoryRoot, "docs/templates/vmodel/L12-acceptance-test-design.md"),
    "utf8",
  )
    .replace(/^status: .*$/m, "status: confirmed")
    .replace(/^pair_artifact: .*$/m, "pair_artifact: docs/design/")
    .replace(/^plan: .*$/m, "plan: docs/plans/PLAN-CONSUMER-01.md");
  writeFixtureDoc(
    root,
    "docs/test-design/L12-acceptance-test-design.md",
    `${l12}\n| **AT-FR-01-01** | Consumer acceptance |\n`,
  );
  if (!options.omitWireframe) {
    writeFixtureDoc(
      root,
      "docs/design/L2-screen/wireframe.md",
      "---\nlayer: L2\nstatus: confirmed\npair_artifact: docs/test-design/L10-ux-validation-test-design.md\n---\n# Consumer wireframe\n",
    );
  }
}

const G8_CONSUMER_CASE_IDS = [
  "IT-CONSUMER-01",
  "IT-CONSUMER-02",
  "IT-CONSUMER-03",
  "IT-CONSUMER-04",
  "IT-CONSUMER-05",
  "IT-CONSUMER-06",
] as const;

type ConsumerG8Manifest = {
  schema_version: string;
  gate: string;
  profile: string;
  plan_id: string;
  selected_it_ids: string[];
  mandatory_it_ids: string[];
  deferred_it_ids: string[];
  commands: {
    command_id: string;
    command: string;
    runner: string;
    scope: string;
    exit_code: number;
    evidence_path: string;
    output_digest: string;
    it_ids: string[];
  }[];
  coverage: {
    it_id: string;
    status: string;
    evidence_paths: string[];
    command_ids: string[];
  }[];
  exit_criteria: {
    all_mandatory_passed: boolean;
    failed_mandatory_count: number;
    stale_defer_count: number;
    doctor_check: string;
  };
  artifacts: Record<string, string>;
};

function consumerG8Manifest(evidenceDirectory = "g8-integration"): ConsumerG8Manifest {
  const commandId = "cmd-consumer-integration";
  const evidencePath = "tests/fixtures/g8-consumer/integration-results.txt";
  return {
    schema_version: `${evidenceDirectory}-evidence-v1`,
    gate: "G8",
    profile: "consumer-integration-minimum",
    plan_id: "PLAN-CONSUMER-01",
    selected_it_ids: [...G8_CONSUMER_CASE_IDS],
    mandatory_it_ids: [...G8_CONSUMER_CASE_IDS],
    deferred_it_ids: [],
    commands: [
      {
        command_id: commandId,
        command: "node tests/consumer-integration-check.mjs",
        runner: "node",
        scope: "consumer fixture",
        exit_code: 0,
        evidence_path: "tests/fixtures/g8-consumer/command-output.txt",
        output_digest: `sha256:${"0".repeat(64)}`,
        it_ids: [...G8_CONSUMER_CASE_IDS],
      },
    ],
    coverage: G8_CONSUMER_CASE_IDS.map((itId) => ({
      it_id: itId,
      status: "passed",
      evidence_paths: [evidencePath],
      command_ids: [commandId],
    })),
    exit_criteria: {
      all_mandatory_passed: true,
      failed_mandatory_count: 0,
      stale_defer_count: 0,
      doctor_check: `${evidenceDirectory}-workflow`,
    },
    artifacts: {
      integration_manifest: `.ut-tdd/evidence/${evidenceDirectory}/ok.json`,
      integration_results: evidencePath,
    },
  };
}

function writeConsumerG8Fixture(
  root: string,
  options: { evidenceDirectory?: string; contractOverride?: boolean } = {},
): void {
  const repositoryRoot = process.cwd();
  const evidenceDirectory = options.evidenceDirectory ?? "g8-integration";
  if (options.contractOverride) {
    const contractSource = readFileSync(
      join(repositoryRoot, "docs/process/vmodel-contract.yaml"),
      "utf8",
    );
    const contract = contractSource.replace(
      "evidence_manifest: .ut-tdd/evidence/g8-integration/engine-swap.json",
      `evidence_manifest: .ut-tdd/evidence/${evidenceDirectory}/engine-swap.json`,
    );
    writeFixtureDoc(root, "docs/process/vmodel-contract.yaml", contract);
  }

  const l8Template = readFileSync(
    join(repositoryRoot, "docs/templates/vmodel/L8-integration-test-design.md"),
    "utf8",
  );
  const rows = G8_CONSUMER_CASE_IDS.map(
    (caseId, index) =>
      `| ${caseId} | integration | Consumer boundary ${index + 1} | Exercise the consumer contract | Pass | DOC-L5-MODULE / DOC-L5-PHYSICAL-DATA |`,
  ).join("\n");
  const l8 = l8Template
    .replace(/^status: .*$/m, "status: confirmed")
    .replace(/^pair_artifact: .*$/m, "pair_artifact: docs/design/L5-detailed-design/")
    .replace(/^plan: .*$/m, "plan: docs/plans/PLAN-CONSUMER-01.md")
    .replace(/^\| <記入> \| <記入> \| <記入> \| <記入> \| <記入> \| <記入> \|$/m, rows);
  writeFixtureDoc(root, "docs/test-design/L8-integration-test-design.md", l8);

  writeFixtureDoc(
    root,
    "docs/design/L5-detailed-design/module-decomposition.md",
    "---\ndoc_type_id: DOC-L5-MODULE\nlayer: L5\nstatus: confirmed\npair_artifact: docs/test-design/L8-integration-test-design.md\nplan: docs/plans/PLAN-CONSUMER-01.md\n---\n# DOC-L5-MODULE\n\n**DOC-L5-MODULE**\n",
  );
  writeFixtureDoc(
    root,
    "docs/design/L5-detailed-design/physical-data.md",
    "---\ndoc_type_id: DOC-L5-PHYSICAL-DATA\nlayer: L5\nstatus: confirmed\npair_artifact: docs/test-design/L8-integration-test-design.md\nplan: docs/plans/PLAN-CONSUMER-01.md\n---\n# DOC-L5-PHYSICAL-DATA\n\n**DOC-L5-PHYSICAL-DATA**\n",
  );
  writeFixtureDoc(root, "tests/fixtures/g8-consumer/integration-results.txt", "passed\n");
  writeFixtureDoc(root, "tests/fixtures/g8-consumer/command-output.txt", "passed\n");
  writeFixtureDoc(
    root,
    `.ut-tdd/evidence/${evidenceDirectory}/ok.json`,
    `${JSON.stringify(consumerG8Manifest(evidenceDirectory), null, 2)}\n`,
  );
}

function firstConsumerCommand(
  manifest: ConsumerG8Manifest,
): ConsumerG8Manifest["commands"][number] {
  const command = manifest.commands[0];
  if (!command) throw new Error("consumer G8 fixture command is missing");
  return command;
}

function updateConsumerG8Manifest(
  root: string,
  mutate: (manifest: ConsumerG8Manifest) => void,
  evidenceDirectory = "g8-integration",
): void {
  const path = join(root, ".ut-tdd", "evidence", evidenceDirectory, "ok.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as ConsumerG8Manifest;
  mutate(manifest);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

const G9_CONSUMER_CASE_IDS = [
  "ST-CONSUMER-01",
  "ST-CONSUMER-02",
  "ST-CONSUMER-03",
  "ST-CONSUMER-04",
  "ST-CONSUMER-05",
  "ST-CONSUMER-06",
] as const;

type ConsumerG9Manifest = {
  schema_version: string;
  gate: string;
  profile: string;
  plan_id: string;
  selected_st_ids: string[];
  mandatory_st_ids: string[];
  deferred_st_ids: string[];
  commands: {
    command_id: string;
    command: string;
    runner: string;
    scope: string;
    exit_code: number;
    evidence_path: string;
    output_digest: string;
    st_ids: string[];
  }[];
  coverage: {
    st_id: string;
    status: string;
    evidence_paths: string[];
    command_ids: string[];
  }[];
  defer: { st_id: string; reason: string; plan_id: string }[];
  exit_criteria: {
    all_mandatory_passed: boolean;
    failed_mandatory_count: number;
    stale_defer_count: number;
    doctor_check: string;
  };
  artifacts: Record<string, string>;
};

function g9ContractObligation() {
  const repositoryRoot = process.cwd();
  const contract = readFileSync(join(repositoryRoot, VMODEL_CONTRACT_PATH), "utf8");
  const obligation = loadCompiledRightArmRegistry(repositoryRoot, contract).obligations.find(
    (entry) => entry.gate === "G9",
  );
  if (!obligation) throw new Error("consumer G9 fixture requires the contract G9 obligation");
  return obligation;
}

function consumerG9Manifest(evidenceDirectory: string): ConsumerG9Manifest {
  const commandId = "cmd-consumer-system";
  const evidencePath = "tests/fixtures/g9-consumer/system-results.txt";
  return {
    schema_version: `${evidenceDirectory}-evidence-v1`,
    gate: "G9",
    profile: "consumer-system-minimum",
    plan_id: "PLAN-CONSUMER-01",
    selected_st_ids: [...G9_CONSUMER_CASE_IDS],
    mandatory_st_ids: [...G9_CONSUMER_CASE_IDS],
    deferred_st_ids: [],
    commands: [
      {
        command_id: commandId,
        command: "node tests/consumer-system-check.mjs",
        runner: "node",
        scope: "consumer fixture",
        exit_code: 0,
        evidence_path: "tests/fixtures/g9-consumer/command-output.txt",
        output_digest: `sha256:${"0".repeat(64)}`,
        st_ids: [...G9_CONSUMER_CASE_IDS],
      },
    ],
    coverage: G9_CONSUMER_CASE_IDS.map((stId) => ({
      st_id: stId,
      status: "passed",
      evidence_paths: [evidencePath],
      command_ids: [commandId],
    })),
    defer: [],
    exit_criteria: {
      all_mandatory_passed: true,
      failed_mandatory_count: 0,
      stale_defer_count: 0,
      doctor_check: `${evidenceDirectory}-workflow`,
    },
    artifacts: {
      system_manifest: `.ut-tdd/evidence/${evidenceDirectory}/ok.json`,
      system_results: evidencePath,
    },
  };
}

function writeConsumerG9Fixture(root: string): void {
  const repositoryRoot = process.cwd();
  const obligation = g9ContractObligation();
  const evidenceDirectory = obligation.evidenceManifest.replaceAll("\\", "/").split("/").at(-2);
  if (!evidenceDirectory) throw new Error("consumer G9 contract has no evidence directory");
  const families = obligation.evidenceFamilies;
  const caseRows = G9_CONSUMER_CASE_IDS.map((caseId, index) => {
    const family = families[index % families.length];
    if (!family) throw new Error("consumer G9 contract has no evidence families");
    return `| ${caseId} | system | Consumer system boundary ${index + 1} | Exercise the consumer contract | Pass | ${family} | DOC-L4-ARCHITECTURE |`;
  }).join("\n");
  const l9Template = readFileSync(
    join(repositoryRoot, "docs/templates/vmodel/L9-system-test-design.md"),
    "utf8",
  );
  const l9 = l9Template
    .replace(/^status: .*$/m, "status: confirmed")
    .replace(/^pair_artifact: .*$/m, "pair_artifact: docs/design/L4-basic-design/")
    .replace(/^plan: .*$/m, "plan: docs/plans/PLAN-CONSUMER-01.md")
    .replace(
      "| テストID | 分類 | テスト項目 | 検証内容/手順 | 期待結果 | トレース元 |",
      "| テストID | 分類 | テスト項目 | 検証内容/手順 | 期待結果 | family | トレース元 |",
    )
    .replace("|---|---|---|---|---|---|", "|---|---|---|---|---|---|---|")
    .replace("| <記入> | <記入> | <記入> | <記入> | <記入> | <記入> |", caseRows);
  writeFixtureDoc(root, "docs/test-design/L9-system-test-design.md", l9);
  writeFixtureDoc(
    root,
    "docs/design/L4-basic-design/architecture.md",
    "---\ndoc_type_id: DOC-L4-ARCHITECTURE\nlayer: L4\nstatus: confirmed\npair_artifact: docs/test-design/L9-system-test-design.md\nplan: docs/plans/PLAN-CONSUMER-01.md\n---\n# DOC-L4-ARCHITECTURE\n\n**DOC-L4-ARCHITECTURE**\n",
  );
  writeFixtureDoc(
    root,
    "docs/design/L5-detailed-design/module-decomposition.md",
    "---\ndoc_type_id: DOC-L5-MODULE\nlayer: L5\nstatus: confirmed\npair_artifact: docs/test-design/L9-system-test-design.md\nplan: docs/plans/PLAN-CONSUMER-01.md\n---\n# DOC-L5-MODULE\n\n**DOC-L5-MODULE**\n",
  );
  writeFixtureDoc(root, "tests/fixtures/g9-consumer/system-results.txt", "passed\n");
  writeFixtureDoc(root, "tests/fixtures/g9-consumer/command-output.txt", "passed\n");
  writeFixtureDoc(
    root,
    `.ut-tdd/evidence/${evidenceDirectory}/ok.json`,
    `${JSON.stringify(consumerG9Manifest(evidenceDirectory), null, 2)}\n`,
  );
}

function updateConsumerG9Manifest(
  root: string,
  mutate: (manifest: ConsumerG9Manifest) => void,
): void {
  const obligation = g9ContractObligation();
  const evidenceDirectory = obligation.evidenceManifest.replaceAll("\\", "/").split("/").at(-2);
  if (!evidenceDirectory) throw new Error("consumer G9 contract has no evidence directory");
  const path = join(root, ".ut-tdd", "evidence", evidenceDirectory, "ok.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as ConsumerG9Manifest;
  mutate(manifest);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function updateConsumerG9Design(root: string, mutate: (content: string) => string): void {
  const path = join(root, "docs", "test-design", "L9-system-test-design.md");
  writeFileSync(path, mutate(readFileSync(path, "utf8")), "utf8");
}

function firstConsumerG9Command(
  manifest: ConsumerG9Manifest,
): ConsumerG9Manifest["commands"][number] {
  const command = manifest.commands[0];
  if (!command) throw new Error("consumer G9 fixture command is missing");
  return command;
}

const G10_CONSUMER_CASE_IDS = [
  "UXV-VISUAL-01",
  "UXV-TOKEN-01",
  "UXV-A11Y-01",
  "UXV-VRT-01",
  "UXV-REVIEW-01",
] as const;

const G10_CONSUMER_SCREEN_IDS = ["SC-001", "SC-002", "SC-003", "SC-004", "SC-005"] as const;

type ConsumerG10Manifest = {
  schema_version: string;
  gate: string;
  profile: string;
  plan_id: string;
  selected_uxv_ids: string[];
  mandatory_uxv_ids: string[];
  deferred_uxv_ids: string[];
  commands: {
    command_id: string;
    command: string;
    runner: string;
    scope: string;
    exit_code: number;
    evidence_path: string;
    output_digest: string;
    uxv_ids: string[];
  }[];
  coverage: {
    uxv_id: string;
    status: string;
    evidence_paths: string[];
    command_ids: string[];
  }[];
  exit_criteria: {
    all_mandatory_passed: boolean;
    failed_mandatory_count: number;
    stale_defer_count: number;
    doctor_check: string;
  };
  artifacts: Record<string, string>;
};

function consumerG10Manifest(): ConsumerG10Manifest {
  const commandId = "cmd-consumer-ux";
  const evidencePath = "tests/fixtures/g10-consumer/ux-results.txt";
  return {
    schema_version: "g10-ux-evidence-v1",
    gate: "G10",
    profile: "consumer-ux-minimum",
    plan_id: "PLAN-CONSUMER-01",
    selected_uxv_ids: [...G10_CONSUMER_CASE_IDS],
    mandatory_uxv_ids: [...G10_CONSUMER_CASE_IDS],
    deferred_uxv_ids: [],
    commands: [
      {
        command_id: commandId,
        command: "node tests/consumer-ux-check.mjs",
        runner: "playwright",
        scope: "consumer fixture",
        exit_code: 0,
        evidence_path: "tests/fixtures/g10-consumer/command-output.txt",
        output_digest: `sha256:${"0".repeat(64)}`,
        uxv_ids: [...G10_CONSUMER_CASE_IDS],
      },
    ],
    coverage: G10_CONSUMER_CASE_IDS.map((uxvId) => ({
      uxv_id: uxvId,
      status: "passed",
      evidence_paths: [evidencePath],
      command_ids: [commandId],
    })),
    exit_criteria: {
      all_mandatory_passed: true,
      failed_mandatory_count: 0,
      stale_defer_count: 0,
      doctor_check: "g10-ux-workflow",
    },
    artifacts: {
      ux_manifest: ".ut-tdd/evidence/g10-ux/ok.json",
      browser_visual_a11y_results: evidencePath,
    },
  };
}

function writeConsumerG10Fixture(root: string): void {
  const repositoryRoot = process.cwd();
  const l10Template = readFileSync(
    join(repositoryRoot, "docs/templates/vmodel/L10-ux-validation.md"),
    "utf8",
  );
  const rows = G10_CONSUMER_CASE_IDS.map(
    (caseId, index) =>
      `| ${caseId} | Consumer UX journey ${index + 1} | ${G10_CONSUMER_SCREEN_IDS[index]} | Expected screen behavior |`,
  ).join("\n");
  const l10 = l10Template
    .replace(/^status: .*$/m, "status: confirmed")
    .replace(/^pair_artifact: .*$/m, "pair_artifact: docs/design/L2-screen/screen-list.md")
    .replace(/^plan: .*$/m, "plan: docs/plans/PLAN-CONSUMER-01.md")
    .replace("| <記入> | <記入> | <記入> | <記入> |", rows);
  writeFixtureDoc(root, "docs/test-design/L10-ux-validation-test-design.md", l10);

  const screenRows = G10_CONSUMER_SCREEN_IDS.map(
    (screenId, index) =>
      `| ${screenId} | Consumer screen ${index + 1} | Summary | Feature | user |`,
  ).join("\n");
  writeFixtureDoc(
    root,
    "docs/design/L2-screen/screen-list.md",
    `---\ndoc_type_id: DOC-L2-SCREEN\nlayer: L2\nstatus: confirmed\npair_artifact: docs/test-design/L10-ux-validation-test-design.md\nplan: docs/plans/PLAN-CONSUMER-01.md\n---\n# DOC-L2-SCREEN\n\n#### 第4章 画面一覧\n\n| 画面ID | 画面名称 | 概要 | 関連機能 | ロール |\n|---|---|---|---|---|\n${screenRows}\n`,
  );
  writeFixtureDoc(root, "tests/fixtures/g10-consumer/ux-results.txt", "passed\n");
  writeFixtureDoc(root, "tests/fixtures/g10-consumer/command-output.txt", "passed\n");
  writeFixtureDoc(
    root,
    ".ut-tdd/evidence/g10-ux/ok.json",
    `${JSON.stringify(consumerG10Manifest(), null, 2)}\n`,
  );
}

function updateConsumerG10Manifest(
  root: string,
  mutate: (manifest: ConsumerG10Manifest) => void,
): void {
  const path = join(root, ".ut-tdd", "evidence", "g10-ux", "ok.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as ConsumerG10Manifest;
  mutate(manifest);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function updateConsumerG10Design(root: string, mutate: (content: string) => string): void {
  const path = join(root, "docs", "test-design", "L10-ux-validation-test-design.md");
  writeFileSync(path, mutate(readFileSync(path, "utf8")), "utf8");
}

function firstConsumerG10Command(
  manifest: ConsumerG10Manifest,
): ConsumerG10Manifest["commands"][number] {
  const command = manifest.commands[0];
  if (!command) throw new Error("consumer G10 fixture command is missing");
  return command;
}

const G11_CONSUMER_CASE_IDS = ["UAT-CONSUMER-01", "UAT-CONSUMER-02"] as const;
const G11_CONSUMER_REQUIREMENT_IDS = [
  "FR-01",
  ...Array.from({ length: 8 }, (_, index) => `NFR-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 7 }, (_, index) => `NFR-${String(index + 11).padStart(2, "0")}`),
] as const;

type ConsumerG11Manifest = {
  schema_version: string;
  gate: string;
  profile: string;
  plan_id: string;
  selected_uat_ids: string[];
  mandatory_uat_ids: string[];
  deferred_uat_ids: string[];
  commands: {
    command_id: string;
    command: string;
    runner: string;
    scope: string;
    exit_code: number;
    evidence_path: string;
    output_digest: string;
    uat_ids: string[];
  }[];
  coverage: {
    uat_id: string;
    status: string;
    evidence_paths: string[];
    command_ids: string[];
  }[];
  defer: { uat_id: string; reason: string; plan_id: string }[];
  exit_criteria: {
    all_mandatory_passed: boolean;
    failed_mandatory_count: number;
    stale_defer_count: number;
    doctor_check: string;
  };
  artifacts: Record<string, string>;
};

type ConsumerG11TraceReview = {
  requirements: { requirement_id: string; status: string }[];
};

type ConsumerG11Decision = {
  decision: string;
  decided_by_role: string;
  revision?: string;
};

function consumerG11Manifest(): ConsumerG11Manifest {
  const commandId = "cmd-consumer-uat";
  const uatResultsPath = "tests/fixtures/g11-consumer/uat-results.txt";
  return {
    schema_version: "g11-uat-evidence-v1",
    gate: "G11",
    profile: "consumer-uat-minimum",
    plan_id: "PLAN-CONSUMER-01",
    selected_uat_ids: [...G11_CONSUMER_CASE_IDS],
    mandatory_uat_ids: [...G11_CONSUMER_CASE_IDS],
    deferred_uat_ids: [],
    commands: [
      {
        command_id: commandId,
        command: "node tests/consumer-uat-check.mjs",
        runner: "node",
        scope: "consumer fixture",
        exit_code: 0,
        evidence_path: "tests/fixtures/g11-consumer/command-output.txt",
        output_digest: `sha256:${"0".repeat(64)}`,
        uat_ids: [...G11_CONSUMER_CASE_IDS],
      },
    ],
    coverage: G11_CONSUMER_CASE_IDS.map((uatId) => ({
      uat_id: uatId,
      status: "passed",
      evidence_paths: [uatResultsPath],
      command_ids: [commandId],
    })),
    defer: [],
    exit_criteria: {
      all_mandatory_passed: true,
      failed_mandatory_count: 0,
      stale_defer_count: 0,
      doctor_check: "g11-uat-workflow",
    },
    artifacts: {
      end_to_end_trace_review: ".ut-tdd/evidence/g11-uat/artifacts/trace-review.json",
      po_uat_decision: ".ut-tdd/evidence/g11-uat/artifacts/po-uat-decision.json",
    },
  };
}

function consumerG11TraceReview(): ConsumerG11TraceReview {
  return {
    requirements: G11_CONSUMER_REQUIREMENT_IDS.map((requirementId) => ({
      requirement_id: requirementId,
      status: "traced",
    })),
  };
}

function consumerG11Decision(): ConsumerG11Decision {
  return {
    decision: "accept",
    decided_by_role: "PO",
    revision: "0123456789abcdef0123456789abcdef01234567",
  };
}

function writeConsumerG11Fixture(root: string): void {
  const repositoryRoot = process.cwd();
  writeConsumerGateFixture(root);
  const l11Template = readFileSync(
    join(repositoryRoot, "docs/templates/vmodel/L11-trace-uat.md"),
    "utf8",
  );
  const caseRows = [
    "| FR-01 | PO シナリオ検収 | UAT | ユースケース | UAT-CONSUMER-01 |",
    "| NFR-01 | PO シナリオ検収 | UAT | 境界値 | UAT-CONSUMER-02 |",
  ].join("\n");
  const l11 = l11Template
    .replace(/^status: .*$/m, "status: confirmed")
    .replace(/^plan: .*$/m, "plan: docs/plans/PLAN-CONSUMER-01.md")
    .replace("| <記入> | <記入> | <記入> | <記入> | <記入> |", caseRows);
  writeFixtureDoc(root, "docs/process/evidence/g11-uat-review-design.md", l11);

  writeFixtureDoc(root, "tests/fixtures/g11-consumer/uat-results.txt", "passed\n");
  writeFixtureDoc(root, "tests/fixtures/g11-consumer/command-output.txt", "passed\n");
  writeFixtureDoc(
    root,
    ".ut-tdd/evidence/g11-uat/artifacts/trace-review.json",
    `${JSON.stringify(consumerG11TraceReview(), null, 2)}\n`,
  );
  writeFixtureDoc(
    root,
    ".ut-tdd/evidence/g11-uat/artifacts/po-uat-decision.json",
    `${JSON.stringify(consumerG11Decision(), null, 2)}\n`,
  );
  writeFixtureDoc(
    root,
    ".ut-tdd/evidence/g11-uat/ok.json",
    `${JSON.stringify(consumerG11Manifest(), null, 2)}\n`,
  );
}

function updateConsumerG11Manifest(
  root: string,
  mutate: (manifest: ConsumerG11Manifest) => void,
): void {
  const path = join(root, ".ut-tdd", "evidence", "g11-uat", "ok.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as ConsumerG11Manifest;
  mutate(manifest);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function updateConsumerG11Design(root: string, mutate: (content: string) => string): void {
  const path = join(root, "docs", "process", "evidence", "g11-uat-review-design.md");
  writeFileSync(path, mutate(readFileSync(path, "utf8")), "utf8");
}

function updateConsumerG11TraceReview(
  root: string,
  mutate: (traceReview: ConsumerG11TraceReview) => void,
): void {
  const path = join(root, ".ut-tdd", "evidence", "g11-uat", "artifacts", "trace-review.json");
  const traceReview = JSON.parse(readFileSync(path, "utf8")) as ConsumerG11TraceReview;
  mutate(traceReview);
  writeFileSync(path, `${JSON.stringify(traceReview, null, 2)}\n`, "utf8");
}

function updateConsumerG11Decision(
  root: string,
  mutate: (decision: ConsumerG11Decision) => void,
): void {
  const path = join(root, ".ut-tdd", "evidence", "g11-uat", "artifacts", "po-uat-decision.json");
  const decision = JSON.parse(readFileSync(path, "utf8")) as ConsumerG11Decision;
  mutate(decision);
  writeFileSync(path, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
}

function firstConsumerG11Command(
  manifest: ConsumerG11Manifest,
): ConsumerG11Manifest["commands"][number] {
  const command = manifest.commands[0];
  if (!command) throw new Error("consumer G11 fixture command is missing");
  return command;
}

const G12_CONSUMER_CASE_IDS = ["AT-FR-01-01", "AT-CONSUMER-02"] as const;
const G12_EVIDENCE_DIRECTORY = "g12-acceptance";
const G12_DEPLOY_RECEIPT_PATH = ".ut-tdd/evidence/g12-acceptance/artifacts/deploy-receipt.json";
const G12_ROLLBACK_READINESS_PATH =
  ".ut-tdd/evidence/g12-acceptance/artifacts/rollback-readiness.json";

type ConsumerG12Manifest = {
  schema_version: string;
  gate: string;
  profile: string;
  plan_id: string;
  selected_at_ids: string[];
  mandatory_at_ids: string[];
  deferred_at_ids: string[];
  commands: {
    command_id: string;
    command: string;
    runner: string;
    scope: string;
    exit_code: number;
    evidence_path: string;
    output_digest: string;
    at_ids: string[];
  }[];
  coverage: {
    at_id: string;
    status: string;
    evidence_paths: string[];
    command_ids: string[];
  }[];
  defer: { at_id: string; reason: string; plan_id: string }[];
  exit_criteria: {
    all_mandatory_passed: boolean;
    failed_mandatory_count: number;
    stale_defer_count: number;
    doctor_check: string;
  };
  artifacts: Record<string, string>;
};

function consumerG12Manifest(): ConsumerG12Manifest {
  const commandId = "cmd-consumer-acceptance";
  const acceptancePath = "tests/fixtures/g12-consumer/acceptance-results.txt";
  return {
    schema_version: "g12-acceptance-evidence-v1",
    gate: "G12",
    profile: "consumer-acceptance-minimum",
    plan_id: "PLAN-CONSUMER-01",
    selected_at_ids: [...G12_CONSUMER_CASE_IDS],
    mandatory_at_ids: [...G12_CONSUMER_CASE_IDS],
    deferred_at_ids: [],
    commands: [
      {
        command_id: commandId,
        command: "node tests/consumer-acceptance-check.mjs",
        runner: "node",
        scope: "consumer fixture",
        exit_code: 0,
        evidence_path: "tests/fixtures/g12-consumer/command-output.txt",
        output_digest: "sha256:" + "0".repeat(64),
        at_ids: [...G12_CONSUMER_CASE_IDS],
      },
    ],
    coverage: G12_CONSUMER_CASE_IDS.map((atId) => ({
      at_id: atId,
      status: "passed",
      evidence_paths: [acceptancePath],
      command_ids: [commandId],
    })),
    defer: [],
    exit_criteria: {
      all_mandatory_passed: true,
      failed_mandatory_count: 0,
      stale_defer_count: 0,
      doctor_check: "g12-acceptance-workflow",
    },
    artifacts: {
      deploy_receipt: G12_DEPLOY_RECEIPT_PATH,
      acceptance_results: acceptancePath,
      rollback_readiness: G12_ROLLBACK_READINESS_PATH,
    },
  };
}

function writeConsumerG12Fixture(root: string): void {
  writeConsumerGateFixture(root);
  const caseTablePath = join(root, "docs/test-design/L12-acceptance-test-design.md");
  const caseRows = [
    "| AT-FR-01-01 | 受入 | Consumer function の受入 | 手順どおり実行する | 合格 | AC-FR-01-01 |",
    "| AT-CONSUMER-02 | 受入 | 非機能の受入 | 計測する | 閾値内 | NFR-01 |",
  ].join("\n");
  const caseDesign = readFileSync(caseTablePath, "utf8").replace(
    "| <記入> | <記入> | <記入> | <記入> | <記入> | <記入> |",
    caseRows,
  );
  writeFileSync(caseTablePath, caseDesign, "utf8");
  writeFixtureDoc(root, "tests/fixtures/g12-consumer/acceptance-results.txt", "passed\n");
  writeFixtureDoc(root, "tests/fixtures/g12-consumer/command-output.txt", "passed\n");
  writeFixtureDoc(
    root,
    G12_DEPLOY_RECEIPT_PATH,
    JSON.stringify(
      {
        revision: "0123456789abcdef0123456789abcdef01234567",
        environment: "staging",
      },
      null,
      2,
    ) + "\n",
  );
  writeFixtureDoc(
    root,
    G12_ROLLBACK_READINESS_PATH,
    JSON.stringify(
      {
        rollback_command: "git revert --no-edit 0123456789abcdef0123456789abcdef01234567",
        verified_at: "2026-09-29T00:00:00Z",
      },
      null,
      2,
    ) + "\n",
  );
  writeFixtureDoc(
    root,
    ".ut-tdd/evidence/g12-acceptance/ok.json",
    JSON.stringify(consumerG12Manifest(), null, 2) + "\n",
  );
}

function updateConsumerG12Manifest(
  root: string,
  mutate: (manifest: ConsumerG12Manifest) => void,
): void {
  const path = join(root, ".ut-tdd", "evidence", G12_EVIDENCE_DIRECTORY, "ok.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as ConsumerG12Manifest;
  mutate(manifest);
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

function updateConsumerG12Design(root: string, mutate: (content: string) => string): void {
  const path = join(root, "docs/test-design/L12-acceptance-test-design.md");
  writeFileSync(path, mutate(readFileSync(path, "utf8")), "utf8");
}

function firstConsumerG12Command(
  manifest: ConsumerG12Manifest,
): ConsumerG12Manifest["commands"][number] {
  const command = manifest.commands[0];
  if (!command) throw new Error("consumer G12 fixture command is missing");
  return command;
}

const G13_CONSUMER_CASE_IDS = ["SMOKE-CONSUMER-01", "SMOKE-CONSUMER-02"] as const;
const G13_EVIDENCE_DIRECTORY = "g13-post-deploy";
const G13_SLI_SLO_PATH = ".ut-tdd/evidence/g13-post-deploy/artifacts/sli-slo.json";
const G13_ROLLBACK_PATH = ".ut-tdd/evidence/g13-post-deploy/artifacts/rollback.json";

type ConsumerG13Manifest = Omit<
  ConsumerG12Manifest,
  | "selected_at_ids"
  | "mandatory_at_ids"
  | "deferred_at_ids"
  | "commands"
  | "coverage"
  | "defer"
  | "artifacts"
> & {
  selected_smoke_ids: string[];
  mandatory_smoke_ids: string[];
  deferred_smoke_ids: string[];
  commands: (Omit<ConsumerG12Manifest["commands"][number], "at_ids"> & { smoke_ids: string[] })[];
  coverage: (Omit<ConsumerG12Manifest["coverage"][number], "at_id"> & { smoke_id: string })[];
  defer: { smoke_id: string; reason: string; plan_id: string }[];
  artifacts: Record<string, string>;
};

function consumerG13Manifest(): ConsumerG13Manifest {
  const commandId = "cmd-consumer-smoke";
  const smokePath = "tests/fixtures/g13-consumer/smoke-results.txt";
  return {
    schema_version: "g13-post-deploy-evidence-v1",
    gate: "G13",
    profile: "consumer-post-deploy-minimum",
    plan_id: "PLAN-CONSUMER-01",
    selected_smoke_ids: [...G13_CONSUMER_CASE_IDS],
    mandatory_smoke_ids: [...G13_CONSUMER_CASE_IDS],
    deferred_smoke_ids: [],
    commands: [
      {
        command_id: commandId,
        command: "node tests/consumer-smoke-check.mjs",
        runner: "node",
        scope: "consumer fixture",
        exit_code: 0,
        evidence_path: "tests/fixtures/g13-consumer/command-output.txt",
        output_digest: "sha256:" + "0".repeat(64),
        smoke_ids: [...G13_CONSUMER_CASE_IDS],
      },
    ],
    coverage: G13_CONSUMER_CASE_IDS.map((smokeId) => ({
      smoke_id: smokeId,
      status: "passed",
      evidence_paths: [smokePath],
      command_ids: [commandId],
    })),
    defer: [],
    exit_criteria: {
      all_mandatory_passed: true,
      failed_mandatory_count: 0,
      stale_defer_count: 0,
      doctor_check: "g13-post-deploy-workflow",
    },
    artifacts: {
      production_smoke: smokePath,
      sli_slo_observation: G13_SLI_SLO_PATH,
      rollback_decision: G13_ROLLBACK_PATH,
    },
  };
}

function writeConsumerG13Fixture(root: string): void {
  writeConsumerGateFixture(root);
  writeFixtureDoc(
    root,
    "docs/test-design/L12-acceptance-test-design.md",
    `${readFileSync(join(root, "docs/test-design/L12-acceptance-test-design.md"), "utf8")}\n| **AT-FR-01-02** | 未観測 |\n`,
  );
  const source = join(process.cwd(), "docs/templates/vmodel/L13-production-observation.md");
  const template = readFileSync(source, "utf8");
  writeFixtureDoc(
    root,
    "docs/process/evidence/g13-post-deploy-verification-design.md",
    template
      .replace("status: draft", "status: confirmed")
      .replace(/^plan: .*$/m, "plan: docs/plans/PLAN-CONSUMER-01.md")
      .replace(
        "| <SMOKE-ID> | <観測内容> | <合否基準> | <AT-ID> |",
        "| SMOKE-CONSUMER-01 | status / doctor の実行 | exit 0 | AT-FR-01-01 |\n| SMOKE-CONSUMER-02 | projection の rebuild | 失敗 0 | AT-FR-01-01 |",
      ),
  );
  writeFixtureDoc(
    root,
    "docs/plans/PLAN-CONSUMER-01.md",
    "---\nplan_id: PLAN-CONSUMER-01\nkind: add-impl\nstatus: confirmed\n---\n",
  );
  writeFixtureDoc(root, "tests/fixtures/g13-consumer/smoke-results.txt", "passed\n");
  writeFixtureDoc(root, "tests/fixtures/g13-consumer/command-output.txt", "passed\n");
  writeFixtureDoc(
    root,
    G13_SLI_SLO_PATH,
    JSON.stringify(
      {
        window_start: "2026-09-29T00:00:00Z",
        window_end: "2026-09-29T06:00:00Z",
        slos: [{ slo_id: "SLO-AVAIL", target: "99.9%", observed: 99.95 }],
      },
      null,
      2,
    ) + "\n",
  );
  writeFixtureDoc(root, G13_ROLLBACK_PATH, JSON.stringify({ decision: "keep" }, null, 2) + "\n");
  writeFixtureDoc(
    root,
    ".ut-tdd/evidence/g13-post-deploy/ok.json",
    JSON.stringify(consumerG13Manifest(), null, 2) + "\n",
  );
}

function updateConsumerG13Manifest(
  root: string,
  mutate: (manifest: ConsumerG13Manifest) => void,
): void {
  const path = join(root, ".ut-tdd", "evidence", G13_EVIDENCE_DIRECTORY, "ok.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as ConsumerG13Manifest;
  mutate(manifest);
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

function updateConsumerG13Design(root: string, mutate: (content: string) => string): void {
  const path = join(root, "docs/process/evidence/g13-post-deploy-verification-design.md");
  writeFileSync(path, mutate(readFileSync(path, "utf8")), "utf8");
}

function firstConsumerG13Command(
  manifest: ConsumerG13Manifest,
): ConsumerG13Manifest["commands"][number] {
  const command = manifest.commands[0];
  if (!command) throw new Error("consumer G13 fixture command is missing");
  return command;
}

function updateConsumerG13Artifact(
  root: string,
  path: string,
  mutate: (artifact: Record<string, unknown>) => void,
): void {
  const absolutePath = join(root, path);
  const artifact = JSON.parse(readFileSync(absolutePath, "utf8")) as Record<string, unknown>;
  mutate(artifact);
  writeFileSync(absolutePath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
}

function updateConsumerG12DeployReceipt(
  root: string,
  mutate: (receipt: Record<string, unknown>) => void,
): void {
  const path = join(root, G12_DEPLOY_RECEIPT_PATH);
  const receipt = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(receipt);
  writeFileSync(path, JSON.stringify(receipt, null, 2) + "\n", "utf8");
}

function updateConsumerG12RollbackReadiness(
  root: string,
  mutate: (readiness: Record<string, unknown>) => void,
): void {
  const path = join(root, G12_ROLLBACK_READINESS_PATH);
  const readiness = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(readiness);
  writeFileSync(path, JSON.stringify(readiness, null, 2) + "\n", "utf8");
}

function makeWritableTree(path: string): void {
  const stat = statSync(path);
  chmodSync(path, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) makeWritableTree(join(path, entry));
  }
}

afterAll(() => {
  for (const root of roots) {
    makeWritableTree(root);
    rmSync(root, { recursive: true, force: true });
  }
  if (buildOutputRoot) {
    makeWritableTree(buildOutputRoot);
    rmSync(buildOutputRoot, { recursive: true, force: true });
  }
});

describe("PR-G0 release-consumer gates", () => {
  it("keeps the public layer-pair API default bound to the harness L10 artifact", () => {
    const docs: PairDoc[] = [
      {
        path: "docs/design/harness/L2-screen/wireframe.md",
        layer: "L2",
        status: "confirmed",
        pairArtifact: "docs/test-design/harness/L10-ux-validation-test-design.md",
      },
      {
        path: "docs/test-design/harness/L10-ux-validation-test-design.md",
        layer: "L10",
        status: "confirmed",
        pairArtifact: "docs/design/harness/L2-screen/",
      },
    ];

    const result = analyzeLayerPairGate(docs, "G2", "L2");

    expect(result.ok).toBe(true);
    expect(result.mockMissing).toBe(false);
  });

  it("U-RCDEV-026: uses the embedded gate definition when the consumer has no copy", () => {
    const docs = loadGateConfirmDocs(fixtureRoot());
    const statuses = parseGateStatuses(docs.gateText);

    expect(docs.gateText.length).toBeGreaterThan(0);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.map((status) => status.gate)).toContain("G1");
  });

  it("U-RCDEV-026: lets the consumer gate definition override the embedded default", () => {
    const root = fixtureRoot();
    const consumerDefinition = [
      "## §2 Consumer gate ledger",
      "| Gate | Layer | Status | Evidence |",
      "| --- | --- | --- | --- |",
      "| G1 | L1 | consumer override | fixture |",
      "",
    ].join("\n");
    writeGateDefinition(root, consumerDefinition);

    const docs = loadGateConfirmDocs(root);

    expect(docs.gateText).toBe(consumerDefinition);
    expect(parseGateStatuses(docs.gateText)).toEqual([
      { gate: "G1", layer: "L1", status: "consumer override", pass: false },
    ]);
  });

  it("U-RCDEV-026: seals all three tracked gate assets in the generated receipt", async () => {
    buildOutputRoot = mkdtempSync(join(tmpdir(), "ut-tdd-release-consumer-gates-build-"));
    const candidateRevision = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    const generation = await buildNodeGeneration({
      outputRoot: buildOutputRoot,
      candidateRevision,
    });

    const receipt = new Map(
      generation.receipt.source_files.map((source) => [source.path, source.sha256]),
    );
    for (const path of GATE_ASSETS) {
      const trackedBytes = execFileSync("git", ["show", `HEAD:${path}`]);
      const expectedDigest = createHash("sha256").update(trackedBytes).digest("hex");
      expect(receipt.get(path), path).toBe(expectedDigest);
    }

    const consumer = fixtureRoot();
    writeFixtureDoc(
      consumer,
      "docs/design/L1-requirements/consumer.md",
      "---\nlayer: L1\nstatus: confirmed\n---\n# Consumer requirement\n",
    );
    const bundledGateMessage = (): string => {
      const result = spawnSync(
        generation.nodePath,
        [generation.compiledCliPath, "doctor", "--json"],
        {
          cwd: consumer,
          encoding: "utf8",
          timeout: 60_000,
          windowsHide: true,
          env: {
            ...process.env,
            HOME: consumer,
            USERPROFILE: consumer,
            APPDATA: consumer,
            CLAUDE_PROJECT_DIR: "",
            CLAUDE_CODE_ENTRYPOINT: "",
            UT_TDD_DISABLE_CLAUDE_MEMORY_WAKE: "1",
            UT_TDD_PROJECT_DIR: "",
            UT_TDD_CLAUDE_SESSIONS_DIR: join(consumer, ".claude", "projects"),
            UT_TDD_CODEX_SESSIONS_DIR: join(consumer, ".codex", "sessions"),
          },
        },
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect([0, 1], result.stderr).toContain(result.status);
      const report = JSON.parse(result.stdout) as { messages: string[] };
      const messages = report.messages.filter((message) =>
        message.startsWith("doctor: gate-confirm"),
      );
      expect(messages, result.stdout).toHaveLength(1);
      return messages[0] as string;
    };

    // No checkout gate assets exist in this consumer; the compiled CLI must
    // parse its embedded ledger rather than catch a missing source-file error.
    expect(bundledGateMessage()).toContain("gate-confirm — OK");
    writeGateDefinition(
      consumer,
      "## §2 Consumer gate ledger\n| Gate | Layer | Status | Evidence |\n| --- | --- | --- | --- |\n| G1 | L1 | consumer override | fixture |\n",
    );
    // Doctor's aggregate can fail for this deliberately minimal fixture.
    // Only the named production check proves consumer precedence here.
    expect(bundledGateMessage()).toContain("G1=consumer override");
  });

  it("U-RCDEV-027: evaluates consumer G1-G6 fixture with non-empty bidirectional traces", () => {
    const root = fixtureRoot();
    writeConsumerGateFixture(root);

    const g1Trace = analyzeG1Trace(loadG1TraceDocs(root));
    const g3Trace = analyzeG3Trace(loadDocs(root));
    expect(g1TraceOk(g1Trace)).toBe(true);
    expect(g1Trace.totals.business).toBeGreaterThan(0);
    expect(g1Trace.totals.screen).toBeGreaterThan(0);
    expect(g1Trace.totals.p0Fr).toBeGreaterThan(0);
    expect(g3TraceOk(g3Trace)).toBe(true);
    expect(g3Trace.totals).toMatchObject({ frL1: 1, l3Fr: 1, ac: 1, at: 1, l1Nfr: 15, l3Nfr: 15 });

    const results = ["G1", "G2", "G3", "G4", "G5", "G6"].map((gate) =>
      evaluateStaticGate({ gate, repoRoot: root }),
    );
    expect(results.map(({ gate, applicable }) => [gate, applicable])).toEqual(
      ["G1", "G2", "G3", "G4", "G5", "G6"].map((gate) => [gate, true]),
    );
    expect(results.every((result) => result.passed)).toBe(true);
    expect(results.flatMap((result) => result.messages).join("\n")).not.toContain("could not run");
    expect(g1TraceMessages(g1Trace).join("\n")).toContain("business=1");
    expect(g3TraceMessages(g3Trace).join("\n")).toContain("frL1=1, l3Fr=1, ac=1, at=1");
  });

  it("U-RCDEV-027: reports the missing required consumer slot, not could-not-run", () => {
    const root = fixtureRoot();
    writeConsumerGateFixture(root, { omitRequiredSlot: true });

    const result = evaluateStaticGate({ gate: "G1", repoRoot: root });
    const messages = result.messages.join("\n");

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(messages).toContain(
      "required doc not created: docs/design/harness/L1-requirements/business-requirements.md",
    );
    expect(messages).not.toContain("could not run");
  });

  it("U-RCDEV-027: rejects a consumer fixture without its L2-to-L10 wireframe pair", () => {
    const root = fixtureRoot();
    writeConsumerGateFixture(root, { omitWireframe: true });

    const result = evaluateStaticGate({ gate: "G2", repoRoot: root });
    const messages = result.messages.join("\n");

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(messages).toContain("mock=missing");
    expect(messages).not.toContain("could not run");
  });

  it("U-RCDEV-028: returns a typed missing-coverage reason and accepts an 80% consumer summary", () => {
    const root = fixtureRoot();
    writeConsumerGateFixture(root);
    const coveragePath = join(root, "coverage", "coverage-summary.json");

    const missing = evaluateStaticGate({ gate: "G7", repoRoot: root });
    const missingCoverage = readCoverageSummary(coveragePath);

    expect(missing.applicable).toBe(true);
    expect(missing.passed).toBe(false);
    expect(missing.reasons).toEqual(["coverage_evidence_missing"]);
    expect(missing.messages.join("\n")).toContain(
      `g7-coverage - violation: coverage summary not found (${coveragePath}); run test coverage before G7`,
    );
    expect(missing.messages.join("\n")).not.toContain("could not run");
    expect(missingCoverage).toMatchObject({
      ok: false,
      pct: null,
      reasons: ["coverage_evidence_missing"],
    });
    writeFixtureDoc(root, "coverage/unreadable.json", "{");
    expect(readCoverageSummary(join(root, "coverage", "unreadable.json"))).toMatchObject({
      ok: false,
      pct: null,
      reasons: ["coverage_summary_unreadable"],
    });
    writeFixtureDoc(root, "coverage/null-summary.json", "null");
    expect(readCoverageSummary(join(root, "coverage", "null-summary.json"))).toMatchObject({
      ok: false,
      pct: null,
      reasons: ["coverage_summary_unreadable"],
    });
    writeFixtureDoc(
      root,
      "coverage/missing-pct.json",
      JSON.stringify({ total: { branches: { pct: 100 } } }),
    );
    expect(readCoverageSummary(join(root, "coverage", "missing-pct.json"))).toMatchObject({
      ok: false,
      pct: null,
      reasons: ["coverage_summary_unreadable"],
    });
    writeFixtureDoc(
      root,
      "coverage/below-threshold.json",
      JSON.stringify({ total: { lines: { pct: 79 } } }),
    );
    expect(readCoverageSummary(join(root, "coverage", "below-threshold.json"))).toMatchObject({
      ok: false,
      pct: 79,
      reasons: ["coverage_below_threshold"],
    });

    writeFixtureDoc(
      root,
      "coverage/coverage-summary.json",
      JSON.stringify({ total: { lines: { pct: 80 } } }),
    );

    const passingCoverage = readCoverageSummary(coveragePath);
    const withCoverage = evaluateStaticGate({ gate: "G7", repoRoot: root });

    expect(passingCoverage).toMatchObject({ ok: true, pct: 80 });
    expect(passingCoverage.reasons).toBeUndefined();
    expect(passingCoverage.message).toBe("g7-coverage - OK (80% >= 80%)");
    expect(withCoverage.passed).toBe(false);
    expect(withCoverage.reasons).toBeUndefined();
    expect(withCoverage.messages).toContain("g7-coverage - OK (80% >= 80%)");
  });
});

describe("PR-GR consumer G8 predicates", () => {
  it("U-RCDEV-029: evaluates consumer G8 from the embedded contract without a local copy", () => {
    const root = fixtureRoot();
    writeConsumerG8Fixture(root);

    const result = evaluateStaticGate({ gate: "G8", repoRoot: root });
    const messages = result.messages.join("\n");

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(true);
    expect(messages).toContain("未判定 (review): QA/TL");
  });

  it("U-RCDEV-029: prefers a consumer contract override for G8 manifest location", () => {
    const root = fixtureRoot();
    writeConsumerG8Fixture(root, {
      evidenceDirectory: "g8-consumer-override",
      contractOverride: true,
    });
    expect(readFileSync(join(root, "docs/process/vmodel-contract.yaml"), "utf8")).toContain(
      "evidence_manifest: .ut-tdd/evidence/g8-consumer-override/engine-swap.json",
    );

    const result = evaluateStaticGate({ gate: "G8", repoRoot: root });

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.messages.join("\n")).toContain("未判定 (review): QA/TL");
  });

  it("U-RCDEV-029: rejects a missing required case-table column (S)", () => {
    const root = fixtureRoot();
    writeConsumerG8Fixture(root);
    const path = join(root, "docs/test-design/L8-integration-test-design.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("期待結果", "結果"), "utf8");

    const result = evaluateStaticGate({ gate: "G8", repoRoot: root });
    const messages = result.messages.join("\n");

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(messages).toContain("missing section");
  });

  it("U-RCDEV-029: rejects duplicate IT case IDs (I)", () => {
    const root = fixtureRoot();
    writeConsumerG8Fixture(root);
    const path = join(root, "docs/test-design/L8-integration-test-design.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("IT-CONSUMER-02", "IT-CONSUMER-01"),
      "utf8",
    );

    const result = evaluateStaticGate({ gate: "G8", repoRoot: root });

    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("duplicate case id");
  });

  it("U-RCDEV-029: rejects a citation to an undefined L5 target (T)", () => {
    const root = fixtureRoot();
    writeConsumerG8Fixture(root);
    const path = join(root, "docs/test-design/L8-integration-test-design.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "DOC-L5-MODULE / DOC-L5-PHYSICAL-DATA",
        "DOC-L5-UNKNOWN / DOC-L5-PHYSICAL-DATA",
      ),
      "utf8",
    );

    const result = evaluateStaticGate({ gate: "G8", repoRoot: root });

    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("trace target missing");
  });

  it("U-RCDEV-029: rejects a case without an L5 citation (T)", () => {
    const root = fixtureRoot();
    writeConsumerG8Fixture(root);
    const path = join(root, "docs/test-design/L8-integration-test-design.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(" | DOC-L5-MODULE / DOC-L5-PHYSICAL-DATA |", " | |"),
      "utf8",
    );

    const result = evaluateStaticGate({ gate: "G8", repoRoot: root });

    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("untraced case IT-CONSUMER-01");
  });

  it("U-RCDEV-029: rejects a nonzero command result (E)", () => {
    const root = fixtureRoot();
    writeConsumerG8Fixture(root);
    updateConsumerG8Manifest(root, (manifest) => {
      firstConsumerCommand(manifest).exit_code = 1;
    });

    const result = evaluateStaticGate({ gate: "G8", repoRoot: root });

    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("exit_code is non-zero");
  });

  it("U-RCDEV-029: rejects a malformed output digest (E)", () => {
    const root = fixtureRoot();
    writeConsumerG8Fixture(root);
    updateConsumerG8Manifest(root, (manifest) => {
      firstConsumerCommand(manifest).output_digest = "sha256:xyz";
    });

    const result = evaluateStaticGate({ gate: "G8", repoRoot: root });

    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("invalid digest");
  });

  it("U-RCDEV-029: rejects a missing or disallowed command evidence path (E)", () => {
    const root = fixtureRoot();
    writeConsumerG8Fixture(root);
    updateConsumerG8Manifest(root, (manifest) => {
      firstConsumerCommand(manifest).evidence_path = ".external/command-output.txt";
    });

    const result = evaluateStaticGate({ gate: "G8", repoRoot: root });

    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("evidence_path missing");
  });

  it("U-RCDEV-029: rejects a G9 manifest schema in consumer G8 (E)", () => {
    const root = fixtureRoot();
    writeConsumerG8Fixture(root);
    updateConsumerG8Manifest(root, (manifest) => {
      manifest.schema_version = "g9-system-evidence-v1";
    });

    const result = evaluateStaticGate({ gate: "G8", repoRoot: root });

    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("invalid schema_version");
  });

  it("U-RCDEV-029: rejects a designed case omitted from all evidence (F)", () => {
    const root = fixtureRoot();
    writeConsumerG8Fixture(root);
    updateConsumerG8Manifest(root, (manifest) => {
      const missingId = "IT-CONSUMER-06";
      manifest.selected_it_ids = manifest.selected_it_ids.filter((id) => id !== missingId);
      manifest.mandatory_it_ids = manifest.mandatory_it_ids.filter((id) => id !== missingId);
      firstConsumerCommand(manifest).it_ids = firstConsumerCommand(manifest).it_ids.filter(
        (id) => id !== missingId,
      );
      manifest.coverage = manifest.coverage.filter((entry) => entry.it_id !== missingId);
    });

    const result = evaluateStaticGate({ gate: "G8", repoRoot: root });

    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("missing row evidence IT-CONSUMER-06");
  });

  it("U-RCDEV-029: rejects a missing contract-required result artifact (A)", () => {
    const root = fixtureRoot();
    writeConsumerG8Fixture(root);
    updateConsumerG8Manifest(root, (manifest) => {
      delete manifest.artifacts.integration_results;
    });

    const result = evaluateStaticGate({ gate: "G8", repoRoot: root });

    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("missing artifact integration_results");
  });

  it("U-RCDEV-029: routes each E-only mutation to consumer G8 validation", () => {
    const mutations: {
      name: string;
      expected: string;
      mutate: (manifest: ConsumerG8Manifest) => void;
    }[] = [
      {
        name: "schema",
        expected: "invalid schema_version",
        mutate: (manifest) => {
          manifest.schema_version = "g9-system-evidence-v1";
        },
      },
      {
        name: "gate",
        expected: "gate must be G8",
        mutate: (manifest) => {
          manifest.gate = "G9";
        },
      },
      {
        name: "exit code",
        expected: "exit_code is non-zero",
        mutate: (manifest) => {
          firstConsumerCommand(manifest).exit_code = 1;
        },
      },
      {
        name: "digest",
        expected: "invalid digest",
        mutate: (manifest) => {
          firstConsumerCommand(manifest).output_digest = `sha256:${"a".repeat(63)}`;
        },
      },
      {
        name: "stale defer count type",
        expected: "stale_defer_count must be 0",
        mutate: (manifest) => {
          (manifest.exit_criteria as unknown as Record<string, unknown>).stale_defer_count = "0";
        },
      },
    ];

    for (const mutation of mutations) {
      const root = fixtureRoot();
      writeConsumerG8Fixture(root);
      updateConsumerG8Manifest(root, mutation.mutate);

      const result = evaluateStaticGate({ gate: "G8", repoRoot: root });

      expect(result.passed, mutation.name).toBe(false);
      expect(result.messages.join("\n"), mutation.name).toContain(mutation.expected);
    }
  });

  it("U-RCDEV-029: keeps harness G8 family checks on the public gate path", () => {
    const root = fixtureRoot();
    const repositoryRoot = process.cwd();
    const harnessResult = evaluateStaticGate({ gate: "G8", repoRoot: repositoryRoot });
    expect(harnessResult.passed).toBe(true);
    expect(harnessResult.messages).toContain("未判定 (review): QA/TL");
    writeFixtureDoc(
      root,
      "docs/test-design/harness/L8-integration-test-design.md",
      readFileSync(
        join(repositoryRoot, "docs/test-design/harness/L8-integration-test-design.md"),
        "utf8",
      ),
    );
    writeFixtureDoc(
      root,
      "docs/process/gates.md",
      readFileSync(join(repositoryRoot, "docs/process/gates.md"), "utf8"),
    );
    const sourceManifestPath = join(
      repositoryRoot,
      ".ut-tdd/evidence/g8-integration/20260626-it-module-state-minimum.json",
    );
    const manifest = JSON.parse(readFileSync(sourceManifestPath, "utf8")) as {
      selected_it_ids: string[];
      mandatory_it_ids: string[];
      commands: { it_ids: string[]; evidence_path: string }[];
      coverage: { it_id: string; evidence_paths: string[] }[];
    };
    // 別familyの負例データであり、そのfamilyのoracle実装citationではない。
    const unrelatedFamilyIds = ["01", "02"].map((suffix) => ["IT", "ASSET", suffix].join("-"));
    manifest.selected_it_ids = [...unrelatedFamilyIds];
    manifest.mandatory_it_ids = [...unrelatedFamilyIds];
    manifest.commands = manifest.commands.map((command) => ({
      ...command,
      it_ids: [...unrelatedFamilyIds],
    }));
    manifest.coverage = manifest.coverage.map((entry, index) => ({
      ...entry,
      it_id: unrelatedFamilyIds[index % unrelatedFamilyIds.length] as string,
    }));
    const evidencePaths = new Set([
      ...manifest.commands.map((command) => command.evidence_path),
      ...manifest.coverage.flatMap((entry) => entry.evidence_paths),
    ]);
    for (const path of evidencePaths) {
      writeFixtureDoc(root, path, readFileSync(join(repositoryRoot, path), "utf8"));
    }
    writeFixtureDoc(
      root,
      ".ut-tdd/evidence/g8-integration/consumer-family-negative.json",
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    const result = evaluateStaticGate({ gate: "G8", repoRoot: root });
    const messages = result.messages.join("\n");

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(messages).toContain("selected IT coverage missing IT-MODULE- family");
    expect(messages).toContain("mandatory IT coverage missing IT-STATE- family");
    expect(messages).toContain("未判定 (review): QA/TL");

    writeFixtureDoc(
      root,
      "docs/process/vmodel-contract.yaml",
      readFileSync(join(repositoryRoot, "docs/process/vmodel-contract.yaml"), "utf8").replace(
        "    approval_role: QA/TL",
        "    approval_role: TL",
      ),
    );
    const changedRole = evaluateStaticGate({ gate: "G8", repoRoot: root });
    expect(changedRole.passed).toBe(false);
    expect(changedRole.messages).toContain("未判定 (review): TL");
    expect(changedRole.messages).not.toContain("未判定 (review): QA/TL");
  });
});

describe("PR-G9 consumer G9 predicates", () => {
  it("U-RCDEV-030: evaluates consumer G9 from the contract and emits its review tier", () => {
    const root = fixtureRoot();
    const obligation = g9ContractObligation();
    writeConsumerG9Fixture(root);

    const result = evaluateStaticGate({ gate: "G9", repoRoot: root });
    const messages = result.messages.join("\n");

    expect(obligation.evidenceFamilies).toEqual(
      expect.arrayContaining(["ST", "performance", "security"]),
    );
    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(true);
    expect(messages).toContain(`未判定 (review): ${obligation.approvalRole}`);
  });

  it("U-RCDEV-030: rejects each missing G9 template chapter and subsection (S)", () => {
    const template = readFileSync(
      join(process.cwd(), "docs/templates/vmodel/L9-system-test-design.md"),
      "utf8",
    );
    const headings = template.split(/\r?\n/).filter((line) => /^#{4,5} /.test(line));
    expect(headings.length).toBeGreaterThan(7);
    const acceptedMissingHeadings: string[] = [];
    for (const heading of headings) {
      const root = fixtureRoot();
      writeConsumerG9Fixture(root);
      updateConsumerG9Design(root, (content) =>
        content
          .split(/\r?\n/)
          .filter((line) => line !== heading)
          .join("\n"),
      );
      const result = evaluateStaticGate({ gate: "G9", repoRoot: root });
      if (result.passed || !result.messages.join("\n").includes(`missing section ${heading}`)) {
        acceptedMissingHeadings.push(heading);
      }
    }
    expect(acceptedMissingHeadings).toEqual([]);
  });

  it("U-RCDEV-030: rejects a missing required G9 case-table column (S)", () => {
    const root = fixtureRoot();
    writeConsumerG9Fixture(root);
    updateConsumerG9Design(root, (content) => content.replace("期待結果", "結果"));

    const result = evaluateStaticGate({ gate: "G9", repoRoot: root });

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("missing section");
  });

  it("U-RCDEV-030: rejects duplicate ST case IDs (I)", () => {
    const root = fixtureRoot();
    writeConsumerG9Fixture(root);
    updateConsumerG9Design(root, (content) => content.replace("ST-CONSUMER-02", "ST-CONSUMER-01"));

    const result = evaluateStaticGate({ gate: "G9", repoRoot: root });

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("duplicate case id");
  });

  it("U-RCDEV-030: rejects a case whose only citation is outside the L4 pair (T)", () => {
    const root = fixtureRoot();
    writeConsumerG9Fixture(root);
    updateConsumerG9Design(root, (content) =>
      content.replace("DOC-L4-ARCHITECTURE", "DOC-L5-MODULE"),
    );

    const result = evaluateStaticGate({ gate: "G9", repoRoot: root });

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("untraced case ST-CONSUMER-01");
  });

  it("U-RCDEV-030: rejects a defer to a missing PLAN (F)", () => {
    const root = fixtureRoot();
    writeConsumerG9Fixture(root);
    updateConsumerG9Manifest(root, (manifest) => {
      const deferredId = "ST-CONSUMER-06";
      manifest.mandatory_st_ids = manifest.mandatory_st_ids.filter((id) => id !== deferredId);
      manifest.deferred_st_ids = [deferredId];
      manifest.coverage = manifest.coverage.filter((entry) => entry.st_id !== deferredId);
      manifest.defer = [
        {
          st_id: deferredId,
          reason: "Consumer fixture defer mutation",
          plan_id: "PLAN-CONSUMER-MISSING-01",
        },
      ];
    });

    const result = evaluateStaticGate({ gate: "G9", repoRoot: root });

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("stale defer ST-CONSUMER-06");
  });

  it("U-RCDEV-030: accepts a deferred ST row routed to an existing PLAN (F)", () => {
    const root = fixtureRoot();
    writeConsumerG9Fixture(root);
    writeFixtureDoc(root, "docs/plans/PLAN-CONSUMER-DEFER-01.md", "# Consumer defer plan\n");
    updateConsumerG9Manifest(root, (manifest) => {
      const deferredId = "ST-CONSUMER-06";
      manifest.mandatory_st_ids = manifest.mandatory_st_ids.filter((id) => id !== deferredId);
      manifest.deferred_st_ids = [deferredId];
      manifest.coverage = manifest.coverage.filter((entry) => entry.st_id !== deferredId);
      manifest.defer = [
        {
          st_id: deferredId,
          reason: "Consumer fixture defers this row to its tracked plan",
          plan_id: "PLAN-CONSUMER-DEFER-01",
        },
      ];
    });

    const result = evaluateStaticGate({ gate: "G9", repoRoot: root });

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.messages.join("\n")).toContain("未判定 (review): QA/TL");
  });

  it("U-RCDEV-030: rejects a missing contract-required system manifest artifact (A)", () => {
    const root = fixtureRoot();
    writeConsumerG9Fixture(root);
    updateConsumerG9Manifest(root, (manifest) => {
      delete manifest.artifacts.system_manifest;
    });

    const result = evaluateStaticGate({ gate: "G9", repoRoot: root });

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("missing artifact system_manifest");
  });

  it("U-RCDEV-030: requires every contract evidence family in consumer case rows", () => {
    const root = fixtureRoot();
    const securityFamily = g9ContractObligation().evidenceFamilies.find(
      (family) => family === "security",
    );
    if (!securityFamily) throw new Error("consumer G9 contract has no security evidence family");
    writeConsumerG9Fixture(root);
    updateConsumerG9Design(root, (content) =>
      content.replaceAll(`| ${securityFamily} |`, "| ST |"),
    );

    const result = evaluateStaticGate({ gate: "G9", repoRoot: root });
    const messages = result.messages.join("\n");

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(messages).toContain(securityFamily);
  });

  it("U-RCDEV-030: rejects an unknown per-row G9 evidence family", () => {
    const root = fixtureRoot();
    const securityFamily = g9ContractObligation().evidenceFamilies.find(
      (family) => family === "security",
    );
    if (!securityFamily) throw new Error("consumer G9 contract has no security evidence family");
    writeConsumerG9Fixture(root);
    updateConsumerG9Design(root, (content) =>
      content.replace(
        `| ${securityFamily} | DOC-L4-ARCHITECTURE |`,
        "| UNKNOWN-FAMILY | DOC-L4-ARCHITECTURE |",
      ),
    );

    const result = evaluateStaticGate({ gate: "G9", repoRoot: root });
    const messages = result.messages.join("\n");

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(messages).toContain("UNKNOWN-FAMILY");
  });

  it("U-RCDEV-030: rejects failed mandatory G9 exit criteria (E)", () => {
    const root = fixtureRoot();
    writeConsumerG9Fixture(root);
    updateConsumerG9Manifest(root, (manifest) => {
      manifest.exit_criteria.failed_mandatory_count = 1;
    });

    const result = evaluateStaticGate({ gate: "G9", repoRoot: root });

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("U-RCDEV-030: routes each E-only mutation through consumer G9 validation", () => {
    const mutations: {
      name: string;
      expected: string;
      mutate: (manifest: ConsumerG9Manifest) => void;
    }[] = [
      {
        name: "schema",
        expected: "invalid schema_version",
        mutate: (manifest) => {
          manifest.schema_version = "g8-integration-evidence-v1";
        },
      },
      {
        name: "gate",
        expected: "gate must be G9",
        mutate: (manifest) => {
          manifest.gate = "G8";
        },
      },
      {
        name: "exit code",
        expected: "exit_code is non-zero",
        mutate: (manifest) => {
          firstConsumerG9Command(manifest).exit_code = 1;
        },
      },
      {
        name: "digest",
        expected: "invalid digest",
        mutate: (manifest) => {
          firstConsumerG9Command(manifest).output_digest = `sha256:${"a".repeat(63)}`;
        },
      },
      {
        name: "stale defer count type",
        expected: "stale_defer_count must be 0",
        mutate: (manifest) => {
          (manifest.exit_criteria as unknown as Record<string, unknown>).stale_defer_count = "0";
        },
      },
    ];

    for (const mutation of mutations) {
      const root = fixtureRoot();
      writeConsumerG9Fixture(root);
      updateConsumerG9Manifest(root, mutation.mutate);

      const result = evaluateStaticGate({ gate: "G9", repoRoot: root });

      expect(result.applicable, mutation.name).toBe(true);
      expect(result.passed, mutation.name).toBe(false);
      expect(result.messages.join("\n"), mutation.name).toContain(mutation.expected);
    }
  });

  it("U-RCDEV-030: preserves the existing harness G9 workflow result on the public gate path", () => {
    const repositoryRoot = process.cwd();
    const workflow = checkG9SystemWorkflow(repositoryRoot);
    const result = evaluateStaticGate({ gate: "G9", repoRoot: repositoryRoot });
    const workflowMessages = result.messages.filter((message) =>
      message.startsWith("g9-system-workflow"),
    );

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(workflow.ok);
    expect(workflowMessages).toEqual(workflow.messages);
    expect(result.messages).toContain(`未判定 (review): ${g9ContractObligation().approvalRole}`);
  });
});

describe("PR-G10 consumer G10 predicates", () => {
  it("U-RCDEV-031: accepts multiple defined screen citations and rejects an empty trace", () => {
    const root = fixtureRoot();
    writeConsumerG10Fixture(root);
    updateConsumerG10Design(root, (content) => content.replace("| SC-001 |", "| SC-001, SC-002 |"));
    const valid = evaluateStaticGate({ gate: "G10", repoRoot: root });
    expect(valid.applicable).toBe(true);
    expect(valid.passed).toBe(true);

    updateConsumerG10Design(root, (content) => content.replace("| SC-001, SC-002 |", "| |"));
    const invalid = evaluateStaticGate({ gate: "G10", repoRoot: root });
    expect(invalid.applicable).toBe(true);
    expect(invalid.passed).toBe(false);
    expect(invalid.messages.join("\n")).toContain("untraced case UXV-VISUAL-01");
  });

  it("U-RCDEV-031: evaluates consumer G10 from its L10 contract and L2 screen IDs", () => {
    const root = fixtureRoot();
    writeConsumerG10Fixture(root);

    const result = evaluateStaticGate({ gate: "G10", repoRoot: root });

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.messages.join("\n")).toContain("未判定 (review): PO/QA");
  });

  it("U-RCDEV-031: requires all eight L10 template chapters and the No/対象画面 case columns (S)", () => {
    const template = readFileSync(
      join(process.cwd(), "docs/templates/vmodel/L10-ux-validation.md"),
      "utf8",
    );
    const headings = template.split(/\r?\n/).filter((line) => /^#### 第[1-8]章 /.test(line));
    expect(headings).toHaveLength(8);
    const acceptedMissingHeadings: string[] = [];
    for (const heading of headings) {
      const root = fixtureRoot();
      writeConsumerG10Fixture(root);
      updateConsumerG10Design(root, (content) =>
        content
          .split(/\r?\n/)
          .filter((line) => line !== heading)
          .join("\n"),
      );
      const result = evaluateStaticGate({ gate: "G10", repoRoot: root });
      if (result.passed || !result.messages.join("\n").includes(`missing section ${heading}`)) {
        acceptedMissingHeadings.push(heading);
      }
    }
    expect(acceptedMissingHeadings).toEqual([]);

    const root = fixtureRoot();
    writeConsumerG10Fixture(root);
    updateConsumerG10Design(root, (content) => content.replace("対象画面", "画面"));
    const result = evaluateStaticGate({ gate: "G10", repoRoot: root });
    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("missing section");
  });

  it("U-RCDEV-031: rejects duplicate UXV case IDs (I)", () => {
    const root = fixtureRoot();
    writeConsumerG10Fixture(root);
    updateConsumerG10Design(root, (content) => content.replace("UXV-TOKEN-01", "UXV-VISUAL-01"));

    const result = evaluateStaticGate({ gate: "G10", repoRoot: root });

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("duplicate case id");
  });

  it("U-RCDEV-031: requires each 対象画面 value to be a defined DOC-L2-SCREEN screen ID (T)", () => {
    const root = fixtureRoot();
    writeConsumerG10Fixture(root);
    updateConsumerG10Design(root, (content) => content.replace("| SC-001 |", "| DOC-L2-OTHER |"));

    const result = evaluateStaticGate({ gate: "G10", repoRoot: root });

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("trace target missing");
  });

  it("U-RCDEV-031: does not infer screen IDs from a L2 document with an empty formal screen table (T)", () => {
    const root = fixtureRoot();
    writeConsumerG10Fixture(root);
    writeFixtureDoc(
      root,
      "docs/design/L2-screen/screen-list.md",
      "---\ndoc_type_id: DOC-L2-SCREEN\nlayer: L2\nstatus: confirmed\npair_artifact: docs/test-design/L10-ux-validation-test-design.md\nplan: docs/plans/PLAN-CONSUMER-01.md\n---\n# DOC-L2-SCREEN\n\n#### 第4章 画面一覧\n\n| 画面ID | 画面名称 | 概要 | 関連機能 | ロール |\n|---|---|---|---|---|\n",
    );

    const result = evaluateStaticGate({ gate: "G10", repoRoot: root });

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("trace target missing");
  });

  it("U-RCDEV-031: rejects a designed UXV case omitted from all evidence (F)", () => {
    const root = fixtureRoot();
    writeConsumerG10Fixture(root);
    updateConsumerG10Manifest(root, (manifest) => {
      const missingId = "UXV-REVIEW-01";
      manifest.selected_uxv_ids = manifest.selected_uxv_ids.filter((id) => id !== missingId);
      manifest.mandatory_uxv_ids = manifest.mandatory_uxv_ids.filter((id) => id !== missingId);
      firstConsumerG10Command(manifest).uxv_ids = firstConsumerG10Command(manifest).uxv_ids.filter(
        (id) => id !== missingId,
      );
      manifest.coverage = manifest.coverage.filter((entry) => entry.uxv_id !== missingId);
    });

    const result = evaluateStaticGate({ gate: "G10", repoRoot: root });

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("missing row evidence UXV-REVIEW-01");
  });

  it("U-RCDEV-031: rejects a missing contract-required browser visual/a11y artifact (A)", () => {
    const root = fixtureRoot();
    writeConsumerG10Fixture(root);
    updateConsumerG10Manifest(root, (manifest) => {
      delete manifest.artifacts.browser_visual_a11y_results;
    });

    const result = evaluateStaticGate({ gate: "G10", repoRoot: root });

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("missing artifact browser_visual_a11y_results");
  });

  it("U-RCDEV-031: keeps skipped G10 applicable and failed for every reason/profile variation", () => {
    const variations = [
      {
        name: "non-empty reason",
        skipReason: "L10 has no consumer profile authority",
        profile: undefined,
      },
      { name: "empty reason", skipReason: "", profile: undefined },
      { name: "cli profile", skipReason: "L10 has no consumer profile authority", profile: "cli" },
    ] as const;
    for (const variation of variations) {
      const root = fixtureRoot();
      writeConsumerG10Fixture(root);
      updateConsumerG10Design(root, (content) => {
        const status = content.match(/^status: .*$/m)?.[0];
        if (!status) throw new Error("consumer G10 fixture has no status frontmatter");
        return content.replace(
          status,
          `status: skipped\nskip_reason: ${JSON.stringify(variation.skipReason)}`,
        );
      });
      if (variation.profile) {
        updateConsumerG10Manifest(root, (manifest) => {
          manifest.profile = variation.profile;
        });
      }

      const result = evaluateStaticGate({ gate: "G10", repoRoot: root });
      const messages = result.messages.join("\n");

      expect(result.applicable, variation.name).toBe(true);
      expect(result.passed, variation.name).toBe(false);
      expect(messages, variation.name).toContain(
        "skipped slot DOC-L10-UX-VALIDATION: no consumer profile-selection authority (VMC-005)",
      );
      expect(messages, variation.name).not.toContain("n/a");
      expect(messages, variation.name).not.toContain("invalid schema_version");
      expect(messages, variation.name).not.toContain("missing artifact");
    }
  });

  it("U-RCDEV-031: routes each E-only mutation through consumer G10 validation", () => {
    const mutations: {
      name: string;
      expected: string;
      mutate: (manifest: ConsumerG10Manifest) => void;
    }[] = [
      {
        name: "schema",
        expected: "invalid schema_version",
        mutate: (manifest) => {
          manifest.schema_version = "g9-system-evidence-v1";
        },
      },
      {
        name: "gate",
        expected: "gate must be G10",
        mutate: (manifest) => {
          manifest.gate = "G9";
        },
      },
      {
        name: "exit code",
        expected: "exit_code is non-zero",
        mutate: (manifest) => {
          firstConsumerG10Command(manifest).exit_code = 1;
        },
      },
      {
        name: "digest",
        expected: "invalid digest",
        mutate: (manifest) => {
          firstConsumerG10Command(manifest).output_digest = `sha256:${"a".repeat(63)}`;
        },
      },
      {
        name: "stale defer count type",
        expected: "stale_defer_count must be 0",
        mutate: (manifest) => {
          (manifest.exit_criteria as unknown as Record<string, unknown>).stale_defer_count = "0";
        },
      },
    ];

    for (const mutation of mutations) {
      const root = fixtureRoot();
      writeConsumerG10Fixture(root);
      updateConsumerG10Manifest(root, mutation.mutate);

      const result = evaluateStaticGate({ gate: "G10", repoRoot: root });

      expect(result.applicable, mutation.name).toBe(true);
      expect(result.passed, mutation.name).toBe(false);
      expect(result.messages.join("\n"), mutation.name).toContain(mutation.expected);
    }
  });

  it("U-RCDEV-031: preserves the existing harness G10 workflow result on the public gate path", () => {
    const repositoryRoot = process.cwd();
    const workflow = checkG10UxWorkflow(repositoryRoot);
    const result = evaluateStaticGate({ gate: "G10", repoRoot: repositoryRoot });
    const workflowMessages = result.messages.filter((message) =>
      message.startsWith("g10-ux-workflow"),
    );

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(workflow.ok);
    expect(workflowMessages).toEqual(workflow.messages);
  });
});

describe("PR-G12 consumer G12 predicates", () => {
  it("U-RCDEV-033: evaluates the normal consumer G12 acceptance contract", () => {
    const root = fixtureRoot();
    writeConsumerG12Fixture(root);

    const result = evaluateStaticGate({ gate: "G12", repoRoot: root });
    const messages = result.messages.join("\n");

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(true);
    expect(messages).toContain("未判定 (review): PO/TL");
  });

  it("U-RCDEV-033: requires the L12 template title, all chapters, and G8 case-table columns (S)", () => {
    const template = readFileSync(
      join(process.cwd(), "docs/templates/vmodel/L12-acceptance-test-design.md"),
      "utf8",
    );
    const title = template.split(/\r?\n/).find((line) => /^# DOC-L12-ACCEPTANCE:/.test(line));
    const headings = template.split(/\r?\n/).filter((line) => /^#{4,5} /.test(line));
    expect(title).toBeDefined();
    expect(headings).toHaveLength(10);

    const titleRoot = fixtureRoot();
    writeConsumerG12Fixture(titleRoot);
    updateConsumerG12Design(titleRoot, (content) => content.replace(title ?? "", ""));
    const titleResult = evaluateStaticGate({ gate: "G12", repoRoot: titleRoot });
    expect(titleResult.passed).toBe(false);
    expect(titleResult.messages.join("\n")).toContain("missing section " + title);

    for (const heading of headings) {
      const root = fixtureRoot();
      writeConsumerG12Fixture(root);
      updateConsumerG12Design(root, (content) =>
        content
          .split(/\r?\n/)
          .filter((line) => line !== heading)
          .join("\n"),
      );
      const result = evaluateStaticGate({ gate: "G12", repoRoot: root });
      expect(result.applicable, heading).toBe(true);
      expect(result.passed, heading).toBe(false);
      expect(result.messages.join("\n"), heading).toContain("missing section " + heading);
    }

    const requiredColumns = [
      "テストID",
      "分類",
      "テスト項目",
      "検証内容/手順",
      "期待結果",
      "トレース元",
    ];
    const header = "| " + requiredColumns.join(" | ") + " |";
    for (const missingColumn of requiredColumns) {
      const root = fixtureRoot();
      writeConsumerG12Fixture(root);
      updateConsumerG12Design(root, (content) =>
        content.replace(header, header.replace(missingColumn, "")),
      );
      const result = evaluateStaticGate({ gate: "G12", repoRoot: root });
      const messages = result.messages.join("\n");
      expect(result.applicable, missingColumn).toBe(true);
      expect(result.passed, missingColumn).toBe(false);
      expect(messages, missingColumn).toContain("required case table columns");
      if (missingColumn === "トレース元") expect(messages).toContain("missing section");
    }
  });

  it("U-RCDEV-033: rejects duplicate AT case IDs (I)", () => {
    const root = fixtureRoot();
    writeConsumerG12Fixture(root);
    updateConsumerG12Design(root, (content) =>
      content.replace("| AT-CONSUMER-02 |", "| AT-FR-01-01 |"),
    );

    const result = evaluateStaticGate({ gate: "G12", repoRoot: root });
    const messages = result.messages.join("\n");

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(messages).toContain("duplicate case id AT-FR-01-01");
  });

  it("U-RCDEV-033: requires nonempty citations and rejects an undefined L3 AC (T)", () => {
    const mutations = [
      {
        name: "undefined AC",
        mutate: (root: string) =>
          updateConsumerG12Design(root, (content) => content.replace("AC-FR-01-01", "AC-FR-99-01")),
        expected: "trace target missing AC-FR-99-01",
      },
      {
        name: "empty citation",
        mutate: (root: string) =>
          updateConsumerG12Design(root, (content) => content.replace("| AC-FR-01-01 |", "| |")),
        expected: "untraced case AT-FR-01-01",
      },
    ];
    for (const mutation of mutations) {
      const root = fixtureRoot();
      writeConsumerG12Fixture(root);
      mutation.mutate(root);

      const result = evaluateStaticGate({ gate: "G12", repoRoot: root });
      expect(result.applicable, mutation.name).toBe(true);
      expect(result.passed, mutation.name).toBe(false);
      expect(result.messages.join("\n"), mutation.name).toContain(mutation.expected);
    }
  });

  it("U-RCDEV-033: rejects a designed AT row omitted from all evidence (F)", () => {
    const root = fixtureRoot();
    writeConsumerG12Fixture(root);
    updateConsumerG12Manifest(root, (manifest) => {
      const missingId = "AT-CONSUMER-02";
      manifest.selected_at_ids = manifest.selected_at_ids.filter((id) => id !== missingId);
      manifest.mandatory_at_ids = manifest.mandatory_at_ids.filter((id) => id !== missingId);
      firstConsumerG12Command(manifest).at_ids = firstConsumerG12Command(manifest).at_ids.filter(
        (id) => id !== missingId,
      );
      manifest.coverage = manifest.coverage.filter((entry) => entry.at_id !== missingId);
    });

    const result = evaluateStaticGate({ gate: "G12", repoRoot: root });

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("missing row evidence AT-CONSUMER-02");
  });

  it("U-RCDEV-033: rejects a missing contract-required acceptance_results artifact (A)", () => {
    const root = fixtureRoot();
    writeConsumerG12Fixture(root);
    updateConsumerG12Manifest(root, (manifest) => {
      delete manifest.artifacts.acceptance_results;
    });

    const result = evaluateStaticGate({ gate: "G12", repoRoot: root });

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("missing artifact acceptance_results");
  });

  it("U-RCDEV-033: validates both G12 JSON artifacts and leaves acceptance_results as text", () => {
    const mutations: {
      name: string;
      expected: string;
      mutate: (root: string) => void;
    }[] = [
      {
        name: "39-character deploy revision",
        expected: "invalid deploy_receipt.revision",
        mutate: (root) =>
          updateConsumerG12DeployReceipt(root, (receipt) => {
            receipt.revision = "0".repeat(39);
          }),
      },
      {
        name: "non-hex deploy revision",
        expected: "invalid deploy_receipt.revision",
        mutate: (root) =>
          updateConsumerG12DeployReceipt(root, (receipt) => {
            receipt.revision = "g" + "0".repeat(39);
          }),
      },
      {
        name: "missing deploy environment",
        expected: "deploy_receipt.environment is required",
        mutate: (root) =>
          updateConsumerG12DeployReceipt(root, (receipt) => {
            delete receipt.environment;
          }),
      },
      {
        name: "missing rollback command",
        expected: "rollback_readiness.rollback_command is required",
        mutate: (root) =>
          updateConsumerG12RollbackReadiness(root, (readiness) => {
            delete readiness.rollback_command;
          }),
      },
      {
        name: "timezone-less rollback date",
        expected: "invalid rollback_readiness.verified_at",
        mutate: (root) =>
          updateConsumerG12RollbackReadiness(root, (readiness) => {
            readiness.verified_at = "2026-09-29";
          }),
      },
      {
        name: "non-JSON deploy receipt",
        expected: "invalid artifact deploy_receipt: JSON object required",
        mutate: (root) => writeFixtureDoc(root, G12_DEPLOY_RECEIPT_PATH, "not JSON\n"),
      },
    ];

    for (const mutation of mutations) {
      const root = fixtureRoot();
      writeConsumerG12Fixture(root);
      mutation.mutate(root);

      const result = evaluateStaticGate({ gate: "G12", repoRoot: root });
      expect(result.applicable, mutation.name).toBe(true);
      expect(result.passed, mutation.name).toBe(false);
      expect(result.messages.join("\n"), mutation.name).toContain(mutation.expected);
    }
  });

  it("U-RCDEV-033: routes each E-only mutation through consumer G12 validation", () => {
    const mutations: {
      name: string;
      expected: string[];
      mutate: (manifest: ConsumerG12Manifest) => void;
    }[] = [
      {
        name: "schema",
        expected: ["invalid schema_version"],
        mutate: (manifest) => {
          manifest.schema_version = "g11-uat-evidence-v1";
        },
      },
      {
        name: "gate",
        expected: ["gate must be G12"],
        mutate: (manifest) => {
          manifest.gate = "G11";
        },
      },
      {
        name: "exit code",
        expected: ["exit_code is non-zero"],
        mutate: (manifest) => {
          firstConsumerG12Command(manifest).exit_code = 1;
        },
      },
      {
        name: "digest",
        expected: ["invalid digest"],
        mutate: (manifest) => {
          firstConsumerG12Command(manifest).output_digest = "sha256:" + "a".repeat(63);
        },
      },
      {
        name: "stale defer count type",
        expected: ["stale_defer_count must be 0"],
        mutate: (manifest) => {
          (manifest.exit_criteria as unknown as Record<string, unknown>).stale_defer_count = "0";
        },
      },
      {
        name: "wrong prefix-derived mandatory field",
        expected: ["missing row evidence AT-FR-01-01", "missing row evidence AT-CONSUMER-02"],
        mutate: (manifest) => {
          const fields = manifest as unknown as Record<string, unknown>;
          fields.mandatory_it_ids = fields.mandatory_at_ids;
          delete fields.mandatory_at_ids;
        },
      },
    ];

    for (const mutation of mutations) {
      const root = fixtureRoot();
      writeConsumerG12Fixture(root);
      updateConsumerG12Manifest(root, mutation.mutate);

      const result = evaluateStaticGate({ gate: "G12", repoRoot: root });
      const messages = result.messages.join("\n");
      expect(result.applicable, mutation.name).toBe(true);
      expect(result.passed, mutation.name).toBe(false);
      for (const expected of mutation.expected) expect(messages, mutation.name).toContain(expected);
    }
  });
});
describe("PR-G11 consumer G11 predicates", () => {
  function evaluateG11(root: string) {
    return evaluateStaticGate({ gate: "G11", repoRoot: root });
  }

  it("U-RCDEV-032: accepts the complete consumer UAT contract and exposes the PO/TL review decision", () => {
    const root = fixtureRoot();
    writeConsumerG11Fixture(root);

    const result = evaluateStaticGate({ gate: "G11", repoRoot: root });

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.messages).toContain("未判定 (review): PO/TL");
  });

  it("U-RCDEV-032: enforces the L11 chapter shape and required case columns (S)", () => {
    const root = fixtureRoot();
    writeConsumerG11Fixture(root);
    updateConsumerG11Design(root, (content) => content.replace("| ケースID |", "| ケース |"));

    const result = evaluateStaticGate({ gate: "G11", repoRoot: root });
    const messages = result.messages.join("\n");

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(messages).toContain("missing section");
    expect(messages).toContain("required case table columns");
  });

  it("U-RCDEV-032: rejects duplicate UAT case IDs (I)", () => {
    const root = fixtureRoot();
    writeConsumerG11Fixture(root);
    updateConsumerG11Design(root, (content) =>
      content.replace("UAT-CONSUMER-02", "UAT-CONSUMER-01"),
    );

    const actualResult = evaluateG11(root);

    expect(actualResult).toMatchObject({ applicable: true, passed: false });
    expect(actualResult.messages.join("\n")).toContain("duplicate case id UAT-CONSUMER-01");
  });

  it("U-RCDEV-032: traces cases only through the G11 L1/L3-L6/L7 pair set plus L3 requirement IDs (T)", () => {
    const pairMiss = fixtureRoot();
    writeConsumerG11Fixture(pairMiss);
    updateConsumerG11Design(pairMiss, (content) =>
      content.replace("| FR-01 | PO シナリオ", "| DOC-L7-UNIT-TEST-DESIGN | PO シナリオ"),
    );
    const pairMissResult = evaluateStaticGate({ gate: "G11", repoRoot: pairMiss });
    const pairMissMessages = pairMissResult.messages.join("\n");
    expect(pairMissResult.applicable).toBe(true);
    expect(pairMissResult.passed).toBe(false);
    expect(pairMissMessages).toContain("untraced case UAT-CONSUMER-01");
    expect(pairMissMessages).not.toContain("trace target missing DOC-L7-UNIT-TEST-DESIGN");

    const undefinedTarget = fixtureRoot();
    writeConsumerG11Fixture(undefinedTarget);
    updateConsumerG11Design(undefinedTarget, (content) =>
      content.replace("| FR-01 | PO シナリオ", "| FR-99 | PO シナリオ"),
    );
    const actualResult = evaluateG11(undefinedTarget);

    expect(actualResult).toMatchObject({ applicable: true, passed: false });
    expect(actualResult.messages.join("\n")).toContain("trace target missing FR-99");
  });

  it("U-RCDEV-032: requires every designed UAT case in manifest, command, and coverage evidence (F)", () => {
    const root = fixtureRoot();
    writeConsumerG11Fixture(root);
    updateConsumerG11Manifest(root, (manifest) => {
      const missingId = "UAT-CONSUMER-02";
      manifest.selected_uat_ids = manifest.selected_uat_ids.filter((id) => id !== missingId);
      manifest.mandatory_uat_ids = manifest.mandatory_uat_ids.filter((id) => id !== missingId);
      firstConsumerG11Command(manifest).uat_ids = firstConsumerG11Command(manifest).uat_ids.filter(
        (id) => id !== missingId,
      );
      manifest.coverage = manifest.coverage.filter((entry) => entry.uat_id !== missingId);
    });

    const actualResult = evaluateG11(root);

    expect(actualResult).toMatchObject({ applicable: true, passed: false });
    expect(actualResult.messages.join("\n")).toContain("missing row evidence UAT-CONSUMER-02");
  });

  it("U-RCDEV-032: requires the PO UAT decision artifact (A)", () => {
    const root = fixtureRoot();
    writeConsumerG11Fixture(root);
    updateConsumerG11Manifest(root, (manifest) => {
      delete manifest.artifacts.po_uat_decision;
    });

    const actualResult = evaluateG11(root);

    expect(actualResult).toMatchObject({ applicable: true, passed: false });
    expect(actualResult.messages.join("\n")).toContain("missing artifact po_uat_decision");
  });

  it("U-RCDEV-032: validates the complete L3 requirement trace set and its closed status vocabulary", () => {
    const mutations: {
      name: string;
      expected: string;
      mutate: (traceReview: ConsumerG11TraceReview) => void;
    }[] = [
      {
        name: "missing last requirement",
        expected: "untraced requirement NFR-17",
        mutate: (review) => {
          review.requirements = review.requirements.filter(
            (item) => item.requirement_id !== "NFR-17",
          );
        },
      },
      {
        name: "missing FR heading requirement",
        expected: "untraced requirement FR-01",
        mutate: (review) => {
          review.requirements = review.requirements.filter(
            (item) => item.requirement_id !== "FR-01",
          );
        },
      },
      {
        name: "blocked requirement",
        expected: "blocked requirement FR-01",
        mutate: (review) => {
          const item = review.requirements.find((entry) => entry.requirement_id === "FR-01");
          if (!item) throw new Error("consumer G11 trace fixture has no FR-01");
          item.status = "blocked";
        },
      },
      {
        name: "unrecognized status",
        expected: "invalid trace status FR-01: pending",
        mutate: (review) => {
          const item = review.requirements.find((entry) => entry.requirement_id === "FR-01");
          if (!item) throw new Error("consumer G11 trace fixture has no FR-01");
          item.status = "pending";
        },
      },
      {
        name: "undefined requirement",
        expected: "trace review references undefined requirement FR-99",
        mutate: (review) => {
          review.requirements.push({ requirement_id: "FR-99", status: "traced" });
        },
      },
      {
        name: "duplicate requirement",
        expected: "duplicate trace requirement FR-01",
        mutate: (review) => {
          const item = review.requirements.find((entry) => entry.requirement_id === "FR-01");
          if (!item) throw new Error("consumer G11 trace fixture has no FR-01");
          review.requirements.push({ ...item });
        },
      },
    ];

    for (const mutation of mutations) {
      const root = fixtureRoot();
      writeConsumerG11Fixture(root);
      updateConsumerG11TraceReview(root, mutation.mutate);

      const actualResult = evaluateG11(root);

      expect(actualResult).toMatchObject({ applicable: true, passed: false });
      expect(actualResult.messages.join("\n")).toContain(mutation.expected);
    }
  });

  it("U-RCDEV-032: rejects a non-object trace review artifact", () => {
    const root = fixtureRoot();
    writeConsumerG11Fixture(root);
    writeFixtureDoc(root, ".ut-tdd/evidence/g11-uat/artifacts/trace-review.json", "traced\n");

    const actualResult = evaluateG11(root);

    expect(actualResult).toMatchObject({ applicable: true, passed: false });
    expect(actualResult.messages.join("\n")).toContain(
      "invalid artifact end_to_end_trace_review: JSON object required",
    );
  });

  it("U-RCDEV-032: rejects trace review requirement entries with fields beyond requirement_id and status", () => {
    const root = fixtureRoot();
    writeConsumerG11Fixture(root);
    updateConsumerG11TraceReview(root, (review) => {
      const entry = review.requirements.find((item) => item.requirement_id === "FR-01");
      if (!entry) throw new Error("consumer G11 trace fixture has no FR-01");
      (entry as unknown as Record<string, unknown>).extra = "not part of the frozen shape";
    });

    const actualResult = evaluateG11(root);

    expect(actualResult).toMatchObject({ applicable: true, passed: false });
    expect(actualResult.messages.join("\n")).toContain("invalid trace review requirement FR-01");
  });

  it("U-RCDEV-032: fails closed when the L3 document defines no requirement IDs (R)", () => {
    const root = fixtureRoot();
    writeConsumerG11Fixture(root);
    writeFixtureDoc(
      root,
      "docs/design/L3-functional/functional-requirements.md",
      "---\ndoc_type_id: DOC-L3-FUNCTIONAL\nlayer: L3\nstatus: confirmed\npair_artifact: docs/test-design/harness/L3-functional-test-design.md\nplan: docs/plans/PLAN-CONSUMER-01.md\n---\n# DOC-L3-FUNCTIONAL\n\n本文書に要件 ID はありません。\n",
    );
    writeFixtureDoc(
      root,
      "docs/design/L3-functional/nfr-grade.md",
      "---\ndoc_type_id: DOC-L3-NFR-GRADE\nlayer: L3\nstatus: confirmed\npair_artifact: docs/test-design/harness/L3-functional-test-design.md\nplan: docs/plans/PLAN-CONSUMER-01.md\n---\n# DOC-L3-NFR-GRADE\n",
    );
    updateConsumerG11Design(root, (content) =>
      content
        .replace("| FR-01 | PO シナリオ", "| DOC-L3-FUNCTIONAL | PO シナリオ")
        .replace("| NFR-01 | PO シナリオ", "| DOC-L3-FUNCTIONAL | PO シナリオ"),
    );

    const actualResult = evaluateG11(root);

    expect(actualResult).toMatchObject({ applicable: true, passed: false });
    expect(actualResult.messages.join("\n")).toContain(
      "no requirement ids defined in DOC-L3-FUNCTIONAL",
    );
  });

  it("U-RCDEV-032: enforces UAT decision accept/reject semantics and required identity fields", () => {
    const mutations: {
      expected: string;
      mutate: (decision: ConsumerG11Decision) => void;
    }[] = [
      {
        expected: "invalid po_uat_decision.decision maybe",
        mutate: (decision) => {
          decision.decision = "maybe";
        },
      },
      {
        expected: "po_uat_decision.decision is reject",
        mutate: (decision) => {
          decision.decision = "reject";
        },
      },
      {
        expected: "po_uat_decision.decided_by_role is required",
        mutate: (decision) => {
          decision.decided_by_role = "";
        },
      },
      {
        expected: "invalid po_uat_decision.revision",
        mutate: (decision) => {
          delete decision.revision;
        },
      },
      {
        expected: "invalid po_uat_decision.revision",
        mutate: (decision) => {
          decision.revision = "0123456789abcdef0123456789abcdef0123456";
        },
      },
    ];

    for (const mutation of mutations) {
      const root = fixtureRoot();
      writeConsumerG11Fixture(root);
      updateConsumerG11Decision(root, mutation.mutate);

      const actualResult = evaluateG11(root);

      expect(actualResult).toMatchObject({ applicable: true, passed: false });
      expect(actualResult.messages.join("\n")).toContain(mutation.expected);
    }
  });

  it("U-RCDEV-032: validates each G11 E-only manifest predicate without weakening S/I/T/F/A", () => {
    const mutations: {
      name: string;
      expected: string;
      mutate: (manifest: ConsumerG11Manifest) => void;
    }[] = [
      {
        name: "schema",
        expected: "invalid schema_version",
        mutate: (manifest) => {
          manifest.schema_version = "g12-acceptance-evidence-v1";
        },
      },
      {
        name: "gate",
        expected: "gate must be G11",
        mutate: (manifest) => {
          manifest.gate = "G12";
        },
      },
      {
        name: "exit code",
        expected: "exit_code is non-zero",
        mutate: (manifest) => {
          firstConsumerG11Command(manifest).exit_code = 1;
        },
      },
      {
        name: "digest",
        expected: "invalid digest",
        mutate: (manifest) => {
          firstConsumerG11Command(manifest).output_digest = `sha256:${"a".repeat(63)}`;
        },
      },
      {
        name: "stale defer count type",
        expected: "stale_defer_count must be 0",
        mutate: (manifest) => {
          (manifest.exit_criteria as unknown as Record<string, unknown>).stale_defer_count = "0";
        },
      },
      {
        name: "G11 mandatory field name",
        expected: "missing row evidence UAT-CONSUMER-01",
        mutate: (manifest) => {
          const record = manifest as unknown as Record<string, unknown>;
          record.mandatory_it_ids = manifest.mandatory_uat_ids;
          delete record.mandatory_uat_ids;
        },
      },
    ];

    for (const mutation of mutations) {
      const root = fixtureRoot();
      writeConsumerG11Fixture(root);
      updateConsumerG11Manifest(root, mutation.mutate);

      const result = evaluateStaticGate({ gate: "G11", repoRoot: root });
      const messages = result.messages.join("\n");
      expect(result.applicable, mutation.name).toBe(true);
      expect(result.passed, mutation.name).toBe(false);
      expect(messages, mutation.name).toContain(mutation.expected);
      if (mutation.name === "G11 mandatory field name") {
        expect(messages).toContain("missing row evidence UAT-CONSUMER-02");
      }
    }
  });
});

describe("PR-G13 consumer G13 predicates", () => {
  it("U-RCDEV-034: evaluates the normal consumer G13 post-deploy contract", () => {
    const template = readFileSync(
      join(process.cwd(), "docs/templates/vmodel/L13-production-observation.md"),
      "utf8",
    );
    expect(template).toContain(
      "「### harness 追補:」で始まる節は ZIP 由来ではなく、harness の gate 判定のために足した節である。",
    );
    expect(template).toContain("| ケースID | 観測内容 | 合否基準 | トレース元 |");
    const root = fixtureRoot();
    writeConsumerG13Fixture(root);
    const result = evaluateStaticGate({ gate: "G13", repoRoot: root });
    expect(result).toMatchObject({ gate: "G13", applicable: true, passed: true });
    expect(result.messages.join("\n")).toContain(
      "right-arm-static - OK (G13, cases=2, manifests=1)",
    );
    expect(result.messages.join("\n")).toContain("未判定 (review): PO/TL");
  });

  it("U-RCDEV-034: resolves L12 acceptance IDs from the harness catalog layout", () => {
    const root = fixtureRoot();
    writeConsumerG13Fixture(root);
    const flatPath = join(root, "docs/test-design/L12-acceptance-test-design.md");
    writeFixtureDoc(
      root,
      "docs/test-design/harness/L12-acceptance-test-design.md",
      readFileSync(flatPath, "utf8"),
    );
    rmSync(flatPath);

    const result = evaluateStaticGate({ gate: "G13", repoRoot: root });
    expect(result).toMatchObject({ gate: "G13", applicable: true, passed: true });
    expect(result.messages.join("\n")).toContain(
      "right-arm-static - OK (G13, cases=2, manifests=1)",
    );
  });

  it("U-RCDEV-034: does not require reverse closure for unreferenced L12 acceptance IDs", () => {
    const root = fixtureRoot();
    writeConsumerG13Fixture(root);
    writeFixtureDoc(
      root,
      "docs/test-design/L12-acceptance-test-design.md",
      `${readFileSync(join(root, "docs/test-design/L12-acceptance-test-design.md"), "utf8")}\n| **AT-FR-01-03** | 未観測 |\n`,
    );
    const result = evaluateStaticGate({ gate: "G13", repoRoot: root });
    expect(result).toMatchObject({ applicable: true, passed: true });
  });

  it("U-RCDEV-034: requires the L13 title and every source #### / ##### heading", () => {
    const template = readFileSync(
      join(process.cwd(), "docs/templates/vmodel/L13-production-observation.md"),
      "utf8",
    );
    const sourceHeadings = template
      .split(/\r?\n/)
      .filter((line) => /^# |^#### |^##### /.test(line));
    expect(sourceHeadings.length).toBeGreaterThan(10);
    for (const heading of sourceHeadings) {
      const root = fixtureRoot();
      writeConsumerG13Fixture(root);
      updateConsumerG13Design(root, (text) => text.replace(`${heading}\n`, ""));
      const result = evaluateStaticGate({ gate: "G13", repoRoot: root });
      expect(result, heading).toMatchObject({ applicable: true, passed: false });
      expect(result.messages.join("\n"), heading).toContain(`missing section ${heading}`);
    }
  });

  it("U-RCDEV-034: rejects missing, malformed, duplicate, and non-AT traces", () => {
    const mutations: { name: string; mutate: (root: string) => void; expected: string }[] = [
      {
        name: "missing trace",
        mutate: (root) => updateConsumerG13Design(root, (text) => text.replace("AT-FR-01-01", "")),
        expected: "untraced case SMOKE-CONSUMER-01",
      },
      {
        name: "unknown trace",
        mutate: (root) =>
          updateConsumerG13Design(root, (text) => text.replace("AT-FR-01-01", "AT-FR-99-99")),
        expected: "trace target missing AT-FR-99-99",
      },
      {
        name: "defined non-AT trace",
        mutate: (root) =>
          updateConsumerG13Design(root, (text) => text.replace("AT-FR-01-01", "NFR-01")),
        expected: "trace target missing NFR-01",
      },
      {
        name: "duplicate case id",
        mutate: (root) =>
          updateConsumerG13Design(root, (text) =>
            text.replace("SMOKE-CONSUMER-02", "SMOKE-CONSUMER-01"),
          ),
        expected: "duplicate case id SMOKE-CONSUMER-01",
      },
      {
        name: "wrong case id prefix",
        mutate: (root) =>
          updateConsumerG13Design(root, (text) =>
            text.replace("SMOKE-CONSUMER-02", "ST-CONSUMER-02"),
          ),
        expected: "case id must start with SMOKE-: ST-CONSUMER-02",
      },
      {
        name: "missing case columns",
        mutate: (root) =>
          updateConsumerG13Design(root, (text) =>
            text.replace(
              "| ケースID | 観測内容 | 合否基準 | トレース元 |",
              "| 観測内容 | 合否基準 | トレース元 |",
            ),
          ),
        expected: "required case table columns",
      },
    ];
    for (const mutation of mutations) {
      const root = fixtureRoot();
      writeConsumerG13Fixture(root);
      mutation.mutate(root);
      const result = evaluateStaticGate({ gate: "G13", repoRoot: root });
      expect(result, mutation.name).toMatchObject({ applicable: true, passed: false });
      expect(result.messages.join("\n"), mutation.name).toContain(mutation.expected);
      if (mutation.name === "unknown trace" || mutation.name === "defined non-AT trace")
        expect(result.messages.join("\n")).toContain("untraced case SMOKE-CONSUMER-01");
    }
  });

  it("U-RCDEV-034: requires evidence for each mandatory smoke row", () => {
    const root = fixtureRoot();
    writeConsumerG13Fixture(root);
    updateConsumerG13Manifest(root, (manifest) => {
      manifest.mandatory_smoke_ids = ["SMOKE-CONSUMER-01"];
      manifest.selected_smoke_ids = ["SMOKE-CONSUMER-01"];
      firstConsumerG13Command(manifest).smoke_ids = ["SMOKE-CONSUMER-01"];
      manifest.coverage = manifest.coverage.filter((row) => row.smoke_id === "SMOKE-CONSUMER-01");
    });
    const result = evaluateStaticGate({ gate: "G13", repoRoot: root });
    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("missing row evidence SMOKE-CONSUMER-02");
  });

  it("U-RCDEV-034: validates G13-only evidence artifacts and keeps rollback as an operational outcome", () => {
    const mutations: {
      name: string;
      mutate: (root: string) => void;
      expected: string;
      passed?: boolean;
    }[] = [
      {
        name: "missing artifact",
        mutate: (root) =>
          updateConsumerG13Manifest(root, (manifest) => {
            delete manifest.artifacts.rollback_decision;
          }),
        expected: "missing artifact rollback_decision",
      },
      {
        name: "invalid JSON",
        mutate: (root) => writeFixtureDoc(root, G13_SLI_SLO_PATH, "not JSON\n"),
        expected: "invalid artifact sli_slo_observation: JSON object required",
      },
      {
        name: "invalid window start",
        mutate: (root) =>
          updateConsumerG13Artifact(root, G13_SLI_SLO_PATH, (artifact) => {
            artifact.window_start = "not-a-date";
          }),
        expected: "invalid sli_slo_observation.window_start",
      },
      {
        name: "timezone required",
        mutate: (root) =>
          updateConsumerG13Artifact(root, G13_SLI_SLO_PATH, (artifact) => {
            artifact.window_start = "2026-09-29T00:00:00";
          }),
        expected: "invalid sli_slo_observation.window_start",
      },
      {
        name: "window end timezone required",
        mutate: (root) =>
          updateConsumerG13Artifact(root, G13_SLI_SLO_PATH, (artifact) => {
            artifact.window_end = "2026-09-29T06:00:00";
          }),
        expected: "invalid sli_slo_observation.window_end",
      },
      {
        name: "window not increasing",
        mutate: (root) =>
          updateConsumerG13Artifact(root, G13_SLI_SLO_PATH, (artifact) => {
            artifact.window_end = artifact.window_start;
          }),
        expected: "sli_slo_observation window is not closed",
      },
      {
        name: "empty slos",
        mutate: (root) =>
          updateConsumerG13Artifact(root, G13_SLI_SLO_PATH, (artifact) => {
            artifact.slos = [];
          }),
        expected: "sli_slo_observation.slos is required",
      },
      {
        name: "missing observed",
        mutate: (root) =>
          updateConsumerG13Artifact(root, G13_SLI_SLO_PATH, (artifact) => {
            const firstSlo = (artifact.slos as Record<string, unknown>[])[0];
            if (firstSlo) delete firstSlo.observed;
          }),
        expected: "sli_slo_observation.slos[SLO-AVAIL].observed is required",
      },
      {
        name: "missing target",
        mutate: (root) =>
          updateConsumerG13Artifact(root, G13_SLI_SLO_PATH, (artifact) => {
            const firstSlo = (artifact.slos as Record<string, unknown>[])[0];
            if (firstSlo) firstSlo.target = "";
          }),
        expected: "sli_slo_observation.slos[SLO-AVAIL].target is required",
      },
      {
        name: "non-numeric target is rejected",
        mutate: (root) =>
          updateConsumerG13Artifact(root, G13_SLI_SLO_PATH, (artifact) => {
            const firstSlo = (artifact.slos as Record<string, unknown>[])[0];
            if (firstSlo) firstSlo.target = null;
          }),
        expected: "sli_slo_observation.slos[SLO-AVAIL].target is required",
      },
      {
        name: "missing slo id is indexed",
        mutate: (root) =>
          updateConsumerG13Artifact(root, G13_SLI_SLO_PATH, (artifact) => {
            const firstSlo = (artifact.slos as Record<string, unknown>[])[0];
            if (firstSlo) delete firstSlo.slo_id;
          }),
        expected: "sli_slo_observation.slos[0].slo_id is required",
      },
      {
        name: "numeric target is valid",
        mutate: (root) =>
          updateConsumerG13Artifact(root, G13_SLI_SLO_PATH, (artifact) => {
            const firstSlo = (artifact.slos as Record<string, unknown>[])[0];
            if (firstSlo) firstSlo.target = 99.9;
          }),
        expected: "right-arm-static - OK (G13, cases=2, manifests=1)",
        passed: true,
      },
      {
        name: "duplicate slo",
        mutate: (root) => {
          updateConsumerG13Artifact(root, G13_SLI_SLO_PATH, (artifact) => {
            (artifact.slos as unknown[]).push({
              ...(artifact.slos as Record<string, unknown>[])[0],
            });
          });
        },
        expected: "duplicate slo SLO-AVAIL",
      },
      {
        name: "invalid decision",
        mutate: (root) =>
          updateConsumerG13Artifact(root, G13_ROLLBACK_PATH, (artifact) => {
            artifact.decision = "unknown";
          }),
        expected: "invalid rollback_decision.decision unknown",
      },
      {
        name: "rollback is valid",
        mutate: (root) =>
          updateConsumerG13Artifact(root, G13_ROLLBACK_PATH, (artifact) => {
            artifact.decision = "rollback";
          }),
        expected: "right-arm-static - OK (G13, cases=2, manifests=1)",
        passed: true,
      },
      {
        name: "case-sensitive decision",
        mutate: (root) =>
          updateConsumerG13Artifact(root, G13_ROLLBACK_PATH, (artifact) => {
            artifact.decision = "Keep";
          }),
        expected: "invalid rollback_decision.decision Keep",
      },
      {
        name: "future observation window",
        mutate: (root) =>
          updateConsumerG13Artifact(root, G13_SLI_SLO_PATH, (artifact) => {
            artifact.window_start = "2099-01-01T00:00:00Z";
            artifact.window_end = "2099-01-01T06:00:00Z";
          }),
        expected: "right-arm-static - OK (G13, cases=2, manifests=1)",
        passed: true,
      },
    ];
    for (const mutation of mutations) {
      const root = fixtureRoot();
      writeConsumerG13Fixture(root);
      mutation.mutate(root);
      const result = evaluateStaticGate({ gate: "G13", repoRoot: root });
      expect(result.passed, mutation.name).toBe(mutation.passed ?? false);
      expect(result.messages.join("\n"), mutation.name).toContain(mutation.expected);
    }
  });

  it("U-RCDEV-034: validates each G13 E-only manifest predicate", () => {
    const mutations: {
      name: string;
      expected: string;
      mutate: (manifest: ConsumerG13Manifest) => void;
    }[] = [
      {
        name: "schema",
        expected: "invalid schema_version",
        mutate: (manifest) => {
          manifest.schema_version = "g12-acceptance-evidence-v1";
        },
      },
      {
        name: "gate",
        expected: "gate must be G13",
        mutate: (manifest) => {
          manifest.gate = "G12";
        },
      },
      {
        name: "exit code",
        expected: "exit_code is non-zero",
        mutate: (manifest) => {
          firstConsumerG13Command(manifest).exit_code = 1;
        },
      },
      {
        name: "digest",
        expected: "invalid digest",
        mutate: (manifest) => {
          firstConsumerG13Command(manifest).output_digest = `sha256:${"a".repeat(63)}`;
        },
      },
      {
        name: "stale defer count type",
        expected: "stale_defer_count must be 0",
        mutate: (manifest) => {
          (manifest.exit_criteria as unknown as Record<string, unknown>).stale_defer_count = "0";
        },
      },
      {
        name: "G13 mandatory field name",
        expected: "missing row evidence SMOKE-CONSUMER-01",
        mutate: (manifest) => {
          const record = manifest as unknown as Record<string, unknown>;
          record.mandatory_at_ids = manifest.mandatory_smoke_ids;
          delete record.mandatory_smoke_ids;
        },
      },
    ];
    for (const mutation of mutations) {
      const root = fixtureRoot();
      writeConsumerG13Fixture(root);
      updateConsumerG13Manifest(root, mutation.mutate);
      const result = evaluateStaticGate({ gate: "G13", repoRoot: root });
      expect(result.passed, mutation.name).toBe(false);
      expect(result.messages.join("\n"), mutation.name).toContain(mutation.expected);
      if (mutation.name === "G13 mandatory field name")
        expect(result.messages.join("\n")).toContain("missing row evidence SMOKE-CONSUMER-02");
    }
  });
});
