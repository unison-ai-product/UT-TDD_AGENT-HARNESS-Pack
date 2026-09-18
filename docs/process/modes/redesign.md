# Redesign 駆動モデル

## 概要

Redesign は、監査・PoC・外部変化・上流判断を入力に、設計を先に修正してからForwardへ合流し、
その設計から実装へ降下する駆動モデルである。判定軸は起点ではなく遷移方向であり、
`design_to_implementation` だけを許可する。

## 不変条件

- `route_mode: redesign`、kind は `design` または `add-design`、layer は L1-L6。
- Forward escapeとしてIssue、origin、escape reason、Forward合流先を必須にする。
- 先行実装は `discarded` または `none`。`preserved` は Reverse のみである。
- 既存設計を一件 `supersedes` し、Forward合流後に開始する実装PLANを束縛する。

## フロー

`起点証拠 → 設計差替え → pair-freeze → Forward合流 → 実装 → 右腕検証`

実装から設計へ事実を追従させる場合はRedesignではなくReverseを使う。
