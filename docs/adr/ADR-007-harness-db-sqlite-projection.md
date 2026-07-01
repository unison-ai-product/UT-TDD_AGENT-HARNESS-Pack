# ADR-007: harness.db = SQLite projection / フィードバック機構 (ADR-001 の SQLite deferral を解除)

- **Status**: accepted
- **Date**: 2026-06-08
- **Deciders**: PM (Opus) + PO (ユーザー)
- **関連**: `docs/adr/ADR-001-ut-tdd-harness-redesign-and-language.md` (state = YAML/JSON、SQLite は「必要時 better-sqlite3」として deferral) / `docs/plans/PLAN-L5-08-harness-db-feedback.md` / `.ut-tdd/audit/A-105-harness-db-feedback-l5.md` / `docs/design/harness/L5-detailed-design/physical-data.md` §2.7/§9 / requirements_v1.2 §6.8・functional-requirements §7 / CLAUDE.md 設計の柱3 (フィードバック機構)

## 背景

ADR-001 (TS/Bun 全面再実装) は永続化を **`.ut-tdd/` file-based state (YAML/JSON)** とし、SQLite は **「必要時 `better-sqlite3`」として採用を deferral** していた (legacy `legacy DB` schema の流用却下は維持)。

その後の設計降下 (PLAN-L5-08 / A-105) で、PO が「`.ut-tdd/harness.db` は単なる V-model state cache ではなく、抜け漏れ・依存・ゆがみ・繰り返し失敗を検出する **フィードバック機構** であるべき」と明確化した。これは CLAUDE.md「設計の柱」の **柱3 = 自動化で state(DB) 管理を簡単にし、設計⇔実装⇔テストのズレを次サイクルに返すフィードバックループにする** の実体そのものである。要求は新 FR ではなく既存 FR-L1-05/06/07/09/12/13/17/18/19/20/33/37/39/40/41/45/46/47/48/49 に分散しており、欠けていたのは「これらを 1 つの DB reference-feedback + automation foundation として L5 物理 schema に落とすこと」だった。

ADR-001 本文は L5 降下に合わせて SQLite projection DB 採用へ更新済みだが、**accepted ADR の決定を新 ADR なしに in-place 反転していた** (決定史の消失 = cleanup 原則違反、cross-agent review A-105 で指摘)。本 ADR はその記録漏れを解消し、deferral 解除を正式記録する。

> 決定・設計は PLAN-L5-08 / A-105 / physical-data §9 で確定済。本 ADR は **新規決定でなく既決定 (deferral 解除) の記録**である (ADR-006 と同型の cleanup)。

## 決定

`.ut-tdd/harness.db` を **SQLite projection DB かつフィードバック機構**として採用する (ADR-001 の SQLite deferral を解除)。

- **projection であり authoring source ではない**: docs/YAML/JSON state/log を正規化した投影。governance doc・PLAN 本文の正本は markdown/YAML 側に残す。projection は再構築可能 (rebuildable)。
- **runtime**: Bun では `bun:sqlite` を第一候補、Node 互換が要る adapter のみ `better-sqlite3`。legacy `legacy DB` schema は流用しない (ADR-001 維持)。
- **役割**: V-model 製本 state / 別駆動 model run / session・hook・gate log / skill 発火率 metrics / workflow automation readiness / guardrail decision ledger / asset catalog・search index / quality・feedback signal。物理 schema は physical-data §2.7 + §9 (17 projection table + index + invariant)。
- **安全境界 (MUST)**: raw provider transcript / secret / credential / PII を DB に保存しない。ID・理由・score・redacted summary のみ。automation readiness は証跡なしに ready にしない。guardrail human-required を projection で降格しない。

## 検討した代替案

- **file-based 維持 (SQLite revert)** (却下): 当初 cross-agent review で「実装ゼロ・YAGNI」として revert を検討したが、harness.db は柱3 フィードバック機構の実体であり、設計 (L5) が実装 (L7) に先行するのは V-model で正常。「src に実装が無い」は revert 根拠にならない。横断クエリ (trace/coverage/finding/skill metrics) を file 走査で都度再計算するコストと、フィードバックループの data-backed 化要求が file-only では満たせない ([[feedback_check_pillar_before_revert]])。
- **legacy source `legacy DB` schema 流用** (却下、ADR-001 から継続): bash 依存・個人パス・schema 不整合。UT-TDD 独自 projection schema を新設する。
- **重量 ORM 導入** (却下): projection は軽量・再構築可能で十分。zod を SSoT に保ち、DB は投影に徹する。

## 結果

- (+) ADR-001 の SQLite deferral を正式クローズし、in-place 反転の決定史消失 (cleanup 違反) を解消。physical-data §2.7/§9・requirements §6.8・functional-requirements §7 の harness.db 記述が ADR で grounding される。
- (+) 柱3 (フィードバック機構) / 柱4 (skill 発火率による動的注入の学習 input) が data-backed になる土台が L5 で確定。
- (−/carry) **L7 実装負担**: 17 projection table + projection writer + search + feedback metrics + automation readiness + guardrail ledger + asset catalog + `ut-tdd db/find/metrics/feedback/automation/guardrail/asset` CLI。harness 単体実装で最大の表面 → L7 の優先順位は PO 判断 (本 ADR は設計採択であり L7 着手時期を確定しない)。
- (−/carry) projection と入力 state の不一致は `findings` に保存し silent repair しない (検証は doctor / vmodel lint、L7 実装)。
- 本決定は設計採択の記録であり、現時点でコード変更を伴わない (SQLite 実装は L7 carry)。
