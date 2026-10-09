# ハーネスの review custody の挙動

### (未確認) verdict の本文にある「英小文字 + `:`」で始まる行は header とみなされ、`verdict_identity_mismatch` になる

- 事実: `parseReviewVerdictEnvelope` は verdict の全行を走査し、`^([a-z_]+):[ \t]*(.*)$` に合う行を header とみなす。許可した 9 項目 (`schema_version` / `request_digest` / `attempt` / `pr` / `exact_head` / `review_revision` / `reviewer_provider` / `reviewer_model` / `invocation_nonce`) 以外の key、重複、欠落はすべて `verdict_identity_mismatch` で fail-close する。判定が PASS でも receipt は作られない。
- 対象バージョン: main `3581ee5c`
- 確認日: 2026-10-08
- 確認方法: コードを読んだ (`src/feedback/review-attestation.ts:570-603`、全行走査は `:581-591`)。実害は PR #893 の exact head `8e6d9a48` の closing review で観測された (本文 36 行目の `negative: "..."` と、折り返しで行頭に来た 84 行目の `things: ...`)。 対象版と実行コマンドの両方が記録されていない (コード閲覧・観測・transcript のみ、または版が未確認) ため、項目全体を未確認として扱う。再現して記録するまで、実測の事実として扱わない。
- 出典: issue #393 の 2026-10-08 コメント。
- ハーネスへの影響: CLI は `exit=1` だけを返し、reason は custody の jsonl を読まないと分からない。暫定策は、reviewer task に「本文の行を英小文字の key + `:` で始めない」と書くこと。header を先頭ブロックだけで解析する修正と、rejected の reason を stderr に出す修正は #393 で扱う (2026-10-08 時点で main には未反映)。

### (未確認) 拒否の記録は `.git/ut-tdd-runtime/review-custody/review-custody.jsonl` にある

- 事実: custody の監査ログは、git の common dir 配下の `ut-tdd-runtime/review-custody/review-custody.jsonl`。
- 対象バージョン: main `3581ee5c`
- 確認日: 2026-10-08
- 確認方法: コードを読んだ (`src/feedback/review-verdict-custody.ts:173`)。 対象版と実行コマンドの両方が記録されていない (コード閲覧・観測・transcript のみ、または版が未確認) ため、項目全体を未確認として扱う。再現して記録するまで、実測の事実として扱わない。
- 出典: 上記のコード、issue #393 のコメント。
- ハーネスへの影響: review が `exit=1` で終わったら、reason をここで確認する。
