---
title: "PLAN Asset v2 authoring / migration contract"
status: draft
owner: PO / TL
updated: 2026-07-10
---

# PLAN Asset v2 authoring / migration contract

## 1. 目的

PLANを一時的なpath/frontmatterではなく、rename・layer変更・長期再利用に耐える設計資産として保持する。
Markdownはauthoring view、append-only revision/transition/evidence ledgerは実績正本、harness.dbはrebuild可能なprojectionとする。

## 2. canonical schema

```yaml
schema_version: ut-tdd.plan/v2
asset_id: plan:01J00000000000000000000000
plan_key: PLAN-L4-23-forward-fsm-plan-asset-v2
revision: 1
revision_of: null
aliases: []
lifecycle: active
workflow:
  type: forward
  target_layer: L4
  expected_state: pair_freeze_ready
scope:
  requirement_ids: [VUP-REQ-09]
  artifact_ids: [artifact:forward-fsm, artifact:plan-v2]
dependencies:
  requires_asset_ids: []
  blocks_asset_ids: []
evidence_policy:
  profile: forward-l4/v1
```

## 3. identityとrevision

- `asset_id`はimmutableであり、path、slug、layer token、ordinalをidentityにしない。
- `plan_key`はhuman-readable aliasであり、変更時はalias historyを残す。
- 意味変更はrevisionを増やす。旧revision本文/evidence/transitionを上書きしない。
- dependency、supersede、artifact、evidenceは可能な限りimmutable IDを参照する。
- numeric ordinalはauthoring namespaceで一意とし、予約台帳によって並列採番競合をfail-closeする。
- canonical revision payloadは既知fieldだけでなくunknown v1 frontmatter、dependency、artifact、workflow、evidence policy、本文digestを保持し、adapter更新で過去fieldを落とさない。

## 4. Forward状態

```text
proposed → planned → pair_freeze_ready → pair_frozen → red_frozen
→ implementing → implementation_complete → trace_freeze_ready → trace_frozen
→ review_ready → reviewed → accepted → archived
```

例外状態`blocked|superseded|rejected|reopened`は、actor、reason、対象revision、source commit、evidence IDを持つ
transition eventを必須とする。

## 5. transition event

```yaml
transition_id: transition:01J00000000000000000000000
asset_id: plan:01J00000000000000000000000
revision: 1
from_state: pair_freeze_ready
to_state: pair_frozen
occurred_at: 2026-07-10T00:00:00Z
actor:
  runtime: codex
  model: gpt-5
guard_definition_version: forward-l4/v1
evidence_ids: [evidence:01J00000000000000000000000]
source_commit: 0000000000000000000000000000000000000000
decision: pass
reason: design_and_L9_pair_reviewed
```

現在状態はevent reductionで導出する。Markdown statusやschedule RAGの直接編集をtransition実績の代用にしない。

## 6. evidence record

evidenceは`subject_asset_id`、`subject_revision`、`source_commit`、redacted argv、`output_digest`、exit code、producer、occurred/expiryを
持つ。失敗exitもRed/監査証拠として保存するが、対象revision不一致、commit/digest不一致、期限切れ、失敗exit codeのevidenceをaccept guardへ使用しない。

## 7. v1 migration

- v1 PLANはrepository identityとfull `plan_id`から決定論的legacy asset IDを得る。
- 既存fileを一括renameせず、v1 adapterがcanonical v2 DTOを返す。
- 新規PLANと意味変更PLANはv2へ昇格する。
- numeric core衝突はmigration ledgerでwinner/new ordinal/legacy aliasを固定し、恒久allowlistへ逃がさない。設計baselineは18群、現HEAD inventoryは20群/41 PLANであり、HEAD digestごとに再計測する。
- legacy asset IDは`[algorithm label, root tracked ut-tdd.project.json#repository_identity, full legacy plan_id]`をuint32 big-endian byte lengthでframe化したSHA-256から初回だけ導出する。config schema/blob/HEADを検証し、remote URLからidentityを推測せず、config不在はfail-closeする。checkout path、branch、source path、layer、ordinalを入力にせず、導出後はrename時に再計算しない。
- `ut-tdd plan migrate --dry-run`は書換えず、identity、collision、unresolved reference、evidence bindingを表示する。
- 明示`--execute`は新revision/alias/ledgerをappendし、履歴を書き換えない。

## 8. CLI契約

- `ut-tdd workflow status --plan <alias|asset_id>`（実装予定。現行CLIではない）
- `ut-tdd workflow transition --plan <asset_id> --to <state> --evidence <id...>`（実装予定。現行CLIではない）
- `ut-tdd workflow explain --plan <asset_id> --to <state>`（実装予定。現行CLIではない）
- `ut-tdd plan validate <path>`
- `ut-tdd plan migrate --dry-run [--path <path>]`
- `ut-tdd plan revise --asset <asset_id> --from-revision <n>`

CLI、hook、doctorは同じcanonical parser、FSM、guard verdict、exit codeを使用する。

全workflow JSON surfaceは`ok/command/subject/current_state/requested_state/verdict/findings/evidence_ids/event_id/state_digest`
の共通envelopeを使う。exitは成功0、guard/domain違反1、usage/schema違反2、I/O/transaction失敗3とする。
`status|explain`は書込み禁止、`transition`はappend eventとcurrent projectionを同一transactionで更新する。

## 9. 受入不変条件

- rename/layer変更でasset identityが変わらない。
- revision更新で旧revision/evidenceが保持される。
- illegal transition、stale evidence、unresolved alias、二重ordinal予約をfail-closeする。
- projection全削除/rebuild後もevent identityとreduced stateが一致する。
