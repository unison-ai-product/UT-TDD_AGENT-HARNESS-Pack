export interface PlanDraftCommand<TPayload> {
  commandId: string;
  commandPayloadDigest: string;
  /** HEADに依存せず、same-command入力そのものを再証明するdigest。 */
  replayBindingDigest?: `sha256:${string}`;
  planId: string;
  recordedAt: string;
  payload: TPayload;
  source: DraftArtifact;
  projectionPath: string;
}

export interface DraftArtifact {
  path: string;
  content: string;
  expectedPreimage?: ArtifactPreimage;
}

export type ArtifactPreimage =
  | { readonly kind: "absent" }
  | { readonly kind: "sha256"; readonly digest: `sha256:${string}` };

export interface DraftValidationPort<TPayload> {
  validate(command: PlanDraftCommand<TPayload>): void;
}

export type DraftJournalEntry<TReceipt> =
  | { status: "intent" | "recovery_required"; payloadDigest: string }
  | {
      status: "committed";
      payloadDigest: string;
      receipt: TReceipt;
      cleanup: DraftCleanupBinding;
    };

export interface DraftCleanupArtifact {
  readonly path: string;
  readonly temporaryPath: string;
  readonly rollbackPath: string;
  readonly preimage: ArtifactPreimage;
  readonly postimage: `sha256:${string}`;
}

/** processを跨いでfinalizeだけを安全に再開するためのdurable capability。 */
export interface DraftCleanupOperation {
  readonly operation: "finalize";
  readonly tokenId: string;
  readonly requestDigest: `sha256:${string}`;
  readonly artifacts: readonly [DraftCleanupArtifact, DraftCleanupArtifact];
}

export interface DraftCleanupBinding {
  readonly status: "pending" | "completed";
  readonly operation: DraftCleanupOperation;
  readonly reason?: string;
}

export interface DraftJournalPort<TReceipt extends DraftReceiptBinding> {
  find(commandId: string): DraftJournalEntry<TReceipt> | undefined;
  recordIntent(command: DraftJournalCommand): void;
  commit(input: DraftJournalCommit<TReceipt>): void;
  markRecoveryRequired(commandId: string, payloadDigest: string, reason: string): void;
  markCleanupPending(commandId: string, payloadDigest: string, reason: string): void;
  completeCleanup(commandId: string, payloadDigest: string): void;
}

export interface DraftJournalCommit<TReceipt extends DraftReceiptBinding> {
  commandId: string;
  payloadDigest: string;
  receipt: TReceipt;
  cleanup: DraftCleanupOperation;
}

export interface DraftJournalCommand {
  commandId: string;
  payloadDigest: string;
  planId: string;
  sourcePath: string;
  recordedAt: string;
}

export interface DraftReceiptBinding {
  assetId: string;
  revision: number;
  certificateId: string;
  commandPayloadDigest: string;
  certificateDigest?: string;
}

export interface DraftPublishToken {
  readonly id: string;
}

export interface DraftPublisherPort {
  stage(artifacts: readonly DraftArtifact[]): DraftPublishToken;
  publish(token: DraftPublishToken): void;
  restore(token: DraftPublishToken): void;
  finalize(token: DraftPublishToken): void;
  /** 呼出し側がtokenを再試行しないterminal境界で、保持中のOS資源を解放する。 */
  dispose(token: DraftPublishToken): void;
  describeCleanup(
    token: DraftPublishToken,
    requestDigest: `sha256:${string}`,
  ): DraftCleanupOperation;
  resumeCleanup(operation: DraftCleanupOperation): void;
}

export interface DraftArtifactRendererPort<TPayload, TReceipt extends DraftReceiptBinding> {
  render(
    command: PlanDraftCommand<TPayload>,
    receipt: TReceipt,
  ): readonly [DraftArtifact, DraftArtifact];
}

export interface DraftLedgerPort<TPayload, TReceipt extends DraftReceiptBinding> {
  transact(command: PlanDraftCommand<TPayload>, onPrepared: (receipt: TReceipt) => void): TReceipt;
}

export interface PlanDraftServicePorts<TPayload, TReceipt extends DraftReceiptBinding> {
  validator: DraftValidationPort<TPayload>;
  journal: DraftJournalPort<TReceipt>;
  publisher: DraftPublisherPort;
  renderer: DraftArtifactRendererPort<TPayload, TReceipt>;
  ledger: DraftLedgerPort<TPayload, TReceipt>;
}

