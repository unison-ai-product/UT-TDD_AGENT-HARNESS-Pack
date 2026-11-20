import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
const repoRoot = process.cwd();
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
type TestProbeOutcome = {
  stdout: string;
  stderr: string;
  status: number | null;
  spawnError: string | null;
  timedOut: boolean;
};
type TestProbeAuditInput = Omit<
  Parameters<typeof runNodeBanAuditBase>[0],
  "f0cLanes" | "observedScopes" | "classifyProcess"
> &
  Partial<Pick<Parameters<typeof runNodeBanAuditBase>[0], "f0cLanes" | "observedScopes">> & {
    testProbeOutcome?: TestProbeOutcome;
  };
const runNodeBanAudit = (input: TestProbeAuditInput) => {
  const auditInput = {
    ...input,
    f0cLanes: input.f0cLanes ?? f0cLanes,
    classifyProcess: classifyRuntimeImageProcess,
    observedScopes: input.observedScopes ?? [
      ...new Set(input.processObservations.map((observation) => observation.scope)),
    ],
    testProbeOutcome:
      "testProbeOutcome" in input ? input.testProbeOutcome : validTestProbeOutcome(),
  };
  return runNodeBanAuditBase(auditInput as unknown as Parameters<typeof runNodeBanAuditBase>[0]);
};

