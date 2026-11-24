# UT-TDD コーディング規約

本書は TypeScript/Node core の coding-rule SSoT であり、コード・テスト・設計文書の量と分割の目安も持つ。
Requirements reference: `docs/governance/ut-tdd-agent-harness-requirements_v1.2.md` §7.6.1.
実行ゲート: `src/lint/coding-rules.ts` を `ut-tdd doctor` から実行する。

## 最小実装原則 (anti-over-engineering)

要件を満たす最短・最小の実装を選ぶ。over-engineering (投機的なコード・機能の大量生産) は品質欠陥として扱う。

- 新しい型・契約・層・registry・receipt・機能を足す前に、既存の型/関数/データで解けないかを先に問う (YAGNI)。将来の投機で契約や抽象を増やさない。
- 同じ問題は「コード・機能を大量に作る」より「短く解く」方を優先する。行数・型数・分岐が増える解は、要件が実際に要求している場合だけ採る。
- object-oriented DDD を採る理由は、ドメインを小さく凝集した型で表現して code 量と分散を減らすためであって、ceremony (wrapper / envelope / registry の積み増し) を増やすためではない。DDD が code を膨張させているなら設計を疑う。
- 設計 review / freeze では各契約・型・層について「要件のどの falsifiable な必要から来るか」を問い、答えられない追加は削るか後続 revision へ送る。

## Workflow Placement / workflow 上の位置づけ

coding-rule 文書は workflow step であり、事後の CI note ではない。

- Forward L6: G6/G7 handoff 前に `docs/governance/coding-rules.md` が不変で現在も適用可能か確認する。差分があれば function design delta として更新する。
- Add-feature: 追加設計に coding-rule への影響を記録する。影響が `unchanged` か、この SSoT と対応する U-CODE tests に反映済みの場合に実装を開始する。
- Refactor / Retrofit / Recovery / Reverse fullback: 実装言語、lint tool、命名、型付け、error-handling style、generated-code boundary を変える場合は implementation freeze 前にこの SSoT を更新する。
- Review: reviewer approval 前に `npm run typecheck`、`npm run lint`、`npx vitest run`、`ut-tdd doctor` を green にする。

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

## ドメイン・構造設計規約 (PLAN-L4-21)

本節は ZIP 94/95 相当の L4 設計契約である。上の `coding_rules` YAML は現行 hard gate の正本であり、本節の
追加 rule は L6 の設計と L7 のテスト設計に従って analyzer と oracle を追加してから YAML の hard gate へ昇格する。

### 値オブジェクト

- VO は完全コンストラクタを持つ。必須値を後から setter で埋める初期化は禁止する。
- VO は immutable とし、public mutable field / setter / mutable collection の外部公開を避ける。
- user input 由来の `create` と persisted/projection 由来の `reconstruct` を分離する。
- invalid input は `null` / `false` で潰さず、typed finding、zod issue、または explicit error state として返す。
- VO 値域と正規化は呼び出し側へ散らさず、schema SSoT または VO module に置く。

### クラス・メソッド構造

| rule id | 設計閾値 | 目的 |
|---|---|---|
| `max-nesting-depth` | source function 内の制御ネストは原則 3 以下 | main path を浅くし、guard clause / helper 抽出を促す |
| `max-function-lines` | source function / method は概ね 80 nonblank lines 以下 | 1 関数 1 責務を保つ |
| `max-cyclomatic-complexity` | source function の分岐点は概ね 12 以下 | policy table / registry / strategy への外部化を促す |
| `command-query-separation` | command は mutation、query は読み取りに分離 | 副作用と戻り値の混在による検証不能性を避ける |
| `prefer-guard-clause` | 正常系を深い `else` に閉じ込めない | 変更時の局所性とレビュー容易性を上げる |

hard gate 化の順序:

1. 既存 repo の実測値を対象 Issue に記録する。
2. false-positive が出やすい CQS / guard clause は限定 pattern から始める。
3. 既存超過は silent grandfather にせず、refactor candidate または期限付き例外として記録する。
4. analyzer 実装と L7 oracle が揃った rule だけ `coding_rules` YAML の hard gate へ昇格する。

## 量・分割・Refactor の目安

