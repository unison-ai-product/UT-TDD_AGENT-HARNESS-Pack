---
schema_version: skill.v1
name: design-decision-elicitation
skill_type: workflow-contract
applies_to:
  layers:
    - L2
    - L3
    - L4
    - L5
    - L6
  drive_models:
    - Forward
    - Add-feature
    - Reverse
    - Retrofit
decision_points:
  - when: "PO へ質問を出そうとしている"
    choose: "設計判断 (trade-off が実在する方式選択 / spec 未確定点) のみ、共通フォーマットで聞く"
    over: "進捗確認・実行許可・自力で確定できる事実を質問にする"
    because: "可逆作業は進めるのが原則で、質問はブロッキングな設計判断に限る (docs/governance/design-decision-elicitation.md)"
  - when: "Claude の対話セッションで設計判断を聞く"
    choose: "AskUserQuestion を使い、推奨案を先頭 + (推奨)、各選択肢に trade-off の description を付ける"
    over: "ラベルだけの選択肢や推奨なしの列挙を出す"
    because: "共通フォーマットは推奨 1 つ + trade-off 必須を要求する (選択肢 2〜4 個)"
  - when: "判断材料がコード断片・schema・UI 構成など具体物で伝わる"
    choose: "preview (コードブロック / ASCII 図) を選択肢に付ける"
    over: "文章説明だけで比較させる"
    because: "具体物の視覚比較のほうが判断が速く誤解が少ない (preview は single-select のみ)"
  - when: "非対話 / autonomous セッション、または Codex CLI で設計判断が必要になった"
    choose: "AskUserQuestion を使わず、共通フォーマットの markdown 選択肢表 (## 設計判断依頼) を最終報告に載せて停止する"
    over: "非対話セッションで AskUserQuestion を呼ぶ / フォーマットなしの自由文で聞く"
    because: "非対話では応答を待てず、Codex には構造化質問ツールが無い。markdown 表が両ランタイム共通の代替表現"
  - when: "PO の回答を得た"
    choose: "採択した選択肢と理由を PLAN の設計判断節 (または ADR) に記録する"
    over: "チャット止まりにする"
    because: "設計判断はチャットで消える。正本は PLAN / ADR (永続教訓は HARNESS メモリへ)"
---

# design decision elicitation

PO への設計判断の聞き方を固定する skill。正本フォーマットは
`docs/governance/design-decision-elicitation.md`。

## 使いどころ

- 設計 (L2-L6) の途中で trade-off が実在する方式選択に当たったとき。
- spec / AC の未確定点で、どちらに倒すかで成果物が変わるとき。
- PO ルール・governance との衝突が疑われ、解釈確認が要るとき。

## 手順

1. 判断が本当に PO のものか確認する (コード / spec / 慣例既定で自力確定できるなら聞かない)。
2. 前提 2〜3 行 + 選択肢 2〜4 個 + 各 trade-off + 推奨 1 つ (先頭、理由 1 行) を組む。
3. Claude 対話セッション: AskUserQuestion (必要なら preview 付き)。
   非対話 / Codex: `## 設計判断依頼` markdown 表を出力して停止。
4. 回答を PLAN の設計判断節 / ADR に記録してから実装を進める。