const runNodeBanAuditWithTestProbe = (input: TestProbeAuditInput) => runNodeBanAudit(input);
const runNodeBanAuditIsUnqualified = (input: TestProbeAuditInput): boolean => {
  try {
    return runNodeBanAuditWithTestProbe(input).receipt.qualification !== "qualified";
  } catch {
    return true;
  }
};
const validTestProbeOutcome = (): TestProbeOutcome => ({
  stdout: JSON.stringify({
    schema: "node-invocation-probe-result/v1",
    candidate_id: "CAND-NODEBOOT-201",
    probe_id: "CAND-NODEBOOT-201/P1",
    test_source: "src/cli.ts#audit node-invocation-probe",
    production_target: "src/runtime/node-bootstrap.ts#createNodeInvocation",
    generation_id: node.generation_id,
    subject_revision: node.subject_revision,
    compiled_cli_sha256: node.artifact_digest.slice("sha256:".length),
    executed: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    checks: [
      { id: "invocation-options", result: "passed" },
      { id: "compiled-cli-argv0", result: "passed" },
      { id: "node-path-absolute", result: "passed" },
      { id: "compiled-cli-path-absolute", result: "passed" },
    ],
  }),
  stderr: "",
  status: 0,
  spawnError: null,
  timedOut: false,
});
const testProbeAuditInput = () => ({
  repoRoot,
  subjectRevision,
  f0c,
  node,
  documents: cleanDocuments(),
  processObservations: completeRuntimeObservations(),
});
const mutateValidProbePayload = (
  mutate: (payload: Record<string, unknown>) => Record<string, unknown>,
): TestProbeOutcome => {
  const valid = validTestProbeOutcome();
  const payload = JSON.parse(valid.stdout) as Record<string, unknown>;
  return { ...valid, stdout: JSON.stringify(mutate(payload)) };
};
const validProbeChecks = (): Array<Record<string, unknown>> =>
  JSON.parse(validTestProbeOutcome().stdout).checks as Array<Record<string, unknown>>;

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
      runNodeBanAudit({
        repoRoot: process.cwd(),
        subjectRevision,
        f0c,
        node,
        documents: cleanDocuments(),
        f0cLanes: [{ ...f0cLanes[0], generation_id: "node-ci-other" }, f0cLanes[1]],
        processObservations: [nodeObservation()],
        observedScopes: ["status"],
        testProbeOutcome: validTestProbeOutcome(),
      }),
    ).toThrow("q0-f0c-lane-evidence-generation-mismatch");
    expect(() =>
      runNodeBanAudit({
        repoRoot: process.cwd(),
        subjectRevision,
        f0c,
        node,
        documents: cleanDocuments(),
        f0cLanes: [{ ...f0cLanes[0], sealed_generation_id: f0c.generation_id }, f0cLanes[1]],
        processObservations: [nodeObservation()],
        observedScopes: ["status"],
        testProbeOutcome: validTestProbeOutcome(),
      }),
    ).toThrow("q0-f0c-sealed-generation-conflated");
  });

  it("ST-NODEPROBE-002 requires assertion reach and rejects the same child outcome", () => {
    const moduleUrl = pathToFileURL(join(repoRoot, "src/runtime/node-bootstrap.ts")).href;
    const syntheticGeneration = JSON.stringify({
      nodePath: "relative-node",
      compiledCliPath: join(repoRoot, "dist/node-generations/probe/ut-tdd.mjs"),
      generationPath: join(repoRoot, "dist/node-generations/probe"),
      receipt: {
        schema_version: 2,
        generation_id: node.generation_id,
        subject_revision: node.subject_revision,
        runtime: "node",
        compiled_cli: {
          path: "dist/node-generations/probe/ut-tdd.mjs",
          sha256: node.artifact_digest.slice("sha256:".length),
          local_version: "0.0.0",
        },
      },
    });
    const childScript = `
        const bootstrap = await import(${JSON.stringify(moduleUrl)});
        if (typeof bootstrap.runNodeInvocationProbe !== "function") {
          console.error("probe-handler-unimplemented");
          process.exitCode = 2;
        } else {
          await bootstrap.runNodeInvocationProbe(${syntheticGeneration});
        }
      `;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", childScript], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 30_000,
    });
    const spawnError = child.error as ({ code?: string } & Error) | undefined;
    const testProbeOutcome: TestProbeOutcome = {
      stdout: child.stdout ?? "",
      stderr: child.stderr ?? "",
      status: child.status,
      spawnError: spawnError?.message ?? null,
      timedOut: spawnError?.code === "ETIMEDOUT",
    };
    const q0Unqualified = runNodeBanAuditIsUnqualified({
      ...testProbeAuditInput(),
      testProbeOutcome,
    });
    expect({
      spawnSucceeded: spawnError === undefined,
      nonzero: typeof child.status === "number" && child.status !== 0,
      noSuccessJson: testProbeOutcome.stdout === "",
      reachedAssertion: testProbeOutcome.stderr.includes("node-path-absolute"),
      q0Unqualified,
    }).toEqual({
      spawnSucceeded: true,
      nonzero: true,
      noSuccessJson: true,
      reachedAssertion: true,
      q0Unqualified: true,
    });
  });

  it("ST-NODEPROBE-003 spawn ENOENT cannot qualify the test scope", () => {
    const missingCommand = join(repoRoot, "node_modules", ".ut-tdd-missing-node-probe-command");
    const child = spawnSync(missingCommand, [], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    const spawnError = child.error as ({ code?: string } & Error) | undefined;
    expect(spawnError?.code).toBe("ENOENT");
    expect(child.status).toBeNull();
    const testProbeOutcome: TestProbeOutcome = {
      stdout: child.stdout ?? "",
      stderr: child.stderr ?? "",
      status: child.status,
      spawnError: spawnError?.message ?? null,
      timedOut: spawnError?.code === "ETIMEDOUT",
    };
    expect(
      runNodeBanAuditIsUnqualified({
        ...testProbeAuditInput(),
        testProbeOutcome,
      }),
    ).toBe(true);
  });

  const invalidProbeOutcomes: Array<[string, TestProbeOutcome | undefined]> = [
    ["missing outcome", undefined],
    ["nonzero status", { ...validTestProbeOutcome(), status: 1 }],
    ["null status", { ...validTestProbeOutcome(), status: null }],
    ["spawn error", { ...validTestProbeOutcome(), spawnError: "ENOENT" }],
    ["timeout", { ...validTestProbeOutcome(), timedOut: true }],
    ["empty stdout", { ...validTestProbeOutcome(), stdout: "" }],
    ["malformed JSON", { ...validTestProbeOutcome(), stdout: "{" }],
    [
      "multiple objects",
      (() => {
        const valid = validTestProbeOutcome();
        return { ...valid, stdout: `${valid.stdout}\n${valid.stdout}` };
      })(),
    ],
    [
      "duplicate top-level field",
      (() => {
        const valid = validTestProbeOutcome();
        return {
          ...valid,
          stdout: valid.stdout.replace(
            '"candidate_id":"CAND-NODEBOOT-201"',
            '"candidate_id":"CAND-NODEBOOT-201","candidate_id":"CAND-NODEBOOT-201"',
          ),
        };
      })(),
    ],
    [
      "duplicate nested field",
      (() => {
        const valid = validTestProbeOutcome();
        return {
          ...valid,
          stdout: valid.stdout.replace(
            '"id":"invocation-options","result":"passed"',
            '"id":"invocation-options","id":"invocation-options","result":"passed"',
          ),
        };
      })(),
    ],
    [
      "unknown top-level field",
      mutateValidProbePayload((payload) => ({ ...payload, extra: true })),
    ],
    ...(
      [
        "schema",
        "candidate_id",
        "probe_id",
        "test_source",
        "production_target",
        "generation_id",
        "subject_revision",
        "compiled_cli_sha256",
        "executed",
        "passed",
        "failed",
        "skipped",
        "checks",
      ] as const
    ).map((key): [string, TestProbeOutcome] => [
      `required field missing: ${key}`,
      mutateValidProbePayload((payload) => {
        const result = { ...payload };
        delete result[key];
        return result;
      }),
    ]),
    [
      "candidate mismatch",
      mutateValidProbePayload((payload) => ({ ...payload, candidate_id: "other" })),
    ],
    ["probe mismatch", mutateValidProbePayload((payload) => ({ ...payload, probe_id: "other" }))],
    [
      "test source mismatch",
      mutateValidProbePayload((payload) => ({ ...payload, test_source: "other" })),
    ],
    [
      "production target mismatch",
      mutateValidProbePayload((payload) => ({ ...payload, production_target: "other" })),
    ],
    ["schema mismatch", mutateValidProbePayload((payload) => ({ ...payload, schema: "other" }))],
    [
      "generation mismatch",
      mutateValidProbePayload((payload) => ({ ...payload, generation_id: "other-generation" })),
    ],
    [
      "subject mismatch",
      mutateValidProbePayload((payload) => ({ ...payload, subject_revision: "c".repeat(40) })),
    ],
    [
      "compiled CLI digest mismatch",
      mutateValidProbePayload((payload) => ({ ...payload, compiled_cli_sha256: "0".repeat(64) })),
    ],
    ["zero executed", mutateValidProbePayload((payload) => ({ ...payload, executed: 0 }))],
    ["multiple executed", mutateValidProbePayload((payload) => ({ ...payload, executed: 2 }))],
    ["wrong executed type", mutateValidProbePayload((payload) => ({ ...payload, executed: "1" }))],
    ["zero passed", mutateValidProbePayload((payload) => ({ ...payload, passed: 0 }))],
    ["partial count", mutateValidProbePayload((payload) => ({ ...payload, passed: 3 }))],
    ["failed count", mutateValidProbePayload((payload) => ({ ...payload, failed: 1 }))],
    ["skip count", mutateValidProbePayload((payload) => ({ ...payload, skipped: 1 }))],
    [
      "check missing",
      mutateValidProbePayload((payload) => ({ ...payload, checks: validProbeChecks().slice(1) })),
    ],
    [
      "check duplicate",
      mutateValidProbePayload((payload) => {
        const checks = validProbeChecks();
        return { ...payload, checks: [checks[0], checks[0], checks[2], checks[3]] };
      }),
    ],
    [
      "unknown check ID",
      mutateValidProbePayload((payload) => {
        const checks = validProbeChecks();
        return { ...payload, checks: [{ ...checks[0], id: "unknown-check" }, ...checks.slice(1)] };
      }),
    ],
    [
      "check order",
      mutateValidProbePayload((payload) => ({ ...payload, checks: validProbeChecks().reverse() })),
    ],
    [
      "check failed",
      mutateValidProbePayload((payload) => {
        const checks = validProbeChecks();
        return { ...payload, checks: [{ ...checks[0], result: "failed" }, ...checks.slice(1)] };
      }),
    ],
    [
      "check ID missing",
      mutateValidProbePayload((payload) => {
        const checks = validProbeChecks();
        const first = { ...(checks[0] ?? {}) };
        delete first.id;
        return { ...payload, checks: [first, ...checks.slice(1)] };
      }),
    ],
    [
      "check result missing",
      mutateValidProbePayload((payload) => {
        const checks = validProbeChecks();
        const first = { ...(checks[0] ?? {}) };
        delete first.result;
        return { ...payload, checks: [first, ...checks.slice(1)] };
      }),
    ],
    [
      "unknown nested field",
      mutateValidProbePayload((payload) => {
        const checks = validProbeChecks();
        return { ...payload, checks: [{ ...checks[0], extra: true }, ...checks.slice(1)] };
      }),
    ],
  ];

  it.each(invalidProbeOutcomes)("ST-NODEPROBE-004 rejects %s", (_case, testProbeOutcome) => {
    const input = {
      ...testProbeAuditInput(),
      testProbeOutcome,
    };
    expect(runNodeBanAuditIsUnqualified(input)).toBe(true);
  });

  it("ST-NODEPROBE-004 accepts only a valid synthetic validator fixture", () => {
    // This fixture exercises input validation only; it is not real probe evidence.
    expect(
      runNodeBanAuditWithTestProbe({
        ...testProbeAuditInput(),
        testProbeOutcome: validTestProbeOutcome(),
      }).receipt.qualification,
    ).toBe("qualified");
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
      repoRoot,
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
