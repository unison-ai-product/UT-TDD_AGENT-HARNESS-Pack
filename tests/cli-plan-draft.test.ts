import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { parsePlanDraftManifest, registerPlanDraftCommand } from "../src/cli/plan-draft.ts";
import { NodePlanDraftRunner } from "../src/plan-admission/node-plan-draft-runner.ts";
import { TRACKED_RECEIPT_SCHEMA } from "../src/plan-admission/tracked-receipt-projection.ts";

const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
});

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 2,
    command_id: "cmd-1",
    plan_id: "PLAN-L4-999",
    recorded_at: "2026-07-15T10:00:00.000Z",
    admission: {
      route_signal: "forward",
      route_mode: "forward",
      kind: "design",
      layer: "L4",
      drive: "agent",
      branch: "work/forward-design",
    },
    source: { path: "docs/plans/PLAN-L4-999.md", content: "# PLAN" },
    projection: {
      path: "docs/governance/plan-admission-receipts.json",
    },
    ...overrides,
  });
}

async function run(input: string, status: "created" | "replayed" = "created") {
  const output: string[] = [];
  const execute = vi.fn(
    () =>
      ({
        status,
        receipt: {
          assetId: "asset-1",
          revision: 1,
          certificateId: "cert-1",
          commandPayloadDigest: "a".repeat(64),
        },
      }) as const,
  );
  const runner = { run: execute };
  const program = new Command().exitOverride();
  const plan = program.command("plan");
  registerPlanDraftCommand(plan, {
    readText: () => input,
    writeOutput: (text) => output.push(text),
    runner,
  });
  await program.parseAsync(["node", "ut-tdd", "plan", "draft", "--manifest", "draft.json"]);
  return { output, execute };
}

