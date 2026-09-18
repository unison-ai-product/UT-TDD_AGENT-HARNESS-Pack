import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePlanRevisionManifest, registerPlanRevisionCommand } from "../src/cli/plan-revise.ts";

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
});
