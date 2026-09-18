// PLAN-L6-83: Forward外遷移Issue・駆動モデル選択契約の判定関数群 (PLAN-L7-452 で Red→Green)。
//
// Execution Ledger が authoring source、GitHub Issue は外部 projection という責務分離
// (PLAN-L4-30) を守る: ここは純粋判定 + port 呼び出しのみで、GitHub SDK に依存しない。
// validation は throw や推測補完をせず structured violation を返す (fail-close)。

import { createHash } from "node:crypto";

/** L4 function §3.1 の 11 駆動モデル (off-Forward 実行方式)。技術 drive とは別 value object。 */
export const OFF_FORWARD_DRIVE_MODELS = [
  "reverse",
  "recovery",
  "incident",
  "discovery",
  "scrum",
  "refactor",
  "retrofit",
  "add-feature",
  "research",
  "design-bottomup",
  "version-up",
] as const;
export type OffForwardDriveModel = (typeof OFF_FORWARD_DRIVE_MODELS)[number];

const TECH_DRIVES = new Set(["be", "fe", "fullstack", "db", "agent", "normal"]);
const FORWARD_SIGNALS = new Set(["descend", "ascend", "revise", "freeze", "accept"]);
const ESCAPE_SIGNALS = new Set([
  "blocked",
  "rejected",
  "reopened",
  "superseded",
  "preemptive",
  "defer",
]);
const LAYER_PATTERN = /^L(?:[0-9]|1[0-4])$/;

export interface RequestForwardEscape {
  command_id: string;
  origin_asset_id: string;
  origin_revision_id: string;
  origin_layer: string;
  origin_state: string;
  escape_reason: string;
  drive_model: string;
  reentry_target_asset_id: string;
  reentry_target_revision_id: string;
  reentry_target_layer: string;
  reentry_target_state: string;
  issue_projection: {
    owner: string;
    repository: string;
    title: string;
    labels: string[];
  };
  plan_id: string;
}

type ForwardEscapeCommandView = Omit<Readonly<RequestForwardEscape>, "issue_projection"> & {
  readonly issue_projection: {
    readonly owner: string;
    readonly repository: string;
    readonly title: string;
    readonly labels: readonly string[];
  };
};

export interface ContractViolation {
  code: string;
  message: string;
}

/** Ledger の読み取り view (validation に必要な最小面)。 */
export interface ForwardEscapeLedgerView {
  currentRevisionOf(assetId: string): string | undefined;
  lookupRevision(
    assetId: string,
    revisionId: string,
  ): { layer: string; states: readonly string[] } | undefined;
  priorCommand(commandId: string): { payload_digest: string } | undefined;
}

export interface ForwardEscapeValidationCertificate {
  readonly certificate_id: string;
  readonly event_digest: string;
}

/** E2をLedgerへappendし、後段が照合できるopaque certificateを発行するport。 */
export interface ForwardEscapeCustodyPort {
  issue(input: {
    readonly command_id: string;
    readonly payload_digest: string;
  }): ForwardEscapeValidationCertificate;
  verify(event: ValidatedForwardEscape): boolean;
}

export function classifyForwardBoundary(transition: {
  signal: string;
}): "inside_forward" | "forward_escape" | "invalid" {
  if (FORWARD_SIGNALS.has(transition.signal)) return "inside_forward";
  if (ESCAPE_SIGNALS.has(transition.signal)) return "forward_escape";
  return "invalid";
}

