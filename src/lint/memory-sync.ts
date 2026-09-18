import { execFileSync } from "node:child_process";

/**
 * memory-sync — 共有 memory の同期契約 (PLAN-L7-468 PR-B、issue #175)。
 *
 * `.ut-tdd/memory/*.md` は Claude / Codex 共有の正本だが、`ut-tdd memory add` は
 * ファイルを書くだけで同期状態を誰も検査しない。実測 (2026-07-28): ローカル作業ツリーに
 * origin 追跡分が 32 件欠落し、逆にローカルのみの未コミットが 15 件あった。15 件はすべて
 * 引き継ぎ目的で書かれたもので、書いた側は「共有した」と認識していた。
 *
 * 「共有済み」の定義は **その内容が origin へ到達**。パス存在ではなく HEAD と origin の
 * blob oid 一致で判定する。パス存在だと、既存 memory を編集して commit したが push して
 * いない場合に shared と誤判定し、更新経路の沈黙欠落を素通りさせる (issue #187)。
 *
 * 同一 working tree を共有する構成ではファイル自体は
 * 相手から見えるが、永続性・別 worktree・branch 切替に耐えるのは origin 到達のみであり、
 * これは「引き継ぎ・検証の基準点 = HEAD」規律と整合する。
 *
 * 段階:
 * - untracked / 未コミット変更 = **error** (配達経路が無い、または内容が届いていない)
 * - commit 済みだが origin 未到達 = **warn** (in-flight ブランチの正常運用を止めない)
 */

export type MemorySyncState =
  /** git が知らない = 消えたら失われる。 */
  | "untracked"
  /** 追跡されているが working tree の変更が commit されていない。 */
  | "uncommitted-change"
  /** commit 済みだが、その内容が origin の基準 ref に到達していない (未 push / 更新未 push)。 */
  | "not-on-origin"
  /** origin 到達済み。 */
  | "shared";

export interface MemorySyncFile {
  source_path: string;
  state: MemorySyncState;
}

export interface MemorySyncInput {
  files: MemorySyncFile[];
  /** origin の基準 ref を解決できたか。解決できない環境では warn 段を評価できない。 */
  originResolved: boolean;
  originRef: string;
}

export interface MemorySyncResult {
  ok: boolean;
  violations: MemorySyncFile[];
  warnings: MemorySyncFile[];
  shared: number;
  originResolved: boolean;
  originRef: string;
}

const ERROR_STATES = new Set<MemorySyncState>(["untracked", "uncommitted-change"]);

export function analyzeMemorySync(input: MemorySyncInput): MemorySyncResult {
  const violations = input.files.filter((file) => ERROR_STATES.has(file.state));
  const warnings = input.files.filter((file) => file.state === "not-on-origin");
  return {
    ok: violations.length === 0 && input.originResolved,
    violations,
    warnings,
    shared: input.files.filter((file) => file.state === "shared").length,
    originResolved: input.originResolved,
    originRef: input.originRef,
  };
}

export function memorySyncMessages(result: MemorySyncResult): string[] {
  const messages: string[] = [];
  if (!result.ok) {
    const sample = result.violations
      .slice(0, 5)
      .map((file) => `${file.source_path}(${file.state})`)
      .join(", ");
    const more = result.violations.length > 5 ? ` (+${result.violations.length - 5}件)` : "";
    messages.push(
      `memory-sync - violation: 共有 memory が未共有 ${result.violations.length}件 — ${sample}${more}。` +
        `.ut-tdd/memory は Claude/Codex 共有の正本であり、commit + push されない限り相手ランタイム・` +
        `別 worktree・branch 切替後には存在しない (書いた側だけが「共有した」と認識する沈黙欠落)`,
    );
  }
  if (result.warnings.length > 0) {
    const sample = result.warnings
      .slice(0, 5)
      .map((file) => file.source_path)
      .join(", ");
    const more = result.warnings.length > 5 ? ` (+${result.warnings.length - 5}件)` : "";
    messages.push(
      `memory-sync - note: commit 済みだが ${result.originRef} 未到達 ${result.warnings.length}件 — ` +
        `${sample}${more} (in-flight ブランチなら正常。PR merge で解消する)`,
    );
  }
  if (!result.originResolved) {
    messages.push(
      `memory-sync - violation: ${result.originRef} を解決できず共有到達を判定不能 ` +
        "(origin 到達を証明できないため hard gate は fail-close)",
    );
  }
  // origin を解決できない環境で「すべて到達」と言わない (未評価と OK を混同しない)。
  if (result.ok && result.warnings.length === 0 && result.originResolved) {
    messages.push(
      `memory-sync — OK (共有 memory ${result.shared}件がすべて ${result.originRef} に到達)`,
    );
  }
  return messages;
}

