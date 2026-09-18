import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CustodyDecision,
  CustodyFailureReason,
  CustodyPullRequestFacts,
} from "../../src/feedback/review-custody.ts";
import { migratePlanLedger } from "../../src/plan-asset/ledger/schema.ts";
import {
  assembleSealedLineageMigrationDryRun,
  CustodyDecisionSealedLineageReviewAuthorityPort,
  executeSealedLineageRecovery,
  SystemSealedLineageIssueAuthorityPort,
  SystemSealedLineageProjectIdentityPort,
} from "../../src/plan-asset/ledger/sealed-lineage-local-migration.ts";
import { type HarnessDb, openHarnessDb } from "../../src/state-db/index.ts";

const opened: HarnessDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

describe("sealed lineage local migration", () => {
  it("U-PA-SEAL-001: tracked historyを推測で再構築せずsealし、同一aliasのsuccessor rev1を作る", async () => {
    const { db, transaction } = await fixture();

    expect(transaction.migrate(input())).toMatchObject({
      ok: true,
      replayed: false,
      successorAssetId: SUCCESSOR_ASSET_ID,
      successorRevision: 1,
    });
    expect(count(db, "plan_revisions")).toBe(1);
    expect(count(db, "sealed_plan_lineages")).toBe(1);
    expect(count(db, "plan_lineage_migration_certificates")).toBe(1);
    expect(count(db, "genesis_issue_custody")).toBe(1);
    expect(count(db, "plan_admission_receipts")).toBe(1);
    expect(db.prepare("SELECT asset_id FROM plan_aliases WHERE alias = ?").get(PLAN_ID)).toEqual({
      asset_id: SUCCESSOR_ASSET_ID,
    });
  });

  it("U-PA-SEAL-002: same payload replayは冪等、history改変はconflictとしてwrite 0", async () => {
    const { db, transaction } = await fixture();
    const command = input();
    expect(transaction.migrate(command)).toMatchObject({ ok: true, replayed: false });
    const baseline = counts(db);
    expect(transaction.migrate(command)).toMatchObject({ ok: true, replayed: true });
    expect(transaction.migrate({ ...command, historicalTailDigest: digest("tampered") })).toEqual({
      ok: false,
      ruleId: "sealed-lineage-command-conflict",
    });
    expect(counts(db)).toEqual(baseline);
  });

  it("U-PA-SEAL-009: durable replayはGit/review authorityの一時不在後も再実行できる", async () => {
    const { db, Transaction } = await baseFixture();
    const command = input();
    const transaction = new Transaction(db, {
      git: fakeGit(command),
      reviewAuthority: fakeReviewAuthority(),
      issueAuthority: fakeIssueAuthority(command),
    });
    expect(transaction.migrate(command)).toMatchObject({ ok: true, replayed: false });
    const unavailableGit = {
      readHeadCommit: () => {
        throw new Error("git-unavailable");
      },
      isReachableFromTrackedRemote: () => {
        throw new Error("git-unavailable");
      },
      readBlob: () => {
        throw new Error("git-unavailable");
      },
    };
    const replay = new Transaction(db, {
      git: unavailableGit,
      reviewAuthority: {
        observe: () => {
          throw new Error("review-authority-unavailable");
        },
      },
    });
    expect(replay.migrate(command)).toMatchObject({ ok: true, replayed: true });
  });

  it.each([
    "asset",
    "revision",
    "alias",
    "admission",
    "custody",
    "seal",
    "certificate",
    "receipt",
  ] as const)("U-PA-SEAL-003: %s faultで全writeをrollbackする", async (boundary) => {
    const { db, Transaction } = await baseFixture();
    const command = input();
    const transaction = new Transaction(db, {
      fault: {
        after(actual) {
          if (actual === boundary) throw new Error(`fault:${boundary}`);
        },
      },
      git: fakeGit(command),
      reviewAuthority: fakeReviewAuthority(),
      issueAuthority: fakeIssueAuthority(command),
    });
    expect(() => transaction.migrate(command)).toThrow(`fault:${boundary}`);
    expect(counts(db)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it.each([
    ["certificateDigest", "seal-certificate-digest-mismatch"],
    ["sourceAuthorityDigest", "seal-source-authority-invalid"],
    ["reviewedImplementationAuthorityDigest", "seal-review-authority-invalid"],
  ] as const)("U-PA-SEAL-004: E.6 %s の1 bit改変はwrite 0", async (field, ruleId) => {
    const { db, Transaction } = await baseFixture();
    const command = input();
    const mutated = { ...command, [field]: flipDigest(command[field]) } as MigrationInput;
    const transaction = new Transaction(db, {
      git: fakeGit(command),
      reviewAuthority: fakeReviewAuthority(),
    });
    expect(transaction.migrate(mutated)).toEqual({ ok: false, ruleId });
    expect(counts(db)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it.each([
    ["unreachable", "seal-source-commit-unreachable"],
    ["source path", "seal-source-path-noncanonical"],
    ["source absent", "seal-source-path-absent"],
    ["source oid", "seal-source-blob-mismatch"],
    ["source payload", "seal-source-payload-drift"],
    ["projection path", "seal-projection-path-noncanonical"],
    ["projection custody", "seal-projection-custody-mismatch"],
    ["projection terminal", "seal-projection-terminal-mismatch"],
    ["head race", "seal-source-head-toctou"],
  ] as const)("U-PA-SEAL-005: E.3 %s のGit preflight不成立はwrite 0", async (caseName, ruleId) => {
    const { db, Transaction } = await baseFixture();
    const command = input();
    const baseGit = fakeGit(command);
    let reads = 0;
    const git = {
      ...baseGit,
      readHeadCommit: () => {
        reads += 1;
        return caseName === "head race" && reads > 1 ? "e".repeat(40) : command.sourceCommit;
      },
      isReachableFromTrackedRemote: () => caseName !== "unreachable",
      readBlob: (commit: string, path: string) => {
        const blob = baseGit.readBlob(commit, path);
        if (caseName === "source absent" && path === command.sourcePath) return undefined;
        if (caseName === "source oid" && path === command.sourcePath && blob)
          return { ...blob, blobOid: flipOid(blob.blobOid) };
        if (caseName === "source payload" && path === command.sourcePath && blob)
          return { ...blob, bytes: Buffer.from("---\nplan_id: drift\n---\nbody", "utf8") };
        if (caseName === "projection custody" && path === command.historicalProjectionPath && blob)
          return { ...blob, bytes: Buffer.from("{}", "utf8") };
        if (caseName === "projection terminal" && path === command.historicalProjectionPath && blob)
          return { ...blob, bytes: Buffer.from(JSON.stringify({ records: [] }), "utf8") };
        return blob;
      },
    };
    const mutated =
      caseName === "source path"
        ? { ...command, sourcePath: "docs/plans/not-the-plan.md" }
        : caseName === "projection path"
          ? { ...command, historicalProjectionPath: "docs/other.json" }
          : caseName === "projection terminal"
            ? {
                ...command,
                historicalProjectionContentDigest: digest(JSON.stringify({ records: [] })),
              }
            : command;
    const transaction = new Transaction(db, { git, reviewAuthority: fakeReviewAuthority() });
    expect(transaction.migrate(mutated)).toEqual({ ok: false, ruleId });
    expect(counts(db)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("U-PA-SEAL-006: projection の最大 sequence が重複する場合は terminal を一意に束縛しない", async () => {
    const { db, Transaction } = await baseFixture();
    const command = input();
    const baseGit = fakeGit(command);
    const duplicate = JSON.stringify({
      records: [
        {
          sequence: 3,
          record_digest: `sha256:${command.historicalTailDigest}`,
          binding: {
            plan_id: command.planId,
            asset_id: command.historicalAssetId,
            revision: command.historicalTerminalRevision,
          },
        },
        {
          sequence: 3,
          record_digest: `sha256:${command.historicalTailDigest}`,
          binding: {
            plan_id: command.planId,
            asset_id: command.historicalAssetId,
            revision: command.historicalTerminalRevision,
          },
        },
      ],
    });
    const git = {
      ...baseGit,
      readBlob: (commit: string, path: string) => {
        const blob = baseGit.readBlob(commit, path);
        if (path !== command.historicalProjectionPath || !blob) return blob;
        return { ...blob, bytes: Buffer.from(duplicate, "utf8") };
      },
    };
    const mutated = { ...command, historicalProjectionContentDigest: digest(duplicate) };
    const transaction = new Transaction(db, { git, reviewAuthority: fakeReviewAuthority() });
    expect(transaction.migrate(mutated)).toEqual({
      ok: false,
      ruleId: "seal-projection-terminal-mismatch",
    });
    expect(counts(db)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("U-PA-SEAL-007: Git preflight port が無い場合はfail-closeする", async () => {
    const { db, Transaction } = await baseFixture();
    const command = input();
    const transaction = new Transaction(db, {
      reviewAuthority: fakeReviewAuthority(),
    });
    expect(transaction.migrate(command)).toEqual({
      ok: false,
      ruleId: "seal-git-preflight-unavailable",
    });
    expect(counts(db)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("U-PA-SEAL-008: review authority port が無い場合はfail-closeする", async () => {
    const { db, Transaction } = await baseFixture();
    const command = input();
    const transaction = new Transaction(db, { git: fakeGit(command) });
    expect(transaction.migrate(command)).toEqual({
      ok: false,
      ruleId: "seal-review-authority-invalid",
    });
    expect(counts(db)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("U-PA-SEAL-010: custody observationの未知・重複reasonはfail-closeする", async () => {
    const { db, Transaction } = await baseFixture();
    const command = input();
    const transaction = new Transaction(db, {
      git: fakeGit(command),
      reviewAuthority: {
        observe: () => ({
          pullRequestNumber: 543,
          baseRef: "main",
          headSha: "d".repeat(40),
          custodyState: "custody_rejected" as const,
          custodyReasons: ["unverified_family", "unverified_family"],
        }),
      },
    });
    expect(transaction.migrate(command)).toEqual({
      ok: false,
      ruleId: "seal-review-authority-invalid",
    });
    expect(counts(db)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("U-PA-SEAL-011: 非terminal recordの自己整合な三値を宣言してもterminal束縛を迂回できない", async () => {
    const { db, Transaction } = await baseFixture();
    const command = input();
    const historicalTailDigest = digest("record-1");
    const projection = JSON.stringify({
      schema_version: "ut-tdd.plan-admission-receipts/v1",
      records: [
        {
          sequence: 1,
          record_digest: `sha256:${historicalTailDigest}`,
          binding: {
            plan_id: command.planId,
            asset_id: "plan:old-recovery-16-asset",
            revision: 1,
          },
        },
        {
          sequence: 3,
          record_digest: `sha256:${command.historicalTailDigest}`,
          binding: {
            plan_id: command.planId,
            asset_id: command.historicalAssetId,
            revision: command.historicalTerminalRevision,
          },
        },
      ],
    });
    const mutated = withAuthorityDigests({
      ...command,
      historicalAssetId: "plan:old-recovery-16-asset",
      historicalTerminalRevision: 1,
      historicalTailDigest,
      historicalProjectionContentDigest: digest(projection),
    });
    const baseGit = fakeGit(command);
    const git = {
      ...baseGit,
      readBlob: (commit: string, path: string) => {
        const blob = baseGit.readBlob(commit, path);
        return path === command.historicalProjectionPath && blob
          ? { ...blob, bytes: Buffer.from(projection, "utf8") }
          : blob;
      },
    };
    const transaction = new Transaction(db, { git, reviewAuthority: fakeReviewAuthority() });

    expect(transaction.migrate(mutated)).toEqual({
      ok: false,
      ruleId: "seal-projection-terminal-mismatch",
    });
    expect(counts(db)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it.each([
    [
      "historicalAssetId",
      (command: MigrationInput) => ({ ...command, historicalAssetId: "plan:other-asset" }),
    ],
    [
      "historicalTerminalRevision",
      (command: MigrationInput) => ({ ...command, historicalTerminalRevision: 2 }),
    ],
    [
      "historicalTailDigest",
      (command: MigrationInput) => ({ ...command, historicalTailDigest: digest("other-tail") }),
    ],
  ] as const)("U-PA-SEAL-012: terminal bindingの%sはsource authority digestを変える", (_field, mutate) => {
    const command = input();
    const mutated = mutate(command);
    expect(sourceAuthorityDigest(mutated)).not.toBe(command.sourceAuthorityDigest);
  });

  it("U-PA-SEAL-013: custody_admitted分岐を実行し、rejected+unverified_familyと別digestにする", async () => {
    const command = input();
    const admittedObservation = reviewObservation("custody_admitted", []);
    const admitted = withReviewDigest(
      command,
      reviewedAuthorityDigest(command, admittedObservation),
    );
    expect(admitted.reviewedImplementationAuthorityDigest).not.toBe(
      command.reviewedImplementationAuthorityDigest,
    );

    const { db, Transaction } = await baseFixture();
    const transaction = new Transaction(db, {
      git: fakeGit(admitted),
      reviewAuthority: reviewAuthorityFor(admittedObservation),
      issueAuthority: fakeIssueAuthority(admitted),
    });
    expect(transaction.migrate(admitted)).toMatchObject({ ok: true, replayed: false });
    expect(count(db, "sealed_plan_lineages")).toBe(1);
  });

  it.each([
    [
      "column order",
      [
        "unison-ai-product/UT-TDD_AGENT-HARNESS",
        PLAN_ID,
        "543",
        "d".repeat(40),
        "main",
        "custody_rejected",
        "unverified_family",
      ],
    ],
    [
      "column omission",
      [
        "unison-ai-product/UT-TDD_AGENT-HARNESS",
        PLAN_ID,
        "543",
        "main",
        "custody_rejected",
        "unverified_family",
      ],
    ],
    [
      "pull request leading zero",
      [
        "unison-ai-product/UT-TDD_AGENT-HARNESS",
        PLAN_ID,
        "0543",
        "main",
        "d".repeat(40),
        "custody_rejected",
        "unverified_family",
      ],
    ],
    [
      "custody alternative representation",
      [
        "unison-ai-product/UT-TDD_AGENT-HARNESS",
        PLAN_ID,
        "543",
        "main",
        "d".repeat(40),
        "rejected",
        "unverified_family",
      ],
    ],
    [
      "custody reasons alternative representation",
      [
        "unison-ai-product/UT-TDD_AGENT-HARNESS",
        PLAN_ID,
        "543",
        "main",
        "d".repeat(40),
        "custody_rejected",
        '["unverified_family"]',
      ],
    ],
  ] as const)("U-PA-SEAL-014: E.4 %s preimage deviation is rejected", async (_caseName, values) => {
    const { db, Transaction } = await baseFixture();
    const command = input();
    const mutated = withReviewDigest(
      command,
      framedDigest("ut-tdd-seal-review-authority-v1", values),
    );
    const transaction = new Transaction(db, {
      git: fakeGit(mutated),
      reviewAuthority: fakeReviewAuthority(),
    });

    expect(transaction.migrate(mutated)).toEqual({
      ok: false,
      ruleId: "seal-review-authority-invalid",
    });
    expect(counts(db)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("U-PA-SEAL-015: E.2から導出されないsuccessor asset idはwrite前に拒否する", async () => {
    const { db, Transaction } = await baseFixture();
    const command = withAuthorityDigests({
      ...input(),
      successorAssetId: `plan:rebase:${digest("caller-controlled-seed")}`,
    });
    const transaction = new Transaction(db, {
      git: fakeGit(command),
      reviewAuthority: fakeReviewAuthority(),
    });

    expect(transaction.migrate(command)).toEqual({
      ok: false,
      ruleId: "sealed-lineage-input-invalid",
    });
    expect(counts(db)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it.each([
    ["port absent", undefined, (command: MigrationInput) => command],
    ["live read failure", { observe: () => undefined }, (command: MigrationInput) => command],
    [
      "wrong issue number",
      {
        observe: (command: MigrationInput) => ({
          number: command.issue.number + 1,
          rawBody: "issue 102",
          updatedAt: "2026-09-09T00:00:00Z",
        }),
      },
      (command: MigrationInput) => command,
    ],
    [
      "body digest drift",
      {
        observe: (command: MigrationInput) => ({
          number: command.issue.number,
          rawBody: "changed issue body",
          updatedAt: "2026-09-09T00:00:00Z",
        }),
      },
      (command: MigrationInput) => command,
    ],
    [
      "PLAN frontmatter issue number mismatch",
      null,
      (command: MigrationInput) =>
        withAuthorityDigests({
          ...command,
          issue: { ...command.issue, number: 103 },
        }),
    ],
    [
      "PLAN episode mismatch",
      null,
      (command: MigrationInput) =>
        withAuthorityDigests({ ...command, issue: { ...command.issue, episodeId: "E4-999" } }),
    ],
  ] as const)("U-PA-SEAL-016: %sはIssue authorityとして受理しない", async (_name, authority, mutate) => {
    const { db, Transaction } = await baseFixture();
    const command = mutate(input());
    const issueAuthority = authority === null ? fakeIssueAuthority(command) : authority;
    const transaction = new Transaction(db, {
      git: fakeGit(command),
      reviewAuthority: fakeReviewAuthority(),
      issueAuthority,
    });

    expect(transaction.migrate(command)).toEqual({
      ok: false,
      ruleId: "seal-issue-authority-invalid",
    });
    expect(counts(db)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it.each([
    ["LF + terminal newline", "line1\nline2\n", true],
    ["CRLF + terminal newline", "line1\r\nline2\r\n", false],
    ["LF without terminal newline", "line1\nline2", false],
  ] as const)("U-PA-SEAL-017: Issue body bytes %sを正規化しない", async (_name, rawBody, accepted) => {
    const { db, Transaction } = await baseFixture();
    const baselineBody = "line1\nline2\n";
    const command = withAuthorityDigests({
      ...input(),
      issue: { ...input().issue, preimageDigest: digest(baselineBody) },
    });
    const transaction = new Transaction(db, {
      git: fakeGit(command),
      reviewAuthority: fakeReviewAuthority(),
      issueAuthority: {
        observe: () => ({
          number: command.issue.number,
          rawBody,
          updatedAt: "2026-09-09T00:00:00Z",
        }),
      },
    });

    expect(transaction.migrate(command).ok).toBe(accepted);
    expect(count(db, "sealed_plan_lineages")).toBe(accepted ? 1 : 0);
  });

  it.each([
    ["repository", { repository: "other/repository" }, rejectedDecision(["unverified_family"])],
    ["pull request", { prNumber: 544 }, rejectedDecision(["unverified_family"])],
    ["head", { headSha: "e".repeat(40) }, rejectedDecision(["unverified_family"])],
    ["base", { baseRef: "release" }, rejectedDecision(["unverified_family"])],
    ["rejected reason content", {}, rejectedDecision(["missing"])],
    ["forged local receipt", {}, rejectedDecision(["signature_unverified"])],
    ["provider failure", {}, rejectedDecision(["provider_failed"])],
    ["FLAG verdict", {}, rejectedDecision(["verdict_flagged"])],
    ["same-family or identity mismatch", {}, rejectedDecision(["identity_mismatch"])],
    ["rejected reason order", {}, rejectedDecision(["unverified_family", "missing"])],
    ["admitted subject", {}, admittedDecision({ headSha: "e".repeat(40) })],
  ] as const)("U-PA-SEAL-018: typed custodyの%s driftを拒否する", async (_name, factPatch, decision) => {
    const { db, Transaction } = await baseFixture();
    const command = input();
    const facts = { ...reviewFacts(), ...factPatch };
    const transaction = new Transaction(db, {
      git: fakeGit(command),
      reviewAuthority: new CustodyDecisionSealedLineageReviewAuthorityPort(facts, decision),
      issueAuthority: fakeIssueAuthority(command),
    });

    expect(transaction.migrate(command)).toEqual({
      ok: false,
      ruleId: "seal-review-authority-invalid",
    });
    expect(counts(db)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("U-PA-SEAL-018: typed custodyの正規rejected decisionを受理する", async () => {
    const { db, Transaction } = await baseFixture();
    const command = input();
    const transaction = new Transaction(db, {
      git: fakeGit(command),
      reviewAuthority: new CustodyDecisionSealedLineageReviewAuthorityPort(
        reviewFacts(),
        rejectedDecision(["unverified_family"]),
      ),
      issueAuthority: fakeIssueAuthority(command),
    });

    expect(transaction.migrate(command)).toMatchObject({ ok: true, replayed: false });
    expect(count(db, "sealed_plan_lineages")).toBe(1);
  });

  it("U-PA-SEAL-019: System Issue adapterはREST JSONのraw bodyを変更せず返す", () => {
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const rawBody = "line1\r\nline2\r\n";
    const adapter = new SystemSealedLineageIssueAuthorityPort((args) => {
      mutableCalls.push([...args]);
      return JSON.stringify({ number: 102, body: rawBody, updated_at: "2026-09-09T00:00:00Z" });
    });

    expect(adapter.observe(input())).toEqual({
      number: 102,
      rawBody,
      updatedAt: "2026-09-09T00:00:00Z",
    });
    expect(calls).toEqual([
      [
        "api",
        "repos/unison-ai-product/UT-TDD_AGENT-HARNESS/issues/102",
        "--header",
        "Cache-Control: no-cache",
      ],
    ]);
  });

  it("U-PA-SEAL-020: dry-run assemblerはtracked Git/Issue/custodyだけから全preimageを導出する", async () => {
    const command = input();
    const result = await assembleSealedLineageMigrationDryRun({
      commandId: command.commandId,
      planId: command.planId,
      actor: command.actor,
      occurredAt: command.occurredAt,
      git: fakeGit(command),
      projectIdentity: fakeProjectIdentity(command),
      issueAuthority: fakeIssueAuthority(command),
      reviewCustody: fakeLiveReviewCustody(),
    });

    expect(result).toMatchObject({
      ok: true,
      input: command,
      validation: { ok: true },
    });
    if (!result.ok) throw new Error(result.ruleId);
    expect(result.canonicalManifest).toBe(stableCanonical(result.input));
    expect(result.manifestDigest).toBe(digest(result.canonicalManifest));
  });

  it.each([
    "identity_noncanonical_bytes",
    "identity_repository_unbound",
  ] as const)("U-PA-SEAL-020: project identity loaderの%s拒否をfail-closeする", async (ruleId) => {
    const command = input();
    const projectIdentity = new SystemSealedLineageProjectIdentityPort(
      ".",
      command.repositoryIdentity,
      () => ({ ok: false, error: { ruleId, message: "rejected fixture" } }),
    );
    expect(
      await assembleSealedLineageMigrationDryRun({
        commandId: command.commandId,
        planId: command.planId,
        actor: command.actor,
        occurredAt: command.occurredAt,
        git: fakeGit(command),
        projectIdentity,
        issueAuthority: fakeIssueAuthority(command),
        reviewCustody: fakeLiveReviewCustody(),
      }),
    ).toEqual({ ok: false, ruleId: "seal-git-preflight-unavailable" });
  });

  it("U-PA-SEAL-020: project identity HEAD driftをfail-closeする", async () => {
    const command = input();
    expect(
      await assembleSealedLineageMigrationDryRun({
        commandId: command.commandId,
        planId: command.planId,
        actor: command.actor,
        occurredAt: command.occurredAt,
        git: fakeGit(command),
        projectIdentity: {
          observe: () => ({
            repositoryIdentity: command.repositoryIdentity,
            sourceCommit: "e".repeat(40),
            receiptDigest: digest("project-identity-receipt"),
          }),
        },
        issueAuthority: fakeIssueAuthority(command),
        reviewCustody: fakeLiveReviewCustody(),
      }),
    ).toEqual({ ok: false, ruleId: "seal-git-preflight-unavailable" });
  });

  it.each([
    "review",
    "issue",
  ] as const)("U-PA-SEAL-021: %s authority観測中のHEAD移動はtransaction直前にwrite 0で拒否する", async (boundary) => {
    const { db, Transaction } = await baseFixture();
    const command = input();
    const stableGit = fakeGit(command);
    let head = command.sourceCommit;
    const git = { ...stableGit, readHeadCommit: () => head };
    const reviewAuthority = {
      observe: () => {
        if (boundary === "review") head = "e".repeat(40);
        return reviewObservation("custody_rejected", ["unverified_family"]);
      },
    };
    const issueAuthority = {
      observe: () => {
        if (boundary === "issue") head = "e".repeat(40);
        return fakeIssueAuthority(command).observe();
      },
    };
    const transaction = new Transaction(db, { git, reviewAuthority, issueAuthority });

    expect(transaction.migrate(command)).toEqual({
      ok: false,
      ruleId: "seal-source-head-toctou",
    });
    expect(counts(db)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it.each([
    "false",
    "throw",
  ] as const)("U-PA-SEAL-021: authority観測後のremote到達性%sをtyped拒否する", async (mode) => {
    const { db, Transaction } = await baseFixture();
    const command = input();
    const stableGit = fakeGit(command);
    let finalCheck = false;
    const git = {
      ...stableGit,
      isReachableFromTrackedRemote: () => {
        if (!finalCheck) return true;
        if (mode === "throw") throw new Error("remote-unavailable");
        return false;
      },
    };
    const issueAuthority = {
      observe: () => {
        finalCheck = true;
        return fakeIssueAuthority(command).observe();
      },
    };
    const transaction = new Transaction(db, {
      git,
      reviewAuthority: fakeReviewAuthority(),
      issueAuthority,
    });

    expect(transaction.migrate(command)).toEqual({
      ok: false,
      ruleId: "seal-source-commit-unreachable",
    });
    expect(counts(db)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it.each([
    "time-varying",
    "runner-summary",
  ] as const)("U-PA-SEAL-022: %s review preimageをcanonical authorityとして受理しない", async (variant) => {
    const { db, Transaction } = await baseFixture();
    const base = input();
    const observation = reviewObservation("custody_rejected", ["unverified_family"]);
    const forged = framedDigest("ut-tdd-seal-review-authority-v1", [
      base.repositoryIdentity,
      base.planId,
      String(observation.pullRequestNumber),
      observation.baseRef,
      observation.headSha,
      variant === "runner-summary" ? "unverified_family" : observation.custodyState,
      observation.custodyReasons.join(","),
      ...(variant === "time-varying" ? ["2026-09-09T00:00:00Z"] : []),
    ]);
    const command = withReviewDigest(base, forged);
    const transaction = new Transaction(db, {
      git: fakeGit(command),
      reviewAuthority: reviewAuthorityFor(observation),
      issueAuthority: fakeIssueAuthority(command),
    });
    expect(transaction.migrate(command)).toEqual({
      ok: false,
      ruleId: "seal-review-authority-invalid",
    });
    expect(counts(db)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it.each([
    "field-missing",
    "field-altered",
  ] as const)("U-PA-SEAL-023: certificate_json %s preimageを拒否する", async (variant) => {
    const { db, Transaction } = await baseFixture();
    const command = input();
    const certificate = {
      historicalAssetId: command.historicalAssetId,
      historicalTerminalRevision: command.historicalTerminalRevision,
      ...(variant === "field-missing" ? {} : { historicalTailDigest: digest("altered") }),
      planId: command.planId,
      reviewedImplementationAuthorityDigest: command.reviewedImplementationAuthorityDigest,
      sourceAuthorityDigest: command.sourceAuthorityDigest,
      successorAssetId: command.successorAssetId,
      successorRevision: 1,
    };
    const transaction = new Transaction(db, {
      git: fakeGit(command),
      reviewAuthority: fakeReviewAuthority(),
      issueAuthority: fakeIssueAuthority(command),
    });
    expect(
      transaction.migrate({
        ...command,
        certificateDigest: digest(stableCanonical(certificate)),
      }),
    ).toEqual({ ok: false, ruleId: "seal-certificate-digest-mismatch" });
    expect(counts(db)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("U-PA-SEAL-024: caller-supplied certificate_json fieldを入力として拒否する", async () => {
    const { db, Transaction } = await baseFixture();
    const command = input();
    const transaction = new Transaction(db, {
      git: fakeGit(command),
      reviewAuthority: fakeReviewAuthority(),
      issueAuthority: fakeIssueAuthority(command),
    });
    expect(transaction.migrate({ ...command, certificateJson: "{}" } as MigrationInput)).toEqual({
      ok: false,
      ruleId: "sealed-lineage-input-invalid",
    });
    expect(counts(db)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("U-PA-SEAL-025: live preflightから隔離ledger sealとstrict reviseを順序実行する", async () => {
    const { db } = await baseFixture();
    const command = input();
    const calls: string[] = [];
    const result = await executeSealedLineageRecovery({
      dryRun: dryRunRequest(command),
      openLedger: () => {
        calls.push("open-ledger");
        return { db, close: () => calls.push("close-ledger") };
      },
      runPlanRevision: () => {
        calls.push("plan-revise");
        return { ok: true, output: "revision-2" };
      },
    });

    expect(result).toMatchObject({ ok: true, revisionOutput: "revision-2" });
    expect(calls).toEqual(["open-ledger", "close-ledger", "plan-revise"]);
    expect(counts(db)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("U-PA-SEAL-026: dry-run fail-closeではledgerもreviseも起動しない", async () => {
    const command = input();
    let opened = 0;
    let revised = 0;
    const result = await executeSealedLineageRecovery({
      dryRun: {
        ...dryRunRequest(command),
        git: { ...fakeGit(command), isReachableFromTrackedRemote: () => false },
      },
      openLedger: () => {
        opened += 1;
        throw new Error("must not open");
      },
      runPlanRevision: () => {
        revised += 1;
        return { ok: true, output: "unexpected" };
      },
    });

    expect(result).toEqual({
      ok: false,
      stage: "dry-run",
      ruleId: "seal-source-commit-unreachable",
    });
    expect({ opened, revised }).toEqual({ opened: 0, revised: 0 });
  });

  it("U-PA-SEAL-027: seal authority driftでは全table write 0かつrevise 0", async () => {
    const { db } = await baseFixture();
    const command = input();
    let issueReads = 0;
    let revised = 0;
    const result = await executeSealedLineageRecovery({
      dryRun: {
        ...dryRunRequest(command),
        issueAuthority: {
          observe: () => ({
            number: command.issue.number,
            rawBody: issueReads++ === 0 ? "issue 102" : "changed issue",
            updatedAt: "2026-09-10T00:00:00Z",
          }),
        },
      },
      openLedger: () => ({ db, close: () => undefined }),
      runPlanRevision: () => {
        revised += 1;
        return { ok: true, output: "unexpected" };
      },
    });

    expect(result).toEqual({
      ok: false,
      stage: "seal",
      ruleId: "seal-issue-authority-invalid",
    });
    expect(counts(db)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(revised).toBe(0);
  });

  it("U-PA-SEAL-028: strict revise失敗をtypedに返し隔離seal証跡を保持する", async () => {
    const { db } = await baseFixture();
    const command = input();
    const result = await executeSealedLineageRecovery({
      dryRun: dryRunRequest(command),
      openLedger: () => ({ db, close: () => undefined }),
      runPlanRevision: () => ({ ok: false, ruleId: "plan-revision-failed" }),
    });

    expect(result).toEqual({
      ok: false,
      stage: "plan-revise",
      ruleId: "plan-revision-failed",
    });
    expect(counts(db)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });
});

const PLAN_ID = "PLAN-RECOVERY-16-plan-revision-authoring";
const SUCCESSOR_ASSET_ID =
  "plan:rebase:74ca026f9a0b72dca6f4fb164dd4e8f43c9ea3c9b31c4db21dec38a66d9d7d57";

type Boundary =
  | "asset"
  | "revision"
  | "alias"
  | "admission"
  | "custody"
  | "seal"
  | "certificate"
  | "receipt";

interface MigrationInput {
  commandId: string;
  repositoryIdentity: string;
  planId: string;
  historicalAssetId: string;
  historicalTerminalRevision: number;
  historicalTailDigest: string;
  historicalProjectionPath: string;
  historicalProjectionBlobOid: string;
  historicalProjectionContentDigest: string;
  successorAssetId: string;
  canonicalPayloadJson: string;
  canonicalPayloadDigest: string;
  bodyDigest: string;
  sourcePath: string;
  sourceCommit: string;
  sourceBlobOid: string;
  actor: string;
  occurredAt: string;
  certificateDigest: string;
  sourceAuthorityDigest: string;
  reviewedImplementationAuthorityDigest: string;
  trustedStatus: "draft";
  issue: {
    number: number;
    episodeId: string;
    preimageDigest: string;
  };
}

interface MigrationResult {
  ok: boolean;
  replayed?: boolean;
  successorAssetId?: string;
  successorRevision?: number;
  ruleId?: string;
}

interface Transaction {
  migrate(input: MigrationInput): MigrationResult;
}

interface TransactionConstructor {
  new (
    db: HarnessDb,
    options?: {
      fault?: { after(boundary: Boundary): void };
      git?: {
        readHeadCommit(): string;
        isReachableFromTrackedRemote(commit: string): boolean;
        readBlob(commit: string, path: string): { blobOid: string; bytes: Uint8Array } | undefined;
      };
      reviewAuthority?: {
        observe(input: MigrationInput):
          | {
              pullRequestNumber: number;
              baseRef: string;
              headSha: string;
              custodyState: "custody_admitted" | "custody_rejected";
              custodyReasons: readonly string[];
            }
          | undefined;
      };
      issueAuthority?: {
        observe(input: MigrationInput):
          | {
              number: number;
              rawBody: string;
              updatedAt: string;
            }
          | undefined;
      };
    },
  ): Transaction;
}

async function loadTransaction(): Promise<TransactionConstructor> {
  const modulePath = "../../src/plan-asset/ledger/sealed-lineage-local-migration.ts";
  const module = (await import(/* @vite-ignore */ modulePath)) as Record<string, unknown>;
  expect(module.SealedLineageLocalMigration).toBeTypeOf("function");
  return module.SealedLineageLocalMigration as TransactionConstructor;
}

async function baseFixture() {
  const db = openHarnessDb(":memory:");
  opened.push(db);
  expect(migratePlanLedger(db).ok).toBe(true);
  return { db, Transaction: await loadTransaction() };
}

async function fixture() {
  const value = await baseFixture();
  const command = input();
  return {
    ...value,
    transaction: new value.Transaction(value.db, {
      git: fakeGit(command),
      reviewAuthority: fakeReviewAuthority(),
      issueAuthority: fakeIssueAuthority(command),
    }),
  };
}

function input(): MigrationInput {
  const payload = stableCanonical({
    admission_receipt: { issue: { episode_id: "E4-102", issue_id: 102 } },
    plan_id: PLAN_ID,
    status: "draft",
  });
  const historicalTailDigest = digest("record-3");
  const projection = JSON.stringify({
    schema_version: "ut-tdd.plan-admission-receipts/v1",
    records: [
      {
        sequence: 3,
        record_digest: `sha256:${historicalTailDigest}`,
        binding: {
          plan_id: PLAN_ID,
          asset_id: "plan:890b18d79d85d8d7cc2591c7146af5e2",
          revision: 3,
        },
      },
    ],
  });
  const base = {
    commandId: "seal-lineage:recovery-16:v1",
    repositoryIdentity: "unison-ai-product/UT-TDD_AGENT-HARNESS",
    planId: PLAN_ID,
    historicalAssetId: "plan:890b18d79d85d8d7cc2591c7146af5e2",
    historicalTerminalRevision: 3,
    historicalTailDigest,
    historicalProjectionPath: "docs/governance/plan-admission-receipts.json",
    historicalProjectionBlobOid: "b".repeat(40),
    historicalProjectionContentDigest: digest(projection),
    successorAssetId: SUCCESSOR_ASSET_ID,
    canonicalPayloadJson: payload,
    canonicalPayloadDigest: digest(payload),
    bodyDigest: digest("body"),
    sourcePath: "docs/plans/PLAN-RECOVERY-16-plan-revision-authoring.md",
    sourceCommit: "a".repeat(40),
    sourceBlobOid: "c".repeat(40),
    actor: "codex",
    occurredAt: "2026-07-27T03:30:00.000Z",
    certificateDigest: "0".repeat(64),
    sourceAuthorityDigest: "0".repeat(64),
    reviewedImplementationAuthorityDigest: "0".repeat(64),
    trustedStatus: "draft" as const,
    issue: {
      number: 102,
      episodeId: "E4-102",
      preimageDigest: digest("issue 102"),
    },
  };
  const sourceAuthorityDigest = framedDigest("ut-tdd-seal-source-authority-v1", [
    base.repositoryIdentity,
    base.planId,
    base.sourcePath,
    base.sourceCommit,
    base.sourceBlobOid,
    base.canonicalPayloadDigest,
    base.bodyDigest,
    base.historicalProjectionPath,
    base.historicalProjectionBlobOid,
    base.historicalProjectionContentDigest,
    base.historicalAssetId,
    String(base.historicalTerminalRevision),
    base.historicalTailDigest,
  ]);
  const reviewedImplementationAuthorityDigest = framedDigest("ut-tdd-seal-review-authority-v1", [
    base.repositoryIdentity,
    base.planId,
    "543",
    "main",
    "d".repeat(40),
    "custody_rejected",
    "unverified_family",
  ]);
  const certificateDigest = digest(
    stableCanonical({
      historicalAssetId: base.historicalAssetId,
      historicalTerminalRevision: base.historicalTerminalRevision,
      historicalTailDigest: base.historicalTailDigest,
      planId: base.planId,
      reviewedImplementationAuthorityDigest,
      sourceAuthorityDigest,
      successorAssetId: base.successorAssetId,
      successorRevision: 1,
    }),
  );
  return {
    ...base,
    sourceAuthorityDigest,
    reviewedImplementationAuthorityDigest,
    certificateDigest,
  };
}

function fakeGit(command: MigrationInput) {
  const source = Buffer.from(
    `---\nplan_id: ${command.planId}\nstatus: draft\nadmission_receipt:\n  issue:\n    issue_id: 102\n    episode_id: E4-102\n---\nbody`,
    "utf8",
  );
  const projection = Buffer.from(
    JSON.stringify({
      schema_version: "ut-tdd.plan-admission-receipts/v1",
      records: [
        {
          sequence: command.historicalTerminalRevision,
          record_digest: `sha256:${command.historicalTailDigest}`,
          binding: {
            plan_id: command.planId,
            asset_id: command.historicalAssetId,
            revision: command.historicalTerminalRevision,
          },
        },
      ],
    }),
    "utf8",
  );
  return {
    readHeadCommit: () => command.sourceCommit,
    isReachableFromTrackedRemote: () => true,
    readBlob: (_commit: string, path: string) =>
      path === command.sourcePath
        ? { blobOid: command.sourceBlobOid, bytes: source }
        : path === command.historicalProjectionPath
          ? { blobOid: command.historicalProjectionBlobOid, bytes: projection }
          : path === "ut-tdd.project.json"
            ? {
                blobOid: "f".repeat(40),
                bytes: Buffer.from(
                  JSON.stringify({ repository_identity: command.repositoryIdentity }),
                  "utf8",
                ),
              }
            : undefined,
  };
}

function fakeReviewAuthority() {
  return reviewAuthorityFor(reviewObservation("custody_rejected", ["unverified_family"]));
}

function reviewFacts(): CustodyPullRequestFacts {
  return {
    repository: "unison-ai-product/UT-TDD_AGENT-HARNESS",
    prNumber: 543,
    baseRef: "main",
    headSha: "d".repeat(40),
    state: "OPEN",
    mergeSha: null,
    mergedAt: null,
  };
}

function rejectedDecision(reasons: readonly CustodyFailureReason[]): CustodyDecision {
  return { state: "custody_rejected", reasons, details: ["fixture"] };
}

function admittedDecision(
  patch: Partial<Extract<CustodyDecision, { state: "custody_admitted" }>> = {},
): CustodyDecision {
  return {
    state: "custody_admitted",
    repository: "unison-ai-product/UT-TDD_AGENT-HARNESS",
    prNumber: 543,
    headSha: "d".repeat(40),
    receiptKind: "pre_merge_review",
    reviewRevision: `rv1-${"a".repeat(64)}`,
    judgmentDigest: "a".repeat(64),
    receiptDigest: "b".repeat(64),
    artifactDigest: "c".repeat(64),
    workflowRef:
      "unison-ai-product/UT-TDD_AGENT-HARNESS/.github/workflows/harness-check.yml@refs/heads/main",
    workflowSha: "d".repeat(40),
    runId: "1",
    runAttempt: 1,
    issuer: "https://token.actions.githubusercontent.com",
    reviewerFamily: "claude",
    familyAuthority: "fixture",
    ...patch,
  };
}

function fakeIssueAuthority(command: MigrationInput) {
  return {
    observe: () => ({
      number: command.issue.number,
      rawBody: "issue 102",
      updatedAt: "2026-09-09T00:00:00Z",
    }),
  };
}

function fakeProjectIdentity(command: MigrationInput) {
  return {
    observe: () => ({
      repositoryIdentity: command.repositoryIdentity,
      sourceCommit: command.sourceCommit,
      receiptDigest: digest("project-identity-receipt"),
    }),
  };
}

function dryRunRequest(command: MigrationInput) {
  return {
    commandId: command.commandId,
    planId: command.planId,
    actor: command.actor,
    occurredAt: command.occurredAt,
    git: fakeGit(command),
    projectIdentity: fakeProjectIdentity(command),
    issueAuthority: fakeIssueAuthority(command),
    reviewCustody: {
      observe: async () => ({
        facts: reviewFacts(),
        decision: rejectedDecision(["unverified_family"]),
      }),
    },
  };
}

function fakeLiveReviewCustody() {
  return {
    observe: async () => ({
      facts: reviewFacts(),
      decision: rejectedDecision(["unverified_family"]),
    }),
  };
}

type CustodyState = "custody_admitted" | "custody_rejected";

interface ReviewObservation {
  pullRequestNumber: number;
  baseRef: string;
  headSha: string;
  custodyState: CustodyState;
  custodyReasons: readonly string[];
}

function reviewObservation(
  custodyState: CustodyState,
  custodyReasons: readonly string[],
): ReviewObservation {
  return {
    pullRequestNumber: 543,
    baseRef: "main",
    headSha: "d".repeat(40),
    custodyState,
    custodyReasons,
  };
}

function reviewAuthorityFor(observation: ReviewObservation) {
  return { observe: () => observation };
}

function sourceAuthorityDigest(command: MigrationInput): string {
  return framedDigest("ut-tdd-seal-source-authority-v1", [
    command.repositoryIdentity,
    command.planId,
    command.sourcePath,
    command.sourceCommit,
    command.sourceBlobOid,
    command.canonicalPayloadDigest,
    command.bodyDigest,
    command.historicalProjectionPath,
    command.historicalProjectionBlobOid,
    command.historicalProjectionContentDigest,
    command.historicalAssetId,
    String(command.historicalTerminalRevision),
    command.historicalTailDigest,
  ]);
}

function reviewedAuthorityDigest(command: MigrationInput, observation: ReviewObservation): string {
  return framedDigest("ut-tdd-seal-review-authority-v1", [
    command.repositoryIdentity,
    command.planId,
    String(observation.pullRequestNumber),
    observation.baseRef,
    observation.headSha,
    observation.custodyState,
    observation.custodyReasons.join(","),
  ]);
}

function withAuthorityDigests(command: MigrationInput): MigrationInput {
  return withReviewDigest(
    { ...command, sourceAuthorityDigest: sourceAuthorityDigest(command) },
    command.reviewedImplementationAuthorityDigest,
  );
}

function withReviewDigest(
  command: MigrationInput,
  reviewedImplementationAuthorityDigest: string,
): MigrationInput {
  return {
    ...command,
    reviewedImplementationAuthorityDigest,
    certificateDigest: digest(
      stableCanonical({
        historicalAssetId: command.historicalAssetId,
        historicalTerminalRevision: command.historicalTerminalRevision,
        historicalTailDigest: command.historicalTailDigest,
        planId: command.planId,
        reviewedImplementationAuthorityDigest,
        sourceAuthorityDigest: command.sourceAuthorityDigest,
        successorAssetId: command.successorAssetId,
        successorRevision: 1,
      }),
    ),
  };
}

function counts(db: HarnessDb): number[] {
  return [
    "plan_assets",
    "plan_revisions",
    "plan_aliases",
    "sealed_plan_lineages",
    "plan_lineage_migration_certificates",
    "genesis_issue_custody",
    "plan_admission_receipts",
    "append_command_receipts",
  ].map((table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n));
}

function count(db: HarnessDb, table: string): number {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function framedDigest(label: string, values: readonly string[]): string {
  const hash = createHash("sha256");
  for (const value of [label, ...values]) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return hash.digest("hex");
}

function stableCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableCanonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableCanonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function flipDigest(value: string): string {
  return `${value[0] === "0" ? "1" : "0"}${value.slice(1)}`;
}

function flipOid(value: string): string {
  return `${value[0] === "a" ? "b" : "a"}${value.slice(1)}`;
}