function payloadDigest(command: ForwardEscapeCommandView): string {
  // 冪等判定用の正準 digest。field 順を固定して同一 payload = 同一 digest を保証する。
  const canonical = JSON.stringify([
    command.origin_asset_id,
    command.origin_revision_id,
    command.origin_layer,
    command.origin_state,
    command.escape_reason,
    command.drive_model,
    command.reentry_target_asset_id,
    command.reentry_target_revision_id,
    command.reentry_target_layer,
    command.reentry_target_state,
    command.issue_projection.owner,
    command.issue_projection.repository,
    command.issue_projection.title,
    command.issue_projection.labels,
    command.plan_id,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

export interface ForwardEscapeValidation {
  violations: ContractViolation[];
  replay: boolean;
  payload_digest: string;
  validated?: ValidatedForwardEscape;
}

export interface ValidatedForwardEscape {
  readonly type: "ForwardEscapeValidated";
  readonly sequence: "E2";
  readonly command: ForwardEscapeCommandView;
  readonly payload_digest: string;
  readonly certificate: ForwardEscapeValidationCertificate;
}

function validatedEvent(
  command: RequestForwardEscape,
  payloadDigestValue: string,
  certificate: ForwardEscapeValidationCertificate,
): ValidatedForwardEscape {
  const event = Object.freeze({
    type: "ForwardEscapeValidated" as const,
    sequence: "E2" as const,
    command: Object.freeze({
      ...command,
      issue_projection: Object.freeze({
        ...command.issue_projection,
        labels: Object.freeze([...command.issue_projection.labels]),
      }),
    }),
    payload_digest: payloadDigestValue,
    certificate: Object.freeze({ ...certificate }),
  });
  return event;
}

function custodyViolation(error: unknown): ContractViolation {
  // Adapter error本文はSQLite pathやprovider情報を含み得るため、閉じたcodeだけへ変換する。
  // payload conflictだけはdomain上の再利用違反として区別し、それ以外はavailabilityへ畳む。
  return error instanceof Error && error.message === "e2-command-payload-mismatch"
    ? {
        code: "e2-command-payload-mismatch",
        message: "同じcommand_idへ異なるpayloadのE2 certificateは発行できない",
      }
    : {
        code: "e2-custody-unavailable",
        message: "Ledger E2 custodyを安全に確定できない",
      };
}

export function validateForwardEscape(
  command: RequestForwardEscape,
  ledger: ForwardEscapeLedgerView,
  custody?: ForwardEscapeCustodyPort,
): ForwardEscapeValidation {
  const violations: ContractViolation[] = [];
  const requiredText: Array<[keyof RequestForwardEscape, string]> = [
    ["command_id", "missing-command-id"],
    ["origin_asset_id", "missing-origin-asset"],
    ["origin_revision_id", "missing-origin-revision"],
    ["origin_state", "missing-origin-state"],
    ["escape_reason", "missing-escape-reason"],
    ["reentry_target_asset_id", "missing-reentry-asset"],
    ["reentry_target_revision_id", "missing-reentry-revision"],
    ["plan_id", "missing-plan-id"],
  ];
  for (const [field, code] of requiredText) {
    if (!String(command[field] ?? "").trim()) {
      violations.push({ code, message: `${String(field)} が空` });
    }
  }

  for (const [field, value] of [
    ["issue_projection.owner", command.issue_projection?.owner],
    ["issue_projection.repository", command.issue_projection?.repository],
    ["issue_projection.title", command.issue_projection?.title],
  ] as const) {
    if (!String(value ?? "").trim()) {
      violations.push({ code: "invalid-issue-projection", message: `${field} が空` });
    }
  }
  if (
    !Array.isArray(command.issue_projection?.labels) ||
    command.issue_projection.labels.length === 0
  ) {
    violations.push({
      code: "invalid-issue-projection",
      message: "issue_projection.labels は1件以上必要",
    });
  }

  if (!command.drive_model) {
    violations.push({ code: "missing-drive-model", message: "drive_model が未選択" });
  } else if (TECH_DRIVES.has(command.drive_model)) {
    violations.push({
      code: "tech-drive-confusion",
      message: `技術 drive (${command.drive_model}) は off-Forward 駆動モデルではない`,
    });
  } else if (!(OFF_FORWARD_DRIVE_MODELS as readonly string[]).includes(command.drive_model)) {
    violations.push({
      code: "unknown-drive-model",
      message: `未知の drive_model: ${command.drive_model}`,
    });
  }

  // reentry 側と対称に、空も pattern 不正も fail-close する (§2: L0..L14 の明示値)。
  if (!LAYER_PATTERN.test(command.origin_layer ?? "")) {
    violations.push({
      code: "invalid-origin-layer",
      message: `origin_layer は L0..L14 の明示値: ${command.origin_layer || "(空)"}`,
    });
  }
  if (
    !command.reentry_target_layer ||
    !LAYER_PATTERN.test(command.reentry_target_layer) ||
    !String(command.reentry_target_state ?? "").trim()
  ) {
    violations.push({
      code: "invalid-reentry-target",
      message: "reentry_target_layer/state が欠落または不正",
    });
  }

  if (command.origin_asset_id && command.origin_revision_id) {
    const current = ledger.currentRevisionOf(command.origin_asset_id);
    const revision = ledger.lookupRevision(command.origin_asset_id, command.origin_revision_id);
    if (!revision) {
      violations.push({
        code: "origin-revision-not-found",
        message: `origin ${command.origin_asset_id}@${command.origin_revision_id} がLedgerに実在しない`,
      });
    } else if (
      revision.layer !== command.origin_layer ||
      !revision.states.includes(command.origin_state)
    ) {
      violations.push({
        code: "origin-state-not-found",
        message: `origin layer/state がrevision実体と不一致: ${command.origin_layer}/${command.origin_state}`,
      });
    }
    if (current === undefined) {
      violations.push({
        code: "origin-asset-not-found",
        message: `origin asset ${command.origin_asset_id} がLedgerに実在しない`,
      });
    } else if (current !== command.origin_revision_id) {
      violations.push({
        code: "stale-origin-revision",
        message: `origin_revision_id=${command.origin_revision_id} は current=${current} と不一致 (暗黙追従は禁止)`,
      });
    }
  }
  if (command.reentry_target_asset_id && command.reentry_target_revision_id) {
    const reentryRevision = ledger.lookupRevision(
      command.reentry_target_asset_id,
      command.reentry_target_revision_id,
    );
    if (
      !reentryRevision ||
      reentryRevision.layer !== command.reentry_target_layer ||
      !reentryRevision.states.includes(command.reentry_target_state)
    ) {
      violations.push({
        code: "reentry-target-not-found",
        message: `reentry target がLedger revision/stateに実在しない: ${command.reentry_target_asset_id}@${command.reentry_target_revision_id} ${command.reentry_target_layer}/${command.reentry_target_state}`,
      });
    }
  }

  const digest = payloadDigest(command);
  let replay = false;
  const prior = command.command_id ? ledger.priorCommand(command.command_id) : undefined;
  if (prior) {
    if (prior.payload_digest === digest) {
      replay = true;
    } else {
      violations.push({
        code: "command-id-payload-mismatch",
        message: `command_id=${command.command_id} が異なる payload で再利用された`,
      });
    }
  }

  let certificate: ForwardEscapeValidationCertificate | undefined;
  if (violations.length === 0 && custody) {
    try {
      certificate = custody.issue({ command_id: command.command_id, payload_digest: digest });
    } catch (error) {
      violations.push(custodyViolation(error));
    }
  }
  if (
    violations.length === 0 &&
    (!certificate?.certificate_id.trim() || !certificate.event_digest.trim())
  ) {
    violations.push({
      code: "e2-custody-unavailable",
      message: "Ledger E2 certificateを取得できない",
    });
  }
  return {
    violations,
    replay,
    payload_digest: digest,
    ...(violations.length === 0 && certificate
      ? { validated: validatedEvent(command, digest, certificate) }
      : {}),
  };
}

/** Issue body / Ledger event / PLAN route_mode の三面一致 (どれか一つでも欠け・不一致は遷移不可)。 */
export function checkDriveModelAlignment(input: {
  command_drive_model: string;
  issue_body_drive_model: string;
  plan_route_mode: string;
}): ContractViolation[] {
  const values = [
    input.command_drive_model,
    input.issue_body_drive_model,
    input.plan_route_mode,
  ].map((value) => String(value ?? "").trim());
  const canonical = new Set<string>(OFF_FORWARD_DRIVE_MODELS);
  if (values.some((value) => !canonical.has(value))) {
    return [
      {
        code: "unknown-drive-model",
        message: `三面のいずれかが正規drive modelでない: ${values.join(" / ")}`,
      },
    ];
  }
  if (values.some((value) => !value) || new Set(values).size !== 1) {
    return [
      {
        code: "drive-model-misalignment",
        message: `三面 (command/issue/plan) が同一正規化値でない: ${values.join(" / ")}`,
      },
    ];
  }
  return [];
}

/** Issue 本文 projection (origin 4-tuple / escape reason / drive model / reentry target / PLAN ID 必須)。 */
export function renderForwardEscapeIssueBody(command: ForwardEscapeCommandView): string {
  return [
    `## Forward escape (${command.drive_model})`,
    "",
    `- Origin asset: ${command.origin_asset_id}`,
    `- Origin revision: ${command.origin_revision_id}`,
    `- Origin layer/state: ${command.origin_layer} / ${command.origin_state}`,
    `- Escape reason: ${command.escape_reason}`,
    `- Drive model: ${command.drive_model}`,
    `- Reentry target: ${command.reentry_target_asset_id}@${command.reentry_target_revision_id} / ${command.reentry_target_layer} / ${command.reentry_target_state}`,
    `- PLAN: ${command.plan_id}`,
    "",
    "<!-- ut-tdd:forward-escape/v1",
    `command_id: ${command.command_id}`,
    `drive_model: ${command.drive_model}`,
    "-->",
  ].join("\n");
}

export interface IssueBinding {
  repository: string;
  issue_number: number;
  node_id: string;
  url: string;
  body_digest: string;
  observed_revision: string;
}

/** GitHub Issue 作成 port (副作用面)。分類・validation から分離する (PLAN-L6-83 §4)。 */
export interface ForwardEscapeIssuePort {
  /** 同じidempotency_keyはprocess再生成後も同じIssueを返すcreate-or-get契約。 */
  createOrGetIssue(request: {
    idempotency_key: string;
    owner: string;
    repository: string;
    title: string;
    body: string;
    body_digest: string;
    labels: string[];
  }): { ok: true; binding: IssueBinding } | { ok: false; reason: string };
}

export type IssueProjectionEvent =
  | {
      type: "IssueProjected";
      command_id: string;
      payload_digest: string;
      binding: IssueBinding;
    }
  | {
      type: "IssueProjectionDeferred";
      command_id: string;
      payload_digest: string;
      reason: string;
    };

export type DurableIssueProjectionEvent =
  | {
      type: "IssueProjectionQueued";
      command_id: string;
      payload_digest: string;
      repository: string;
      body_digest: string;
    }
  | IssueProjectionEvent;

export const DURABLE_PROJECTION_FAILURE_REASONS = [
  "github-request-failed",
  "github-request-threw",
  "github-success-binding-invalid",
] as const;

function durableProjectionFailureReason(
  kind: "failure" | "exception",
): (typeof DURABLE_PROJECTION_FAILURE_REASONS)[number] {
  // Provider message/headers/transcriptはsecret/PIIを含み得るため永続化しない。
  return kind === "exception" ? "github-request-threw" : "github-request-failed";
}

/** Production adapterはappendをdurable transactionとして実装する。戻り値だけをreceiptにしない。 */
export interface ForwardEscapeProjectionJournal {
  append(event: DurableIssueProjectionEvent): {
    readonly durable: true;
    readonly event_digest: string;
  };
  eventsFor(commandId: string): readonly DurableIssueProjectionEvent[];
}

function appendDurably(
  journal: ForwardEscapeProjectionJournal,
  event: DurableIssueProjectionEvent,
): void {
  const receipt = journal.append(event);
  if (receipt?.durable !== true || !receipt.event_digest?.trim()) {
    throw new Error("projection-journal-not-durable");
  }
}

function validBinding(
  binding: IssueBinding,
  expectedRepository: string,
  expectedBodyDigest: string,
): boolean {
  if (
    binding.repository !== expectedRepository ||
    binding.body_digest !== expectedBodyDigest ||
    !Number.isSafeInteger(binding.issue_number) ||
    binding.issue_number <= 0 ||
    !binding.node_id.trim() ||
    !binding.observed_revision.trim()
  ) {
    return false;
  }
  try {
    const url = new URL(binding.url);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.pathname === `/${expectedRepository}/issues/${binding.issue_number}`
    );
  } catch {
    return false;
  }
}

/** E3→E4 projection。失敗は Deferred として返し、event を失わない (throw しない)。 */
export interface ProjectForwardEscapeIssueInput {
  readonly validated: ValidatedForwardEscape;
  readonly port: ForwardEscapeIssuePort;
  readonly journal: ForwardEscapeProjectionJournal;
  readonly custody: Pick<ForwardEscapeCustodyPort, "verify">;
}

export function projectForwardEscapeIssue(
  input: ProjectForwardEscapeIssueInput,
): IssueProjectionEvent {
  const { validated, port, journal, custody } = input;
  if (
    validated.type !== "ForwardEscapeValidated" ||
    validated.sequence !== "E2" ||
    validated.payload_digest !== payloadDigest(validated.command) ||
    !custody.verify(validated)
  ) {
    throw new Error("forward-escape-e2-required");
  }
  const command = validated.command;
  const body = renderForwardEscapeIssueBody(command);
  const bodyDigest = createHash("sha256").update(body).digest("hex");
  const repository = `${command.issue_projection.owner}/${command.issue_projection.repository}`;
  const prior = journal.eventsFor(command.command_id);
  const queued = prior.find((event) => event.type === "IssueProjectionQueued");
  if (
    queued?.type === "IssueProjectionQueued" &&
    (queued.payload_digest !== validated.payload_digest ||
      queued.repository !== repository ||
      queued.body_digest !== bodyDigest)
  ) {
    throw new Error("projection-journal-payload-mismatch");
  }
  const projected = prior.findLast((event) => event.type === "IssueProjected");
  if (projected?.type === "IssueProjected") {
    if (
      projected.payload_digest !== validated.payload_digest ||
      !validBinding(projected.binding, repository, bodyDigest)
    ) {
      throw new Error("projection-journal-binding-invalid");
    }
    return projected;
  }
  if (!prior.some((event) => event.type === "IssueProjectionQueued")) {
    appendDurably(journal, {
      type: "IssueProjectionQueued",
      command_id: command.command_id,
      payload_digest: validated.payload_digest,
      repository,
      body_digest: bodyDigest,
    });
  }
  const defer = (reason: string): IssueProjectionEvent => {
    const event = {
      type: "IssueProjectionDeferred" as const,
      command_id: command.command_id,
      payload_digest: validated.payload_digest,
      reason,
    };
    appendDurably(journal, event);
    return event;
  };
  let result: ReturnType<ForwardEscapeIssuePort["createOrGetIssue"]>;
  try {
    result = port.createOrGetIssue({
      idempotency_key: command.command_id,
      owner: command.issue_projection.owner,
      repository: command.issue_projection.repository,
      title: command.issue_projection.title,
      body,
      body_digest: bodyDigest,
      labels: [...command.issue_projection.labels],
    });
  } catch (error) {
    void error;
    return defer(durableProjectionFailureReason("exception"));
  }
  if (!result.ok) return defer(durableProjectionFailureReason("failure"));
  if (!validBinding(result.binding, repository, bodyDigest)) {
    return defer("github-success-binding-invalid");
  }
  const event = {
    type: "IssueProjected" as const,
    command_id: command.command_id,
    payload_digest: validated.payload_digest,
    binding: result.binding,
  };
  // remote success後のjournal障害はGitHub失敗へ偽装しない。再開時はcreateOrGetの
  // idempotency keyで同じremote Issueを回収し、E4 appendを再試行する。
  appendDurably(journal, event);
  return event;
}

export interface ReconcileFinding {
  code: string;
  message: string;
  command_id: string;
}

/** 外部 Issue の削除・改変・重複・別 repository 投影を finding 化する (Ledger は書き換えない)。 */
export function reconcileIssueProjection(
  bindings: Array<{
    command_id: string;
    repository: string;
    issue_number: number;
    body_digest: string;
  }>,
  githubSnapshot: Array<{
    repository: string;
    issue_number: number;
    state: string;
    body_digest: string;
  }>,
): ReconcileFinding[] {
  const findings: ReconcileFinding[] = [];
  for (const binding of bindings) {
    const observed = githubSnapshot.filter(
      (issue) =>
        issue.repository === binding.repository && issue.issue_number === binding.issue_number,
    );
    if (observed.length === 0) {
      findings.push({
        code: "issue-missing",
        message: `bound issue #${binding.issue_number} (${binding.repository}) が観測できない (削除または別 repository)`,
        command_id: binding.command_id,
      });
    } else {
      for (const issue of observed) {
        if (issue.body_digest !== binding.body_digest) {
          findings.push({
            code: "issue-body-tampered",
            message: `issue #${binding.issue_number} の body digest が Ledger 記録と不一致`,
            command_id: binding.command_id,
          });
        }
      }
    }
    const duplicates = githubSnapshot.filter(
      (issue) =>
        issue.repository === binding.repository &&
        issue.issue_number !== binding.issue_number &&
        issue.body_digest === binding.body_digest,
    );
    for (const duplicate of duplicates) {
      findings.push({
        code: "issue-duplicated",
        message: `同一 body digest の issue #${duplicate.issue_number} が別番号で存在する`,
        command_id: binding.command_id,
      });
    }
  }
  return findings;
}
