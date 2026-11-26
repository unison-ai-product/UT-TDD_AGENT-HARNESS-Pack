# Pack 公開手順書 (運用者向け)

新しい PC・新しい担当でも、同じ Pack を作って公開し、受入まで進めるための手順書です。
設計の契約は `docs/design/harness/L6-function-design/pack-build-inputs.md` (ビルド入力) と
`docs/design/harness/L6-function-design/privacy-scan.md` (denylist)、`pack-exec-mode.md` (実行 bit) にあります。

**自動化の状態**: 各手順に印を付けています。

- [自動] いまの main で実装済みのコマンドです。
- [手動] 人が行う手順です。恒久的に人が行います。
- [未自動 #1882] 本書の契約 (`pack-build-inputs.md`) が Green になるまで、人が補っている手順です。Green 後はコマンドが検査します。
- [未自動] #1882 の範囲外で、人が行っている手順です。

> 注意: 新しい PC で再現できることは必達条件です。本書だけで手順が足りなければ、手順書の不備として #1882 に報告してください。

## 0. 前提 (新しい PC で一度だけ)

| 前提 | 内容 | 確認 |
| --- | --- | --- |
| Node | source の `.node-version` と `package.json` の `engines.node` (`>=24.22.3 <25`) を満たす Node 24。pin と違う版で作らない | `node -v` |
| git / シェル | Git Bash 系のシェルで実行します (PowerShell から `ut-tdd` は起動できません) | `git --version` |
| `gh` | GitHub CLI を入れ、Pack repo に PR を出せるアカウントでログインします。**認証情報を repo や文書に書きません** | `gh auth status` |
| 私有 denylist | `~/.ut-tdd/privacy-denylist.txt` (§0.1)。無いと `sync-pack` / `package` は書き出しの前に止まります | §0.1 |
| 作業場所 | source と Pack の checkout は **home の外**に置きます (`package` は home 配下の作業を拒否します)。例: `C:\dev\` の下 | - |
| Node / npm の置き場所 | `node` と `npm` の実体も **home の外**に置きます。`package` は、repo だけでなく Node / npm の path が home 配下にあっても止まります (`assertProducerPathsOutsideHome`、`src/cli/distribution.ts`)。nvm / volta / fnm などで home の下に入れた Node は使えません。公式の installer で `C:\Program Files\nodejs\` などへ入れます | `which -a node npm` (Git Bash) |

### 0.1 denylist の作り方

denylist は、公開 repo に書けない語 (私有の repo 名、個人名、個人のアカウント名など) を、公開前に検出するための私有ファイルです。

1. 置き場は OS ユーザの home の `~/.ut-tdd/privacy-denylist.txt` だけです (`.ut-tdd` が無ければ作ります)。環境変数や引数では渡せません。
2. 形式は UTF-8 のテキストです。1 行に **JavaScript の正規表現の本体**を 1 個書きます (`/` で囲みません)。
   空行と、`#` で始まる行は無視されます。各行は大文字小文字を区別せず (`i`)、Unicode (`u`) で解釈されます。
3. 中身は、公開してはいけない語の一覧です。必要な語は、前任の運用者または PO から安全な経路で受け取ります。
4. **repo の中に置いて commit してはいけません** (repo の中の path は `in-repo` として拒否されます)。**中身を画面・ログ・Issue・PR に出さない**でください (`cat` しない)。
5. 確認は、ファイルが在って空でないこと (サイズだけ) と、`sync-pack` が `privacy-denylist-unavailable` を出さないことで行います。
   `absent` / `unreadable` / `empty` / `invalid` / `in-repo` のどれでも、書き出しの前に止まります。

## 1. source と Pack の clone

[手動]

1. source (`unison-ai-product/UT-TDD_AGENT-HARNESS`) と Pack (`unison-ai-product/UT-TDD_AGENT-HARNESS-Pack`) を、**新しい clone** で別々の directory に作ります。
   既存の checkout を使い回しません (古い作業木、取り残しの file が混ざるため)。
2. source で `npm ci --ignore-scripts` を実行します (依存は lockfile の exact version です)。
3. Pack の checkout は `main` を最新にし、作業木が clean であることを `git status --short` で確かめます。

## 2. source の commit を固定する

[手動]

1. source の公開に使う commit (`main` の SHA) を決め、`git rev-parse HEAD` で 40 桁を控えます。以降の全手順でこの SHA を使います。
2. 作業木に未 commit の変更が無いことを `git status --short` で確かめます (`sync-pack` は HEAD の tracked path から選びます)。
3. source の CI (`harness-check`) がその SHA で green であることを確かめます。

## 3. Pack に反映する (`sync-pack`)

[自動] artifact の copy と scan。[未自動 #1882] ビルド入力の copy と検査。

```bash
node src/cli.ts distribution sync-pack --repo-dir <Pack の checkout> --tag <v0.2.0-canary.N> --prune-local --json
```

- 成功は exit 0 です。JSON の `privacyScan` / `secretScan` の該当が 0 件であることを確かめます (一致した文字列は出ません)。
- **ビルド入力** (`node-toolchain-provenance.json`、`tsconfig.node.json`、`vmodel-document-catalog.md`、`docs/templates/vmodel/*.md`) は、現在は `sync-pack` が扱いません。
  `--prune-local` は、これらを消します (canary.8 の ENOENT の原因)。#1882 が Green になるまで、次を人が行います。
  - 固定した SHA の tracked file から、ビルド入力を同じ相対 path で Pack の checkout に **bytes を変えずに**コピーする。
  - 件数を、固定した SHA の `git ls-tree` の結果と照合する (canary.7 と canary.8 は 52 件)。
  - 内容にも privacy-scan (denylist) を掛ける (Pack の checkout に対して別途実行する)。
  Green 後は、`sync-pack` が copy し、足りなければ書き出しの前に理由コード付きで止まります。
- 実行 bit は `pack-exec-mode.md` の契約どおり、`git add` の後に `git update-index --chmod=+x -- <path>` が必要です (`scripts/ut-tdd`、`scripts/git-hooks/pre-push`)。
  `sync-pack` の出力 `nextCommands` を確認します (自動化は未実装の場合があります)。

## 4. Pack の PR (C1 / C2)

[手動] `sync-pack` は `git add` / `commit` / `push` を実行しません。

1. Pack で作業 branch を切り、`sync-pack` の `nextCommands` の `git add` を実行して、**C1** を作ります。
   commit message の末尾に、固定した source の SHA を `Source-Commit: <40 桁の SHA>` の trailer として書きます。
2. **C2** は、C1 の上に `release/` だけを変える commit です (`release/manifest.yaml`、release の control manifest)。
   `package` は、C2 が `release/` の外を変えていると `consumer_runtime_release_diff_outside_release` で止まります。
   C2 は、#1885 のサブコマンドで作ります (契約は `docs/design/harness/L6-function-design/pack-c2-manifest.md`)。Pack の checkout を cwd にして、次の 1 行を実行し、`release/manifest.yaml` だけを commit します。
   ```bash
   node <source の clone の絶対 path>/src/cli.ts distribution c2-manifest --c1 <C1 の SHA> --tag <v0.2.0-canary.N> --previous <Pack main の SHA> --json
   ```
   **#1885 が merge するまで、この手順は手順書だけでは再現できません。その間は公開しません。** tar の inventory を手で書かないでください。
3. Pack に PR を出し、Pack の CI を green にします。Draft の間は公開しません。
4. 公開に使う tag は C2 に付けます。tag は書き換えません (取り消せないため)。

### 4.1 C1 のビルド入力が source commit の blob と一致することを照らす

[未自動 #1897] 人が行います。`package` の照合は、ビルド入力の期待 bytes を C1 の blob とするため、`sync-pack` の後から C1 の commit までの間に人が書き換えた bytes を検出できません (`pack-build-inputs.md` §5.1、残余リスク)。この手順がその穴を塞ぎます。

**いつ行うか**: 手順 1 で C1 を commit した後、§5 (`package`) の前です。C1 の SHA が決まっていればよく、C2 (手順 2) の前後どちらでも構いません。

**前提**: source の checkout は §2 で固定した SHA にあり、作業木が clean であることとします。ビルド入力の一覧は、source の `src/setup/pack-build-inputs.ts` (`selectPackBuildInputs`、一覧の単一の正本) から作ります。一覧を手で書き写しません。一覧だけを出す専用のコマンドは無いため、その関数を Node で呼びます。

```bash
SRC_DIR=<source の clone の絶対 path>
PACK_DIR=<Pack の checkout の絶対 path>
C1=<C1 の SHA>
WORK=<空の作業 directory (Pack の checkout の外)>

# 1. C1 の Source-Commit (40 桁) を読む。無い、または 40 桁でなければ中止する
SRC=$(git -C "$PACK_DIR" log -1 --format='%(trailers:key=Source-Commit,valueonly,unfold)' "$C1" | tr -d '[:space:]')
echo "$SRC" | grep -Eq '^[0-9a-f]{40}$' || { echo "STOP: Source-Commit が読めない"; exit 1; }

# 2. その commit が source の checkout にあり、§2 で固定した HEAD と同じことを確かめる
git -C "$SRC_DIR" cat-file -e "$SRC^{commit}" || { echo "STOP: source commit が無い"; exit 1; }
[ "$SRC" = "$(git -C "$SRC_DIR" rev-parse HEAD)" ] || { echo "STOP: source の HEAD が Source-Commit と違う"; exit 1; }

# 3. ビルド入力の path の一覧を作る (Pack 側も source 側も同じ相対 path。pack-build-inputs.md §5)
node --input-type=module -e '
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const [dir, sha] = process.argv.slice(1);
const { selectPackBuildInputs } = await import(pathToFileURL(dir + "/src/setup/pack-build-inputs.ts").href);
const tree = execFileSync("git", ["-C", dir, "ls-tree", "-r", "--name-only", sha], { encoding: "utf8" }).split("\n").filter(Boolean);
const s = selectPackBuildInputs(tree);
if (!s.ok) { console.error(JSON.stringify(s.reasons)); process.exit(1); }
console.log(s.paths.join("\n"));
' "$SRC_DIR" "$SRC" > "$WORK/build-inputs.txt" || { echo "STOP: 一覧が作れない"; exit 1; }
wc -l < "$WORK/build-inputs.txt"   # 件数を控える

# 4. path ごとに、C1 の blob の OID と source commit の blob の OID を比べ、全行を記録する
while IFS= read -r p; do
  p=${p%$'\r'}
  c1_oid=$(git -C "$PACK_DIR" rev-parse "$C1:$p" 2>/dev/null) || c1_oid=MISSING
  src_oid=$(git -C "$SRC_DIR" rev-parse "$SRC:$p" 2>/dev/null) || src_oid=MISSING
  if [ "$c1_oid" = MISSING ] || [ "$c1_oid" != "$src_oid" ]; then s=MISMATCH; else s=ok; fi
  echo "$s $p $c1_oid $src_oid"
done < "$WORK/build-inputs.txt" > "$WORK/build-input-oids.txt"
if grep -q '^MISMATCH' "$WORK/build-input-oids.txt"; then echo "STOP"; grep '^MISMATCH' "$WORK/build-input-oids.txt"; else echo "OK"; fi
```

- 比べる OID は、**commit 済みの C1** の blob です (`git rev-parse "$C1:<path>"`)。`git hash-object <path>` は作業木の現在の bytes を読むため、commit の後に書き換えた file や、commit していない変更を見落とします。この手順の目的は C1 に入った bytes の確認なので、作業木ではなく commit を読みます。
- 手順 3 は、source の `selectPackBuildInputs` をそのまま使います (一覧の複製を持ちません)。source が §2 の SHA に固定され clean であることが、一覧と source の blob を同じ commit に揃える前提です。
- `$WORK` の 2 つの file は一時 file です。Pack の checkout の外に置き、commit しません。

**止める条件**: 次のどれか 1 つでも当てはまれば、**`package` に進まず公開を止めます**。
- `Source-Commit` の trailer が無い、または 40 桁でない。
- `Source-Commit` の commit が source の checkout に無い、または source の HEAD と違う。
- 一覧が作れない (`pack_build_input_*` の理由コードが出る)。
- C1 に無い path が 1 件でもある (`MISSING`)。
- OID が 1 件でも一致しない (`MISMATCH`)。

止めたときは、C1 を作り直します (ビルド入力を直接書き換えず、`sync-pack` の出力をそのまま `git add` します)。原因が分からなければ #1897 に報告します。

**証跡**: 次を公開 Issue のコメントに残します (件数は §7 の release note にも書きます)。
- `Source-Commit` の SHA と C1 の SHA。
- 一覧の件数。
- path ごとの 2 つの OID の組 (`build-input-oids.txt` の全行) と、最後に `OK` と出たこと。

この手順は、コマンドによる検査が入るまでの暫定です。入ったら本節の「[未自動 #1897]」を取り除き、コマンドの使い方に置き換えます。

## 5. asset を作る (`package`)

[自動] 5 asset の生成。[未自動 #1882] ビルド入力の欠落の検査 (Green 後は理由コードで止まります)。

Pack の checkout を clean にし、**空の出力先**を指定します。依存は source の clone にだけ入っているので、**cwd を Pack の checkout に置き、source の CLI を絶対 path で呼びます** (Pack の checkout には `node_modules` がありません)。

```bash
cd <Pack の checkout>
node <source の clone の絶対 path>/src/cli.ts distribution package --tag <v0.2.0-canary.N> --out <空の directory> --json
```

- 出力先が空でないと止まります。home 配下の作業は拒否されます。
- 作る 5 asset は、`<tag>.tar.gz`、`<tag>.tar.gz.sha256`、`<tag>.ut-tdd.mjs`、`<tag>.consumer-runtime.json`、`<tag>.consumer.sha256` です。
- 失敗に `node-bootstrap-provenance-missing` / `node-bootstrap-tsconfig-missing` / ENOENT が出たときは、ビルド入力が Pack の C1 に無い兆候です (§3)。

## 6. sha256 を独立に検証する

[手動] producer の出力を信用せず、**別の道具**で再計算します。

1. PowerShell の `Get-FileHash -Algorithm SHA256 <file>` (または `sha256sum`) で、5 asset の sha256 を計算します。producer の JSON と一致することを確かめます。
2. `.sha256` の sidecar の中身が、対応する asset の計算値と一致することを確かめます。
3. **再現性の確認**。別の Pack の checkout で同じ C1 / C2 から producer を再実行します (呼び方は §5 と同じで、cwd を別の Pack の checkout に置き、source の CLI を絶対 path で呼びます)。比べ方は Node / npm の install path で変わります。
   - 同じ PC の 2 つ目の checkout、または Node / npm の install path が同一の別 PC: **5 asset 全ての sha256 が一致**します。
   - Node / npm の install path が異なる別 PC: `tar.gz`、`tar.gz.sha256`、`ut-tdd.mjs` の 3 つが一致すれば合格です。`consumer-runtime.json` と `consumer.sha256` は一致しません (receipt に Node / npm の絶対 path と、それを含む `generation_id` が入るため。契約は `pack-build-inputs.md` §7.1)。差が path だけであることは、receipt を base64 から戻し、`node.path`、`npm.cli_path`、`generation_id`、`receipt_digest` 以外が一致することで示します。
   - [未自動] path に依らない byte 同一は保証しません。別 Issue で扱います。
4. 結果 (SHA と 5 つの sha256) を、公開 Issue のコメントに残します。

## 7. 公開する (prerelease)

[手動] 公開は PO の承認後です (取り消せません)。

```bash
node src/cli.ts distribution release-plan --tag <v0.2.0-canary.N> --json   # 手順の確認だけ。実行はしない
```

1. `gh release create` を **`--prerelease`** で作り、5 asset を添付します。**`latest` は変えません** (`--latest=false`)。canary は常に prerelease です。
2. release note には次を書きます。固定した source の SHA、C1 / C2 の SHA、tag、5 asset の sha256 の表、ビルド入力の件数、
   既知の制限、再導入の注意 (§9)。私有の名前や認証情報を書きません。
3. 公開後に、release の asset 一覧と sha256 が §6 の値と一致することを、**ダウンロードし直して**確かめます。

## 8. 公開後の受入 (Windows)

[手動] 動作保証環境は Windows です。公開した asset だけを使い、source / worktree / Pack checkout を参照しません。

1. 新しい空の directory と新しい git repository (origin あり) を作ります。
2. `docs/reference/setup-guide.md` の手順で、公開した asset を使って導入し、`setup` と `doctor` を実行します。
3. 結果を公開 Issue に記録します。失敗は版を直す Issue にし、公開済みの tag を書き換えません。

## 9. 既存の利用者の再導入 (新しい clone へ)

新しい版へは、本書の標準手順として **新しい clone に入れ直します** (既存の clone の中を更新する手順は定めません)。

1. 新しい空の directory に clone し、`setup-guide.md` の手順で新しい版を入れます。
2. 古い clone から、必要な commit を push してから移します。**古い clone に残るもの (自動では移りません)**:
   `.ut-tdd/state/` (作業の状態)、evidence (`.ut-tdd/` の review・audit)、**未 push の commit と未 commit の作業**。
3. 古い clone は、移行を確認してから別 directory へ移します (削除ではなく移動)。

## 10. 手順の更新

#1882 が Green になったら、§3 と §5 の「[未自動 #1882]」を取り除き、手作業の手順を削除します。
再現の実測 (新しい clone と空の作業 directory で、本書だけを見て asset を作り、sha256 が独立検証と一致すること) の結果を #1882 に記録するまで、本書は draft です。
