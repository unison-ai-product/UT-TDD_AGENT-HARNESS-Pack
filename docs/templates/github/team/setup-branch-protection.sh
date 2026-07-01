#!/usr/bin/env bash
# Phase 0-B: main の branch protection 適用 (一回限り ops、要件 §6.5/§9.1)。
#
# ut-tdd setup は既定でこのスクリプトを「生成」するのみ (emit-only)。実際の適用は
# **admin 権限の人間が実行**する — branch protection 変更は本番 merge ゲートの変更 =
# 認可・本番影響であり、harness の無人自動適用はしない (CLAUDE.md エスカレーション境界)。
#
# 前提: `gh auth login` 済み + 対象 repo の admin 権限。
# token は本スクリプト / harness に保持しない (gh の認証状態に委譲)。
set -euo pipefail

REPO="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"

echo "main の branch protection を適用します: ${REPO}"
echo "  - harness-check を Required Status Check (strict) に登録"
echo "  - 必須レビュー承認数 = 1 / 管理者も対象 (enforce_admins)"
read -r -p "続行しますか? [y/N] " ans
[[ "${ans}" == "y" || "${ans}" == "Y" ]] || { echo "中止しました"; exit 1; }

gh api -X PUT "repos/${REPO}/branches/main/protection" \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "checks": [ { "context": "harness-check" } ] },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 1 },
  "restrictions": null
}
JSON

echo "完了: ${REPO} の main は保護されました。"