describe("plan draft CLI registrar", () => {
  it("U-PADM-040: strict manifestをAdmission後にserviceへ渡しcreatedをexit 0で返す", async () => {
    const result = await run(manifest());
    expect(process.exitCode).toBe(0);
    expect(result.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({ command_id: "cmd-1" }),
        admission: expect.objectContaining({ routeMode: "forward" }),
      }),
    );
    expect(JSON.parse(result.output.join(""))).toMatchObject({ ok: true, status: "created" });
  });

  it("U-PADM-041: committed commandのreplayもexit 0で返す", async () => {
    const result = await run(manifest(), "replayed");
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(result.output.join(""))).toMatchObject({ ok: true, status: "replayed" });
  });

  it("U-PADM-042: Admission拒否はfactoryを呼ばずexit 1にする", async () => {
    const input = JSON.parse(manifest()) as Record<string, unknown>;
    input.admission = { ...(input.admission as object), kind: "charter", layer: "L4" };
    const result = await run(JSON.stringify(input));
    expect(process.exitCode).toBe(1);
    expect(result.execute).not.toHaveBeenCalled();
    expect(JSON.parse(result.output.join(""))).toMatchObject({ ok: false });
  });

  it("U-PADM-043: unknown fieldとpath traversalをstrict parseで拒否する", () => {
    expect(() => parsePlanDraftManifest(manifest({ unexpected: true }))).toThrow();
    const input = JSON.parse(manifest()) as { source: { path: string } };
    input.source.path = "docs/../outside.md";
    expect(() => parsePlanDraftManifest(JSON.stringify(input))).toThrow();
  });

  function withIssue(issue: Record<string, unknown>): string {
    const input = JSON.parse(manifest()) as { admission: Record<string, unknown> };
    input.admission.issue = issue;
    return JSON.stringify(input);
  }

  /** PLAN-L7-690 command境界のfail-closeはZodErrorのspecific issue (code+path) で検査する。
   *  exit 1 / toThrow()のみだとguardが無関係なexceptionを投げてもGreenになる (#701 Sol r2 FINDING)。 */
  function issueBindingRejectionIssues(fn: () => unknown): ZodError["issues"] {
    let thrown: unknown;
    try {
      fn();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ZodError);
    return (thrown as ZodError).issues;
  }

  it("U-ISSUEBIND-001 (plan draft): projection_state=projectedの全ゼロdigestをtyped fail-closeする (§2.2)", () => {
    expect(
      issueBindingRejectionIssues(() =>
        parsePlanDraftManifest(
          withIssue({
            provider: "github",
            issue_id: 690,
            episode_id: "E4-690",
            projection_state: "projected",
            projection_digest: `sha256:${"0".repeat(64)}`,
          }),
        ),
      ),
    ).toContainEqual(
      expect.objectContaining({
        code: "custom",
        path: ["admission", "issue", "projection_digest"],
      }),
    );
  });

  it("U-ISSUEBIND-002 (plan draft): projection_state=unprojectedをdigestなしで受理する (§2.1)", () => {
    const parsed = parsePlanDraftManifest(
      withIssue({
        provider: "github",
        issue_id: 690,
        episode_id: "E4-690",
        projection_state: "unprojected",
      }),
    );
    expect(parsed.admission.issue).toEqual({
      provider: "github",
      issue_id: 690,
      episode_id: "E4-690",
      projection_state: "unprojected",
    });
  });

  it("U-ISSUEBIND-002 (plan draft): projection_state=unprojected+projection_digestの矛盾入力をfail-closeする (§2.1)", () => {
    expect(
      issueBindingRejectionIssues(() =>
        parsePlanDraftManifest(
          withIssue({
            provider: "github",
            issue_id: 690,
            episode_id: "E4-690",
            projection_state: "unprojected",
            projection_digest: `sha256:${"a".repeat(64)}`,
          }),
        ),
      ),
    ).toContainEqual(
      expect.objectContaining({ code: "unrecognized_keys", path: ["admission", "issue"] }),
    );
    expect(
      issueBindingRejectionIssues(() =>
        parsePlanDraftManifest(
          withIssue({
            provider: "github",
            issue_id: 690,
            episode_id: "E4-690",
            projection_state: "unprojected",
            projection_digest: `sha256:${"0".repeat(64)}`,
          }),
        ),
      ),
    ).toContainEqual(
      expect.objectContaining({ code: "unrecognized_keys", path: ["admission", "issue"] }),
    );
  });

  it("U-ISSUEBIND-003 (plan draft): projection_state=projectedのdigest欠落/null/空文字をfail-closeする (§2.1)", () => {
    expect(
      issueBindingRejectionIssues(() =>
        parsePlanDraftManifest(
          withIssue({
            provider: "github",
            issue_id: 690,
            episode_id: "E4-690",
            projection_state: "projected",
          }),
        ),
      ),
    ).toContainEqual(
      expect.objectContaining({
        code: "invalid_type",
        path: ["admission", "issue", "projection_digest"],
      }),
    );
    expect(
      issueBindingRejectionIssues(() =>
        parsePlanDraftManifest(
          withIssue({
            provider: "github",
            issue_id: 690,
            episode_id: "E4-690",
            projection_state: "projected",
            projection_digest: null,
          }),
        ),
      ),
    ).toContainEqual(
      expect.objectContaining({
        code: "invalid_type",
        path: ["admission", "issue", "projection_digest"],
      }),
    );
    expect(
      issueBindingRejectionIssues(() =>
        parsePlanDraftManifest(
          withIssue({
            provider: "github",
            issue_id: 690,
            episode_id: "E4-690",
            projection_state: "projected",
            projection_digest: "",
          }),
        ),
      ),
    ).toContainEqual(
      expect.objectContaining({
        code: "invalid_string",
        path: ["admission", "issue", "projection_digest"],
      }),
    );
  });

  it("U-ISSUEBIND-005 (plan draft): projection_state欠落は新規revision入力境界でfail-closeする (§2.2)", () => {
    expect(
      issueBindingRejectionIssues(() =>
        parsePlanDraftManifest(
          withIssue({
            provider: "github",
            issue_id: 690,
            episode_id: "E4-690",
            projection_digest: `sha256:${"a".repeat(64)}`,
          }),
        ),
      ),
    ).toContainEqual(
      expect.objectContaining({
        code: "invalid_union_discriminator",
        path: ["admission", "issue", "projection_state"],
      }),
    );
  });
});

