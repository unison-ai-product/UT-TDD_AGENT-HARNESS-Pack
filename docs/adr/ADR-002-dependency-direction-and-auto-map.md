# ADR-002: 依存方向ルール (schema 安定核) + 依存マップ自動生成・構想 vs 実装 drift チェック

- **Status**: accepted
- **Date**: 2026-05-29
- **Deciders**: PM (Opus) + PO (ユーザー)
- **関連**: `docs/design/harness/L4-basic-design/architecture.md` §3 / `docs/design/harness/L5-detailed-design/module-decomposition.md` §4・§7 / `docs/adr/ADR-001-ut-tdd-harness-redesign-and-language.md` / improvement-backlog IMP-032

## 背景

UT-TDD harness の core が module 化する (cli/schema/lint/plan/vmodel/runtime/doctor + 将来 workflow/adapter ...) なかで、module 間の依存が複雑化する。逆依存や循環依存が混入すると保守が破綻し、テスト容易性も失われる。

L4 architecture §3 / L5 module-decomposition §4 で「**全依存は schema へ一方向・循環禁止・fs は副作用端点に隔離**」を設計したが、**設計宣言と実装 (実 import グラフ) が時間とともに乖離しないか**を継続検証する仕組みが必要。

PO 意図 (2026-05-29): UT harness の state/DB を構築する際に **依存関係の自動マップ生成機能**を入れる想定。**構想 (設計が宣言する依存方向) と実装 (実 import) でどれだけ差が出るかをチェックし、修正したい**。

## 決定

1. **依存方向ルールを正式採択**: 全依存は `schema` へ向かう一方向 (schema は何も import しない安定核)。`cli`/`doctor` が最外 (副作用層)。**循環依存禁止** (D-03=0)。`fs` (Node built-in) は依存方向ルール対象外の副作用アクセスとし、core ロジック (`analyzeX(docs?)` pure) と `loadX()` (fs 端点) を分離する。
2. **依存マップ自動生成 + 構想 vs 実装 drift lint を機能化** (将来、IMP-032): 実 import グラフを機械生成し、設計 doc が宣言する「期待依存マップ」(architecture §3 / module-decomposition §4 を形式化したもの) と照合。乖離 (逆依存 / 循環 / 想定外 edge) を **fail-close で検出**。OSS 候補 = `knip` / `madge` (L3 §7.1 tech-fork 調査)。

## 判断理由

- 既存 lint 群 (g3-trace / fr-registry / doc-consistency / entity-coverage) と同じ「**設計 ↔ 実装の機械的整合**」哲学。zod で enum drift を根絶したのと同様、**依存 drift をグラフ照合で根絶**する。
- 「構想 vs 実装の差を測って修正する」= dogfooding の中核。harness 自身が自分の依存構造を監査できることは、対象リポジトリへの harness 価値の実証にもなる。
- 循環依存は core の根幹リスク (architecture §3 の D-03=0 保証) であり、ADR で固定して将来 module 追加時の必須参照点にする価値が高い。

## 検討した代替案

| 案 | 判定 | 理由 |
|----|------|------|
| 手動レビューのみ | 却下 | module 増加で drift 見逃しが不可避。機械検証でないと D-03=0 を保証できない |
| ADR 化しない (§3/§4 のまま) | 却下 | 構造の根幹で将来必ず参照される判断。履歴・却下理由が散逸する |
| 依存方向を強制しない (自由 import) | 却下 | 循環・テスト不能・保守破綻のリスク。安定核 (schema) 設計が崩れる |

## 結果

- (+) 依存構造が機械検証可能になり、循環・逆依存を CI/doctor で fail-close できる。
- (+) **構想 (設計) と実装の gap を定量化・可視化し修正できる** (PO 意図の実現)。
- (+) 将来 module 追加時の依存判断の正本が ADR として残る。
- (−) dependency-map auto-gen + drift lint の実装コスト (L7、IMP-032)。OSS (knip/madge) 流用で緩和。
- (−) 「期待依存マップ」を設計 doc から形式化する作業が必要 (architecture §3 を機械可読形式へ)。

## 後続対応

- **IMP-032** として「依存マップ自動生成 + 構想 vs 実装 drift lint」を L7 で起票。architecture §3 を「期待依存マップ」(YAML/JSON) として形式化し、実 import グラフと照合。
- **最小スライス実装済 (IMP-075、PLAN-L7-16)**: 上記 IMP-032 (import グラフの循環/逆依存/想定外 edge 照合、knip/madge) の前段として、**「architecture §3.1 building block 集合 ⊇ `src/` 実在 module」の包含 drift** を `src/lint/module-drift.ts` (doctor `checkModuleDrift`、warn-first) で実装した。これは A-103 で発見した impl→design back-fill 漏れ (handover/setup/web を「将来」放置した meta-drift) の再発防止網 (U-MDRIFT-005 が実 repo 孤児0 を CI 担保)。**IMP-032 本体 (import グラフ drift) は引き続き carry** — module 集合包含と import edge 照合は別検査 (前者=module の有無、後者=module 間の依存方向)。
- module-decomposition §7 の「ADR-002 候補」を本 ADR (accepted) 参照に更新。
- L6 機能設計で drift lint のアルゴリズム (グラフ構築 + 照合 + 差分レポート) を pseudocode 化。
## A-124 追補: 成果物横断 graph と tool adapter の選定

