---
status: confirmed
layer: L6
pair_artifact: docs/test-design/harness/L7-unit-test-design.md
---

# DDD/TDD ルール SSoT

本書は UT-TDD harness における DDD/TDD 厳格性の requirements-level SSoT である。`docs/governance/coding-rules.md` は TypeScript 実装形状を制約し、本書は domain boundary、invariant trace、TDD evidence、test oracle strength、integration-test granularity を制約する。

## ルール

```yaml
ddd_tdd_rules:
  - id: domain-boundary
    enforcement: hard
    owner: src/lint/ddd-tdd-rules.ts
    intent: source module は governance/domain boundary を越えて higher-level runtime または CLI module を import してはならない。
  - id: invariant-test-trace
    enforcement: hard
    owner: src/lint/ddd-tdd-rules.ts
    intent: 宣言された domain invariant は必ず L7 U-* oracle を明示する。
  - id: red-first-evidence
    enforcement: hard
    owner: src/lint/ddd-tdd-rules.ts
    intent: tdd_red_required が付いた confirmed TDD PLAN は red_at と green_at を時系列順に記録する。
  - id: test-oracle-strength
    enforcement: hard
    owner: src/lint/ddd-tdd-rules.ts
    intent: test case は明示的な expect/assert oracle を含み、truthiness check だけに依存してはならない。
  - id: integration-gwt
    enforcement: hard
    owner: src/lint/ddd-tdd-rules.ts
    intent: L8 IT-* row は Given/When/Then 粒度を持つ。
  - id: unit-oracle-substance
    enforcement: hard
    owner: src/lint/ddd-tdd-rules.ts
    intent: L7 unit test-design の U-*-NNN row は link/citation だけではなく、実際の期待挙動を記述する (skeleton 不可、IMP-083 residual)。
```

## domain boundary map の定義

| Source area | 許可される方向 | 禁止例 |
|---|---|---|
| `src/lint/**` | governance lint は docs/source text を読み、pure finding を返してよい | `src/runtime/**`、`src/doctor/**`、CLI orchestration の import |
| `src/runtime/**` | runtime state/logging は lower-level helper と schema を呼び出してよい | governance lint または V-model checker module の import |
| `src/schema/**` | schema は lower-level contract package として扱う | feature、runtime、lint、CLI module の import |

boundary checks は意図的に保守的にする。2 領域をまたいで shared type が必要な場合は、上位 import ではなく下位 module へ移す。

## 不変条件

- id: DDD-INV-001 oracle: U-DDDTDD-001 - Governance/domain module は非循環であり、lower-level contract は higher-level runtime orchestration に依存しない。
- id: DDD-INV-002 oracle: U-DDDTDD-002 - Domain invariant 宣言は、L7 test-design artifact に明示的な U-* oracle がある場合のみ受理する。
- id: DDD-INV-003 oracle: U-DDDTDD-003 - TDD 実装証跡は Red-first とする。TDD evidence を要求する confirmed plan では `red_at <= green_at` を満たす。
- id: DDD-INV-004 oracle: U-DDDTDD-004 - Unit test は assertion なし実行や truthiness check だけでなく、具体的な oracle を公開する。
- id: DDD-INV-005 oracle: U-DDDTDD-005 - Integration test は Given/When/Then 粒度で確認できる。

## Workflow Placement / workflow 上の位置づけ

- Forward L6: L7 実装開始前に domain boundary、invariant、rule ID を定義または更新する。
- Add-feature `add-design`: domain boundary、invariant、workflow evidence、test 粒度を変更する feature は、この SSoT を更新するか、影響なしを明示する。
- L7 Red: TDD を要求する `add-impl` plan は、review evidence を freeze-ready と扱う前に Red-first evidence を記録する。
- L8 integration: すべての IT-* row は Given/When/Then を使う。placeholder integration row は carry に限り、confirmable として数えない。
- 定量/定性の分離: qualitative review の前に mechanical check (`vitest`、`doctor`、lint) を実行する。critical な DDD/TDD point は quantitative evidence と agent/human review evidence の両方を持つ。
- Doctor/CI: `checkDddTddRules` は `ut-tdd doctor` と doctor command 経由の shared harness check pipeline で実行する。

## 機械チェック契約

`src/lint/ddd-tdd-rules.ts` は本書、workflow docs、`src/**/*.ts`、`tests/**/*.ts`、PLAN docs、L7/L8 test-design docs を読む。rule drift、workflow anchor drift、boundary drift、invariant oracle gap、Red-first evidence 欠落、弱い test oracle、GWT integration 粒度欠落を deterministic violation として返す。

## baseline debt の扱い

active な DDD/TDD baseline debt は登録しない。analyzer は将来の段階的 hardening 用に正確な `path:line rule` baseline key を扱えるが、現 repo guard は suppression なしで clean である。