本節は、コード・テスト・設計文書の量と分割、重複の統合、「Refactor なし」の判定について、どこを見ればよいかを 1 か所にまとめる。値の持ち主が別にあるものは写さず、path と節で指す。上の `coding_rules` YAML が hard gate の正本であり、本節の目安は、ここに明記したものを除いて gate ではない。

### 量の上限

| 対象 | 上限 | 値の持ち主 | 状態 |
|---|---|---|---|
| 設計文書 (L6 topic・L7 topic・layer 文書) の行数と責務の数 | 値は写さない | `docs/design/harness/L6-function-design/doc-split-gate.md` §4.2 | 未実装 (#1307〜#1309) |
| src・tests のファイルの行数 | 未定 | #1310 で決める | 未定 |
| 関数の行数 | 80 nonblank 行 | 本書「クラス・メソッド構造」の `max-function-lines` | gate ではない (gate 化は #1310) |
| 循環的複雑度 | 12 | 本書「クラス・メソッド構造」の `max-cyclomatic-complexity` | gate ではない (gate 化は #1310) |
| 制御のネスト | 3 | 本書「クラス・メソッド構造」の `max-nesting-depth` | gate ではない (gate 化は #1310) |
| 関数の引数 | 3 | 本書「機械判定ポリシー」の `max-source-params` | hard (`src/lint/coding-rules.ts`) |
| PR の量 | 1 論点 | `CLAUDE.md` §PR スコープ規律 3 (新規 source_module 1 個 + 対になるテスト + 最小配線) | 規律 |

次の値は、設計上の上限ではなく、Refactor の候補を出す値である。超えたものは負債候補として登録され、Refactor の入力になる。超えたこと自体は違反ではなく、上の上限とは意味が違う。

| 指標 | 現行値 | 持ち主 |
|---|---|---|
| 循環的複雑度 | 関数あたり 15 超 | `docs/governance/vmodel-refactor-qa-release-gates.md` §2.1 |
| 重複コード率 | 5% 超 | 同上 |
| 関数の行数 (helper 抽出の候補) | 120 行 | `src/state-db/refactor-candidate-policy.ts` の `extractHelperLines` |
| module の行数 (分割の候補) | 700 行 | 同 `splitModuleLines` |
| module の export 数 (分割の候補) | 24 | 同 `splitModuleExports` |
| 重複した関数 (統合の候補) | 10 行以上 | 同 `dedupeFunctionMinLines` |

### 責務の数え方と分割の判断

- 設計文書: 責務の数え方は `docs/design/harness/L6-function-design/doc-split-gate.md` §3 に従う。
- 関数: 1 関数 1 責務とする。
- module: 1 module の責務の数え方とファイル単位の上限は #1310 で決める。
- PR: 新規 source_module 1 個を 1 つの論点とする (`CLAUDE.md` §PR スコープ規律 3)。

判断は次のとおりとする。上限を超えたら分割する。上限の内側でも、変更理由が 2 つ以上あるなら分割を検討する。

### 重複を統合する条件

重複を作らず 1 か所に置く規則文は、`CLAUDE.md` §Rule Placement Convention が持つ。設計文書・tests の重複は次のとおり扱う (#1304 で確定)。コードの重複は「Refactor なし」でよい条件 (下の節) と、上の「Refactor の候補を出す値」の `dedupeFunctionMinLines` が扱う。

- **義務 (PR の中で直す)**: PR が新しく作る重複だけを義務の対象にする。設計文書なら、既存の文書に同じ topic の節・候補 (同じ関数名・finding 名・対象 path を契約の対象にしているもの) があるのに、別の文書や別の節に契約を書くこと。tests なら、`tests/support/` に既にある helper・fixture と同じ役割のものを、テストファイルの中に新しく書くこと。どちらも、PR の中で既存の側へ統合して直す。数値の閾値は置かない。文書の重複を測る道具が無く、閾値を書いても確かめられないためである。判定は非著者 family の reviewer が、下の節で PR 本文に貼る grep の結果を材料に行う。
- **義務にしないもの (計測で拾う)**: 複数の PR にまたがって既に積もった重複は、PR の義務にせず、下の「増加の計測」と「統合候補の抽出」で見つけて Refactor Issue (ラベル `refactor`) に積む。

### 新しい設計文書を作る条件

契約を書くときは、既存の文書へ節を足すことを先に検討する。新しい設計文書 (`docs/design/` と `docs/test-design/` の新規ファイル。L6 / L7 の対を含む) を作ってよいのは、次のどれかに当たるときだけとする。

1. 契約の対象 (関数名・finding 名・対象 path) を `docs/design/` と `docs/test-design/` で grep して、契約の対象として扱っている既存の節が無い。
2. 既存の文書に節を足すと、その文書が `docs/design/harness/L6-function-design/doc-split-gate.md` §4.2 の上限を超える。
3. 既存の文書と変更の理由が違う (別の module の契約で、同じ文書に置くと別々の理由で同時に変更されることになる)。

新しく作るときは、PR 本文に `新規文書の理由:` で始まる行を置き、当たる条件の番号と、1 の grep のコマンドと結果を書く。reviewer は、grep の結果と理由が食い違っていないか (同じ対象を扱う節が既にあるのに新しく作っていないか) を見る。食い違いは軽作業の是正 (既存の文書への統合) として同じ PR の中で直す。

### 契約 PR の Refactor 工程

契約 PR (`docs/design/`・`docs/test-design/` を変え、`src/`・`scripts/` を含まない PR) も、契約を書いた後に Refactor 工程を通す。

1. 同じ topic の既存の節・候補を探す (上の条件 1 と同じ grep)。重複していれば 1 か所に統合し、残りは統合先を指す 1 行にするか削除する。
2. 置き換えた記述は削除する。「旧記述」「撤回」などの注記を付けて残さない。置き換えた `CANDIDATE-*` の行も表から消す。経緯は git の履歴と PR 本文が持つ。ただし、正式 ID の oracle を退役させるときは、下の「tests の Refactor 工程」の手順に従う。
3. 1 と 2 は、契約を書いた commit の後に `refactor(docs):` の commit として分けて置く。直す余地が無いときは、PR 本文に行頭の `Refactor なし (理由)` を 1 行書く。理由には、1 の grep で何を見たかを書く。

契約 PR の Refactor 工程は、merge gate の `REFACTOR:` 欄 (実装 PR だけが対象) では確かめない。非著者 family の reviewer が、review の観点として commit の順と 1・2 の結果を見る。

### tests の Refactor 工程

実装 PR の Refactor commit は `tests/` の内容差分 0 である (`skills/test-driven-development.md`)。そのため、tests の構造を直す作業は実装 PR に混ぜず、tests の Refactor PR として別に出す。

- **tests の Refactor PR**: `tests/` だけを変え、`src/`・`scripts/`・`docs/test-design/` を変えない。commit は `refactor(tests):` とする。許すのは、重複した helper・fixture の `tests/support/` への統合と、テストファイルの rename・移動・分割である。テストの assertion を変えず、実行されるテストの数と、テストが引用する oracle ID の集合を変えない (`docs/governance/oracle-test-trace-baseline.json` が増えも減りもしない)。PR 本文に、変更前後のテストの数を書く。
- **統合候補の抽出**: 同じ名前の helper 関数がテストファイルで何か所定義されているかを、次のコマンドで出す。3 か所以上で定義されている名前を統合候補とする。候補であって義務ではない。同じ名前でも役割が違うものは統合しない。`const x = () => ...` の形の helper はこのコマンドでは拾えない。

  ```bash
  git grep -hoE '^(export )?function [A-Za-z0-9_]+' origin/main -- 'tests/*.test.ts' | sed -E 's/^(export )?function //' | sort | uniq -c | sort -rn | awk '$1>=3'
  ```

- **退役した oracle の除去**: 既存の ratchet と同じ順で行う。手順の型は `docs/design/harness/L6-function-design/oracle-test-citation-trace.md` §6.5 である。
  - test-design の宣言と、テストの同じ ID のラベルは、同じ PR で外す。`oracle-test-trace` が、未引用の宣言と未宣言の引用をそれぞれ違反にするためである。この PR は `src/` を含まない (設計書保護 gate、`docs/design/harness/L6-function-design/design-protection-diff-gate.md` §10.2)。
  - 実装も退役させるときは、テスト本体と `src/` の削除を後の実装 PR で行う。
  - 最後の引用テストが消える ID は、テストを消す PR で `docs/governance/oracle-test-trace-baseline.json` から外す。baseline は縮小だけを許し、残すと stale baseline として違反になる。
  - 退役していない oracle のテストを、tests の Refactor PR で消さない。

### 増加の計測

src・tests・docs のサイズと本数の推移は、§定期棚卸し (`CLAUDE.md` の EOD close-out) で次の 1 本のコマンドで出す (Git Bash で実行する)。`origin/main` の first-parent 上で 28・14・7・0 日前の時点の commit を固定し、その tree の blob のサイズ合計とファイル数を区分ごとに出す。履歴は git が持つので、計測値を別に保存しない。

```bash
git fetch -q origin && for d in 28 14 7 0; do c=$(git rev-list -1 --first-parent --before="$d days ago" origin/main); printf '== %s %s\n' "$(git log -1 --format=%cs "$c")" "${c:0:9}"; git -c core.quotePath=false ls-tree -r -l "$c" | awk -F'\t' '{split($1,m," "); p=$2; b="other"; if(p~/^src\//)b="src"; else if(p~/^tests\//)b="tests"; else if(p~/^scripts\//)b="scripts"; else if(p~/^docs\/design\//)b="docs/design"; else if(p~/^docs\/test-design\//)b="docs/test-design"; else if(p~/^docs\/plans\//)b="docs/plans"; else if(p~/^docs\/governance\/candidates\//)b="docs/governance/candidates"; else if(p~/^docs\//)b="docs(other)"; n[b]++; s[b]+=m[4]} END{for(k in n) printf "%-27s %5d files %7.0f KB\n",k,n[k],s[k]/1024}' | sort; done
```

- 時点は `ref@{date}` ではなく `git rev-list --before` で commit に固定する。`ref@{date}` はローカルの reflog に依存し、clone ごとに値が変わる。
- path は `ls-tree` のタブ区切りで読み、`core.quotePath=false` で日本語の path も引用符なしで区分する。空白を含む path でも区分は崩れない。
- 計測値は gate にしない。gate にするかは、4 週間分の計測を見てから Issue で判断する。gate にすると決めたときは、先にこのコマンドを純粋関数と CLI (L6 / L7 の対とテスト) へ移し、その後で gate を入れる。
- ここで測るのはリポジトリ全体の量である。src・tests のファイル単位の行数の上限は #1310 が扱う。

次の表は、`origin/main` の first-parent 上の 2 つの commit、`89f32c1b1` (2026-09-28) と `909b26c77` (2026-10-23) を比べた値である。上のコマンドは相対日時で commit を選ぶため、流す日によって比べる commit が変わる。表の値を再現するときは、次のように commit を直接指定する。

```bash
for c in 89f32c1b1 909b26c77; do printf '== %s %s\n' "$(git log -1 --format=%cs "$c")" "${c:0:9}"; git -c core.quotePath=false ls-tree -r -l "$c" | awk -F'\t' '{split($1,m," "); p=$2; b="other"; if(p~/^src\//)b="src"; else if(p~/^tests\//)b="tests"; else if(p~/^scripts\//)b="scripts"; else if(p~/^docs\/design\//)b="docs/design"; else if(p~/^docs\/test-design\//)b="docs/test-design"; else if(p~/^docs\/plans\//)b="docs/plans"; else if(p~/^docs\/governance\/candidates\//)b="docs/governance/candidates"; else if(p~/^docs\//)b="docs(other)"; n[b]++; s[b]+=m[4]} END{for(k in n) printf "%-27s %5d files %7.0f KB\n",k,n[k],s[k]/1024}' | sort; done
```

| 区分 | 2026-09-28 | 2026-10-23 | 増加 (サイズ) |
|---|---|---|---|
| `src` | 439 本 4236KB | 441 本 4421KB | +4% |
| `tests` | 336 本 3766KB | 351 本 4898KB | +30% |
| `docs/design` | 64 本 1458KB | 85 本 2150KB | +47% |
| `docs/test-design` | 46 本 937KB | 75 本 1549KB | +65% |
| `docs/governance/candidates` | 54 本 462KB | 76 本 12132KB | 約 26 倍 |

同じ時点で、上の統合候補のコマンドでは、同じ名前の helper `git` が 15 か所、`runCli` が 11 か所で定義されていた。一時ディレクトリは、`mkdtempSync` を直接使うテストファイルが 135 本、`tests/support/temp-tree.ts` を使うものが 28 本である (`git grep -l <語> origin/main -- tests | wc -l`)。

### 「Refactor なし」でよい条件と判定者

- 条件 (#1300 で確定): 実装 PR (`src/` か `scripts/` を変える PR) で Refactor commit を置かず「Refactor なし (理由)」で済ませてよいのは、次の 2 つを両方満たすときだけとする。
  1. PR 本文に、行頭の `Refactor なし (理由)` が 1 行ある。理由は空でなく、何を見て直す余地が無いとしたかを書く (例: 「1 関数内の 7 行の分岐の修正だけで、構造を足していない」)。
  2. Green の差分が、本節「量の上限」の関数の行数・循環的複雑度・制御のネスト・関数の引数の上限と、「Refactor の候補を出す値」(helper 抽出の候補・module の行数・module の export 数・重複した関数) のどれにも、新しく触れていない。新しく触れるとは、変更前は内側だったものが変更後に超えること、または Green で足したコードが超えることをいう。重複は同じ PR の中で作ったものだけを数える。
- 2 を満たしやすい典型は、1 関数内の局所修正と、`src/` 配下の docs・config・テストデータだけの変更である。典型に当たっても 2 の確認は省かない。
- 2 に触れたときは、同じ PR に Refactor commit を積んで直す。大きな構造変更が要るときは Refactor Issue (ラベル `refactor`) を起票し、PR 本文から指す。
- PR をまたぐ重複 (複数の PR に分かれて積もった重複や、既存コードとの重複) は、この条件では扱わない。計測で発火する Refactor チケット (#1304 / #1310) が扱う。
- 判定者: 条件を満たすかは、成果物を書いていない非著者 family の reviewer が判定する。著者の自己申告は根拠にしない。判定は verdict の `REFACTOR:` 欄に書き、`ut-tdd pr merge` は実装 PR で欄が無いか不合格の値なら merge を拒否する (契約は確定済み、実装は #1300 の実装チケットで入れる)。欄の形と gate の規則は `docs/design/harness/L6-function-design/merge-gate-refactor-stage.md` が持つ (本節の条件は gate が機械で判定するものではなく、gate が見るのは判定の記録である)。
- 区別: 実装 PR の中の Refactor commit (Green の後の `refactor:`。`CLAUDE.md` §PR スコープ規律 5 と `skills/test-driven-development.md`) と、Refactor mode (独立した作業。`docs/process/modes/refactor.md`) は別のものとして扱う。
- 大きな構造変更は、Refactor Issue と設計文書に記録する。

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

- `npm run typecheck`、`npm run lint`、`npx vitest run`、`ut-tdd doctor` は TypeScript core 変更の最小 verification set である。
- test helper の引数数は `max-source-params` の上限対象外とする。ただし tests も no-any、suppression comment 禁止、命名規則には従う。
- fail-open は catch block が明示 state を返す/記録する、または fail-open intent をその場に文書化する場合だけ許可する。silent catch block と rethrow-only catch block は例外ではない。
- boundary rules は v2 では意図的に最小とする。`lint` は pure、`runtime` は governance checks より下位、`schema` は feature modules より下位に置く。
- 例外の必要性と適用条件を policy の GitHub Issue に記録し、この SSoT と lint tests を同時に更新する。
- **変動点外部化 (左肺設計義務、定義 = `docs/design/harness/L5-detailed-design/internal-processing.md` C.7)**: 設計 doc の変動点 (変更・追加が頻出する箇所 = project 差 / 増える集合 / 差し替え実装 / 閾値対応表) は設計時に外部化 (config/registry/policy) し、外部化設計 (何が変わる/機構/固定契約/未知キー fail-close) を doc に内包する。ハードコード→後日 retrofit の発生源を潰す。変動しない箇所の外部化は禁止 (過大外部化 = YAGNI)。他 layer 設計 author も本義務に従う。
