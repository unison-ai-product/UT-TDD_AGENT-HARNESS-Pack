> **正本化済** (PLAN-REVERSE-01 で DISCOVERY-04 dogfood 実績から正本化、2026-06-04)。docs/process は forward/modes/gates の運用正本。規範変更は concept/requirements (上位正本) 先行 → 本 dir へ反映する。

# Recovery 駆動モデル

出典: concept v3.1 §2.5 / §2.6.1 signal→mode (`agent_runaway`/`context_exhaustion`/`regression_dev`) / §2.6.3 承認者 / requirements v1.2 §1.3 kind=recovery / §1.5 workflow_phase 禁止規定 / §1.10 phase 禁止 / §1.8 role=aim / source process reference recovery-workflow.md (翻案元)

---

## 1. 概要

Recovery は **AI エージェント (Claude Code / Codex) の逸脱・暴走・大規模変更・工程逸脱・予算過剰消費・再開不能**を、ガード (事前) と収束 (事後) の二段構えで対応するモード。開発中の問題のみを対象とし、本番障害は Incident で分岐する。

### frontmatter 早見表 (README 台帳より)

| 項目 | 値 |
|------|----|
| kind | `recovery` |
| drive | 専門職継承 (be/fe/fullstack/db/agent、§1.6 V7。復旧対象 work の専門職、例 fullstack) |
| layer | `cross` |
| workflow_phase | **禁止** (§1.5/§1.10、phase を持たない) |
| owner | tl + po |
| 承認者 | **tl** (再開ポイント確認) + **po** (スコープ承認) — 人間サインオフ必須 |
| Forward 合流点 | 収束後 → 中断していた L0-L14 工程へ復帰 / 再発防止 → L14 |

**workflow_phase 禁止**: Recovery は phase を持たない (§1.5/§1.10)。フローは以下の箇条書きで定義する。

---

## 2. フロー構成 (phase なし)

Recovery は phase ではなく **二段構えの機構**で動作する:

### トリガー分類 (何を Recovery で拾うか)

> PO 定義 (2026-05-29):「リカバリーは認識ズレや AI 暴走の対応。だが**実態の本線は『明確に指示したのにやっていない』『勝手に余計なことをした』のトラブルシューティング**」。失敗を正直に分類し (a/b を c に丸めない)、要求レベルに戻してスコープから見直し、**上からドキュメントを直す**。

| # | パターン | 説明 | 「認識ずれ」と呼ばない理由 |
|---|---|---|---|
| **(a)** | **指示無視** | 明確に指示されたのに**やっていない** (最頻) | 受領済の指示の不履行 = culpable。softening 禁止 |
| **(b)** | **逸脱/オーバーステップ** | **勝手に余計なこと**をした (指示外の追加・改変) | 指示範囲を超えた逸脱 |
| (c) | 認識ずれ・前提誤読 | 前提を取り違えて進めた | (本当に誤読のときのみ) |
| (d) | AI 暴走 | runaway / context 枯渇 / regression | — |

> harness の存在意義 = AI が指示どおり動かない/逸脱するのを検出・是正すること。

### ガード機構 (事前: 「これ大丈夫?」)

| 機構 | 検出・警告 |
|------|-----------|
| agent-guard hook (`PreToolUse(Agent)`) | 許可リスト外 subagent_type / model 無指定 / model override を block (fail-close) |
| gate (fail-close) | 危険操作を関所で停止 |
| budget 上限 | トークン・操作の過剰消費を上限で警告 |
| subagent guard | Codex 委譲経路外の直叩きを block |
| **forced-stop 検出** (SessionStart `scanDanglingStops`、PLAN-L6-04/L7-02) | `session_end` で閉じない dangling session を**ユーザー強制停止 (ESC/Ctrl+C/Stop) = 高 severity 負シグナル**と推定し `forced_stop` 記録。停止後の是正フィードバック (Haiku 分類) を Recovery 起票候補に (concept §2.6.1 `forced_stop`=`agent_runaway` 級。fail-open、起票は人間 yes) |

### 収束機構 (事後: 本線ワークフロー 5 step)

```
trigger (a)(b)(c)(d)
   │
   ▼
Step 1: 全部拾う ──────► Step 2: 認識確認 (PO) ──► Step 3: 正常化ポイント特定
   (網羅収集)              (勝手に直さない)          (どこに戻せば正常化するか=可変)
                                                          │
   Step 5: fullback ◄──── Step 4: その点から top-down 修正 ◄┘
   (Forward 合流)          (reopen point 起点、必要範囲のみ)
```

