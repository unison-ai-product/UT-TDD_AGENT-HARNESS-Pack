import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { parsePlanRevisionManifest, registerPlanRevisionCommand } from "../src/cli/plan-revise.ts";
import { NodePlanRevisionRunner } from "../src/plan-admission/node-plan-revision-runner.ts";
import { TRACKED_RECEIPT_SCHEMA } from "../src/plan-admission/tracked-receipt-projection.ts";

const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
});

const digest = "a".repeat(64);

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    command_id: "revise-1",
    plan_id: "PLAN-L4-31",
    actor: "codex",
    recorded_at: "2026-07-17T10:00:00.000Z",
    base: {
      asset_id: "asset-plan-l4-31",
      revision: 1,
      revision_digest: digest,
      source_commit: "b".repeat(40),
      source_blob_oid: "c".repeat(40),
      source_content_digest: digest,
      projection_tail_digest: digest,
    },
    admission: {
      route_signal: "forward",
      route_mode: "forward",
      kind: "design",
      layer: "L4",
      drive: "agent",
      branch: "work/forward-plan-revision",
    },
    source: { path: "docs/plans/PLAN-L4-31.md", content: "# revised PLAN" },
    projection: { path: "docs/governance/plan-admission-receipts.json" },
    ...overrides,
  });
}

async function run(input: string) {
  const output: string[] = [];
  const execute = vi.fn(() => ({ status: "revised", revision: 2 }) as const);
  const program = new Command().exitOverride();
  const plan = program.command("plan");
  registerPlanRevisionCommand(plan, {
    readText: () => input,
    writeOutput: (text) => output.push(text),
    runner: { run: execute },
  });
  await program.parseAsync(["node", "ut-tdd", "plan", "revise", "--manifest", "revise.json"]);
  return { execute, output };
}

