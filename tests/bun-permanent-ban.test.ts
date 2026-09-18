import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectNodeBanFindings,
  NodeBanAuditError,
  type NodeBanDocuments,
  type NodeBanF0cAggregateBinding,
  type NodeBanGenerationBinding,
  runNodeBanAudit as runNodeBanAuditBase,
  verifyNodeBanAuditReceipt,
} from "../src/lint/bun-permanent-ban.ts";
import {
  classifyRuntimeImageProcess,
  NodeOnlyProcessObserver,
} from "../src/runtime/runtime-image-observer.ts";
import { workspaceRead } from "./support/workspace-roots.ts";

const subjectRevision = "a".repeat(40);
const artifactDigest = `sha256:${"b".repeat(64)}`;
const f0c: NodeBanF0cAggregateBinding = {
  ok: true,
  schema_version: "node-generation-aggregate.v1",
  generation_id: "node-ci-q0-run-1-1",
  artifact_digest: artifactDigest,
  subject_revision: subjectRevision,
  workflow_revision: subjectRevision,
  run_id: "q0-run-1",
  run_attempt: 1,
};
const node: NodeBanGenerationBinding = {
  lane: "linux",
  generation_id: "node-linux",
  subject_revision: subjectRevision,
  artifact_digest: artifactDigest,
  receipt_digest: "d".repeat(64),
  runtime: "node",
};
const f0cLanes = [
  {
    schema_version: "node-generation-ci.v1" as const,
    lane: "linux" as const,
    generation_id: f0c.generation_id,
    sealed_generation_id: "node-linux",
    artifact_digest: artifactDigest,
    subject_revision: subjectRevision,
    workflow_revision: subjectRevision,
    run_id: f0c.run_id,
    run_attempt: f0c.run_attempt,
    conclusion: "success" as const,
  },
  {
    schema_version: "node-generation-ci.v1" as const,
    lane: "windows" as const,
    generation_id: f0c.generation_id,
    sealed_generation_id: "node-windows",
    artifact_digest: artifactDigest,
    subject_revision: subjectRevision,
    workflow_revision: subjectRevision,
    run_id: f0c.run_id,
    run_attempt: f0c.run_attempt,
    conclusion: "success" as const,
  },
];
const completeRuntimeObservations = () => {
  const observer = new NodeOnlyProcessObserver();
  for (const [scope, args] of [
    ["status", ["ut-tdd.mjs", "status", "--json"]],
    ["doctor", ["ut-tdd.mjs", "doctor", "--profile", "consumer-toolchain"]],
    ["test", ["ut-tdd.mjs", "plan", "lint"]],
    ["hook", ["ut-tdd.mjs", "hook", "work-guard"]],
  ] as const) {
    observer.inspect(
      { command: process.execPath, args, options: { shell: false, windowsHide: true } },
      scope,
    );
  }
  observer.proveNoFallback("descendant", "child-process port records no descendant launch");
  observer.proveNoFallback("download", "runtime-image acquisition port is disabled");
  return observer.snapshot();
};
const runNodeBanAudit = (
  input: Omit<
    Parameters<typeof runNodeBanAuditBase>[0],
    "f0cLanes" | "observedScopes" | "classifyProcess"
  > &
    Partial<Pick<Parameters<typeof runNodeBanAuditBase>[0], "f0cLanes" | "observedScopes">>,
) =>
  runNodeBanAuditBase({
    ...input,
    f0cLanes: input.f0cLanes ?? f0cLanes,
    classifyProcess: classifyRuntimeImageProcess,
    observedScopes: input.observedScopes ?? [
      ...new Set(input.processObservations.map((observation) => observation.scope)),
    ],
  });

const cleanWorkflow = `name: clean\non: {pull_request: {types: [opened]}}\npermissions: {}\nconcurrency: clean\njobs: {build: {runs-on: ubuntu-latest, steps: []}}\n`;
const cleanDocuments = (): NodeBanDocuments => ({
  runtime: [{ path: "src/clean.ts", text: "export const clean = true;" }],
  workflows: [
    {
      file: ".github/workflows/clean.yml",
      content: cleanWorkflow,
      profile: "source",
      role: "runtime",
    },
  ],
  instructions: {
    agents: "AGENTS shared markers",
    claudeProject: "CLAUDE shared markers",
    claudeRuntime: "runtime shared markers",
    instructionSurfaces: { ".claude/commands/status.md": "status" },
  },
  toolchain: {
    packageJson: JSON.stringify({}),
    bunLock: null,
    packageLock: JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }),
    nodeVersion: "24.13.0",
  },
  debtBaseline: "schema_version: bun-migration-debt.v1\ninventory: []\n",
});

const nodeObservation = () => {
  const observer = new NodeOnlyProcessObserver();
  return observer.inspect({
    command: process.execPath,
    args: ["ut-tdd.mjs", "status", "--json"],
    options: { shell: false, windowsHide: true },
  });
};