| Step | 名称 | 内容 | 完了条件 |
|---|---|---|---|
| **1** | **全部拾う (collect)** | 該当事象を**漏れなく**収集。source = session 履歴 / ledger 反省ノート (A-* の「反省」「PO 指摘」) / memory feedback / transcript / failure_log。各事象を (a)〜(d) で分類 | 収集 list が source 横断で漏れなし |
| **2** | **認識確認 (confirm)** | 拾った list を **PO に提示し確認**。誤分類・抜け・優先度を PO が裁定。**承認前に修正着手しない** | PO が list と分類を確定 |
| **3** | **正常化ポイント特定 (locate reopen point)** | 「**どこに戻せば正常化するか**」を事象ごとに見極める。**毎回 要求とは限らない** (下表)。症状の起点まで遡るが、最小限の戻りで正常化する点を選ぶ | 各事象の reopen point (forward_routing 値) 確定 |
| **4** | **reopen point から top-down 修正 (fix)** | 特定した点を起点に**上位から下流へ** doc/コードを必要範囲だけ修正 (下流症状だけ繕わない)。起点が要求なら要求→要件→設計、設計なら設計層から。各層で pair/trace 再整合 | reopen point 以下が修正済、孤児 0 |
| **5** | **fullback** | Forward 中断工程へ合流。②駆動 exit → forward_routing。修正後の層から Forward 再開 | Forward spine に復帰、再発防止 (§3 exit) 登録 |

> ガード機構の検出 (forced_stop / agent-guard block / budget 警告) は Step 1 の trigger source の一部。handover CURRENT.json で逸脱点を把握し、recovery PLAN (本文 7 節構成、kind=recovery) を Step 3 で起票する。

#### reopen point は可変 (毎回 要求ではない)

「正常化に必要な最小の戻り先」を事象ごとに選ぶ。PO 指摘 (2026-05-29):「リカバリーが毎回要求とは限らない。設計の解釈を間違えてるパターンもある。どこに戻せば正常化するのかって話。GitHub でコミットしてたらそれでいいケースもある」。

| reopen point | 該当する事象 | top-down 修正範囲 |
|---|---|---|
| **L1/L3 (要求/要件)** | 要求・FR の漏れ/逸脱 (例: 内部資産 FR 前提抜け) | 要求 → 要件 → 設計 → … |
| **L4-L6 (設計)** | **設計の解釈誤り** (要求は正、設計の読み違い) | 当該設計層 → 下流 |
| **L7 (実装)** | 実装だけの誤り (設計は正) | 実装 + テスト |
| **git commit のみで足りる** | 既に正しく commit 済 / 軽微で doc 改訂不要 | doc 改訂なし、記録のみ |
| **gap-only (記録のみ)** | 是正不要だが将来用に記録 | backlog/handover 記録のみ |

> 原則: **過剰に上流へ戻さない**。設計解釈誤りを要求からやり直すのは無駄。逆に要求漏れを設計で繕うのも不可 (症状だけ修正 = 再発)。「最小で正常化する点」を Step 3 で見極める。

---

## 3. exit 条件

- 再開ポイント確定
- 認識訂正履歴を recovery-log に記録済
- **再発防止ドキュメント作成済 (MUST)** — root cause + **具体的な仕組み変更 (guard/test/schema/CLAUDE.md rule/hook への機械強制)** + 強制点への trace + L14 route。prose 止まりを禁じる (仕組み化志向、§8.6 失敗→仕組みループ、[[feedback_process_for_record_not_weight]])。「軽い停止だから省略」は不可
  - **最低要件 (これを満たさないと「作成済」と見なさない)**: ① root cause 特定 / ② 再発防止に向けた guard/test/rule/hook のいずれかへの**具体的変更点 (ファイル・関数粒度で trace 可能)** / ③ L14 への route 先または carry 先の明記。① のみ列挙 (②③ 空欄) の prose は不可。詳細 artifact schema は後続 PLAN で確定 (§4 carry)
- **tl がリオープンポイント確認 + po がスコープ承認** (人間サインオフ必須、§2.6.3)
- 標準 L0-L14 フロー復帰が可能な状態 (rollback/再開 **と** 再発防止 doc の両方を満たすまで exit しない。判定: tl + po、§2.6.3)

---

## 4. Forward 合流点

| 収束後の内容 | 合流先 |
|-------------|--------|
| 中断していた実装・設計・検証 | 中断時点の L 工程へ直接復帰 |
| 認識訂正・再発防止策 | L14 運用検証 (フィードバック) |

