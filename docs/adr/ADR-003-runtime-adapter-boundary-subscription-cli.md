# ADR-003: runtime adapter 境界 — 契約プラン CLI/hook 隔離 (Anti-Corruption Layer)

- **Status**: accepted
- **Date**: 2026-05-29
- **Deciders**: PM (Opus) + PO (ユーザー)
- **関連**: `docs/design/harness/L4-basic-design/external-if.md` §6 / `docs/design/harness/L5-detailed-design/if-detail.md` §1・§7 / `docs/adr/ADR-001-ut-tdd-harness-redesign-and-language.md` / `../../CLAUDE.md` (契約プラン方針) / improvement-backlog IMP-030・IMP-031

## 背景

UT-TDD harness は Claude Code / Codex (AI runtime) / GitHub / 観測系 (Sentry/Uptime Robot) など外部 runtime・ツールを利用する。

正本 CLAUDE.md は **「Codex / Claude Code は API 直叩りではなく、契約プラン (月額) + CLI / hook を harness が管理する対象として扱う」** と定め、禁止事項として「外部 provider SDK や認証情報を前提にした fallback を通常導線として追加しない」を課す。

しかし L4/L5 設計 (external-if / if-detail) で、AI runtime 境界が **API key 認証前提**で記述される漏れが発生し、PO 指摘 (2026-05-29、A-71) で是正した。**この境界決定が ADR で固定されていなかったこと**が漏れの一因。再発を構造的に防ぐため境界を ADR 化する。

## 決定

1. **外部 runtime を runtime adapter で隔離** (Anti-Corruption Layer)。core は **正規化 intent** (「worker に委譲」「reviewer を呼べ」) のみ発行し、provider 固有を core に持ち込まない。
2. **adapter は API key ではなく「起動方式」を吸収する**:
   - Claude = Claude Code の Agent tool / hook (harness は Claude Code 内に常駐する host runtime)
   - Codex = `codex exec` CLI subprocess 起動 (`ut-tdd codex` 導線)
   - GitHub = `gh` CLI
3. **harness は AI provider の API key を保持・授受しない**。AI runtime の認証は **各 CLI の契約プラン (月額) ログインが自己管理** する harness 外の関心事 (Claude Code 常駐 / `codex login` / `gh auth`)。
4. core は **provider SDK/API に直接依存しない** (architecture §3 依存方向、ADR-001 と整合)。

## 判断理由

- ADR-001 の「bash 排除・CLI 入口・subagent 起動を runtime adapter に隔離」の具体化。
- 契約プラン前提は **コスト構造** (月額固定で API 従量でない) + **governance** (concept §2.1.0 ルール同一性: Claude/Codex が同一 core を呼ぶ) の両面で正本方針。
- adapter で起動方式を隔離すれば **provider 切替** (Claude↔Codex、FR-L1-42) が可能で、API key 管理リスクもゼロになる。
- 境界を ADR で固定することで、A-71 のような **API-premise 漏れを構造的に防止** (IMP-030 guard と連動)。

## 検討した代替案

| 案 | 判定 | 理由 |
|----|------|------|
| API / SDK 直叩き (API key 管理) | **却下** | CLAUDE.md 契約プラン方針違反。認証情報管理リスク + API 従量コスト。禁止事項 (認証前提 fallback) に抵触 |
| adapter なしで core が直接 CLI 呼出 | 却下 | provider lock-in。core が provider 固有を持ち、ルール同一性・テスト容易性を損なう |
| ADR 化しない (external-if §6 のまま) | 却下 | A-71 の漏れが示すとおり、境界が固定されないと前提ズレが再発する |

## 結果

- (+) provider 切替可 (adapter 差し替え)。FR-L1-42 provider 引継ぎの基盤。
- (+) **API key 管理が不要** (契約プラン CLI 自己認証)。harness の秘密管理は GitHub (gh ログイン) + 観測系 inbound token のみに縮小。
- (+) 同種の API-premise 前提ズレを構造的に防止 (IMP-030 guard の根拠)。
- (−) adapter 実装コスト (L7)。CLI subprocess 起動 + エラー変換 (`AdapterError`: absent/auth=未ログイン/rate-limit=契約上限/timeout)。
- (−) 契約プラン CLI への依存 (CLI 仕様変更に追従が必要)。

## 後続対応

- **IMP-030**: 「AI runtime に API key 前提を書かない」guard を L6/L7 doc + lint に組み込む。
- **IMP-031 (将来境界)**: 画面 (14 screen) + DB を Web サーバ側に配置する場合、**local harness ↔ Web サーバ間の通信境界** (ネットワーク) が新設される。現状は file-based local (ネットワークなし) だが、Phase B / multi-team (L3 §7.2 BR-multi) で本 adapter 方針の延長として設計する。**Web サーバ配置方針 (中央・全 project 横断・GitHub backbone) は [ADR-005](./ADR-005-distribution-model-and-central-ui.md) D2 を参照。**
- if-detail §7 の「ADR-003 候補」を本 ADR (accepted) 参照に更新。