describe("Q0 Node-only Bun qualification", () => {
  it("CAND-NODEBOOT-020 rejects absent, stale, or cross-artifact F0c prerequisites", () => {
    expect(() =>
      runNodeBanAudit({
        repoRoot: process.cwd(),
        subjectRevision,
        f0c: { ...f0c, ok: false } as never,
        node,
        documents: cleanDocuments(),
        processObservations: completeRuntimeObservations(),
      }),
    ).toThrow("q0-f0c-prerequisite-invalid");
    expect(() =>
      runNodeBanAudit({
        repoRoot: process.cwd(),
        subjectRevision,
        f0c: { ...f0c, subject_revision: "c".repeat(40) },
        node,
        documents: cleanDocuments(),
        processObservations: [nodeObservation()],
      }),
    ).toThrow("q0-subject-revision-mismatch");
    expect(() =>
      runNodeBanAudit({
        repoRoot: process.cwd(),
        subjectRevision,
        f0c: { ...f0c, artifact_digest: `sha256:${"c".repeat(64)}` },
        node,
        documents: cleanDocuments(),
        processObservations: [nodeObservation()],
      }),
    ).toThrow("q0-artifact-digest-mismatch");
    expect(() =>
      runNodeBanAudit({
        repoRoot: process.cwd(),
        subjectRevision,
        f0c: { ...f0c, workflow_revision: "c".repeat(40) },
        node,
        documents: cleanDocuments(),
        processObservations: [nodeObservation()],
      }),
    ).toThrow("q0-f0c-workflow-revision-mismatch");
    expect(() =>
      runNodeBanAuditBase({
        repoRoot: process.cwd(),
        subjectRevision,
        f0c,
        node,
        documents: cleanDocuments(),
        f0cLanes: [{ ...f0cLanes[0], generation_id: "node-ci-other" }, f0cLanes[1]],
        processObservations: [nodeObservation()],
        observedScopes: ["status"],
        classifyProcess: classifyRuntimeImageProcess,
      }),
    ).toThrow("q0-f0c-lane-evidence-generation-mismatch");
    expect(() =>
      runNodeBanAuditBase({
        repoRoot: process.cwd(),
        subjectRevision,
        f0c,
        node,
        documents: cleanDocuments(),
        f0cLanes: [{ ...f0cLanes[0], sealed_generation_id: f0c.generation_id }, f0cLanes[1]],
        processObservations: [nodeObservation()],
        observedScopes: ["status"],
        classifyProcess: classifyRuntimeImageProcess,
      }),
    ).toThrow("q0-f0c-sealed-generation-conflated");
  });

  it("CAND-NODEBOOT-201 detects independent static Bun axes", () => {
    const base = cleanDocuments();
    expect(
      collectNodeBanFindings({
        ...base,
        runtime: [{ path: "src/probe.ts", text: `spawnSync("${["bu", "n"].join("")}", args);` }],
      }).some((item) => item.detector === "runtime-portability"),
    ).toBe(true);
    const fixtureRoot = workspaceRead({
      id: "q0-bun-ban-pack-template",
      mode: "isolated_fixture",
      reason: "Q0のPack CI検出oracleを実行スナップショット上のfixtureへ束縛するため",
      root: process.cwd(),
    });
    const packTemplate = readFileSync(
      join(fixtureRoot, "docs", "templates", "github", "common", "pack-harness-check.yml"),
      "utf8",
    ).replace("node .ut-tdd/bin/ut-tdd.mjs", "bun run .ut-tdd/bin/ut-tdd.mjs");
    expect(
      collectNodeBanFindings({
        ...base,
        workflows: [
          {
            file: "docs/templates/github/common/pack-harness-check.yml",
            content: packTemplate,
            profile: "pack",
            role: "pack_template",
          },
        ],
      }).some((item) => item.detector === "github-ci-policy"),
    ).toBe(true);
    expect(
      collectNodeBanFindings({
        ...base,
        instructions: {
          agents: "run `bun run build`",
          claudeProject: "shared",
          claudeRuntime: "shared",
        },
      }).some((item) => item.detector === "rule-drift"),
    ).toBe(true);
  });

  it("CAND-NODEBOOT-202 blocks Bun, tsx, TypeScript, and shell process paths", () => {
    const observer = new NodeOnlyProcessObserver();
    const blocked = ["bun", "bunx", "tsx", "bash"].map((command) =>
      observer.inspect({
        command,
        args: command === "bash" ? ["-c", "node"] : ["run"],
        options: { shell: false, windowsHide: true },
      }),
    );
    const ts = observer.inspect({
      command: process.execPath,
      args: ["src/cli.ts"],
      options: { shell: false, windowsHide: true },
    });
    const shell = observer.inspect({
      command: process.execPath,
      args: ["status"],
      options: { shell: true, windowsHide: true },
    });
    expect([...blocked, ts, shell].every((item) => item.outcome === "blocked")).toBe(true);
    expect([...blocked, ts, shell].every((item) => item.spawned === false)).toBe(true);
    expect(nodeObservation().outcome).toBe("allowed");
  });

  it("CAND-NODEBOOT-203/204 emits a deterministic receipt and rejects every binding mutation", () => {
    const result = runNodeBanAudit({
      repoRoot: process.cwd(),
      subjectRevision,
      f0c,
      node,
      documents: cleanDocuments(),
      processObservations: completeRuntimeObservations(),
    });
    expect(result.receipt.qualification).toBe("qualified");
    expect(
      verifyNodeBanAuditReceipt(result.receipt, {
        subjectRevision,
        f0c,
        node,
        f0cLanes,
        classifyProcess: classifyRuntimeImageProcess,
      }),
    ).toEqual(result.receipt);
    expect(() =>
      verifyNodeBanAuditReceipt(result.receipt, {
        subjectRevision,
        f0c: { ...f0c, subject_revision: "c".repeat(40) },
        node,
        f0cLanes,
        classifyProcess: classifyRuntimeImageProcess,
      }),
    ).toThrow("q0-receipt-binding-mismatch");
    expect(() =>
      verifyNodeBanAuditReceipt(
        { ...result.receipt, node_artifact_digest: `sha256:${"c".repeat(64)}` },
        { subjectRevision, f0c, node, f0cLanes, classifyProcess: classifyRuntimeImageProcess },
      ),
    ).toThrow(NodeBanAuditError);
    expect(() =>
      verifyNodeBanAuditReceipt(
        {
          ...result.receipt,
          findings: [{ detector: "process-observer", path: "bun", rule: "x", detail: "x" }],
        },
        { subjectRevision, f0c, node, f0cLanes, classifyProcess: classifyRuntimeImageProcess },
      ),
    ).toThrow(/digest/);
  });

  it("fails closed when process coverage is absent and records blocked fallback attempts", () => {
    const noProcess = runNodeBanAudit({
      repoRoot: process.cwd(),
      subjectRevision,
      f0c,
      node,
      documents: cleanDocuments(),
      processObservations: [],
    });
    expect(noProcess.receipt.qualification).toBe("indeterminate");
    expect(noProcess.receipt.coverage.gaps).toContain("process-observations");
    const observer = new NodeOnlyProcessObserver();
    const fallback = observer.inspect({
      command: "bun",
      args: ["run", "status"],
      options: { shell: false, windowsHide: true },
    });
    const attempted = runNodeBanAudit({
      repoRoot: process.cwd(),
      subjectRevision,
      f0c,
      node,
      documents: cleanDocuments(),
      processObservations: [fallback],
    });
    expect(attempted.receipt.qualification).toBe("indeterminate");
    expect(attempted.receipt.process_observations).toContainEqual(fallback);

    const forgedSpawn = runNodeBanAudit({
      repoRoot: process.cwd(),
      subjectRevision,
      f0c,
      node,
      documents: cleanDocuments(),
      processObservations: [{ ...fallback, outcome: "allowed", spawned: true }],
    });
    expect(forgedSpawn.receipt.qualification).toBe("non_compliant");
    expect(forgedSpawn.findings.some((item) => item.detector === "process-observer")).toBe(true);

    const forgedOutcome = runNodeBanAudit({
      repoRoot: process.cwd(),
      subjectRevision,
      f0c,
      node,
      documents: cleanDocuments(),
      processObservations: [{ ...fallback, outcome: "allowed", spawned: false }],
    });
    expect(forgedOutcome.receipt.qualification).toBe("non_compliant");
    expect(forgedOutcome.findings.some((item) => item.detector === "process-observer")).toBe(true);
  });

  it("keeps frozen debt non-compliant and missing baseline indeterminate", () => {
    const debt = runNodeBanAudit({
      repoRoot: process.cwd(),
      subjectRevision,
      f0c,
      node,
      documents: {
        ...cleanDocuments(),
        debtBaseline:
          "schema_version: bun-migration-debt.v1\ninventory:\n  - finding_id: legacy\n    detector: runtime-portability\n    path: package.json\n    owner: PLAN-L7-462\n    expires_after: final-node-cutover\n",
      },
      processObservations: completeRuntimeObservations(),
    });
    expect(debt.receipt.qualification).toBe("non_compliant");
    const missing = runNodeBanAudit({
      repoRoot: process.cwd(),
      subjectRevision,
      f0c,
      node,
      documents: { ...cleanDocuments(), debtBaseline: null },
      processObservations: completeRuntimeObservations(),
    });
    expect(missing.receipt.qualification).toBe("indeterminate");
    expect(missing.receipt.coverage.gaps).toContain("debt-baseline");
  });
});
