import { timingSafeEqual } from "node:crypto";
import { calculatePlanDraftCommandDigests } from "../kernel/plan-draft-command-digest.ts";
import type { PlanDraftLedgerTransaction } from "../plan-asset/ledger/plan-draft-ledger.ts";
import type { PlanDraftExecutionPayload } from "./plan-draft-command-assembler.ts";
import type {
  DraftLedgerPort,
  DraftReceiptBinding,
  PlanDraftCommand,
} from "./plan-draft-service.ts";

/** Saga が journal・artifact と結合するために必要な永続 receipt。 */
export interface PlanDraftLedgerReceipt extends DraftReceiptBinding {
  readonly certificateDigest: string;
}

export class PlanDraftLedgerRejectedError extends Error {
  readonly ruleId: string;

  constructor(ruleId: string) {
    super(`PLAN draft ledgerが起票を拒否しました: ${ruleId}`);
    this.ruleId = ruleId;
    this.name = "PlanDraftLedgerRejectedError";
  }
}

export class PlanDraftLedgerDigestMismatchError extends Error {
  constructor(stage: "command" | "receipt") {
    super(`PLAN draft ledgerの${stage} digestがcanonical payloadと一致しません`);
    this.name = "PlanDraftLedgerDigestMismatchError";
  }
}

/** Domain commandを自己申告digestから隔離してledger transactionへ接続する。 */
export class PlanDraftLedgerAdapter
  implements DraftLedgerPort<PlanDraftExecutionPayload, PlanDraftLedgerReceipt>
{
  private readonly ledger: PlanDraftLedgerTransaction;

  constructor(ledger: PlanDraftLedgerTransaction) {
    this.ledger = ledger;
  }

  transact(
    command: PlanDraftCommand<PlanDraftExecutionPayload>,
    onPrepared: (receipt: PlanDraftLedgerReceipt) => void,
  ): PlanDraftLedgerReceipt {
    const expected = calculatePlanDraftCommandDigests(
      command.payload.canonical,
    ).commandPayloadDigest;
    if (!secureEqual(command.commandPayloadDigest, expected)) {
      throw new PlanDraftLedgerDigestMismatchError("command");
    }

    const result = this.ledger.transact(command.payload.canonical, (prepared) => {
      if (!secureEqual(prepared.commandPayloadDigest, expected)) {
        throw new PlanDraftLedgerDigestMismatchError("receipt");
      }
      onPrepared(prepared);
    });
    if (!result.ok) throw new PlanDraftLedgerRejectedError(result.ruleId);
    if (!secureEqual(result.commandPayloadDigest, expected)) {
      throw new PlanDraftLedgerDigestMismatchError("receipt");
    }
    return {
      assetId: result.assetId,
      revision: result.revision,
      certificateId: result.certificateId,
      commandPayloadDigest: result.commandPayloadDigest,
      certificateDigest: result.certificateDigest,
    };
  }
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
