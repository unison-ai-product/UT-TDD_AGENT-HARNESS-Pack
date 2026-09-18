import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileProviderJudgmentEvidenceAdapter } from "../src/feedback/adapters/provider-judgment-evidence.ts";
import type {
  PersistedProviderJudgment,
  ProviderEvidenceReadResult,
  ProviderJudgmentAttemptIdentity,
  ProviderJudgmentEvidencePort,
  ProviderJudgmentWriteResult,
} from "../src/feedback/ports/provider-judgment-evidence.ts";
import {
  type ProviderJudgmentResult,
  produceProviderJudgment,
} from "../src/feedback/provider-judgment.ts";
import { sha256HexOfBytes } from "../src/feedback/review-custody-canonical.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const identity: ProviderJudgmentAttemptIdentity = {
  repository: "unison-ai-product/UT-TDD_AGENT-HARNESS",
  prNumber: 557,
  headSha: "a".repeat(40),
  requestMemoryId: "memory:project:pr-557-review",
  requestDigest: "b".repeat(64),
  reviewRevision: `rv1-${"c".repeat(64)}`,
  attempt: 1,
  authorFamily: "codex",
  invocationNonce: "nonce-review-557",
};

function evidence(overrides: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schema_version: "provider-judgment-evidence/v1",
      verdict: "PASS-WEAK",
      blocking_findings: [],
      ...overrides,
    }),
  );
}

class FakePort implements ProviderJudgmentEvidencePort {
  readResult: ProviderEvidenceReadResult = {
    status: "available",
    identity,
    provider: "claude",
    model: "claude-opus-5",
    bytes: evidence(),
  };
  writeResult: ProviderJudgmentWriteResult = { status: "written" };
  writes: PersistedProviderJudgment[] = [];

  async read(): Promise<ProviderEvidenceReadResult> {
    return this.readResult;
  }

  async write(value: PersistedProviderJudgment): Promise<ProviderJudgmentWriteResult> {
    this.writes.push(value);
    return this.writeResult;
  }
}

async function run(
  port = new FakePort(),
  attempt: ProviderJudgmentAttemptIdentity = identity,
): Promise<ProviderJudgmentResult> {
  return produceProviderJudgment({ attempt, port });
}

