> **正本化中** (PLAN-RECOVERY-10、2026-07-08)。docs/process は forward/modes/gates の運用正本。規範変更は concept/requirements (上位正本) 先行または同一 recovery の fullback で反映する。

# Verify Mode

出典: PLAN-RECOVERY-10 / concept v3.1 V-model / requirements v1.2 §1.3 `kind=verify` 追加方針。

## 1. 目的

Verify は V-model 右肺の検証 PLAN を起票する mode。従来の `impl` / `design` では L8-L14 の検証工程を正規 layer として持てず、検証活動がテストコード実行または prose carry に寄っていた。Verify は「どの層の品質を、どの条件と証跡で検証するか」を PLAN として明示し、検証所見から改善・refactor・reverse・Forward 合流へ戻す。

## 2. Frontmatter

| 項目 | 値 |
|---|---|
| `route_mode` | `verify` |
| `kind` | `verify` |
| `layer` | `L8` / `L9` / `L10` / `L11` / `L12` / `L13` / `L14` |
| `workflow_phase` | 使わない |
| branch prefix | `verify/*` |

`kind=verify` は横断 workflow ではなく Forward 右肺工程の PLAN なので、`layer=cross` にしない。`PLAN-Lx-*` の L-token と `layer` は一致させる。

## 3. Exit

- 検証対象、条件、手順、証跡、exit 判定、defect routing が記録されている。
- 検証実行の結果が green command / audit / gate evidence として残っている。
- 発見事項は `refactor` / `recovery` / `reverse` / `add-feature` などの該当 mode に分類され、Forward 正本への合流方針が明示されている。

## 4. 他 Mode との関係

| mode | 関係 |
|---|---|
| Forward | Verify は Forward 右肺の検証工程。最終的に L0-L14 正本へ戻る。 |
| Reverse | 検証で見つかった設計・要求の欠落を左肺へ戻す時に使う。 |
| Refactor | 品質改善候補がコード構造改善なら refactor 候補へ流す。 |
| Recovery | 退行・前提欠落・運用上の事故なら recovery として扱う。 |

