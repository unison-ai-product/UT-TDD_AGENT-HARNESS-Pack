# UT-TDD コーディング規約

本書は TypeScript/Bun core の coding-rule SSoT である。
Requirements reference: `docs/governance/ut-tdd-agent-harness-requirements_v1.2.md` §7.6.1.
実行ゲート: `src/lint/coding-rules.ts` を `ut-tdd doctor` から実行する。

## Workflow Placement / workflow 上の位置づけ

coding-rule 文書は workflow step であり、事後の CI note ではない。

- Forward L6: G6/G7 handoff 前に `docs/governance/coding-rules.md` が不変で現在も適用可能か確認する。差分があれば function design delta として更新する。
- Add-feature: `add-design` PLAN が coding-rule 影響を記録する。`add-impl` は影響が `unchanged` か、この SSoT と対応 U-CODE tests に反映済みの場合だけ開始する。
- Refactor / Retrofit / Recovery / Reverse fullback: 実装言語、lint tool、命名、型付け、error-handling style、generated-code boundary を変える場合は implementation freeze 前にこの SSoT を更新する。
- Review: reviewer approval 前に `bun run typecheck`、`bun run lint`、`npx vitest run`、`ut-tdd doctor` を green にする。

## 機械判定ポリシー

以下の block は `loadCodingRulePolicy` が機械読取する。Rule ID は lint 実装と一致させる。

```yaml
coding_rules:
  version: 1
  applies_to:
    source:
      - "src/**/*.ts"
    tests:
      - "tests/**/*.ts"
  rules:
    - id: no-explicit-any
      severity: error
      scope: ["source", "test"]
      description: "explicit any を使わず、unknown、generics、具体型を使う。"
    - id: no-suppression-comment
      severity: error
      scope: ["source", "test"]
      description: "TypeScript、ESLint、Biome の suppression comments を使わない。"
    - id: file-name-kebab
      severity: error
      scope: ["source", "test"]
      description: "TypeScript ファイル名は kebab-case、kebab-case .test.ts、または index.ts にする。"
    - id: max-source-params
      severity: error
      scope: ["source"]
      description: "source の関数、method、constructor、arrow function の引数は最大 3 個とし、それを超える場合は input object を使う。"
    - id: structured-error-handling
      severity: error
      scope: ["source"]
      description: "catch block は記録、変換、明示的な失敗 state の返却、または fail-open intent の文書化を行う。未文書化の空 catch と rethrow-only catch は禁止する。"
    - id: module-boundary
      severity: error
      scope: ["source"]
      description: "core module は定義済み依存方向に反する import をしてはならない。共有 logic は lower-level module へ移す。"
    - id: machine-surface-language
      severity: error
      scope: ["source", "test"]
      description: "機械向け CLI、doctor、lint、gate、JSON、env、status、oracle surface は安定した ASCII English decision token を使う。"
```

## 機械 surface の言語

機械読取・機械解析される surface は安定した ASCII English token を使う。
人間向け prose は日本語でよい。ただし tools、agents、logs、tests が依存する判定語は、
日本語文字列や記号に依存してはいけない。

必須 ASCII 判定 token の例:

- `OK`
- `violation`
- `warning`
- `skipped`
- `note`
- `error`
- `ready` / `not ready`

これは CLI output、`doctor` messages、lint/gate messages、JSON keys、
environment variable names、rule IDs、oracle IDs、status words、およびそれらの
surface に対する test assertions に適用する。日本語説明は token の後に置けるが、
token 自体は ASCII のままにする。

## 人間向けメモ

- `bun run typecheck`、`bun run lint`、`npx vitest run`、`ut-tdd doctor` は TypeScript core 変更の最小 verification set である。
- test helper の引数数は `max-source-params` の上限対象外とする。ただし tests も no-any、suppression comment 禁止、命名規則には従う。
- fail-open は catch block が明示 state を返す/記録する、または fail-open intent をその場に文書化する場合だけ許可する。silent catch block と rethrow-only catch block は例外ではない。
- boundary rules は v2 では意図的に最小とする。`lint` は pure、`runtime` は governance checks より下位、`schema` は feature modules より下位に置く。
- 例外は inline comment で処理しない。先に policy PLAN を追加し、この SSoT と lint tests を同時に更新する。
