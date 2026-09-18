import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { calculatePlanDraftCommandDigests } from "../kernel/plan-draft-command-digest.ts";
import { parseLegacyPlanSource } from "../plan-asset/adapters/legacy-plan-inventory.ts";
import { PlanDraftLedgerTransaction } from "../plan-asset/ledger/plan-draft-ledger.ts";
import { openPlanLedger } from "../plan-asset/ledger/schema.ts";
import { parseReservablePlanIdIdentity, planIdMatchesShape } from "../schema/plan-id.ts";
import { NodeAtomicDraftPublisher } from "./node-atomic-draft-publisher.ts";
import {
  assemblePlanDraftCommand,
  type DraftManifestV2,
  type PlanDraftEnvironmentSnapshot,
  type PlanDraftExecutionPayload,
} from "./plan-draft-command-assembler.ts";
import {
  PlanDraftLedgerAdapter,
  type PlanDraftLedgerReceipt,
} from "./plan-draft-ledger-adapter.ts";
import { type DraftReceiptBinding, PlanDraftService } from "./plan-draft-service.ts";
import { evaluatePlanAdmission, type PlanAdmissionRequest } from "./policy.ts";
import { SqliteDraftJournal } from "./sqlite-draft-journal.ts";
import { TrackedReceiptRenderer } from "./tracked-receipt-renderer.ts";

export interface NodePlanDraftRunnerDeps {
  readonly repoRoot: string;
  readonly sourceCommit: () => string;
  readonly actor: () => string;
  readonly readText: (path: string) => string;
}

/** CLI resource scope: ledger DBを一回のcommandに閉じ、成功・失敗の双方でcloseする。 */
export class NodePlanDraftRunner {
  private readonly deps: NodePlanDraftRunnerDeps;

  constructor(deps: NodePlanDraftRunnerDeps) {
    this.deps = deps;
  }

  run(input: {
    manifest: DraftManifestV2;
    admission: PlanAdmissionRequest;
    decision: Extract<ReturnType<typeof evaluatePlanAdmission>, { ok: true }>;
  }) {
    const environment = buildEnvironment(input, this.deps);
    const { command } = assemblePlanDraftCommand({ ...input, environment });
    const db = openPlanLedger({ repoRoot: this.deps.repoRoot });
    try {
      const ledger = new PlanDraftLedgerAdapter(new PlanDraftLedgerTransaction(db));
      const renderer = new TrackedReceiptRenderer({
        read: (path) => this.deps.readText(resolveRepoPath(this.deps.repoRoot, path)),
      });
      const service = new PlanDraftService<PlanDraftExecutionPayload, DraftReceiptBinding>({
        validator: {
          validate: (candidate) =>
            validateCommand(candidate.payload, candidate.commandPayloadDigest),
        },
        journal: new SqliteDraftJournal(db),
        publisher: new NodeAtomicDraftPublisher({ rootDir: this.deps.repoRoot }),
        renderer: {
          render: (candidate, receipt) => renderer.render(candidate, requireLedgerReceipt(receipt)),
        },
        ledger: {
          transact: (candidate, onPrepared) => ledger.transact(candidate, onPrepared),
        },
      });
      return service.execute(command);
    } finally {
      db.close();
    }
  }
}

export function createNodePlanDraftRunner(repoRoot: string): NodePlanDraftRunner {
  return new NodePlanDraftRunner({
    repoRoot,
    sourceCommit: () =>
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
    actor: () => {
      try {
        return (
          execFileSync("git", ["config", "user.name"], {
            cwd: repoRoot,
            encoding: "utf8",
          }).trim() || "ut-tdd"
        );
      } catch {
        return "ut-tdd";
      }
    },
    readText: (path) => readFileSync(path, "utf8"),
  });
}

function buildEnvironment(
  input: {
    manifest: DraftManifestV2;
    admission: PlanAdmissionRequest;
    decision: Extract<ReturnType<typeof evaluatePlanAdmission>, { ok: true }>;
  },
  deps: NodePlanDraftRunnerDeps,
): PlanDraftEnvironmentSnapshot {
  const parsed = parseLegacyPlanSource(input.manifest.source.content);
  if (!parsed) throw new Error("plan-draft-source-invalid");
  const identity = parseReservablePlanIdIdentity(input.manifest.plan_id);
  if (!identity) throw new Error("plan-draft-plan-id-invalid");
  if (!planIdMatchesShape(identity, input.admission))
    throw new Error("plan-draft-source-admission-mismatch");
  const canonicalDecision = evaluatePlanAdmission(input.admission);
  if (!canonicalDecision.ok) throw new Error("plan-draft-admission-invalid");
  const sourceCommit = deps.sourceCommit();
  const seed = sha256(
    stableJson({
      commandId: input.manifest.command_id,
      planId: input.manifest.plan_id,
      sourceCommit,
    }),
  );
  const occurredAt = Date.parse(input.manifest.recorded_at);
  if (!Number.isFinite(occurredAt)) throw new Error("plan-draft-recorded-at-invalid");
  return {
    assetId: `plan:${seed.slice(0, 32)}`,
    reservationId: `reservation:${seed.slice(0, 32)}`,
    certificateId: `certificate:${seed.slice(0, 32)}`,
    namespace: identity.namespace,
    ordinal: identity.ordinal,
    sourceCommit,
    actor: deps.actor(),
    reason: input.admission.escapeReason ?? `route:${input.admission.routeSignal}`,
    identityAlgorithm: "sha256-v1",
    bodyDigest: sha256(parsed.body),
    routeTupleDigest: sha256(
      stableJson({ admission: input.admission, decision: canonicalDecision }),
    ),
    leaseTokenHash: sha256(`lease:${input.manifest.command_id}:${seed}`),
    expiresAt: new Date(occurredAt + 24 * 60 * 60 * 1000).toISOString(),
  };
}

function validateCommand(payload: PlanDraftExecutionPayload, digest: string): void {
  const decision = evaluatePlanAdmission(payload.admission);
  if (!decision.ok) throw new Error("plan-draft-admission-invalid");
  const expected = calculatePlanDraftCommandDigests(payload.canonical).commandPayloadDigest;
  if (digest !== expected) throw new Error("plan-draft-command-digest-invalid");
}

function requireLedgerReceipt(receipt: DraftReceiptBinding): PlanDraftLedgerReceipt {
  if (!("certificateDigest" in receipt) || typeof receipt.certificateDigest !== "string")
    throw new Error("plan-draft-ledger-receipt-incomplete");
  return receipt as PlanDraftLedgerReceipt;
}

function resolveRepoPath(repoRoot: string, path: string): string {
  const normalizedRoot = repoRoot.replaceAll("\\", "/").replace(/\/$/, "");
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").includes(".."))
    throw new Error("plan-draft-path-invalid");
  return `${normalizedRoot}/${normalized}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
