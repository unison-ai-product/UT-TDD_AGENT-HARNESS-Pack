import type { LegacyPlanRevisionBootstrapTransaction } from "../plan-asset/ledger/plan-revision-bootstrap.ts";
import type { PlanRevisionLedgerTransaction } from "../plan-asset/ledger/plan-revision-ledger.ts";
import type {
  DraftLedgerPort,
  DraftReceiptBinding,
  PlanDraftCommand,
} from "./plan-draft-service.ts";
import type { PlanRevisionExecutionPayload } from "./plan-revision-command-assembler.ts";

export interface PlanRevisionReceipt extends DraftReceiptBinding {
  certificateDigest?: string;
}

/** adopted/legacyの永続化方式を一つのSaga portへ束縛する。 */
export class PlanRevisionLedgerAdapter
  implements DraftLedgerPort<PlanRevisionExecutionPayload, PlanRevisionReceipt>
{
  private readonly adopted: PlanRevisionLedgerTransaction;
  private readonly legacy: LegacyPlanRevisionBootstrapTransaction;

  constructor(
    adopted: PlanRevisionLedgerTransaction,
    legacy: LegacyPlanRevisionBootstrapTransaction,
  ) {
    this.adopted = adopted;
    this.legacy = legacy;
  }

  transact(
    command: PlanDraftCommand<PlanRevisionExecutionPayload>,
    onPrepared: (receipt: PlanRevisionReceipt) => void,
  ): PlanRevisionReceipt {
    const input = command.payload.ledgerInput;
    const prepare = (result: PlanRevisionLedgerResult): void => onPrepared(receiptOf(result));
    const result = command.payload.legacy
      ? this.legacy.transact(
          input as Parameters<LegacyPlanRevisionBootstrapTransaction["transact"]>[0],
          prepare,
        )
      : this.adopted.transact(
          input as Parameters<PlanRevisionLedgerTransaction["transact"]>[0],
          prepare,
        );
    if (!result.ok) throw new Error(result.ruleId);
    if (result.commandPayloadDigest !== command.commandPayloadDigest)
      throw new Error("plan-revision-command-digest-mismatch");
    return receiptOf(result);
  }
}

type PlanRevisionLedgerResult = Extract<
  ReturnType<PlanRevisionLedgerTransaction["append"]>,
  { readonly ok: true }
>;

/** Ledgerの処理結果から、再生後も同形で復元できるdurable receiptだけを公開する。 */
function receiptOf(result: PlanRevisionLedgerResult): PlanRevisionReceipt {
  return {
    assetId: result.assetId,
    revision: result.revision,
    certificateId: result.certificateId,
    commandPayloadDigest: result.commandPayloadDigest,
    certificateDigest: result.certificateDigest,
  };
}
