# ADR-006: CLI フレームワーク = commander (oclif 却下、ADR-001 保留の確定)

- **Status**: accepted
- **Date**: 2026-06-05
- **Deciders**: PM (Opus) + PO (ユーザー)
- **関連**: `docs/adr/ADR-001-ut-tdd-harness-redesign-and-language.md` (技術スタックで「oclif または commander」を保留) / `docs/design/harness/L4-basic-design/architecture.md` §2 / `src/cli.ts` (commander 実装済) / improvement-backlog IMP-070

## 背景

ADR-001 (TS/Bun 全面再実装) の技術スタック表は CLI フレームワークを **「oclif または commander」の 2 択で保留**していた。一方、実装 (`src/cli.ts`) は既に **commander で確定**しており、status / doctor / plan / vmodel サブコマンドが commander で動作している。

architecture.md §2 注記が「commander 実装確定済だが ADR で記録を要する (floating)」と宣言していたが、対応 ADR が存在せず、**決定は下されているのに根拠が ADR に記録されていない**状態 (G4 audit A-101 grounding Important / IMP-070)。本 ADR はこの記録漏れ (クリーンアップ対象) を解消し、commander 採択を正式記録する。

> 動作・実装は確定済。本 ADR は **新規決定でなく既決定の記録**である (cleanup 原則: 決定したが ADR に残していない状態を解消)。

## 決定

UT-TDD harness の CLI フレームワークを **commander** に確定する。`src/cli.ts` は commander の `Command` でサブコマンドツリー (status / doctor / plan / vmodel / 将来 reverse・incident・skill・cutover 等) を構成する。

## 検討した代替案

- **oclif** (却下): プラグインアーキテクチャ・スキャフォルディングが強力だが、(a) ファイル規約ベースの重量級構成が「薄い entrypoint + compiled core」(ADR-001 §3) の方針と過剰、(b) `bun build --compile` 単一バイナリ配布との相性検証コストが高い、(c) 本 harness の CLI 表面は中規模で oclif のプラグイン機構は不要。
- **commander** (採択): 軽量・宣言的サブコマンド・TS 型サポート良好・Bun 互換・単一バイナリ化が容易。CLI 表面の規模に対し過不足ない。

## 結果

- (+) architecture.md §2 の floating 注記を解消、ADR-001 保留事項をクローズ (IMP-070 resolved)。
- (+) CLI 表面の追加 (将来 reverse/incident/skill/cutover サブコマンド) は commander の同一様式で拡張でき、設計者が根拠を参照可能。
- (−/carry) 将来 MCP server 化 (architecture.md §2「将来 MCP server 化を見据えた TS」) を行う場合、commander CLI とは別レイヤーの adapter が要る (ADR-003 runtime adapter の延長、Phase B carry)。
- 本決定は実装済挙動の追認であり、コード変更を伴わない (記録のみ)。
