# ADR-004: 内部資産 (subagent/skill/command) の TS 統制境界 — 層1 markdown 正本 / 層2 TS 統制

- **Status**: accepted
- **Date**: 2026-06-01
- **Deciders**: PM (Opus) + TL (Codex gpt-5.x、real invocation 2026-06-01) + PO (ユーザー)
- **関連**: [ADR-001](./ADR-001-ut-tdd-harness-redesign-and-language.md) (TS 全面再実装の根本方針、本 ADR が境界を補完) / [ADR-003](./ADR-003-runtime-adapter-boundary-subscription-cli.md) (契約プラン CLI/hook 前提) / `docs/plans/PLAN-RECOVERY-01-internal-asset-recovery.md` (Recovery) / `docs/plans/PLAN-L4-10-internal-asset-master.md` (本 ADR の起票 PLAN) / `docs/migration/internal-asset-inventory.md` (棚卸) / FR-L1-46〜49 / BR-22

## 背景

UT-TDD harness は source snapshot 由来の **runtime 内部資産** = subagent (`.claude/agents/*.md` 19 個) / skill (`vendor source snapshot skills` 107 個) / command を持つ。これらを「UT-TDD 用に作り替える」必要がある (BR-22、Recovery PLAN-RECOVERY-01 で前提抜けを是正)。

PO 指示 (2026-06-01):「内部資産は作り替える、TS に」。だが「TS に作り替える」には射程の曖昧さがあり、**2 層**に分かれる:

- **層1 資産の中身**: subagent の prompt 本文、skill の知識本文 = 本質的に**自然言語 (markdown)**。Claude Code は `.claude/agents/*.md` を **native 規約で markdown として読む** (動かせない外部制約)。
- **層2 管理機構**: roster registry / skill catalog・recommender・injector / capability-class resolver / 内部資産 drift lint / guard = **ロジック (TS が正当)**。

この境界が固定されていないと、(a) 層1 まで TS literal 化して Claude Code native 規約を壊す、(b) TS→.md 二重管理で drift 源を増やす、というリスクがある。今回の前提抜け (資産を作り替える視点が L1/L3 から欠落) と同型の再発を防ぐため境界を ADR 化する。

## 決定

1. **層1 (資産の中身) = markdown 正本**。subagent prompt (`.claude/agents/*.md`) と skill 本文 (`docs/skills/**/*.md`) は **single source = markdown** とする。TS literal 化 (prompt を TS module 化) はしない。Claude Code native 規約 (`.claude/agents/*.md`) をそのまま正本に使う。
2. **層2 (管理機構) = TS/Bun** (ADR-001 射程)。roster registry / skill catalog / recommender / injector / capability-class resolver / drift lint / guard を `src/runtime/*` + `src/skills/*` に TS 実装する。
3. **TS は生成でなく検証/注入/統制**。TS は markdown 正本に対し registry metadata 抽出 / schema validation / drift lint / capability resolve / runtime guard を担う。`.md` を TS が生成する方式 (single source = TS) は採らない。
4. **drift lint (FR-L1-49)** が境界の番人: 正本 `.md` に legacy source 前提 (絶対パス `~/ai-dev-kit-vscode/` / legacy runtime command 直叩き / 未 curate skill / model family 不整合) が残らないことを **fail-close** で検証する。IMP-033 cross-check rule engine の rule 型インスタンスとして実装 (新規 lint を手書きしない)。

## 判断理由

- Claude Code native 規約 (`.claude/agents/*.md` を markdown で読む) は動かせない外部制約。層1 を TS literal 化すると native 規約を捨てるか、TS から `.md` を生成して読ませる二重変換が必要になり、drift 源が増える (TL P1 指摘)。
- prompt / skill 本文は人間も読むレビュー資産。markdown 正本のほうがレビュー容易・運用摩擦が小さい。
- ADR-001 の「TS 全面再実装」は実行ロジック・統制ロジック・CLI・lint・guard・catalog に適用するのが妥当。自然言語資産はその射程外。
- FR-L1-49 drift lint は「正本 .md に legacy source 前提が残っていないか fail-close」する設計であり、**markdown 正本 + TS 検証**と最も整合 (TS 生成方式だと生成元/生成物の差分管理が追加で要る)。
- `docs/skills/` 空問題は「生成基盤の欠如」でなく「curate 未着手 + drift lint 未実装」として扱える。

## 検討した代替案

| 案 | 判定 | 理由 |
|----|------|------|
| 層1 も literal TS 化 (prompt を TS module、.md 規約を捨てる) | 却下 | Claude Code native 規約を破壊。型安全性より運用摩擦が大きい (TL Q1) |
| 層1 を TS から `.md` 生成 (single source = TS、.md は生成物) | 却下 | 生成元 TS と生成物 .md の二重管理 + Claude Code 互換確認が追加。過剰実装 (TL Q3) |
| ADR-001 主文を改訂して内部資産を含める | 却下 | ADR-001 は実装言語の根本方針。本件は「自然言語資産と TS 統制の境界」という個別設計判断。独立 ADR のほうが保守容易・参照点が明確 (TL Q2)。ADR-001 は改訂せず本 ADR から片方向参照 |
| ADR 化しない (PLAN-L4-10 本文のまま) | 却下 | 今回の前提抜けが示すとおり、境界が固定されないと再発する (ADR-003 と同型の起票理由) |

## 結果

- (+) 「内部資産を TS に作り替える」の射程が確定し、層1/層2 の二重管理リスク・native 規約破壊リスクを構造的に回避。
- (+) FR-L1-49 drift lint の設計根拠が ADR として固定され、roster/catalog/injector の全判断の参照点になる。
- (+) ADR-001 を触らず (accepted ADR 不変の慣習を維持)、本 ADR から片方向参照で履歴が散逸しない。
- (+) **data 集約に影響しない (A-90)**: 層1 markdown を唯一正本とし TS (層2) は scan-on-demand で in-memory 構築 (永続 state なし) のため、roster / skill catalog は L4 data.md の **5 集約に新 entity を追加しない**。data.md §1 (非 entity 判断) / §8 (永続化なし) と本 ADR で整合 (cross-sub-doc 沈黙 gap の解消、L4 全体 G4 再 audit 対象)。
- (−) 層2 (roster registry / catalog / recommender / injector / drift lint) の TS 実装コスト (L4-L7、porting-map W6/W7/W10)。
- (−) markdown 正本に legacy source 前提が残るリスクは drift lint (FR-L1-49) が継続検証する必要がある (未実装の間は手動 audit)。

## 後続対応

- **FR-L1-49 / IMP-033**: drift lint の検査項目 (legacy absolute path / legacy runtime command 直叩き / docs/skills 空 / roster↔guard model family 整合) を rule engine の rule 型として L6-L7 で実装。
- **PLAN-L4-11/12/13**: roster / skill-pack / drift-lint の L4 設計 child で本境界を具体化。
- **porting-map W6/W7 (subagent harden) / W10 (skill curate)**: 後続実装 PLAN に接続。
- **subagent 19 件の legacy source 前提除去**: 絶対パス・legacy runtime command 直叩きを UT-TDD 化 (drift lint の fail-close 対象を 0 にする)。