export type PlanDraftResult<TReceipt> =
  | { status: "created"; receipt: TReceipt }
  | { status: "replayed"; receipt: TReceipt };

export class PlanDraftConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanDraftConflictError";
  }
}

export class PlanDraftRecoveryRequiredError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PlanDraftRecoveryRequiredError";
  }
}

/** 論理commit後の一時成果物cleanupだけが未完了であることを表す。 */
export class PlanDraftCleanupPendingError<TReceipt extends DraftReceiptBinding> extends Error {
  readonly receipt: TReceipt;

  constructor(message: string, receipt: TReceipt, options?: ErrorOptions) {
    super(message, options);
    this.receipt = receipt;
    this.name = "PlanDraftCleanupPendingError";
  }
}

/**
 * Markdown/投影とSQLiteを跨ぐ起票をdurable journalで直列化する。
 * portの実装はstage時点で既存内容を退避し、restoreを冪等にしなければならない。
 */
export class PlanDraftService<TPayload, TReceipt extends DraftReceiptBinding> {
  private readonly ports: PlanDraftServicePorts<TPayload, TReceipt>;

  constructor(ports: PlanDraftServicePorts<TPayload, TReceipt>) {
    this.ports = ports;
  }

  execute(command: PlanDraftCommand<TPayload>): PlanDraftResult<TReceipt> {
    this.ports.validator.validate(command);
    const replay = this.resolveReplay(command);
    if (replay) return replay;

    this.ports.journal.recordIntent({
      commandId: command.commandId,
      payloadDigest: command.commandPayloadDigest,
      planId: command.planId,
      sourcePath: command.source.path,
      recordedAt: command.recordedAt,
    });
    let token: DraftPublishToken | undefined;
    let cleanup: DraftCleanupOperation | undefined;
    let receipt: TReceipt;
    try {
      receipt = this.ports.ledger.transact(command, (prepared) => {
        if (prepared.commandPayloadDigest !== command.commandPayloadDigest) {
          throw new PlanDraftConflictError("ledger receiptのcommand digestがintentと一致しません");
        }
        token = this.ports.publisher.stage(this.ports.renderer.render(command, prepared));
        this.ports.publisher.publish(token);
        cleanup = this.ports.publisher.describeCleanup(
          token,
          command.replayBindingDigest ?? normalizeDigest(command.commandPayloadDigest),
        );
      });
    } catch (cause) {
      this.recover(command, token, cause);
    }
    try {
      if (!cleanup) throw new Error("公開済みartifactのcleanup capabilityがありません");
      this.ports.journal.commit({
        commandId: command.commandId,
        payloadDigest: command.commandPayloadDigest,
        receipt,
        cleanup,
      });
    } catch (cause) {
      this.markCommittedRecovery(command, token, cause);
    }
    if (token) this.finalizePublished(command, token, receipt);
    return { status: "created", receipt };
  }

  private resolveReplay(
    command: PlanDraftCommand<TPayload>,
  ): PlanDraftResult<TReceipt> | undefined {
    const existing = this.ports.journal.find(command.commandId);
    if (!existing) return undefined;
    if (existing.payloadDigest !== command.commandPayloadDigest) {
      throw new PlanDraftConflictError("command_idは異なるpayload_digestで使用済みです");
    }
    if (existing.status === "committed") {
      try {
        // completedでもpostimageと補助path不在を再証明する。pendingなら同じ操作でcleanupを再開する。
        this.ports.publisher.resumeCleanup(existing.cleanup.operation);
        if (existing.cleanup.status === "pending")
          this.ports.journal.completeCleanup(command.commandId, command.commandPayloadDigest);
      } catch (cause) {
        const reason = `durable artifact cleanup/replay検証失敗: ${errorText(cause)}`;
        if (existing.cleanup.status === "pending") {
          try {
            this.ports.journal.markCleanupPending(
              command.commandId,
              command.commandPayloadDigest,
              reason,
            );
          } catch {
            // 元のartifact不整合を主原因として保持する。
          }
        }
        throw new PlanDraftCleanupPendingError(reason, existing.receipt, { cause });
      }
      return { status: "replayed", receipt: existing.receipt };
    }
    throw new PlanDraftRecoveryRequiredError(
      `command_id=${command.commandId} は ${existing.status} のため自動再実行できません`,
    );
  }