日付: 2026-06-09

先行する ADR-002 の決定は依存方向と最初の `module-drift` slice を対象にした。A-124 では対象を module 集合 drift から成果物横断 relation graph へ拡張する:

- source import graph
- design が宣言する期待依存
- doc / PLAN / FR の参照
- test から source / artifact への edge
- DB projection の source-to-table edge
- 生成 diagram artifact

relation graph は `harness.db` に投影し、diagram へ export できるようにする。DB は再生成可能な projection であり、authoring source ではない。

### tool 調査まとめ

| tool | 役割 | 採用方針 |
|---|---|---|
| `dependency-cruiser` | JS/TS 依存を project rules で検証・可視化する。循環依存、禁止依存、package 依存欠落、孤児、DOT 出力に有効。 | dependency rules と graph export の優先 optional adapter。 |
| `knip` | TypeScript/JavaScript project の未使用依存、export、file を検出する。 | dead-node / unused edge 検出の optional adapter。 |
| `madge` | dependency graph を生成し、循環依存を検出する。 | rule では dependency-cruiser を優先し、軽量補助として使う。 |
| Graphviz DOT | 大規模 graph を SVG/PDF/PNG に render する。 | large graph snapshot と CI artifact 用の optional renderer。 |
| Mermaid | GitHub で render できる Markdown-native diagram。 | 小〜中規模 workflow / relation view の優先 documentation diagram 形式。 |
| D2 | SVG/PNG/PDF へ CLI export できる text-to-diagram language。 | architecture/review diagram を整える optional renderer。 |

### 決定

外部 tool を正本にしてはいけない。core graph collector は TypeScript/Bun で実装し、正規化済み row を `harness.db` に書く。外部 tool は adapter として扱う:

1. tool を実行する。
2. raw output を evidence として保存する。
3. `graph_nodes`、`dependency_edges`、`tool_runs`、`findings`、`diagram_artifacts` へ正規化する。
4. gate は正規化済み row のみを根拠にする。

### 初回実装 slice

1. `src/**/*.ts` と `tests/**/*.ts` から source import graph を作る。
2. Markdown の path/ID reference から doc reference graph を作る。
3. 両方を `graph_nodes` と `dependency_edges` に投影する。
4. `impact_results` を算出する `ut-tdd graph impact --changed <path>` を追加する。
5. `ut-tdd graph export --format mermaid|dot --scope <scope>` を追加する。
6. graph projection 欠落時は doctor で warn-first、G7/accept 向け impact rules 有効時は fail-close へ配線する。

## A-125 追補: MCP server と外部 verification profile の選定

日付: 2026-06-09

A-124 graph は UT-TDD に影響範囲を伝える。A-125 は、その影響を検証するためにどの外部 capability を有効化すべきかを決める。2026-06-09 の Web research では、以下を scope 候補に選定した:

| candidate | 役割 | 採用方針 |
|---|---|---|
| MCP Registry | public MCP servers の namespace / installation metadata を持つ discovery metadata。 | metadata source としてのみ使う。security scanner ではない。 |
| MCP Inspector | MCP servers の test/debug 用 Interactive/CLI developer tool。 | 設定済み MCP profile ごとの優先 smoke tool。 |
| Microsoft Playwright MCP | exploratory automation、screenshots、browser-state-heavy loop 向けの browser automation MCP。 | optional interactive verification profile。deterministic CI では Playwright/Vitest tests を優先する。 |
| GitHub MCP Server | GitHub issue/PR/repo/actions/code-security toolsets。 | optional workflow automation profile。default profile は read-only または narrow toolset にする。 |
| modelcontextprotocol reference servers | filesystem/git/memory/fetch/postgres/sqlite の reference capabilities。 | controlled local/reference profiles のみに使う。default filesystem/git profiles は workspace-scoped に限定する。 |
| Docker MCP Toolkit | profiles、signed/attested images、OAuth handling、runtime resource constraints を持つ containerized MCP gateway。 | Docker Desktop が使える場合の優先 team/enterprise runtime profile。 |
| Vitest Browser Mode + Playwright provider | browser-native component/UI tests。 | UI/browser-targeted changes 向け optional test profile。 |
| Testcontainers for Node.js | integration tests 用の disposable databases/services。 | Docker が使える場合の DB/service contract verification 用 optional test profile。 |
| MSW | Browser/Node API mocking。 | API-bound test の安定化と fixture reuse 用 optional test profile。 |

### 決定

外部 tool は default で global install / global enable しない。UT-TDD はそれらを **profiles** として model 化する:

1. `mcp_server_profiles` / `verification_profiles` は、許可コマンド、package refs、risk tier、auth/network/Docker 要件、trigger signals を定義する。
2. Relation graph の影響範囲展開は、`verification_recommendations` を通じて profile を推奨する。
3. `ut-tdd mcp profile probe` と MCP Inspector smoke は、profile が呼び出し可能であることを証明する。
4. 実行結果は `mcp_server_runs`、`tool_runs`、`test_runs`、正規化済み `external_tool_findings` に永続化する。
5. Gate decision は、正規化済み DB row と範囲を限定した evidence files だけを根拠にする。

### セキュリティ方針

- read-only かつ narrow toolsets を優先する。
- home directories を filesystem/git MCP profiles に mount してはいけない。
- credentials、raw provider transcripts、未 redact の MCP payloads を DB に保存してはいけない。
- registry/catalog metadata は discovery input として扱い、安全性の証明にはしない。
- Docker MCP Toolkit は、resource limits、signing/attestation、OAuth handling、profile isolation が使える場合に優先 packaged option とする。

### 初回実装 slice

1. profile schema と生成済み local config path を追加する。
2. 初期 slice として、`ut-tdd mcp profile list --json` と `ut-tdd mcp profile probe <name>` が package install なしで catalog と readiness checks を公開する。
3. readiness gate として、`ut-tdd mcp inspect <name> --method tools/list` は対象 MCP profile check と MCP Inspector profile check を組み合わせ、既定では外部 inspect を拒否する。実際の Inspector server invocation は後続 scope に残す。
4. 初期 slice として、`ut-tdd verify recommend --changed <path>` は changed-file signals を profile triggers に対応付け、Mermaid impact evidence を出力できる。DB-backed relation graph expansion は別の A-124 scope として扱う。
5. 初期 slice として、`ut-tdd verify run --profile <name> --dry-run` と組み込み profile execution を実装する。disabled external profiles は、明示的な `--allow-external`、package/auth/Docker readiness、配線済み runner を要求する。`--save-evidence` は正規化済み JSON を `.ut-tdd/evidence/verification-profiles/` に永続化する。
6. doctor は、推奨されたが利用不能な profile を warn-first とし、profile rules が有効化された後だけ G7/accept で fail-close へ配線する。

## A-126 追補: canonical document export の選定

日付: 2026-06-09

A-126 は dependency/relation graph の決定を canonical document conversion に拡張する。対象は汎用 review reporting ではなく、UT-TDD source documents を人間が読みやすい spreadsheet / Excel / PPTX formats へ変換することである:

- concept / planning documents;
- requirements と acceptance documents;
- detailed design documents;
- PLAN and ADR documents;
- test-design と evidence-summary documents;
- D2 PPTX export は、architecture/workflow visuals 向けの optional diagram-to-deck bridge とする。

### tool 調査まとめ

| tool | 役割 | 採用方針 |
|---|---|---|
| CSV / Markdown summary | document matrix と summary の built-in conversion output。 | default。外部依存なし。 |
| ExcelJS | TypeScript definitions 付きの Node/browser 向け Excel workbook 作成・操作 library。 | structured requirements/design/trace workbook 用 optional XLSX renderer 候補。 |
| SheetJS CE | 広範な JavaScript spreadsheet format support。 | compatibility が重要な場合の optional spreadsheet renderer/parser 候補。 |
| PptxGenJS | JavaScript/TypeScript OOXML PowerPoint generation。 | concept、requirements、design、ADR、PLAN、test-design deck 用 optional PPTX renderer 候補。 |
| D2 PPTX export | diagram を PPTX に export する機能。 | architecture/workflow visual 用 optional diagram-to-deck renderer。 |

### 決定

生成された spreadsheet/deck files は source-of-truth documents ではない。正本は canonical Markdown/docs、normalized DB projection、明示的な review/gate/handover evidence である。

1. canonical documents を structured document projection に parse する。
2. source path、section ID、FR/AC/AT/PLAN/ADR IDs、status、trace、evidence links を保持する。
3. その projection から決定的な export dataset を構築する。
4. rendering 前に dataset を redact する。
5. CSV / Markdown は既定で render する。
6. XLSX / PPTX は readiness evidence を持つ optional renderer profiles 経由でだけ render する。
7. artifact metadata は `document_export_runs`、`document_export_datasets`、`document_export_artifacts` に保存する。
8. Gate は canonical docs、normalized rows、記録済み human decisions を根拠にし、手編集された Office files は根拠にしない。

### 初回実装 slice

将来の L7 work では以下を実装候補とする:

1. `parseCanonicalDocumentStructure` は concept、requirements、detailed design、PLAN、ADR、test-design docs から構造を抽出する。
2. `buildDocumentExportDataset` は document matrices と deck outlines 向けの dataset を構築する。
3. `renderDocumentExport` は CSV と Markdown だけを render する。
4. ExcelJS / SheetJS / PptxGenJS / D2 向け optional renderer probes を追加する。
5. `ut-tdd export docs --kind requirements|concept|design|plan|adr|test-design --format csv|md|xlsx|pptx` は、TDD Red と PLAN route の後だけ有効化する。