// ---------------------------------------------------------------------------
// loader (git 実測)
// ---------------------------------------------------------------------------

const MEMORY_PATHSPEC = ".ut-tdd/memory";
const ORIGIN_REF_CANDIDATES = ["origin/main", "origin/HEAD"] as const;

function gitLines(repoRoot: string, args: string[]): string[] | undefined {
  try {
    // stderr は握りつぶす (ref 探索の失敗は判定材料であり、呼び手のログを汚さない)。
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return undefined;
  }
}

/**
 * `<ref>` の tree から `path -> blob oid` を読む。
 *
 * パス存在ではなく **blob oid** を読むのが要点 (issue #187)。存在判定だと、既存 memory を
 * 編集して commit したが push していない場合に「パスは origin にある」だけで shared と
 * 誤判定し、更新経路の沈黙欠落を素通りさせる。
 *
 * `-z` で NUL 区切りの生パスを読む (`core.quotePath` によるエスケープを避ける)。
 */
function gitTreeBlobs(repoRoot: string, ref: string): Map<string, string> | undefined {
  let raw: string;
  try {
    raw = execFileSync("git", ["ls-tree", "-r", "-z", ref, "--", MEMORY_PATHSPEC], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
  const blobs = new Map<string, string>();
  for (const record of raw.split("\0")) {
    if (!record) continue;
    // `<mode> <type> <oid>\t<path>`
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [, type, oid] = record.slice(0, tab).split(/\s+/);
    if (type !== "blob" || !oid) continue;
    blobs.set(record.slice(tab + 1), oid);
  }
  return blobs;
}

export function loadMemorySyncInput(repoRoot: string): MemorySyncInput {
  const tracked = gitLines(repoRoot, ["ls-files", "--", MEMORY_PATHSPEC]) ?? [];
  const untracked =
    gitLines(repoRoot, ["ls-files", "--others", "--exclude-standard", "--", MEMORY_PATHSPEC]) ?? [];
  // 追跡済みで working tree に未コミット変更があるもの (内容が届いていない)。
  const modified = new Set(
    gitLines(repoRoot, ["diff", "--name-only", "--", MEMORY_PATHSPEC]) ?? [],
  );
  const staged =
    gitLines(repoRoot, ["diff", "--cached", "--name-only", "--", MEMORY_PATHSPEC]) ?? [];
  for (const path of staged) modified.add(path);

  let originRef = ORIGIN_REF_CANDIDATES[0] as string;
  let onOrigin: Map<string, string> | undefined;
  for (const ref of ORIGIN_REF_CANDIDATES) {
    const listed = gitTreeBlobs(repoRoot, ref);
    if (listed) {
      originRef = ref;
      onOrigin = listed;
      break;
    }
  }
  // 手元の commit 済み内容。origin の blob と一致して初めて「その内容が届いた」と言える。
  const onHead = gitTreeBlobs(repoRoot, "HEAD");

  const files: MemorySyncFile[] = [];
  for (const path of untracked) {
    if (!path.endsWith(".md")) continue;
    files.push({ source_path: path, state: "untracked" });
  }
  for (const path of tracked) {
    if (!path.endsWith(".md")) continue;
    if (modified.has(path)) {
      files.push({ source_path: path, state: "uncommitted-change" });
      continue;
    }
    if (!onOrigin) {
      // origin を解決できない環境では origin 到達を判定できない。shared と偽らない。
      files.push({ source_path: path, state: "not-on-origin" });
      continue;
    }
    // 内容一致で判定する。パス存在では更新経路 (既存 memory を編集 + commit、push 前) を
    // shared と誤判定する (issue #187)。HEAD 側を読めない環境では到達を証明できない。
    const headOid = onHead?.get(path);
    const originOid = onOrigin.get(path);
    const shared = headOid !== undefined && headOid === originOid;
    files.push({ source_path: path, state: shared ? "shared" : "not-on-origin" });
  }
  files.sort((a, b) =>
    a.source_path < b.source_path ? -1 : a.source_path > b.source_path ? 1 : 0,
  );
  return { files, originResolved: onOrigin !== undefined, originRef };
}