---

## 5. 必須 role / 承認者

| role | 根拠 | 担当 |
|------|------|------|
| `aim` | requirements §1.8 kind=recovery 必須 | ガード設計・収束手順主担 |
| `tl` | §1.8 owner + §2.6.3 承認者 | 再開ポイント確認・技術的ロールバック判断 |
| `po` | §1.8 owner + §2.6.3 承認者 | スコープ承認 (人間サインオフ必須) |

---

## 5.1 適用記録

| Recovery PLAN | trigger | 対象 | 状態 |
|---|---|---|---|
| [PLAN-RECOVERY-01](../../plans/PLAN-RECOVERY-01-internal-asset-recovery.md) | (a) 指示無視 (内部資産を UT-TDD 用に作り替える指示の不履行) | 内部資産 FR 前提抜け → reopen=L1 | **closed (completed、2026-06-01)**: Step 1-5 完遂。top-down 修正 = L1 BR-22 + FR-L1-46〜49 + L3 carry + L4 設計増分 (ADR-004 / PLAN-L4-10〜13) + L9 ST-ASSET。self-review CONDITIONAL PASS (Critical=0) → G1/G3 再 readiness 機械確認 (孤児0/66 pass) → PO close signoff → Forward fullback |
| [PLAN-RECOVERY-02](../../plans/PLAN-RECOVERY-02-vmodel-canonical.md) | (c) 認識ずれ (V-model 定義の前提欠落) | 正規式モデル収束 → reopen=L0-L3 | **completed (2026-06-04)**: 正規式 (L0⇔価値検証 / 谷=3点合算 / 右腕=データ実在性) へ収束、docs→workflow→assets 整合 (非破壊) |
| [PLAN-RECOVERY-03](../../plans/PLAN-RECOVERY-03-codex-l7-overstep.md) | (b) 逸脱/オーバーステップ + (d) agent_runaway 相当 | Codex の未承認 L7 実装着手 → reopen=L6/L7 process boundary | **confirmed (2026-06-09)**: `src/lint/relation-graph.ts` の未承認追加は撤去済み。PLAN-REVERSE-31 で requirements §6.8.8 / backlog / Recovery 台帳へ fullback。relation graph 本体は A-124 / IMP-118..120 の future L6/L7 scope に戻す |

> **注**: PLAN-RECOVERY-01 は当初 trigger を「認識ずれ」と記述したが、§2 トリガー分類に従い **(a) 指示無視**へ再分類 (PO 訂正反映)。複数事象は Step 1 collect-all を先行する。

---

## 6. 他 mode との連鎖 / 注意

| 接続 / 比較 | 説明 |
|------------|------|
| Incident | 別モード。Recovery = AI 逸脱・開発中。Incident = 本番障害。`env=prod` / `regression_prod` → Incident で分岐 |
| interrupt (設計ギャップ割込み) | 別対応。interrupt = 開発中の設計ギャップ・要件変更の割込み。Recovery = AI 暴走・工程逸脱 |
| forced_stop (強制停止) | **interrupt とは別概念** (命名衝突させない)。forced_stop = ユーザー強制停止 (ESC/Ctrl+C/Stop) = AI やらかしの高 severity signal → Recovery (`agent_runaway` 級、concept §2.6.1)。上記 interrupt は「要件/設計の割込み」、forced_stop は「逸脱 signal」。検出は dangling-turn 推定 (PLAN-L6-04/L7-02、専用 hook 不在 = anthropics/claude-code #9516)。間違え系 (ユーザー誤操作) は Haiku 分類で除外し記録しない |
| docs/governance/recovery-workflow.md | **統合済 → superseded** (IMP-060、2026-06-04)。トリガー分類 (§2) / 本線 5-step (§2 収束機構) / reopen 可変表 / 適用記録 (§5.1) を本 doc へ移管完了。**本 doc が Recovery の単一正本**。recovery-workflow.md は historical (冒頭 banner) |

翻案注記: source process reference の `cutover_orchestrator` / `stop-hook` は UT-TDD の `.claude/hooks/agent-guard.ts` + `ut-tdd` CLI hook 体系に対応。`agent_mandatory` / `lock` 機構は UT-TDD guard + gate として実装予定 (現状 agent-guard のみ有効化済)。

---

出典再掲: README.md 台帳 §2 / concept v3.1 §2.5/§2.6.3 / requirements v1.2 §1.3/§1.5/§1.8/§1.10 / source process reference recovery-workflow.md / docs/governance/recovery-workflow.md
