import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type PlanRevisionManifest, registerPlanRevisionCommand } from "../src/cli/plan-revise.ts";
import { canonicalPlanContentDigest } from "../src/plan-admission/diff-fence.ts";
import { NodeAtomicDraftPublisher } from "../src/plan-admission/node-atomic-draft-publisher.ts";
import {
  NodePlanRevisionRunner,
  revisionUsesLegacyBootstrap,
} from "../src/plan-admission/node-plan-revision-runner.ts";
import {
  canonicalPlanPayload,
  stableJson as productionStableJson,
} from "../src/plan-admission/plan-revision-command-assembler.ts";
import { evaluatePlanAdmission, type PlanAdmissionRequest } from "../src/plan-admission/policy.ts";
import { trackedReceiptRecordDigest } from "../src/plan-admission/tracked-receipt-projection.ts";
import { deriveLegacyAssetId } from "../src/plan-asset/adapters/legacy-plan-adapter.ts";
import { parseLegacyPlanSource } from "../src/plan-asset/adapters/legacy-plan-inventory.ts";
import { PlanRevisionLedgerTransaction } from "../src/plan-asset/ledger/plan-revision-ledger.ts";
import {
  ledgerRowDigest,
  ledgerSchemaDdl,
  migratePlanLedger,
} from "../src/plan-asset/ledger/schema.ts";
import { openHarnessDb } from "../src/state-db/index.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("NodePlanRevisionRunner", () => {
  it("U-PA-REV-039: 空ledgerをtracked terminal rev Nから再水和しasset不変でN+1を発行する", () => {
    const f = rehydrationFixture();
    const baseSource = readFileSync(join(f.root, f.manifest.source.path), "utf8");

    expect(f.runner.run(f.input)).toMatchObject({
      status: "created",
      receipt: { assetId: f.manifest.base.asset_id, revision: 8 },
    });
    expect(
      f.db
        .prepare("SELECT revision FROM plan_revisions WHERE asset_id = ? ORDER BY revision")
        .all(f.manifest.base.asset_id)
        .map((row) => Number(row.revision)),
    ).toEqual([7, 8]);
    expect(
      f.db
        .prepare("SELECT asset_id FROM plan_aliases WHERE alias = ? AND valid_to_revision IS NULL")
        .all(f.manifest.plan_id),
    ).toEqual([{ asset_id: f.manifest.base.asset_id }]);
    const parsed = parseLegacyPlanSource(baseSource);
    if (!parsed) throw new Error("rehydrated source invalid");
    const receiptFreeFrontmatter = { ...parsed.frontmatter };
    delete receiptFreeFrontmatter.admission_receipt;
    expect(
      f.db
        .prepare(
          `SELECT canonical_payload_json, canonical_payload_digest, body_digest
           FROM plan_revisions WHERE asset_id = ? AND revision = 7`,
        )
        .get(f.manifest.base.asset_id),
    ).toEqual({
      canonical_payload_json: stableJsonForTest(receiptFreeFrontmatter),
      canonical_payload_digest: sha(stableJsonForTest(receiptFreeFrontmatter)).slice(7),
      body_digest: sha(parsed.body).slice(7),
    });
  });

  it("U-PA-REV-040: tracked terminalのcontent digest不一致は再水和せずwrite 0", () => {
    const f = rehydrationFixture(sha("forged-content"));

    expect(() => f.runner.run(f.input)).toThrow(
      "plan-revision-rehydration-content-digest-mismatch",
    );
    expect(writeSet(f.db)).toEqual(f.before);
  });

  it("U-PA-REV-041: stale ledgerは中間revisionを捏造せずterminalだけ再水和する", () => {
    const f = rehydrationFixture();
    seedAdopted(f.db, f.manifest.base.asset_id, f.manifest.plan_id, '{"revision":1}', false);

    expect(f.runner.run(f.input)).toMatchObject({ status: "created", receipt: { revision: 8 } });
    expect(
      f.db
        .prepare("SELECT revision FROM plan_revisions WHERE asset_id = ? ORDER BY revision")
        .all(f.manifest.base.asset_id)
        .map((row) => Number(row.revision)),
    ).toEqual([1, 7, 8]);
  });

  it.each([
    [
      "missing (authority不在はrehydrationせず従来経路)",
      [],
      false,
      "plan-revision-legacy-asset-id-mismatch",
    ],
    [
      "asset mismatch",
      [{ asset_id: "plan:other" }],
      true,
      "plan-revision-rehydration-receipt-mismatch",
    ],
    [
      "path mismatch",
      [{ path: "docs/plans/PLAN-L6-32.md" }],
      true,
      "plan-revision-rehydration-receipt-mismatch",
    ],
    [
      "plan identity mismatch",
      [{ plan_id: "PLAN-L6-32" }],
      true,
      "plan-revision-rehydration-receipt-mismatch",
    ],
    [
      "duplicate terminal",
      [{}, {}],
      false,
      "plan-revision-projection-invalid:record[1]:path-revision-duplicate",
    ],
  ])("U-PA-REV-042: projection %sはwrite 0", (_name, bindings, preserveReceiptIdentity, ruleId) => {
    const f = rehydrationFixture();
    rewriteProjection(f, bindings, preserveReceiptIdentity);

    expect(() => f.runner.run(f.input)).toThrow(ruleId);
    expect(writeSet(f.db)).toEqual(f.before);
  });

  it("U-PA-REV-043: canonical payload digest不一致はwrite 0", () => {
    const f = rehydrationFixture();
    f.manifest.base.revision_digest = sha("forged-canonical-payload");

    expect(() => f.runner.run(f.input)).toThrow(
      "plan-revision-rehydration-canonical-digest-mismatch",
    );
    expect(writeSet(f.db)).toEqual(f.before);
  });

  it("U-PA-REV-044: superseded asset history does not shadow the selected terminal asset", () => {
    const f = rehydrationFixture();
    rewriteProjection(
      f,
      [{ asset_id: "plan:superseded", revision: 6, content_digest: sha("old-content") }, {}],
      true,
    );

    expect(f.runner.run(f.input)).toMatchObject({
      status: "created",
      receipt: { assetId: f.manifest.base.asset_id, revision: 8 },
    });
  });

  it("U-PA-REV-045: plan:legacy:プレフィクス資産もHEAD embedded receiptとの完全一致からlegacy bootstrap/sealへ落ちず決定的に再水和される", () => {
    const f = rehydrationFixture(undefined, { legacyPrefixed: true });
    expect(f.manifest.base.asset_id.startsWith("plan:legacy:")).toBe(true);

    expect(f.runner.run(f.input)).toMatchObject({
      status: "created",
      receipt: { assetId: f.manifest.base.asset_id, revision: 8 },
    });
    expect(
      f.db
        .prepare("SELECT revision FROM plan_revisions WHERE asset_id = ? ORDER BY revision")
        .all(f.manifest.base.asset_id)
        .map((row) => Number(row.revision)),
    ).toEqual([7, 8]);
    expect(
      f.db
        .prepare("SELECT 1 FROM legacy_plan_bootstrap_provenance WHERE asset_id = ?")
        .get(f.manifest.base.asset_id),
    ).toBeUndefined();
    expect(
      f.db
        .prepare(
          "SELECT 1 FROM sealed_plan_lineages WHERE historical_asset_id = ? OR successor_asset_id = ?",
        )
        .get(f.manifest.base.asset_id, f.manifest.base.asset_id),
    ).toBeUndefined();
    expect(rows(f.db, "plan_lineage_migration_certificates")).toBe(0);
    expect(revisionUsesLegacyBootstrap(f.db, f.manifest.base.asset_id, f.manifest.command_id)).toBe(
      false,
    );
  });

  it("U-PA-REV-046: plan:<sha> (非legacy prefix) 資産もHEAD embedded receiptとの完全一致から決定的に再水和される", () => {
    const shaAssetId = `plan:${rawSha("non-legacy-sha-asset")}`;
    const f = rehydrationFixture(undefined, { forcedAssetId: shaAssetId });
    expect(f.manifest.base.asset_id.startsWith("plan:legacy:")).toBe(false);

    expect(f.runner.run(f.input)).toMatchObject({
      status: "created",
      receipt: { assetId: shaAssetId, revision: 8 },
    });
    expect(
      f.db
        .prepare("SELECT revision FROM plan_revisions WHERE asset_id = ? ORDER BY revision")
        .all(shaAssetId)
        .map((row) => Number(row.revision)),
    ).toEqual([7, 8]);
    expect(
      f.db
        .prepare("SELECT 1 FROM legacy_plan_bootstrap_provenance WHERE asset_id = ?")
        .get(shaAssetId),
    ).toBeUndefined();
    expect(
      f.db
        .prepare(
          "SELECT 1 FROM sealed_plan_lineages WHERE historical_asset_id = ? OR successor_asset_id = ?",
        )
        .get(shaAssetId, shaAssetId),
    ).toBeUndefined();
    expect(rows(f.db, "plan_lineage_migration_certificates")).toBe(0);
  });

  it("U-PA-REV-047: 再水和append後、新tail recordはtracked terminal recordへprevious_record_digestで連続する", () => {
    const f = rehydrationFixture(undefined, { legacyPrefixed: true });
    const priorTerminal = JSON.parse(
      readFileSync(join(f.root, f.manifest.projection.path), "utf8"),
    ).records.at(-1);

    f.runner.run(f.input);

    const appended = JSON.parse(
      readFileSync(join(f.root, f.manifest.projection.path), "utf8"),
    ).records.at(-1);
    expect(appended.previous_record_digest).toBe(priorTerminal.record_digest);
  });

  it("U-PA-REV-048: terminal content digest不一致はwrite 0でfail-closeしlegacy bootstrap/sealへ迂回しない", () => {
    const f = rehydrationFixture(sha("forged-content"), { legacyPrefixed: true });

    expect(() => f.runner.run(f.input)).toThrow(
      "plan-revision-rehydration-content-digest-mismatch",
    );
    expect(writeSet(f.db)).toEqual(f.before);
  });

  it("U-PA-REV-050: canonical payload digest不一致はwrite 0でfail-closeする", () => {
    const f = rehydrationFixture(undefined, { legacyPrefixed: true });
    f.manifest.base.revision_digest = sha("forged-canonical-payload-rehydration");

    expect(() => f.runner.run(f.input)).toThrow(
      "plan-revision-rehydration-canonical-digest-mismatch",
    );
    expect(writeSet(f.db)).toEqual(f.before);
  });

  it("U-PA-REV-051: embedded receipt項目 (receipt_digest) 改変はprojection recordとの完全一致に失敗しwrite 0でfail-closeする", () => {
    const f = rehydrationFixture(undefined, { legacyPrefixed: true });
    const tamperedSource = f.baseSource.replace(
      `receipt_digest: ${sha("rehydration-terminal-receipt")}`,
      `receipt_digest: ${sha("forged-receipt-digest")}`,
    );
    expect(tamperedSource).not.toBe(f.baseSource);
    writeFileSync(join(f.root, f.manifest.source.path), tamperedSource, "utf8");
    f.drift.headSource = tamperedSource;
    f.manifest.base.source_content_digest = sha(tamperedSource);

    expect(() => f.runner.run(f.input)).toThrow("plan-revision-rehydration-receipt-mismatch");
    expect(writeSet(f.db)).toEqual(f.before);
  });

  it("U-PA-REV-052: 同一plan_id/pathへより新しいsequenceのrecordが存在するlineageはambiguousとしてwrite 0でfail-closeする", () => {
    const f = rehydrationFixture(undefined, { legacyPrefixed: true });
    appendNewerLineageRecord(f);

    expect(() => f.runner.run(f.input)).toThrow("plan-revision-rehydration-lineage-ambiguous");
    expect(writeSet(f.db)).toEqual(f.before);
  });

  it("U-PA-REV-053: HEAD sourceにadmission_receiptが埋め込まれていない資産は再水和されず従来のlegacy bootstrapへ進む (fallback回帰防止)", () => {
    const f = fixture("legacy");
    expect(f.manifest.base.asset_id.startsWith("plan:legacy:")).toBe(true);

    expect(f.runner.run(f.input)).toMatchObject({ status: "created", receipt: { revision: 2 } });
    expect(revisionUsesLegacyBootstrap(f.db, f.manifest.base.asset_id, f.manifest.command_id)).toBe(
      true,
    );
    expect(rows(f.db, "plan_assets")).toBe(1);
  });

  it("U-PA-REV-054: embedded receiptのreceipt_idに対応するprojection recordが存在しない資産は再水和されず従来のlegacy bootstrapへ進む (fallback回帰防止)", () => {
    const drift: Drift = {};
    const f = fixture("legacy", drift);
    const baseSource = readFileSync(join(f.root, f.manifest.source.path), "utf8");
    const withReceipt = baseSource.replace(
      "generates: []\n",
      `generates: []\nadmission_receipt:\n  schema_version: v2\n  receipt_id: certificate:no-matching-record\n  command_id: plan-revise:no-matching-record\n  admitted_at: 2026-09-14T00:00:00.000Z\n  source_digest: ${sha("placeholder")}\n  decision_digest: ${sha("placeholder-decision")}\n  receipt_digest: ${sha("placeholder-receipt")}\n  binding:\n    path: ${f.manifest.source.path}\n    plan_id: ${f.manifest.plan_id}\n    asset_id: ${f.manifest.base.asset_id}\n    revision: 1\n    content_digest: ${sha("placeholder")}\n  route:\n    signal: forward\n    mode: forward\n`,
    );
    writeFileSync(join(f.root, f.manifest.source.path), withReceipt, "utf8");
    drift.headSource = withReceipt;
    f.manifest.source.content = withReceipt.replace("title: Base", "title: Revised");
    f.manifest.base.source_content_digest = sha(withReceipt);
    f.manifest.base.revision_digest = sha(canonicalPlanPayload(withReceipt).payload);

    expect(f.runner.run(f.input)).toMatchObject({ status: "created", receipt: { revision: 2 } });
    expect(revisionUsesLegacyBootstrap(f.db, f.manifest.base.asset_id, f.manifest.command_id)).toBe(
      true,
    );
  });

  it("U-PA-REV-055: admission_receiptが存在するのにreceipt_idが欠落していればfallbackせずwrite 0でfail-closeする", () => {
    const drift: Drift = {};
    const f = fixture("legacy", drift);
    const baseSource = readFileSync(join(f.root, f.manifest.source.path), "utf8");
    const withReceipt = baseSource.replace(
      "generates: []\n",
      `generates: []\nadmission_receipt:\n  schema_version: v2\n  admitted_at: 2026-09-14T00:00:00.000Z\n  source_digest: ${sha("placeholder")}\n  decision_digest: ${sha("placeholder-decision")}\n  receipt_digest: ${sha("placeholder-receipt")}\n  binding:\n    path: ${f.manifest.source.path}\n    plan_id: ${f.manifest.plan_id}\n    asset_id: ${f.manifest.base.asset_id}\n    revision: 1\n    content_digest: ${sha("placeholder")}\n  route:\n    signal: forward\n    mode: forward\n`,
    );
    writeFileSync(join(f.root, f.manifest.source.path), withReceipt, "utf8");
    drift.headSource = withReceipt;
    f.manifest.source.content = withReceipt.replace("title: Base", "title: Revised");
    f.manifest.base.source_content_digest = sha(withReceipt);
    f.manifest.base.revision_digest = sha(canonicalPlanPayload(withReceipt).payload);

    expect(() => f.runner.run(f.input)).toThrow("plan-revision-rehydration-receipt-mismatch");
    expect(writeSet(f.db)).toEqual(f.before);
    expect(rows(f.db, "legacy_plan_bootstrap_provenance")).toBe(0);
  });

  it("U-PA-REV-056: admission_receiptがobjectでなければfallbackせずwrite 0でfail-closeする", () => {
    const drift: Drift = {};
    const f = fixture("legacy", drift);
    const baseSource = readFileSync(join(f.root, f.manifest.source.path), "utf8");
    const withReceipt = baseSource.replace(
      "generates: []\n",
      "generates: []\nadmission_receipt: not-an-object\n",
    );
    writeFileSync(join(f.root, f.manifest.source.path), withReceipt, "utf8");
    drift.headSource = withReceipt;
    f.manifest.source.content = withReceipt.replace("title: Base", "title: Revised");
    f.manifest.base.source_content_digest = sha(withReceipt);
    f.manifest.base.revision_digest = sha(canonicalPlanPayload(withReceipt).payload);

    expect(() => f.runner.run(f.input)).toThrow("plan-revision-rehydration-receipt-mismatch");
    expect(writeSet(f.db)).toEqual(f.before);
    expect(rows(f.db, "legacy_plan_bootstrap_provenance")).toBe(0);
  });

  it("U-PA-REV-049: 実データ regression — PLAN-L6-93のtracked terminal rev27からrev28を決定的に再水和する", () => {
    const f = realPlanL693RehydrationFixture();

    expect(f.runner.run(f.input)).toMatchObject({
      status: "created",
      receipt: { assetId: f.assetId, revision: 28 },
    });
    expect(
      f.db
        .prepare("SELECT revision FROM plan_revisions WHERE asset_id = ? ORDER BY revision")
        .all(f.assetId)
        .map((row) => Number(row.revision)),
    ).toEqual([27, 28]);
    expect(
      f.db
        .prepare("SELECT 1 FROM legacy_plan_bootstrap_provenance WHERE asset_id = ?")
        .get(f.assetId),
    ).toBeUndefined();
    expect(
      f.db
        .prepare(
          "SELECT 1 FROM sealed_plan_lineages WHERE historical_asset_id = ? OR successor_asset_id = ?",
        )
        .get(f.assetId, f.assetId),
    ).toBeUndefined();
  });

  it("U-PA-REV-057: 実データを正規 plan revise --manifest CLIへ接続しrev27からrev28を発行する", async () => {
    const f = realPlanL693RehydrationFixture();
    const manifestPath = join(f.root, "issue541-revise-manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(f.manifest)}\n`, "utf8");
    const output: string[] = [];
    const program = new Command();
    const plan = program.command("plan");
    registerPlanRevisionCommand(plan, {
      runner: f.runner,
      readText: (path) => readFileSync(path, "utf8"),
      writeOutput: (text) => output.push(text),
    });

    await program.parseAsync(["node", "ut-tdd", "plan", "revise", "--manifest", manifestPath]);

    const result = JSON.parse(output.join("")) as {
      ok: boolean;
      result?: { status: string; receipt?: { assetId: string; revision: number } };
      error?: string;
    };
    expect(result).toEqual({
      ok: true,
      result: {
        status: "created",
        receipt: expect.objectContaining({
          assetId: f.assetId,
          revision: 28,
        }),
      },
    });
    expect(result.error).toBeUndefined();
    expect(
      f.db
        .prepare("SELECT revision FROM plan_revisions WHERE asset_id = ? ORDER BY revision")
        .all(f.assetId)
        .map((row) => Number(row.revision)),
    ).toEqual([27, 28]);
    expect(
      f.db
        .prepare("SELECT 1 FROM legacy_plan_bootstrap_provenance WHERE asset_id = ?")
        .get(f.assetId),
    ).toBeUndefined();
    expect(
      f.db
        .prepare(
          "SELECT 1 FROM sealed_plan_lineages WHERE historical_asset_id = ? OR successor_asset_id = ?",
        )
        .get(f.assetId, f.assetId),
    ).toBeUndefined();
  });

  it("U-PA-REV-016: adopt済みNをN+1へ発行しpublisherへsource/projection CASを渡す", () => {
    const f = fixture("adopted");
    const stage = vi.spyOn(f.publisher, "stage");
    const result = f.runner.run(f.input);

    expect(result).toMatchObject({ status: "created", receipt: { revision: 2 } });
    expect(stage).toHaveBeenCalledWith([
      expect.objectContaining({
        path: f.manifest.source.path,
        expectedPreimage: { kind: "sha256", digest: f.manifest.base.source_content_digest },
      }),
      expect.objectContaining({
        path: f.manifest.projection.path,
        expectedPreimage: { kind: "sha256", digest: sha(f.oldProjection) },
      }),
    ]);
    expect(readFileSync(join(f.root, f.manifest.source.path), "utf8")).toContain("Revised");
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("U-PA-REV-017: ledger未採用legacy PLANをrev1 bootstrapとrev2で同時発行する", () => {
    const f = fixture("legacy");
    expect(f.runner.run(f.input)).toMatchObject({ status: "created", receipt: { revision: 2 } });
    expect(rows(f.db, "plan_assets")).toBe(1);
    expect(rows(f.db, "plan_revisions")).toBe(2);
    expect(rows(f.db, "plan_aliases")).toBe(1);
    expect(rows(f.db, "append_command_receipts")).toBe(1);
    const embedded = (
      parseLegacyPlanSource(readFileSync(join(f.root, f.manifest.source.path), "utf8"))?.frontmatter
        .admission_receipt as { binding?: { content_digest?: string } } | undefined
    )?.binding?.content_digest;
    const ledger = f.db.prepare("SELECT content_digest FROM plan_admission_receipts").get() as {
      content_digest: string;
    };
    const projection = JSON.parse(readFileSync(join(f.root, f.manifest.projection.path), "utf8"));
    expect(`sha256:${ledger.content_digest}`).toBe(embedded);
    expect(projection.records.at(-1).binding.content_digest).toBe(embedded);
    expect(revisionUsesLegacyBootstrap(f.db, f.manifest.base.asset_id, f.manifest.command_id)).toBe(
      true,
    );
    expect(
      revisionUsesLegacyBootstrap(f.db, f.manifest.base.asset_id, "command:next-revision"),
    ).toBe(false);
    const revisionTwo = f.db
      .prepare(
        "SELECT canonical_payload_digest FROM plan_revisions WHERE asset_id = ? AND revision = 2",
      )
      .get(f.manifest.base.asset_id) as { canonical_payload_digest: string };
    const next = new PlanRevisionLedgerTransaction(f.db).append({
      commandId: "command:next-revision",
      assetId: f.manifest.base.asset_id,
      planId: f.manifest.plan_id,
      baseRevision: 2,
      basePayloadDigest: revisionTwo.canonical_payload_digest,
      canonicalPayloadJson: '{"title":"revision three"}',
      contentDigest: sha("revision-three-content").slice(7),
      bodyDigest: sha("revision-three-body").slice(7),
      sourcePath: f.manifest.source.path,
      sourceCommit: f.manifest.base.source_commit,
      actor: f.manifest.actor,
      reason: "forward continuation",
      routeTupleDigest: sha("forward-continuation").slice(7),
      certificateId: "certificate:next",
      occurredAt: "2026-07-17T01:00:00.000Z",
    });
    expect(next).toMatchObject({ ok: true, revision: 3 });
    expect(
      revisionUsesLegacyBootstrap(f.db, f.manifest.base.asset_id, "command:next-revision"),
    ).toBe(false);
  });

  it.each([
    "adopted",
    "legacy",
  ] as const)("U-PA-REV-027: success後の%s same-commandは公開済みworking source/projectionを再変更せずreplayする", (mode) => {
    const f = fixture(mode);
    const created = f.runner.run(f.input);
    const publishedSource = readFileSync(join(f.root, f.manifest.source.path), "utf8");
    const publishedProjection = readFileSync(join(f.root, f.manifest.projection.path), "utf8");

    expect(f.runner.run(f.input)).toEqual({ status: "replayed", receipt: created.receipt });
    expect(readFileSync(join(f.root, f.manifest.source.path), "utf8")).toBe(publishedSource);
    expect(readFileSync(join(f.root, f.manifest.projection.path), "utf8")).toBe(
      publishedProjection,
    );
  });

  it("U-PA-REV-038: authoring actorはmanifestに束縛され環境actor再導出なしで正当replayできる", () => {
    const f = fixture("adopted");
    f.runner.run(f.input);

    expect(f.runner.run(f.input)).toMatchObject({ status: "replayed" });
  });

  it("U-PA-REV-030: committed replay時のworking projection欠落を拒否する", () => {
    const f = fixture("adopted");
    f.runner.run(f.input);
    rmSync(join(f.root, f.manifest.projection.path));

    expect(() => f.runner.run(f.input)).toThrow("plan-revision-replay-artifact-binding-invalid");
  });

  it("U-PA-REV-028: commit後にHEADがadvanceしてもdurable request/receipt/postimageからreplayを再証明する", () => {
    const drift: Drift = {};
    const f = fixture("adopted", drift);
    const created = f.runner.run(f.input);
    drift.sourceCommit = "e".repeat(40);
    drift.sourceBlobOid = "f".repeat(40);
    drift.headSource = "advanced HEAD";

    expect(f.runner.run(f.input)).toEqual({ status: "replayed", receipt: created.receipt });
  });

  it("U-PA-REV-031: committed replay前にrevision canonical digest改変をledger検証で拒否する", () => {
    const f = fixture("adopted");
    f.runner.run(f.input);
    tamperAppendOnly(f.db, "plan_revisions", () => {
      f.db
        .prepare(
          "UPDATE plan_revisions SET canonical_payload_digest = ? WHERE asset_id = ? AND revision = 2",
        )
        .run("0".repeat(64), f.manifest.base.asset_id);
    });

    expect(() => f.runner.run(f.input)).toThrow("plan-ledger-unavailable");
  });

  it("U-PA-REV-032: committed replay前にadmission content digest改変をledger検証で拒否する", () => {
    const f = fixture("adopted");
    f.runner.run(f.input);
    tamperAppendOnly(f.db, ["plan_admission_events", "plan_admission_receipts"], () => {
      f.db
        .prepare("UPDATE plan_admission_events SET content_digest = ? WHERE command_id = ?")
        .run("0".repeat(64), f.manifest.command_id);
    });

    expect(() => f.runner.run(f.input)).toThrow("plan-ledger-unavailable");
  });

  it("U-PA-REV-033: committed replayは再digest済みcertificate改変も全binding再証明で拒否する", () => {
    const f = fixture("adopted");
    f.runner.run(f.input);
    tamperAppendOnly(f.db, ["plan_admission_events", "plan_admission_receipts"], () => {
      const event = f.db
        .prepare("SELECT * FROM plan_admission_events WHERE command_id = ?")
        .get(f.manifest.command_id) as Record<string, unknown>;
      const changed = { ...event, certificate_digest: "0".repeat(64) };
      f.db
        .prepare(
          "UPDATE plan_admission_events SET certificate_digest = ?, event_digest = ? WHERE command_id = ?",
        )
        .run(
          changed.certificate_digest,
          ledgerRowDigest(changed, "event_digest"),
          f.manifest.command_id,
        );
      f.db
        .prepare("UPDATE plan_admission_receipts SET certificate_digest = ? WHERE command_id = ?")
        .run(changed.certificate_digest, f.manifest.command_id);
    });

    expect(() => f.runner.run(f.input)).toThrow("plan-revision-replay-certificate-conflict");
  });

  it("U-PA-REV-034: committed replayは再digest済みappend receipt改変も全binding再証明で拒否する", () => {
    const f = fixture("adopted");
    f.runner.run(f.input);
    tamperAppendOnly(f.db, "append_command_receipts", () => {
      const receipt = f.db
        .prepare("SELECT * FROM append_command_receipts WHERE command_id = ?")
        .get(f.manifest.command_id) as Record<string, unknown>;
      const changed = { ...receipt, recorded_at: "2026-07-17T00:00:01.000Z" };
      f.db
        .prepare(
          "UPDATE append_command_receipts SET recorded_at = ?, receipt_digest = ? WHERE command_id = ?",
        )
        .run(
          changed.recorded_at,
          ledgerRowDigest(changed, "receipt_digest"),
          f.manifest.command_id,
        );
    });

    expect(() => f.runner.run(f.input)).toThrow("plan-revision-replay-ledger-conflict");
  });

  it("U-PA-REV-035: committed replayは再digest済みadmission改変も全binding再証明で拒否する", () => {
    const f = fixture("adopted");
    f.runner.run(f.input);
    tamperAppendOnly(f.db, ["plan_admission_events", "plan_admission_receipts"], () => {
      const event = f.db
        .prepare("SELECT * FROM plan_admission_events WHERE command_id = ?")
        .get(f.manifest.command_id) as Record<string, unknown>;
      const changed = { ...event, route_tuple_digest: "0".repeat(64) };
      f.db
        .prepare(
          "UPDATE plan_admission_events SET route_tuple_digest = ?, event_digest = ? WHERE command_id = ?",
        )
        .run(
          changed.route_tuple_digest,
          ledgerRowDigest(changed, "event_digest"),
          f.manifest.command_id,
        );
      f.db
        .prepare("UPDATE plan_admission_receipts SET route_tuple_digest = ? WHERE command_id = ?")
        .run(changed.route_tuple_digest, f.manifest.command_id);
    });

    expect(() => f.runner.run(f.input)).toThrow("plan-revision-replay-ledger-conflict");
  });

  it("U-PA-REV-036: committed replayは保存済みactorを期待値に流用せずauthoring actor改変を拒否する", () => {
    const f = fixture("adopted");
    f.runner.run(f.input);
    tamperAppendOnly(f.db, "plan_revisions", () => {
      f.db
        .prepare("UPDATE plan_revisions SET actor = ? WHERE asset_id = ? AND revision = ?")
        .run("forged-actor", f.manifest.base.asset_id, 2);
    });

    expect(() => f.runner.run(f.input)).toThrow("plan-revision-replay-ledger-conflict");
  });

  it.each([
    "source",
    "projection",
  ] as const)("U-PA-REV-029: committed replay時のworking %s改変をdurable postimage CASで拒否する", (artifact) => {
    const f = fixture("adopted");
    f.runner.run(f.input);
    const path = artifact === "source" ? f.manifest.source.path : f.manifest.projection.path;
    writeFileSync(join(f.root, path), "external mutation", "utf8");

    expect(() => f.runner.run(f.input)).toThrow("plan-revision-replay-artifact-binding-invalid");
  });

  it("U-PA-REV-025: legacy manifestのasset IDがrepository identity由来でなければwrite 0", () => {
    const f = fixture("legacy", { forgedLegacyAssetId: "plan:legacy:forged" });
    expect(() => f.runner.run(f.input)).toThrow("plan-revision-legacy-asset-id-mismatch");
    expect(writeSet(f.db)).toEqual(f.before);
  });

  it("U-PA-REV-026: source frontmatterのplan_idがmanifestと異なればwrite 0", () => {
    const f = fixture("adopted", { revisedPlanId: "PLAN-L4-32" });
    expect(() => f.runner.run(f.input)).toThrow("plan-revision-source-plan-id-mismatch");
    expect(writeSet(f.db)).toEqual(f.before);
  });

  it.each([
    ["source commit", { sourceCommit: "e".repeat(40) }, "plan-revision-source-commit-drift"],
    ["source blob", { sourceBlobOid: "e".repeat(40) }, "plan-revision-source-blob-drift"],
    ["source content", { sourceText: "concurrent source" }, "plan-revision-source-content-drift"],
    ["HEAD source", { headSource: "different HEAD source" }, "plan-revision-head-content-drift"],
    [
      "projection tail",
      { projectionText: projectionWithDifferentValidTail() },
      "plan-revision-projection-tail-drift",
    ],
  ])("U-PA-REV-018: %s driftはwrite 0でfail-closeする", (_name, drift, ruleId) => {
    const f = fixture("adopted", drift);
    const before = writeSet(f.db);
    expect(() => f.runner.run(f.input)).toThrow(ruleId);
    expect(writeSet(f.db)).toEqual(before);
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("U-PA-REV-021: invalid projectionはtail fallbackせずwrite 0で拒否する", () => {
    const f = fixture("adopted", { projectionText: "not-json" });
    const before = writeSet(f.db);
    expect(() => f.runner.run(f.input)).toThrow("plan-revision-projection-invalid");
    expect(writeSet(f.db)).toEqual(before);
  });

  it("U-PA-REV-022: caller decisionと再評価結果の不一致はwrite 0で拒否する", () => {
    const f = fixture("adopted");
    const forged = { ...f.input, decision: { ...f.input.decision, issueRequired: false } };
    expect(() => f.runner.run(forged)).toThrow("plan-revision-admission-decision-mismatch");
    expect(writeSet(f.db)).toEqual(f.before);
  });

  it("U-PA-REV-023: manifestとcaller admissionの不一致はwrite 0で拒否する", () => {
    const f = fixture("adopted");
    const admission = { ...f.input.admission, escapeReason: "forged" };
    expect(() => f.runner.run({ ...f.input, admission })).toThrow(
      "plan-revision-manifest-admission-mismatch",
    );
    expect(writeSet(f.db)).toEqual(f.before);
  });

  it("U-PA-REV-024: repository identity未注入はpath由来へfallbackしない", () => {
    const f = fixture("legacy", { omitRepositoryIdentity: true });
    expect(() => f.runner.run(f.input)).toThrow("plan-revision-repository-identity-required");
    expect(writeSet(f.db)).toEqual(f.before);
  });

  it("U-PA-REV-019: active aliasの別asset束縛はwrite 0で拒否する", () => {
    const f = fixture("alias-mismatch");
    const before = writeSet(f.db);
    expect(() => f.runner.run(f.input)).toThrow("plan-revision-alias-binding-invalid");
    expect(writeSet(f.db)).toEqual(before);
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("U-PA-REV-020: publish失敗でもrollbackしてDBをcloseする", () => {
    const f = fixture("adopted");
    vi.spyOn(f.publisher, "publish").mockImplementation(() => {
      throw new Error("publish-failed");
    });
    const before = writeSet(f.db);
    expect(() => f.runner.run(f.input)).toThrow("publish-failed");
    expect(writeSet(f.db)).toEqual(before);
    expect(f.close).toHaveBeenCalledOnce();
  });
});

function tamperAppendOnly(
  db: ReturnType<typeof openHarnessDb>,
  tables: string | readonly string[],
  tamper: () => void,
): void {
  const targets = new Set(typeof tables === "string" ? [tables] : tables);
  const triggers = ledgerSchemaDdl().flatMap((sql) => {
    const name = /CREATE TRIGGER(?:\s+IF NOT EXISTS)?\s+(\w+)/i.exec(sql)?.[1];
    const table = /BEFORE\s+(?:UPDATE|DELETE)\s+ON\s+(\w+)/i.exec(sql)?.[1];
    return name && table && targets.has(table) ? [{ name, sql }] : [];
  });
  if (triggers.length === 0) throw new Error(`fixture triggers missing: ${[...targets].join(",")}`);
  for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
  try {
    tamper();
  } finally {
    for (const trigger of triggers) db.exec(trigger.sql);
  }
}

type Mode = "adopted" | "legacy" | "alias-mismatch";
type Drift = Partial<{
  sourceCommit: string;
  sourceBlobOid: string;
  sourceText: string;
  projectionText: string;
  headSource: string;
  omitRepositoryIdentity: boolean;
  forgedLegacyAssetId: string;
  revisedPlanId: string;
}>;

function fixture(mode: Mode, drift: Drift = {}) {
  const root = join(tmpdir(), `ut-tdd-plan-revision-runner-${process.pid}-${roots.length}`);
  roots.push(root);
  mkdirSync(join(root, "docs", "plans"), { recursive: true });
  mkdirSync(join(root, "docs", "governance"), { recursive: true });
  const planId = "PLAN-L6-31";
  const sourcePath = `docs/plans/${planId}.md`;
  const projectionPath = "docs/governance/plan-admission-receipts.json" as const;
  const oldSource = `---\nplan_id: ${planId}\ntitle: Base\nkind: design\ndrive: agent\nstatus: confirmed\nlayer: L6\nsub_doc: function-spec\nroute_signal: forward\nroute_mode: forward\nsupersedes:\n  - ${planId}\nagent_slots:\n  - role: aim\n    slot_label: AIM - revision fixture\ngenerates: []\ndependencies:\n  parent: null\n  requires: []\n  references: []\n  blocks: []\n---\n\n# Base\n`;
  const oldProjection = '{"schema_version":"ut-tdd.plan-admission-receipts/v1","records":[]}\n';
  writeFileSync(join(root, sourcePath), drift.sourceText ?? oldSource, "utf8");
  writeFileSync(join(root, projectionPath), drift.projectionText ?? oldProjection, "utf8");
  const sourceCommit = "a".repeat(40);
  const sourceBlobOid = "b".repeat(40);
  const assetId =
    mode === "legacy"
      ? (drift.forgedLegacyAssetId ?? deriveLegacyAssetId("repo:test", planId))
      : "plan:adopted";
  const basePayload = canonicalPlanPayload(oldSource).payload;
  const admission: PlanAdmissionRequest = {
    routeSignal: "design_correction",
    routeMode: "redesign",
    kind: "design",
    layer: "L6",
    subDoc: "function-spec",
    drive: "agent",
    branch: "work/redesign-plan-31",
    status: "draft",
    issue: {
      provider: "github",
      issueId: 102,
      episodeId: "E4-102",
      projectionDigest: sha("issue"),
    },
    origin: { planId, revision: 1, digest: sha(basePayload) },
    transitionDirection: "design_to_implementation",
    implementationDisposition: "discarded",
    reentry: { targetPlanId: planId, targetRevision: 2, phase: "forward_merge" },
    implementationTarget: { targetPlanId: "PLAN-L7-31", targetRevision: 1 },
    escapeReason: "design replacement",
    supersedes: [planId],
  };
  const decision = evaluatePlanAdmission(admission);
  if (!decision.ok) throw new Error(`fixture admission invalid: ${decision.violations.join(",")}`);
  const manifest: PlanRevisionManifest = {
    version: 1,
    command_id: "command:revise-node-31",
    plan_id: planId,
    actor: "codex",
    recorded_at: "2026-07-17T00:00:00.000Z",
    base: {
      asset_id: assetId,
      revision: 1,
      revision_digest: sha(basePayload),
      source_commit: sourceCommit,
      source_blob_oid: sourceBlobOid,
      source_content_digest: sha(oldSource),
      projection_tail_digest: sha("null"),
    },
    admission: {
      route_signal: admission.routeSignal,
      route_mode: admission.routeMode,
      kind: admission.kind,
      layer: admission.layer,
      sub_doc: "function-spec",
      drive: admission.drive,
      branch: admission.branch,
      status: admission.status,
      issue: {
        provider: "github",
        issue_id: 102,
        episode_id: "E4-102",
        projection_digest: sha("issue"),
      },
      origin: { plan_id: planId, revision: 1, digest: sha(basePayload) },
      transition_direction: "design_to_implementation",
      implementation_disposition: "discarded",
      reentry: { target_plan_id: planId, target_revision: 2, phase: "forward_merge" },
      implementation_target: { target_plan_id: "PLAN-L7-31", target_revision: 1 },
      escape_reason: "design replacement",
      supersedes: [planId],
    },
    source: {
      path: sourcePath,
      content: oldSource
        .replace(`plan_id: ${planId}`, `plan_id: ${drift.revisedPlanId ?? planId}`)
        .replace("title: Base", "title: Revised"),
    },
    projection: { path: projectionPath },
  };
  const db = openHarnessDb(":memory:");
  expect(migratePlanLedger(db)).toEqual({ ok: true, version: 7 });
  if (mode !== "legacy") seedAdopted(db, assetId, planId, basePayload, mode === "alias-mismatch");
  // close境界の呼出しを観測しつつ、write-set assertionまではin-memory DBを保持する。
  const close = vi.spyOn(db, "close").mockImplementation(() => undefined);
  const publisher = new NodeAtomicDraftPublisher({ rootDir: root });
  const runner = new NodePlanRevisionRunner({
    repoRoot: root,
    sourceCommit: () => drift.sourceCommit ?? sourceCommit,
    sourceBlobOid: (commit) =>
      commit === (drift.sourceCommit ?? sourceCommit)
        ? (drift.sourceBlobOid ?? sourceBlobOid)
        : sourceBlobOid,
    readText: (path: string) => readFileSync(path, "utf8"),
    headText: (commit) =>
      commit === (drift.sourceCommit ?? sourceCommit) ? (drift.headSource ?? oldSource) : oldSource,
    ...(drift.omitRepositoryIdentity ? {} : { repositoryIdentity: () => "repo:test" }),
    openDb: () => db,
    publisher: () => publisher,
  });
  const before = writeSet(db);
  return {
    root,
    db,
    close,
    publisher,
    runner,
    manifest,
    oldProjection,
    before,
    input: { manifest, admission, decision },
  };
}

function rehydrationFixture(
  tamperBodyMarker?: string,
  options: { legacyPrefixed?: boolean; forcedAssetId?: string } = {},
) {
  const drift: Drift = {
    forgedLegacyAssetId:
      options.forcedAssetId ??
      (options.legacyPrefixed ? deriveLegacyAssetId("repo:test", "PLAN-L6-31") : "plan:rehydrated"),
  };
  const f = fixture("legacy", drift);
  const receiptFreeSource = readFileSync(join(f.root, f.manifest.source.path), "utf8");
  const contentDigest = canonicalPlanContentDigest(receiptFreeSource);
  if (!contentDigest) throw new Error("rehydration fixture source invalid");
  const baseSource = receiptFreeSource.replace(
    "generates: []\n",
    `generates: []\nadmission_receipt:\n  schema_version: v2\n  receipt_id: certificate:rehydration-terminal-7\n  command_id: plan-revise:issue-596:terminal:7\n  admitted_at: 2026-09-14T00:00:00.000Z\n  source_digest: ${contentDigest}\n  decision_digest: ${sha("rehydration-terminal-decision")}\n  receipt_digest: ${sha("rehydration-terminal-receipt")}\n  binding:\n    path: ${f.manifest.source.path}\n    plan_id: ${f.manifest.plan_id}\n    asset_id: ${f.manifest.base.asset_id}\n    revision: 7\n    content_digest: ${contentDigest}\n  route:\n    signal: forward\n    mode: forward\n`,
  );
  writeFileSync(join(f.root, f.manifest.source.path), baseSource, "utf8");
  drift.headSource = baseSource;
  const record = {
    sequence: 1,
    previousRecordDigest: null,
    commandId: "plan-revise:issue-596:terminal:7",
    receiptId: "certificate:rehydration-terminal-7",
    receiptDigest: sha("rehydration-terminal-receipt"),
    decisionDigest: sha("rehydration-terminal-decision"),
    binding: {
      path: f.manifest.source.path,
      planId: f.manifest.plan_id,
      assetId: f.manifest.base.asset_id,
      revision: 7,
      contentDigest,
    },
  };
  const recordDigest = trackedReceiptRecordDigest(record);
  writeFileSync(
    join(f.root, f.manifest.projection.path),
    `${JSON.stringify({
      schema_version: "ut-tdd.plan-admission-receipts/v1",
      records: [
        {
          sequence: record.sequence,
          previous_record_digest: record.previousRecordDigest,
          record_digest: recordDigest,
          command_id: record.commandId,
          receipt_id: record.receiptId,
          receipt_digest: record.receiptDigest,
          decision_digest: record.decisionDigest,
          binding: {
            path: record.binding.path,
            plan_id: record.binding.planId,
            asset_id: record.binding.assetId,
            revision: record.binding.revision,
            content_digest: record.binding.contentDigest,
          },
        },
      ],
    })}\n`,
    "utf8",
  );
  f.manifest.base.revision = 7;
  const parsedPayload = JSON.parse(canonicalPlanPayload(baseSource).payload);
  delete parsedPayload.admission_receipt;
  f.manifest.base.revision_digest = sha(stableJsonForTest(parsedPayload));
  f.manifest.base.projection_tail_digest = recordDigest;
  f.manifest.source.content = baseSource.replace("title: Base", "title: Revised");

  // tamperBodyMarker: HEAD advanced *after* the receipt was minted, without a
  // matching new revision (real-world drift, cf. U-PA-REV-049's historical
  // blob lookup). The embedded receipt / projection record keep declaring the
  // original (real) content digest, but recomputing canonicalPlanContentDigest
  // from the now-tampered body no longer matches it — this is the correct
  // fixture shape for the content-digest-mismatch oracle under rev 5 (the
  // embedded-receipt<->record match itself must still succeed).
  const effectiveSource = tamperBodyMarker
    ? `${baseSource}\n<!-- ${tamperBodyMarker} -->\n`
    : baseSource;
  if (tamperBodyMarker) {
    writeFileSync(join(f.root, f.manifest.source.path), effectiveSource, "utf8");
    drift.headSource = effectiveSource;
  }
  f.manifest.base.source_content_digest = sha(effectiveSource);
  return { ...f, drift, baseSource: effectiveSource };
}

/**
 * Issue #541 実データ regression: mainのPLAN-L6-93 tracked terminal receipt (rev27)
 * とdocs/governance/plan-admission-receipts.jsonの実projectionをfixtureへコピーし
 * (実ファイルの読み取りのみ、mainの当該ファイルは書き換えない)、空ledgerからrev28を
 * 決定的に再水和できることを検証する。base sourceは、rev27 admission_receiptの
 * content_digestへ一致する実際のGit blob (履歴commit) から採る。
 */
function realPlanL693RehydrationFixture() {
  const root = join(tmpdir(), `ut-tdd-plan-revision-runner-real-${process.pid}-${roots.length}`);
  roots.push(root);
  mkdirSync(join(root, "docs", "plans"), { recursive: true });
  mkdirSync(join(root, "docs", "governance"), { recursive: true });
  const planId = "PLAN-L6-93-node-bootstrap-contract";
  const sourcePath = `docs/plans/${planId}.md`;
  const projectionPath = "docs/governance/plan-admission-receipts.json" as const;
  const assetId = "plan:legacy:80a50dd958ae451ea13030276eb8c145a8fdc3104ec145560457f97a07594881";
  // 実プロジェクトルートで、rev27 receiptのcontent_digestが指す実Git blob (historical
  // commit) を読み取る。現HEADの当該ファイルはrev27より後にreceiptを介さず改稿されており
  // (実測: canonicalPlanContentDigestがrev27の記録値と不一致)、rev27の正しいbase sourceは
  // このhistorical blobである。
  const historicalCommit = "d3c0df76e7cdba6dd0dbe51103028428ef9db37f";
  const baseSource = execFileSync("git", ["show", `${historicalCommit}:${sourcePath}`], {
    encoding: "utf8",
    cwd: process.cwd(),
  });
  const sourceBlobOid = execFileSync("git", ["rev-parse", `${historicalCommit}:${sourcePath}`], {
    encoding: "utf8",
    cwd: process.cwd(),
  }).trim();
  // projectionも作業木ではなく、terminal receiptがrev27だった時点のcommitから読む。
  // 作業木の現行projectionはPLAN-L6-93の正規revise (rev28以降) で伸びるため、
  // それを読むとこのfixtureの前提が壊れる (実測: PR #612 のrev28/29追記で赤化)。
  const projectionCommit = "85ae4af7d8e291e2a8f1b568c7de8f286c571837";
  const realProjectionText = execFileSync(
    "git",
    ["show", `${projectionCommit}:${projectionPath}`],
    {
      encoding: "utf8",
      cwd: process.cwd(),
    },
  );
  const projection = JSON.parse(realProjectionText) as {
    records: ReadonlyArray<{
      record_digest: string;
      binding: { asset_id: string; revision: number };
    }>;
  };
  const terminal = projection.records
    .filter((record) => record.binding.asset_id === assetId)
    .reduce((max, record) => (record.binding.revision > max.binding.revision ? record : max));
  if (terminal.binding.revision !== 27)
    throw new Error(
      `fixture assumption drifted: terminal revision is ${terminal.binding.revision}`,
    );
  const tailRecordDigest = projection.records.at(-1)?.record_digest;
  if (!tailRecordDigest) throw new Error("real projection has no tail record");

  writeFileSync(join(root, sourcePath), baseSource, "utf8");
  writeFileSync(join(root, projectionPath), realProjectionText, "utf8");

  const parsed = parseLegacyPlanSource(baseSource);
  if (!parsed) throw new Error("real PLAN-L6-93 historical blob failed to parse");
  const receiptFreeFrontmatter = { ...parsed.frontmatter };
  delete receiptFreeFrontmatter.admission_receipt;
  const canonicalPayload = productionStableJson(receiptFreeFrontmatter);
  const revisionDigest = sha(canonicalPayload);

  const revisedSource = baseSource.replace(
    'title: "PLAN-L6-93: sealed Node bootstrap function redesign"',
    'title: "PLAN-L6-93: sealed Node bootstrap function redesign (issue541 regression fixture)"',
  );
  if (revisedSource === baseSource) throw new Error("fixture revision anchor missing");

  const admission: PlanAdmissionRequest = {
    routeSignal: "feature_addition",
    routeMode: "add-feature",
    kind: "add-design",
    layer: "L6",
    subDoc: "function-spec",
    drive: "fullstack",
    branch: "work/add-feature-issue541-rehydrate-legacy-impl",
    status: "draft",
    issue: {
      provider: "github",
      issueId: 541,
      episodeId: "E4-541-rehydrate-legacy",
      projectionDigest: sha("issue541-real-fixture"),
    },
    origin: { planId, revision: 27, digest: revisionDigest },
    transitionDirection: "design_to_implementation",
    implementationDisposition: "none",
    reentry: { targetPlanId: planId, targetRevision: 28, phase: "forward_merge" },
    escapeReason: "regression fixture for issue #541 legacy rehydration, no production activation",
  };
  const decision = evaluatePlanAdmission(admission);
  if (!decision.ok)
    throw new Error(`real fixture admission invalid: ${decision.violations.join(",")}`);
  const manifest: PlanRevisionManifest = {
    version: 1,
    command_id: "command:issue541-real-rehydration-regression",
    plan_id: planId,
    actor: "codex",
    recorded_at: "2026-09-15T00:00:00.000Z",
    base: {
      asset_id: assetId,
      revision: 27,
      revision_digest: revisionDigest,
      source_commit: historicalCommit,
      source_blob_oid: sourceBlobOid,
      source_content_digest: sha(baseSource),
      projection_tail_digest: tailRecordDigest,
    },
    admission: {
      route_signal: admission.routeSignal,
      route_mode: admission.routeMode,
      kind: admission.kind,
      layer: admission.layer,
      sub_doc: "function-spec",
      drive: admission.drive,
      branch: admission.branch,
      status: admission.status,
      issue: {
        provider: "github",
        issue_id: 541,
        episode_id: "E4-541-rehydrate-legacy",
        projection_digest: sha("issue541-real-fixture"),
      },
      origin: { plan_id: planId, revision: 27, digest: revisionDigest },
      transition_direction: "design_to_implementation",
      implementation_disposition: "none",
      reentry: { target_plan_id: planId, target_revision: 28, phase: "forward_merge" },
      escape_reason:
        "regression fixture for issue #541 legacy rehydration, no production activation",
    },
    source: { path: sourcePath, content: revisedSource },
    projection: { path: projectionPath },
  };
  const db = openHarnessDb(":memory:");
  expect(migratePlanLedger(db)).toEqual({ ok: true, version: 7 });
  vi.spyOn(db, "close").mockImplementation(() => undefined);
  const publisher = new NodeAtomicDraftPublisher({ rootDir: root });
  const runner = new NodePlanRevisionRunner({
    repoRoot: root,
    sourceCommit: () => historicalCommit,
    sourceBlobOid: (commit) => (commit === historicalCommit ? sourceBlobOid : "mismatched"),
    readText: (path: string) => readFileSync(path, "utf8"),
    headText: (commit) => (commit === historicalCommit ? baseSource : "mismatched"),
    repositoryIdentity: () => "repo:issue541-real-fixture",
    openDb: () => db,
    publisher: () => publisher,
  });
  return { root, db, assetId, runner, manifest, input: { manifest, admission, decision } };
}

/**
 * Issue #541 rev5 lineage-ambiguity oracle: rehydrationFixtureが埋め込んだterminal
 * receiptと同じplan_id/pathへ、より新しいsequenceのrecordを (別assetとして) 追加する。
 * 再水和対象はembedded receiptと完全一致するrecordであっても、同じplan_id/pathに
 * それより新しいsequenceのrecordがあれば、stale lineageの再水和としてfail-closeしな
 * ければならない。
 */
function appendNewerLineageRecord(f: ReturnType<typeof rehydrationFixture>): void {
  const current = JSON.parse(readFileSync(join(f.root, f.manifest.projection.path), "utf8")) as {
    schema_version: string;
    records: Array<Record<string, unknown>>;
  };
  const priorTerminal = current.records.at(-1) as { sequence: number; record_digest: string };
  const newerRecord = {
    sequence: priorTerminal.sequence + 1,
    previousRecordDigest: priorTerminal.record_digest,
    commandId: "plan-revise:issue-596:terminal:8-superseding",
    receiptId: "certificate:rehydration-terminal-8-superseding",
    receiptDigest: sha("newer-lineage-receipt"),
    decisionDigest: sha("newer-lineage-decision"),
    binding: {
      path: f.manifest.source.path,
      planId: f.manifest.plan_id,
      assetId: "plan:superseding-lineage",
      revision: 1,
      contentDigest: sha("newer-lineage-content"),
    },
  };
  const recordDigest = trackedReceiptRecordDigest(newerRecord);
  current.records.push({
    sequence: newerRecord.sequence,
    previous_record_digest: newerRecord.previousRecordDigest,
    record_digest: recordDigest,
    command_id: newerRecord.commandId,
    receipt_id: newerRecord.receiptId,
    receipt_digest: newerRecord.receiptDigest,
    decision_digest: newerRecord.decisionDigest,
    binding: {
      path: newerRecord.binding.path,
      plan_id: newerRecord.binding.planId,
      asset_id: newerRecord.binding.assetId,
      revision: newerRecord.binding.revision,
      content_digest: newerRecord.binding.contentDigest,
    },
  });
  writeFileSync(join(f.root, f.manifest.projection.path), `${JSON.stringify(current)}\n`, "utf8");
  f.manifest.base.projection_tail_digest = recordDigest;
}

function rawSha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function rewriteProjection(
  f: ReturnType<typeof rehydrationFixture>,
  bindingOverrides: readonly Record<string, unknown>[],
  preserveFinalReceiptIdentity = false,
): void {
  const current = JSON.parse(readFileSync(join(f.root, f.manifest.projection.path), "utf8"))
    .records[0];
  let previousRecordDigest: string | null = null;
  const records = bindingOverrides.map((overrides, index) => {
    const preserveReceiptIdentity =
      preserveFinalReceiptIdentity && index === bindingOverrides.length - 1;
    const record = {
      sequence: index + 1,
      previousRecordDigest,
      commandId: preserveReceiptIdentity ? current.command_id : `${current.command_id}:${index}`,
      receiptId: preserveReceiptIdentity ? current.receipt_id : `${current.receipt_id}:${index}`,
      receiptDigest: current.receipt_digest,
      decisionDigest: current.decision_digest,
      binding: {
        path: current.binding.path,
        planId: current.binding.plan_id,
        assetId: current.binding.asset_id,
        revision: current.binding.revision,
        contentDigest: current.binding.content_digest,
        ...toCamelBinding(overrides),
      },
    };
    const recordDigest = trackedReceiptRecordDigest(record);
    previousRecordDigest = recordDigest;
    return {
      sequence: record.sequence,
      previous_record_digest: record.previousRecordDigest,
      record_digest: recordDigest,
      command_id: record.commandId,
      receipt_id: record.receiptId,
      receipt_digest: record.receiptDigest,
      decision_digest: record.decisionDigest,
      binding: {
        path: record.binding.path,
        plan_id: record.binding.planId,
        asset_id: record.binding.assetId,
        revision: record.binding.revision,
        content_digest: record.binding.contentDigest,
      },
    };
  });
  const projection = `${JSON.stringify({
    schema_version: "ut-tdd.plan-admission-receipts/v1",
    records,
  })}\n`;
  writeFileSync(join(f.root, f.manifest.projection.path), projection, "utf8");
  f.manifest.base.projection_tail_digest = previousRecordDigest ?? sha("null");
}

function toCamelBinding(value: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(value.path === undefined ? {} : { path: value.path }),
    ...(value.plan_id === undefined ? {} : { planId: value.plan_id }),
    ...(value.asset_id === undefined ? {} : { assetId: value.asset_id }),
    ...(value.revision === undefined ? {} : { revision: value.revision }),
    ...(value.content_digest === undefined ? {} : { contentDigest: value.content_digest }),
  };
}

function projectionWithDifferentValidTail(): string {
  const record = {
    sequence: 1,
    previousRecordDigest: null,
    commandId: "command:concurrent-revision",
    receiptId: "receipt:concurrent-revision",
    receiptDigest: sha("concurrent-receipt"),
    decisionDigest: sha("concurrent-decision"),
    binding: {
      path: "docs/plans/PLAN-L6-31.md",
      planId: "PLAN-L6-31",
      assetId: "plan:adopted",
      revision: 2,
      contentDigest: sha("concurrent-content"),
    },
  };
  return `${JSON.stringify({
    schema_version: "ut-tdd.plan-admission-receipts/v1",
    records: [
      {
        sequence: record.sequence,
        previous_record_digest: record.previousRecordDigest,
        record_digest: trackedReceiptRecordDigest(record),
        command_id: record.commandId,
        receipt_id: record.receiptId,
        receipt_digest: record.receiptDigest,
        decision_digest: record.decisionDigest,
        binding: {
          path: record.binding.path,
          plan_id: record.binding.planId,
          asset_id: record.binding.assetId,
          revision: record.binding.revision,
          content_digest: record.binding.contentDigest,
        },
      },
    ],
  })}\n`;
}

function seedAdopted(
  db: ReturnType<typeof openHarnessDb>,
  assetId: string,
  planId: string,
  payload: string,
  mismatch: boolean,
) {
  const bound = mismatch ? "plan:other" : assetId;
  db.prepare("INSERT INTO plan_assets VALUES (?, ?, ?, ?)").run(
    assetId,
    "2026-07-15T00:00:00.000Z",
    "a".repeat(40),
    "legacy-adopt-v1",
  );
  if (mismatch)
    db.prepare("INSERT INTO plan_assets VALUES (?, ?, ?, ?)").run(
      bound,
      "2026-07-15T00:00:00.000Z",
      "a".repeat(40),
      "legacy-adopt-v1",
    );
  db.prepare("INSERT INTO plan_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    assetId,
    1,
    payload,
    sha(payload).slice(7),
    sha("body").slice(7),
    `docs/plans/${planId}.md`,
    "a".repeat(40),
    "migration",
    "adopt",
    "2026-07-15T00:00:00.000Z",
  );
  if (mismatch)
    db.prepare("INSERT INTO plan_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      bound,
      1,
      payload,
      sha(payload).slice(7),
      sha("other-body").slice(7),
      `docs/plans/${planId}.md`,
      "a".repeat(40),
      "migration",
      "adopt",
      "2026-07-15T00:00:00.000Z",
    );
  const aliasEvent = {
    alias_event_id: `alias-event:${bound}:1`,
    asset_id: bound,
    sequence: 1,
    command_id: `command:alias:${bound}:1`,
    command_payload_digest: sha(`alias-command:${bound}`),
    event_kind: "assigned",
    alias: planId,
    revision: 1,
    reason: "adopt",
    occurred_at: "2026-07-15T00:00:00.000Z",
  };
  const aliasEventDigest = ledgerRowDigest(aliasEvent, "event_digest");
  db.prepare("INSERT INTO plan_alias_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    ...Object.values(aliasEvent),
    aliasEventDigest,
  );
  db.prepare("INSERT INTO plan_aliases VALUES (?, ?, ?, ?, ?, ?)").run(
    planId,
    bound,
    planId,
    1,
    null,
    aliasEventDigest,
  );
}

function rows(db: ReturnType<typeof openHarnessDb>, table: string) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
}
function writeSet(db: ReturnType<typeof openHarnessDb>) {
  return [
    "plan_assets",
    "plan_revisions",
    "plan_alias_events",
    "plan_aliases",
    "plan_admission_events",
    "plan_admission_receipts",
    "append_command_receipts",
  ].map((table) => rows(db, table));
}
function sha(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableJsonForTest(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonForTest).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJsonForTest(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