describe("D3b provider judgment producer", () => {
  it("U-D3B-001: exact attemptからcanonical artifactとd3b refを導出しreplayする", async () => {
    const port = new FakePort();
    const first = await run(port);
    expect(first).toMatchObject({
      ok: true,
      payload: { author_family: "codex", reviewer_family: "claude" },
    });
    if (!first.ok) throw new Error(first.reason);
    expect(first.providerEvidenceRef).toBe(`d3b:${first.judgmentDigest}`);
    expect(first.judgmentDigest).toMatch(/^[0-9a-f]{64}$/);
    port.writeResult = { status: "replay" };
    await expect(run(port)).resolves.toMatchObject({ ok: true, replay: true });
  });

  it.each([
    ["repository", { repository: "other/repo" }],
    ["pr", { prNumber: 558 }],
    ["head", { headSha: "d".repeat(40) }],
    ["request", { requestDigest: "e".repeat(64) }],
    ["memory", { requestMemoryId: "memory:project:other-review" }],
    ["revision", { reviewRevision: `rv1-${"f".repeat(64)}` }],
    ["attempt", { attempt: 2 }],
    ["nonce", { invocationNonce: "nonce-review-other" }],
    ["author family", { authorFamily: "claude" as const }],
  ] satisfies readonly [
    string,
    Partial<ProviderJudgmentAttemptIdentity>,
  ][])("U-D3B-002: %s identity mutationをwrite 0で拒否", async (_name, mutation) => {
    const port = new FakePort();
    port.readResult = {
      ...(port.readResult as Extract<ProviderEvidenceReadResult, { status: "available" }>),
      identity: { ...identity, ...mutation },
    };
    await expect(run(port)).resolves.toEqual({ ok: false, reason: "identity_mismatch" });
    expect(port.writes).toHaveLength(0);
  });

  it("U-D3B-003: evidence bytesをdigestへ束縛する", async () => {
    const left = await run();
    const port = new FakePort();
    const mutatedBytes = new TextEncoder().encode(
      '{"blocking_findings":[],"schema_version":"provider-judgment-evidence/v1","verdict":"PASS-WEAK"}\n',
    );
    port.readResult = {
      ...(port.readResult as Extract<ProviderEvidenceReadResult, { status: "available" }>),
      // Keep the semantic verdict unchanged; only the evidence bytes (key
      // order and trailing whitespace) differ. This catches removal of the
      // evidence-bytes digest binding.
      bytes: mutatedBytes,
    };
    const right = await run(port);
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    if (!left.ok || !right.ok) return;
    expect(right.payload.verdict).toBe(left.payload.verdict);
    expect(right.payload.evidence_digest).toBe(sha256HexOfBytes(mutatedBytes));
    expect(right.judgmentDigest).not.toBe(left.judgmentDigest);
  });

  it.each([
    evidence({ unknown: true }),
    evidence({ schema_version: "d3b.v0" }),
    evidence({ verdict: 1 }),
    new Uint8Array([0xff]),
  ])("U-D3B-004: unknown/malformed schemaを拒否", async (bytes) => {
    const port = new FakePort();
    port.readResult = {
      ...(port.readResult as Extract<ProviderEvidenceReadResult, { status: "available" }>),
      bytes,
    };
    await expect(run(port)).resolves.toEqual({ ok: false, reason: "judgment_schema_invalid" });
    expect(port.writes).toHaveLength(0);
  });

  it("U-D3B-004: required evidence field欠落を拒否", async () => {
    const port = new FakePort();
    port.readResult = {
      ...(port.readResult as Extract<ProviderEvidenceReadResult, { status: "available" }>),
      bytes: new TextEncoder().encode(
        JSON.stringify({ schema_version: "provider-judgment-evidence/v1", verdict: "PASS-WEAK" }),
      ),
    };
    await expect(run(port)).resolves.toEqual({ ok: false, reason: "judgment_schema_invalid" });
    expect(port.writes).toHaveLength(0);
  });

  it.each([
    "",
    " claude-opus-5",
    "claude-opus-5 ",
  ])("U-D3B-004: invalid model %jを拒否", async (model) => {
    const port = new FakePort();
    port.readResult = {
      ...(port.readResult as Extract<ProviderEvidenceReadResult, { status: "available" }>),
      model,
    };
    await expect(run(port)).resolves.toEqual({ ok: false, reason: "identity_mismatch" });
    expect(port.writes).toHaveLength(0);
  });

  it.each([
    evidence({ verdict: "PASS", blocking_findings: ["blocked"] }),
    evidence({ verdict: "FLAG", blocking_findings: [] }),
    evidence({ verdict: "FLAG", blocking_findings: ["b", "a"] }),
    evidence({ verdict: "FLAG", blocking_findings: ["a", "a"] }),
  ])("U-D3B-005: verdictとfindingの矛盾を拒否", async (bytes) => {
    const port = new FakePort();
    port.readResult = {
      ...(port.readResult as Extract<ProviderEvidenceReadResult, { status: "available" }>),
      bytes,
    };
    await expect(run(port)).resolves.toEqual({ ok: false, reason: "judgment_schema_invalid" });
  });

  it("U-D3B-006: artifactはJCS key順かつ末尾改行1件で固定する", async () => {
    const port = new FakePort();
    const result = await run(port);
    if (!result.ok) throw new Error(result.reason);
    const text = new TextDecoder().decode(result.artifactBytes);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.indexOf('"attempt"')).toBeLessThan(text.indexOf('"author_family"'));
    expect(text).not.toContain("judgment_digest");
    expect(result.payload.evidence_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.judgmentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.providerEvidenceRef).toMatch(/^d3b:[0-9a-f]{64}$/);
  });

  it.each([
    ["judgment digest", { judgmentDigest: "f".repeat(64) }],
    ["provider evidence ref", { providerEvidenceRef: `d3b:${"f".repeat(64)}` }],
    ["PR comment", { prComment: "VERDICT: PASS" }],
    ["Memory body", { memoryBody: "VERDICT: PASS" }],
    ["D3a receipt digest", { d3aReceiptDigest: "e".repeat(64) }],
  ])("U-D3B-007: caller supplied %sを入力schemaで拒否する", async (_axis, injected) => {
    const port = new FakePort();
    const result = await produceProviderJudgment({
      attempt: identity,
      port,
      ...injected,
    } as never);
    expect(result).toEqual({ ok: false, reason: "identity_mismatch" });
    expect(port.writes).toHaveLength(0);
  });

  it("U-D3B-006: Unicode evidence is preserved by canonical JCS without weakening digest shape", async () => {
    const port = new FakePort();
    const unicodeBytes = evidence({ verdict: "FLAG", blocking_findings: ["証跡の不一致"] });
    port.readResult = {
      ...(port.readResult as Extract<ProviderEvidenceReadResult, { status: "available" }>),
      bytes: unicodeBytes,
    };
    const result = await run(port);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(new TextDecoder().decode(result.artifactBytes)).toContain("証跡の不一致");
    expect(result.judgmentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.providerEvidenceRef).toMatch(/^d3b:[0-9a-f]{64}$/);
  });

  it.each([
    ["uppercase HEAD", { headSha: "A".repeat(40) }],
    ["uppercase request digest", { requestDigest: "B".repeat(64) }],
    ["uppercase revision digest", { reviewRevision: `rv1-${"C".repeat(64)}` }],
    ["short HEAD", { headSha: "a".repeat(7) }],
    ["short request digest", { requestDigest: "b".repeat(7) }],
    ["short revision digest", { reviewRevision: `rv1-${"c".repeat(7)}` }],
  ] satisfies readonly [
    string,
    Partial<ProviderJudgmentAttemptIdentity>,
  ][])("U-D3B-006: noncanonical %s identity is rejected before artifact write", async (_name, mutation) => {
    const attempt = { ...identity, ...mutation };
    const port = new FakePort();
    port.readResult = {
      ...(port.readResult as Extract<ProviderEvidenceReadResult, { status: "available" }>),
      identity: attempt,
    };
    await expect(run(port, attempt)).resolves.toEqual({
      ok: false,
      reason: "identity_mismatch",
    });
    expect(port.writes).toHaveLength(0);
  });

  it.each([
    ["missing", "evidence_unavailable"],
    ["superseded", "evidence_superseded"],
    ["provider_failure", "provider_failure"],
  ] as const)("U-D3B-008: %sをtyped unavailableへ落とす", async (status, reason) => {
    const port = new FakePort();
    port.readResult = { status };
    await expect(run(port)).resolves.toEqual({ ok: false, reason });
    expect(port.writes).toHaveLength(0);
  });

  it("U-D3B-008: provider read例外をtyped unavailableへ落とす", async () => {
    const port = new FakePort();
    port.read = async () => {
      throw new Error("read failed");
    };
    await expect(run(port)).resolves.toEqual({ ok: false, reason: "provider_failure" });
  });

  it.each([
    ["conflict", "judgment_conflict"],
    ["failed", "judgment_write_failed"],
  ] as const)("U-D3B-009: immutable write %sをfail-close", async (status, reason) => {
    const port = new FakePort();
    port.writeResult = { status };
    await expect(run(port)).resolves.toEqual({ ok: false, reason });
  });

  it("U-D3B-009: immutable write例外をfail-close", async () => {
    const port = new FakePort();
    port.write = async () => {
      throw new Error("write failed");
    };
    await expect(run(port)).resolves.toEqual({ ok: false, reason: "judgment_write_failed" });
  });

  it.each([
    ["codex", "same_family_reviewer"],
    ["other", "identity_mismatch"],
  ])("U-D3B-002: provider family %sの不一致を拒否", async (provider, reason) => {
    const port = new FakePort();
    port.readResult = {
      ...(port.readResult as Extract<ProviderEvidenceReadResult, { status: "available" }>),
      provider: provider as "claude",
    };
    await expect(run(port)).resolves.toEqual({ ok: false, reason });
    expect(port.writes).toHaveLength(0);
  });

  it("file adapterはcontent replayだけを許し同一identity別contentを拒否する", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-d3b-"));
    roots.push(root);
    const evidenceRoot = join(root, "evidence");
    const judgmentsRoot = join(root, "judgments");
    const attemptDir = join(evidenceRoot, identity.requestDigest, "attempts", "attempt-1");
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(
      join(attemptDir, "evidence.json"),
      JSON.stringify({
        schema_version: "d3b-provider-evidence-envelope/v1",
        identity,
        provider: "claude",
        model: "claude-opus-5",
        evidence_base64: Buffer.from(evidence()).toString("base64"),
      }),
    );
    const adapter = new FileProviderJudgmentEvidenceAdapter({
      evidenceRoot,
      judgmentsRoot,
      verifiedInvocation: { ...identity, provider: "claude", model: "claude-opus-5" },
    });
    const first = await produceProviderJudgment({ attempt: identity, port: adapter });
    const replay = await produceProviderJudgment({ attempt: identity, port: adapter });
    expect(first).toMatchObject({ ok: true, replay: false });
    expect(replay).toMatchObject({ ok: true, replay: true });
    if (!first.ok) throw new Error(first.reason);
    expect(readFileSync(join(judgmentsRoot, `${first.judgmentDigest}.json`))).toEqual(
      Buffer.from(first.artifactBytes),
    );

    const retryIdentity = { ...identity, attempt: 2, invocationNonce: "nonce-review-557-retry" };
    const retryRoot = join(evidenceRoot, retryIdentity.requestDigest, "attempts", "attempt-2");
    mkdirSync(retryRoot, { recursive: true });
    writeFileSync(
      join(retryRoot, "evidence.json"),
      JSON.stringify({
        schema_version: "d3b-provider-evidence-envelope/v1",
        identity: retryIdentity,
        provider: "claude",
        model: "claude-opus-5",
        evidence_base64: Buffer.from(evidence({ verdict: "PASS" })).toString("base64"),
      }),
    );
    const retryAdapter = new FileProviderJudgmentEvidenceAdapter({
      evidenceRoot,
      judgmentsRoot,
      verifiedInvocation: {
        ...retryIdentity,
        provider: "claude",
        model: "claude-opus-5",
      },
    });
    const beforeRetryArtifacts = readdirSync(judgmentsRoot).filter((name) =>
      name.endsWith(".json"),
    );
    await expect(
      produceProviderJudgment({ attempt: retryIdentity, port: retryAdapter }),
    ).resolves.toEqual({ ok: false, reason: "judgment_conflict" });
    expect(readdirSync(judgmentsRoot).filter((name) => name.endsWith(".json"))).toEqual(
      beforeRetryArtifacts,
    );
  });

  it.each([
    ["provider", { provider: "codex", model: "claude-opus-5" }],
    ["model", { provider: "claude", model: "claude-sonnet-5" }],
  ] as const)("file adapterは自己申告%sをverified spawn factとして受理しない", async (_axis, claimed) => {
    const root = mkdtempSync(join(tmpdir(), "ut-d3b-spawn-"));
    roots.push(root);
    const evidenceRoot = join(root, "evidence");
    const judgmentsRoot = join(root, "judgments");
    const attemptDir = join(evidenceRoot, identity.requestDigest, "attempts", "attempt-1");
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(
      join(attemptDir, "evidence.json"),
      JSON.stringify({
        schema_version: "d3b-provider-evidence-envelope/v1",
        identity,
        ...claimed,
        evidence_base64: Buffer.from(evidence()).toString("base64"),
      }),
    );
    const adapter = new FileProviderJudgmentEvidenceAdapter({
      evidenceRoot,
      judgmentsRoot,
      verifiedInvocation: { ...identity, provider: "claude", model: "claude-opus-5" },
    });
    await expect(produceProviderJudgment({ attempt: identity, port: adapter })).resolves.toEqual({
      ok: false,
      reason: "provider_failure",
    });
    expect(existsSync(judgmentsRoot)).toBe(false);
  });

  it.each([
    ["head", { headSha: "d".repeat(40) }],
    ["request", { requestDigest: "e".repeat(64) }],
    ["revision", { reviewRevision: `rv1-${"f".repeat(64)}` }],
    ["attempt", { attempt: 2 }],
    ["nonce", { invocationNonce: "nonce-other-invocation" }],
  ])("file adapterは別%sのverified invocation factを流用しない", async (_axis, drift) => {
    const root = mkdtempSync(join(tmpdir(), "ut-d3b-invocation-"));
    roots.push(root);
    const evidenceRoot = join(root, "evidence");
    const judgmentsRoot = join(root, "judgments");
    const attemptDir = join(evidenceRoot, identity.requestDigest, "attempts", "attempt-1");
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(
      join(attemptDir, "evidence.json"),
      JSON.stringify({
        schema_version: "d3b-provider-evidence-envelope/v1",
        identity,
        provider: "claude",
        model: "claude-opus-5",
        evidence_base64: Buffer.from(evidence()).toString("base64"),
      }),
    );
    const adapter = new FileProviderJudgmentEvidenceAdapter({
      evidenceRoot,
      judgmentsRoot,
      verifiedInvocation: {
        ...identity,
        ...drift,
        provider: "claude",
        model: "claude-opus-5",
      },
    });
    await expect(produceProviderJudgment({ attempt: identity, port: adapter })).resolves.toEqual({
      ok: false,
      reason: "provider_failure",
    });
    expect(existsSync(judgmentsRoot)).toBe(false);
  });
});