describe("plan draft CLI: 拒否入力はcommand境界でwrite 0を保つ (#690補正)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function realFixture() {
    const root = join(
      tmpdir(),
      `ut-tdd-plan-draft-cli-write0-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    roots.push(root);
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    mkdirSync(join(root, "docs", "governance"), { recursive: true });
    const sourcePath = "docs/plans/PLAN-L4-999.md";
    const projectionPath = "docs/governance/plan-admission-receipts.json";
    const seededProjection = `${JSON.stringify({ schema_version: TRACKED_RECEIPT_SCHEMA, records: [] })}\n`;
    writeFileSync(join(root, projectionPath), seededProjection, "utf8");
    const ledgerPath = join(root, ".ut-tdd", "ledger", "harness-ledger.db");
    const runner = new NodePlanDraftRunner({
      repoRoot: root,
      sourceCommit: () => "a".repeat(40),
      actor: () => "codex",
      readText: (path) => readFileSync(path, "utf8"),
    });
    return { root, sourcePath, projectionPath, seededProjection, ledgerPath, runner };
  }

  async function runRejected(f: ReturnType<typeof realFixture>, issue: Record<string, unknown>) {
    const output: string[] = [];
    const program = new Command().exitOverride();
    const plan = program.command("plan");
    registerPlanDraftCommand(plan, {
      readText: () => manifest({ admission: { ...JSON.parse(manifest()).admission, issue } }),
      writeOutput: (text) => output.push(text),
      runner: f.runner,
    });
    await program.parseAsync(["node", "ut-tdd", "plan", "draft", "--manifest", "draft.json"]);
    return output;
  }

  /** command境界でcatchされたZodErrorはerrorText()でissues配列のJSON文字列になる (src/cli/plan-draft.ts)。
   *  ここをparseし直しspecific issue (code+path) を検査する: exit 1だけだとguard削除がGreenのまま通る。 */
  function expectRejectedIssue(
    output: string[],
    match: { code: string; path: (string | number)[] },
  ): void {
    const parsed = JSON.parse(output.join("")) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    const issues = JSON.parse(parsed.error) as Array<Record<string, unknown>>;
    expect(issues).toContainEqual(expect.objectContaining(match));
  }

  it("U-ISSUEBIND-001 (plan draft, real boundary): 全ゼロdigestは新規writeを0件に保つ", async () => {
    const f = realFixture();
    const output = await runRejected(f, {
      provider: "github",
      issue_id: 690,
      episode_id: "E4-690",
      projection_state: "projected",
      projection_digest: `sha256:${"0".repeat(64)}`,
    });
    expect(process.exitCode).toBe(1);
    expectRejectedIssue(output, {
      code: "custom",
      path: ["admission", "issue", "projection_digest"],
    });
    expect(existsSync(join(f.root, f.sourcePath))).toBe(false);
    expect(readFileSync(join(f.root, f.projectionPath), "utf8")).toBe(f.seededProjection);
    expect(existsSync(f.ledgerPath)).toBe(false);
  });

  it("U-ISSUEBIND-002 (plan draft, real boundary): unprojected+非全ゼロdigestの矛盾入力は新規writeを0件に保つ", async () => {
    const f = realFixture();
    const output = await runRejected(f, {
      provider: "github",
      issue_id: 690,
      episode_id: "E4-690",
      projection_state: "unprojected",
      projection_digest: `sha256:${"a".repeat(64)}`,
    });
    expect(process.exitCode).toBe(1);
    expectRejectedIssue(output, { code: "unrecognized_keys", path: ["admission", "issue"] });
    expect(existsSync(join(f.root, f.sourcePath))).toBe(false);
    expect(readFileSync(join(f.root, f.projectionPath), "utf8")).toBe(f.seededProjection);
    expect(existsSync(f.ledgerPath)).toBe(false);
  });

  it("U-ISSUEBIND-002 (plan draft, real boundary): unprojected+全ゼロdigestの矛盾入力は新規writeを0件に保つ", async () => {
    const f = realFixture();
    const output = await runRejected(f, {
      provider: "github",
      issue_id: 690,
      episode_id: "E4-690",
      projection_state: "unprojected",
      projection_digest: `sha256:${"0".repeat(64)}`,
    });
    expect(process.exitCode).toBe(1);
    expectRejectedIssue(output, { code: "unrecognized_keys", path: ["admission", "issue"] });
    expect(existsSync(join(f.root, f.sourcePath))).toBe(false);
    expect(readFileSync(join(f.root, f.projectionPath), "utf8")).toBe(f.seededProjection);
    expect(existsSync(f.ledgerPath)).toBe(false);
  });

  it("U-ISSUEBIND-003 (plan draft, real boundary): projectedのdigest欠落は新規writeを0件に保つ", async () => {
    const f = realFixture();
    const output = await runRejected(f, {
      provider: "github",
      issue_id: 690,
      episode_id: "E4-690",
      projection_state: "projected",
    });
    expect(process.exitCode).toBe(1);
    expectRejectedIssue(output, {
      code: "invalid_type",
      path: ["admission", "issue", "projection_digest"],
    });
    expect(existsSync(join(f.root, f.sourcePath))).toBe(false);
    expect(readFileSync(join(f.root, f.projectionPath), "utf8")).toBe(f.seededProjection);
    expect(existsSync(f.ledgerPath)).toBe(false);
  });

  it("U-ISSUEBIND-005 (plan draft, real boundary): projection_state欠落は新規writeを0件に保つ", async () => {
    const f = realFixture();
    const output = await runRejected(f, {
      provider: "github",
      issue_id: 690,
      episode_id: "E4-690",
      projection_digest: `sha256:${"a".repeat(64)}`,
    });
    expect(process.exitCode).toBe(1);
    expectRejectedIssue(output, {
      code: "invalid_union_discriminator",
      path: ["admission", "issue", "projection_state"],
    });
    expect(existsSync(join(f.root, f.sourcePath))).toBe(false);
    expect(readFileSync(join(f.root, f.projectionPath), "utf8")).toBe(f.seededProjection);
    expect(existsSync(f.ledgerPath)).toBe(false);
  });
});