  private recover(
    command: PlanDraftCommand<TPayload>,
    token: DraftPublishToken | undefined,
    cause: unknown,
  ): never {
    let restoreFailure: unknown;
    let disposeFailure: unknown;
    if (token) {
      try {
        this.ports.publisher.restore(token);
      } catch (error) {
        restoreFailure = error;
      } finally {
        try {
          this.ports.publisher.dispose(token);
        } catch (error) {
          disposeFailure = error;
        }
      }
    }
    const recoveryFailure = aggregateFailures(restoreFailure, disposeFailure);
    const reason = recoveryFailure
      ? `draft失敗後のrestore/resource解放に失敗: ${errorText(recoveryFailure)}`
      : token
        ? `draft失敗。artifactはrestore済み: ${errorText(cause)}`
        : `draft失敗。artifact変更なし: ${errorText(cause)}`;
    try {
      this.ports.journal.markRecoveryRequired(
        command.commandId,
        command.commandPayloadDigest,
        reason,
      );
    } catch (journalFailure) {
      const journalDetail = errorText(journalFailure);
      throw new PlanDraftRecoveryRequiredError(
        `${reason}; recovery_requiredの記録にも失敗: ${journalDetail}`,
        { cause: aggregateFailures(cause, recoveryFailure) },
      );
    }
    throw new PlanDraftRecoveryRequiredError(reason, {
      cause: aggregateFailures(cause, recoveryFailure),
    });
  }

  private markCommittedRecovery(
    command: PlanDraftCommand<TPayload>,
    token: DraftPublishToken | undefined,
    cause: unknown,
  ): never {
    let disposeFailure: unknown;
    if (token) {
      try {
        this.ports.publisher.dispose(token);
      } catch (error) {
        disposeFailure = error;
      }
    }
    const terminalFailure = aggregateFailures(cause, disposeFailure);
    const reason = `ledger/file公開後にjournal commit失敗: ${errorText(terminalFailure)}`;
    try {
      this.ports.journal.markRecoveryRequired(
        command.commandId,
        command.commandPayloadDigest,
        reason,
      );
    } catch (journalFailure) {
      // convert: 二次journal障害を元cause付きrecovery errorへ変換する。
      const journalDetail = errorText(journalFailure);
      throw new PlanDraftRecoveryRequiredError(
        `${reason}; recovery_requiredの記録にも失敗: ${journalDetail}`,
        { cause: terminalFailure },
      );
    }
    throw new PlanDraftRecoveryRequiredError(reason, { cause: terminalFailure });
  }

  private finalizePublished(
    command: PlanDraftCommand<TPayload>,
    token: DraftPublishToken,
    receipt: TReceipt,
  ): void {
    try {
      this.ports.publisher.finalize(token);
      this.ports.journal.completeCleanup(command.commandId, command.commandPayloadDigest);
      return;
    } catch (firstFailure) {
      try {
        // finalizeは冪等port契約。通常例外なら同じtokenからcleanupを再開する。
        this.ports.publisher.finalize(token);
        this.ports.journal.completeCleanup(command.commandId, command.commandPayloadDigest);
        return;
      } catch (cause) {
        let disposeFailure: unknown;
        try {
          this.ports.publisher.dispose(token);
        } catch (error) {
          disposeFailure = error;
        }
        const cleanupFailure = aggregateFailures(cause, disposeFailure);
        const reason = `ledger/file/journal確定済みだがartifact cleanup未完了: ${errorText(cleanupFailure)}`;
        try {
          this.ports.journal.markCleanupPending(
            command.commandId,
            command.commandPayloadDigest,
            reason,
          );
        } catch (journalFailure) {
          const pending = new PlanDraftCleanupPendingError(
            `${reason}; cleanup_pendingの記録にも失敗: ${errorText(journalFailure)}`,
            receipt,
            { cause: aggregateFailures(firstFailure, cleanupFailure, journalFailure) },
          );
          throw pending;
        }
        throw new PlanDraftCleanupPendingError(reason, receipt, { cause: cleanupFailure });
      }
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function aggregateFailures(...failures: readonly unknown[]): unknown {
  const present = failures.filter((failure) => failure !== undefined);
  if (present.length <= 1) return present[0];
  return new AggregateError(present, "primary operation and resource release failed");
}

function normalizeDigest(value: string): `sha256:${string}` {
  return (value.startsWith("sha256:") ? value : `sha256:${value}`) as `sha256:${string}`;
}