describe("plan revise CLI registrar", () => {
  it("strict manifestとAdmission decisionをrunner portへ渡す", async () => {
    const result = await run(manifest());
    expect(process.exitCode).toBe(0);
    expect(result.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({
          version: 1,
          base: expect.objectContaining({ revision: 1, source_blob_oid: "c".repeat(40) }),
        }),
        admission: expect.objectContaining({ routeMode: "forward" }),
        decision: expect.objectContaining({ ok: true }),
      }),
    );
    expect(JSON.parse(result.output.join(""))).toMatchObject({ ok: true });
  });

  it("unknown fieldをrootとnested objectの両方で拒否する", () => {
    expect(() => parsePlanRevisionManifest(manifest({ unexpected: true }))).toThrow();
    const input = JSON.parse(manifest()) as { base: Record<string, unknown> };
    input.base.unexpected = true;
    expect(() => parsePlanRevisionManifest(JSON.stringify(input))).toThrow();
  });

  it.each([
    "asset_id",
    "revision",
    "revision_digest",
    "source_commit",
    "source_blob_oid",
    "source_content_digest",
    "projection_tail_digest",
  ])("base.%sを必須にする", (field) => {
    const input = JSON.parse(manifest()) as { base: Record<string, unknown> };
    delete input.base[field];
    expect(() => parsePlanRevisionManifest(JSON.stringify(input))).toThrow();
  });

  it("不正digest、OID、path traversalをwrite前に拒否する", async () => {
    const invalidDigest = JSON.parse(manifest()) as { base: Record<string, unknown> };
    invalidDigest.base.revision_digest = "not-a-digest";
    expect(() => parsePlanRevisionManifest(JSON.stringify(invalidDigest))).toThrow();

    const invalidOid = JSON.parse(manifest()) as { base: Record<string, unknown> };
    invalidOid.base.source_blob_oid = "abc";
    expect(() => parsePlanRevisionManifest(JSON.stringify(invalidOid))).toThrow();

    const traversal = JSON.parse(manifest()) as { source: Record<string, unknown> };
    traversal.source.path = "docs/../outside.md";
    const result = await run(JSON.stringify(traversal));
    expect(process.exitCode).toBe(1);
    expect(result.execute).not.toHaveBeenCalled();
  });

  it("Admission拒否はrunnerを呼ばずexit 1にする", async () => {
    const input = JSON.parse(manifest()) as { admission: Record<string, unknown> };
    input.admission.kind = "charter";
    const result = await run(JSON.stringify(input));
    expect(process.exitCode).toBe(1);
    expect(result.execute).not.toHaveBeenCalled();
    expect(JSON.parse(result.output.join(""))).toMatchObject({ ok: false });
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

  it("U-ISSUEBIND-001 (plan revise): projection_state=projectedの全ゼロdigestをtyped fail-closeする (§2.2)", () => {
    expect(
      issueBindingRejectionIssues(() =>
        parsePlanRevisionManifest(
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

  it("U-ISSUEBIND-002 (plan revise): projection_state=unprojectedをdigestなしで受理する (§2.1)", () => {
    const parsed = parsePlanRevisionManifest(
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

  it("U-ISSUEBIND-002 (plan revise): projection_state=unprojected+projection_digestの矛盾入力をfail-closeする (§2.1)", () => {
    expect(
      issueBindingRejectionIssues(() =>
        parsePlanRevisionManifest(
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
        parsePlanRevisionManifest(
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

  it("U-ISSUEBIND-003 (plan revise): projection_state=projectedのdigest欠落/null/空文字をfail-closeする (§2.1)", () => {
    expect(
      issueBindingRejectionIssues(() =>
        parsePlanRevisionManifest(
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
        parsePlanRevisionManifest(
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
        parsePlanRevisionManifest(
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

  it("U-ISSUEBIND-005 (plan revise): projection_state欠落は新規revision入力境界でfail-closeする (§2.2)", () => {
    expect(
      issueBindingRejectionIssues(() =>
        parsePlanRevisionManifest(
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

describe("plan revise CLI: 拒否入力はcommand境界でwrite 0を保つ (#690補正)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function realFixture() {
    const root = join(
      tmpdir(),
      `ut-tdd-plan-revise-cli-write0-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    roots.push(root);
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    mkdirSync(join(root, "docs", "governance"), { recursive: true });
    const sourcePath = "docs/plans/PLAN-L4-31.md";
    const projectionPath = "docs/governance/plan-admission-receipts.json";
    const seededSource = "# base PLAN-L4-31 fixture\n";
    const seededProjection = `${JSON.stringify({ schema_version: TRACKED_RECEIPT_SCHEMA, records: [] })}\n`;
    writeFileSync(join(root, sourcePath), seededSource, "utf8");
    writeFileSync(join(root, projectionPath), seededProjection, "utf8");
    const ledgerPath = join(root, ".ut-tdd", "ledger", "harness-ledger.db");
    const runner = new NodePlanRevisionRunner({
      repoRoot: root,
      sourceCommit: () => "b".repeat(40),
      sourceBlobOid: () => "c".repeat(40),
      readText: (path) => readFileSync(path, "utf8"),
      headText: () => seededSource,
      repositoryIdentity: () => "repo:test",
    });
    return { root, sourcePath, projectionPath, seededSource, seededProjection, ledgerPath, runner };
  }

  async function runRejected(f: ReturnType<typeof realFixture>, issue: Record<string, unknown>) {
    const output: string[] = [];
    const admission = { ...JSON.parse(manifest()).admission, issue };
    const program = new Command().exitOverride();
    const plan = program.command("plan");
    registerPlanRevisionCommand(plan, {
      readText: () => manifest({ admission }),
      writeOutput: (text) => output.push(text),
      runner: f.runner,
    });
    await program.parseAsync(["node", "ut-tdd", "plan", "revise", "--manifest", "revise.json"]);
    return output;
  }

  /** command境界でcatchされたZodErrorはerrorText()でissues配列のJSON文字列になる (src/cli/plan-revise.ts)。
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

  it("U-ISSUEBIND-001 (plan revise, real boundary): 全ゼロdigestは新規writeを0件に保つ", async () => {
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
    expect(readFileSync(join(f.root, f.sourcePath), "utf8")).toBe(f.seededSource);
    expect(readFileSync(join(f.root, f.projectionPath), "utf8")).toBe(f.seededProjection);
    expect(existsSync(f.ledgerPath)).toBe(false);
  });

  it("U-ISSUEBIND-002 (plan revise, real boundary): unprojected+非全ゼロdigestの矛盾入力は新規writeを0件に保つ", async () => {
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
    expect(readFileSync(join(f.root, f.sourcePath), "utf8")).toBe(f.seededSource);
    expect(readFileSync(join(f.root, f.projectionPath), "utf8")).toBe(f.seededProjection);
    expect(existsSync(f.ledgerPath)).toBe(false);
  });

  it("U-ISSUEBIND-002 (plan revise, real boundary): unprojected+全ゼロdigestの矛盾入力は新規writeを0件に保つ", async () => {
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
    expect(readFileSync(join(f.root, f.sourcePath), "utf8")).toBe(f.seededSource);
    expect(readFileSync(join(f.root, f.projectionPath), "utf8")).toBe(f.seededProjection);
    expect(existsSync(f.ledgerPath)).toBe(false);
  });

  it("U-ISSUEBIND-003 (plan revise, real boundary): projectedのdigest欠落は新規writeを0件に保つ", async () => {
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
    expect(readFileSync(join(f.root, f.sourcePath), "utf8")).toBe(f.seededSource);
    expect(readFileSync(join(f.root, f.projectionPath), "utf8")).toBe(f.seededProjection);
    expect(existsSync(f.ledgerPath)).toBe(false);
  });

  it("U-ISSUEBIND-005 (plan revise, real boundary): projection_state欠落は新規writeを0件に保つ", async () => {
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
    expect(readFileSync(join(f.root, f.sourcePath), "utf8")).toBe(f.seededSource);
    expect(readFileSync(join(f.root, f.projectionPath), "utf8")).toBe(f.seededProjection);
    expect(existsSync(f.ledgerPath)).toBe(false);
  });
});
