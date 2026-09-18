/**
 * MemoryService — 共有 memory の単一アクセス路 (PLAN-L7-468 PR-A)。
 *
 * 不変条件:
 * 1. `.ut-tdd/memory/*.md` が正本。本文は必ずファイルから読む。
 * 2. harness.db `memory_entries` は body を持たない派生 metadata index であり、
 *    「新鮮さの照合」にしか使わない。index が読めなくても読み出しは成立する。
 * 3. filter / 順位 / tie-break は純粋関数 1 実装のみ (DB 経路と file 経路で分岐させない)。
 * 4. staleness は可視。無音で古い結果・空の結果を返さない。
 * 5. 1 件の破損が全件読みを落とさない (per-entry 隔離)。
 *
 * 旧経路 (`selectMemoryEntries(db)`) は DB 側 body を読む read model だった。本 service が
 * 読み路を引き継ぐため、呼び元は service を通す (境界は tests/memory-service.test.ts が固定)。
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isSecretLike } from "../secret.ts";
import { ensureDir } from "../shared/fs.ts";
import {
  type MemoryEntry,
  type MemoryKind,
  type MemoryWriteInput,
  memoryFileNameFor,
  memoryIdFor,
  memorySlugFor,
  parseMemoryFile,
} from "./index.ts";

/** index とファイル正本の関係。degraded を無音にしないための型。 */
export type MemoryFreshness =
  /** index が全件ファイルと一致。 */
  | "fresh"
  /** index が存在するがファイルと不一致 (追加/削除/内容変更が未投影)。 */
  | "stale"
  /** index を読めなかった (lock / 不在 / 破損)。ファイル正本のみで応答した。 */
  | "index-unavailable";

export interface MemoryLoadFinding {
  source_path: string;
  reason: string;
}

export interface MemoryCorpus {
  entries: MemoryEntry[];
  /** parse に失敗して読み飛ばした個別ファイル。空でなければ surface する。 */
  findings: MemoryLoadFinding[];
}

export interface MemoryReadResult extends MemoryCorpus {
  freshness: MemoryFreshness;
  /** freshness が fresh でない理由 (機械可読)。fresh のときは undefined。 */
  freshness_reason?: string;
}

export interface MemoryQueryOptions {
  query?: string;
  limit?: number;
}

const MEMORY_SOURCE_ROOT = join(".ut-tdd", "memory");

/** decoderが使うpure namespace判定。正本literalはMemoryServiceだけが所有する。 */
export function isCanonicalMemorySourcePath(sourcePath: string): boolean {
  if (!sourcePath.trim() || isAbsolute(sourcePath)) return false;
  const normalized = sourcePath.replaceAll("\\", "/");
  const root = MEMORY_SOURCE_ROOT.replaceAll("\\", "/");
  const name = normalized.slice(root.length + 1);
  return (
    sourcePath === normalized &&
    normalized.startsWith(`${root}/`) &&
    dirname(normalized) === root &&
    name !== "" &&
    name !== "." &&
    name !== ".."
  );
}

/**
 * Review requests may bind only a direct child of the canonical authored memory root.
 * Keeping this path policy in MemoryService prevents CLI callers from becoming a second
 * memory-storage boundary while retaining the same fail-closed traversal checks.
 */
export function canonicalAuthoredMemoryPath(
  canonicalProjectRoot: string,
  memoryPath: string,
): string {
  const authoredRoot = resolve(canonicalProjectRoot, MEMORY_SOURCE_ROOT);
  const target = resolve(canonicalProjectRoot, memoryPath);
  const rel = relative(authoredRoot, target).replaceAll("\\", "/");
  if (!rel || rel === "." || rel.startsWith("..") || rel.includes("/") || !rel.endsWith(".md")) {
    throw new Error("review_memory_path_outside_canonical_root");
  }
  return join(MEMORY_SOURCE_ROOT, rel).replaceAll("\\", "/");
}

/** Read one canonical memory entry after path and frontmatter identity are both verified. */
export function readCanonicalMemoryByIdentity(input: {
  repoRoot: string;
  memoryPath: string;
  memoryId: string;
}): MemoryEntry | null {
  const memoryPath = canonicalAuthoredMemoryPath(input.repoRoot, input.memoryPath);
  const resolved = resolveMemoryTaskFile({
    repoRoot: input.repoRoot,
    memoryId: input.memoryId,
    memoryPath,
  });
  if (!resolved) return null;
  try {
    return parseMemoryFile(input.repoRoot, memoryPath);
  } catch {
    return null;
  }
}

/** canonical root内のregular fileだけを解決し、frontmatter identityまで同時に束縛する。 */
export function resolveMemoryTaskFile(input: {
  repoRoot: string;
  memoryId: string;
  memoryPath: string;
}): string | null {
  if (!isCanonicalMemorySourcePath(input.memoryPath)) return null;
  const root = resolve(input.repoRoot, MEMORY_SOURCE_ROOT);
  const candidate = resolve(input.repoRoot, input.memoryPath);
  try {
    const rootStat = lstatSync(root);
    const fileStat = lstatSync(candidate);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) return null;
    const rel = relative(realpathSync(root), realpathSync(candidate));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    const memory = parseMemoryFile(input.repoRoot, input.memoryPath);
    return memory.memory_id === input.memoryId ? candidate : null;
  } catch {
    return null;
  }
}

/** 正本への書き込みを含む memory storage の単一入口。 */
export function writeMemory(input: { repoRoot: string; input: MemoryWriteInput }): MemoryEntry {
  return writeMemoryEntry(input.repoRoot, input.input);
}

/**
 * `ut-tdd memory add` 登録受領書 (PLAN-L6-104 §3.1 decision 7, U-MEMCUT-026)。
 *
 * `content_digest` は呼び手が読み戻した書き込み後の実バイト列から必ず算出する
 * (発行者主張の memory_id / digest を signed source として扱わない)。
 */
export interface MemoryRegistrationReceipt {
  operation_id: string;
  memory_id: string;
  source_path: string;
  content_digest: string;
  exit_code: 0;
}

export function registrationReceiptFor(input: {
  entry: MemoryEntry;
  rawText: string;
  operationId: string;
}): MemoryRegistrationReceipt {
  return {
    operation_id: input.operationId,
    memory_id: input.entry.memory_id,
    source_path: input.entry.source_path,
    content_digest: `sha256:${createHash("sha256").update(input.rawText, "utf8").digest("hex")}`,
    exit_code: 0,
  };
}

const WRITABLE_MEMORY_KINDS = new Set<MemoryKind>(["project", "feedback", "reference", "user"]);

/** MemoryService 内部だけが所有する正本 storage primitive。 */
function writeMemoryEntry(repoRoot: string, input: MemoryWriteInput): MemoryEntry {
  if (!WRITABLE_MEMORY_KINDS.has(input.kind)) throw new Error(`unknown memory kind: ${input.kind}`);
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title) throw new Error("memory title is required");
  if (!body) throw new Error("memory body is required");
  const tags = [...new Set(input.tags ?? [])]
    .map((tag) => tag.trim())
    .filter(Boolean)
    .sort();
  if (isSecretLike([title, body, ...tags].join("\n")))
    throw new Error("memory must not contain secret-like values");

  const memoryId = memoryIdFor({ kind: input.kind, title });
  // filename は memory_id から導くが上限で切り詰める。切り詰めても memory_id は全長のまま
  // frontmatter に載るので識別は失われない (issue #353)。
  const sourcePath = join(".ut-tdd", "memory", memoryFileNameFor(input.kind, memoryId)).replaceAll(
    "\\",
    "/",
  );
  // legacy 側は上限を掛けない。上限超過の legacy ファイルが既に disk 上にある場合、それを
  // 見失うと同一 memory が二重化する。新規流入だけを止めるのが本 fix の範囲。
  const legacySlug = memorySlugFor(title);
  const legacyMemoryId = `memory:${input.kind}:${legacySlug}`;
  const legacySourcePath = join(".ut-tdd", "memory", `${input.kind}-${legacySlug}.md`).replaceAll(
    "\\",
    "/",
  );
  const updatedAt = input.now ?? new Date().toISOString();
  const content = [
    "---",
    `memory_id: ${memoryId}`,
    `kind: ${input.kind}`,
    `title: ${JSON.stringify(title)}`,
    `tags: [${tags.map((tag) => JSON.stringify(tag)).join(", ")}]`,
    `updated_at: ${updatedAt}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
  let writeSourcePath = sourcePath;
  let targetPath = join(repoRoot, sourcePath);
  let targetIsLegacy = false;
  const isSameEntry = (existing: MemoryEntry): boolean =>
    (existing.memory_id === memoryId ||
      (targetIsLegacy && existing.memory_id === legacyMemoryId)) &&
    existing.kind === input.kind &&
    existing.title === title &&
    existing.body === body &&
    existing.tags.length === tags.length &&
    existing.tags.every((tag, index) => tag === tags[index]);
  const readExisting = (): MemoryEntry => {
    try {
      return parseMemoryFile(repoRoot, writeSourcePath);
    } catch (error) {
      throw new Error(`refusing to overwrite existing memory ${sourcePath}: ${String(error)}`);
    }
  };
  let targetExists = false;
  try {
    const stat = lstatSync(targetPath);
    targetExists = true;
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("target is not a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`refusing to overwrite existing memory ${sourcePath}: ${String(error)}`);
    }
  }

  // Existing pre-suffix files are still authoritative. Re-adding a title must
  // not fork the corpus merely because the new identity is collision-safe.
  if (!targetExists && sourcePath !== legacySourcePath) {
    const legacyPath = join(repoRoot, legacySourcePath);
    try {
      const stat = lstatSync(legacyPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("legacy target is not a regular file");
      }
      targetPath = legacyPath;
      writeSourcePath = legacySourcePath;
      targetIsLegacy = true;
      targetExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `refusing to overwrite existing memory ${legacySourcePath}: ${String(error)}`,
        );
      }
    }
  }

  if (targetExists) {
    const existing = readExisting();
    if (!isSameEntry(existing)) {
      throw new Error(`refusing to overwrite existing memory ${sourcePath}`);
    }
    return existing;
  }

  ensureDir(join(repoRoot, ".ut-tdd", "memory"), { recursive: true });
  try {
    // The preflight above gives a useful error for an existing path; wx closes
    // the check-then-write race between concurrent Claude/Codex notifications.
    writeFileSync(targetPath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readExisting();
    if (isSameEntry(existing)) return existing;
    throw new Error(`refusing to overwrite existing memory ${sourcePath}`);
  }
  return parseMemoryFile(repoRoot, writeSourcePath, content);
}

interface MemoryIndexDb {
  prepare(sql: string): { all(): Record<string, unknown>[] };
}

const MEMORY_DIR_SEGMENTS = [".ut-tdd", "memory"] as const;

function memoryRoot(repoRoot: string): string {
  return join(repoRoot, ...MEMORY_DIR_SEGMENTS);
}

function relativeMemoryPath(fileName: string): string {
  return join(...MEMORY_DIR_SEGMENTS, fileName).replaceAll("\\", "/");
}

/**
 * 正本ファイルを per-entry 隔離で読む。
 *
 * `loadMemoryEntries` は全件を map するため 1 件の frontmatter 欠落で全件が throw する
 * (2026-07-28 実測: db rebuild が手書き 1 件で 3m28s 後に中断)。読み路をファイルにする以上、
 * 破損 1 件で SessionStart 全体を落とせてはならないので、失敗は finding として隔離する。
 */
export function loadMemoryCorpus(repoRoot: string): MemoryCorpus {
  const root = memoryRoot(repoRoot);
  if (!existsSync(root)) return { entries: [], findings: [] };
  const entries: MemoryEntry[] = [];
  const findings: MemoryLoadFinding[] = [];
  for (const fileName of readdirSync(root).sort()) {
    if (!fileName.endsWith(".md")) continue;
    const sourcePath = relativeMemoryPath(fileName);
    try {
      entries.push(
        parseMemoryFile(repoRoot, sourcePath, readFileSync(join(root, fileName), "utf8")),
      );
    } catch (error) {
      findings.push({
        source_path: sourcePath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { entries, findings };
}

/**
 * filter / 順位 / limit の唯一の実装。
 *
 * 旧 SQL (`ORDER BY updated_at DESC, memory_id` + JS 側の部分一致 filter + slice) と同一
 * 意味論。等価性は tests/memory-service.test.ts の golden 比較で固定する。
 */
export function queryMemoryEntries(
  entries: readonly MemoryEntry[],
  opts: MemoryQueryOptions = {},
): MemoryEntry[] {
  const limit = opts.limit ?? 8;
  const query = opts.query?.trim().toLowerCase() ?? "";
  return [...entries]
    .sort((a, b) => {
      if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
      return a.memory_id < b.memory_id ? -1 : a.memory_id > b.memory_id ? 1 : 0;
    })
    .filter((entry) => {
      if (!query) return true;
      return [entry.title, entry.body, entry.tags.join(","), entry.kind]
        .join(" ")
        .toLowerCase()
        .includes(query);
    })
    .slice(0, limit);
}

/** index 側の照合値。body は読まない (index は body を持たない前提)。 */
interface IndexFingerprint {
  memory_id: string;
  content_hash: string;
}

function readIndexFingerprints(db: MemoryIndexDb): IndexFingerprint[] {
  return db
    .prepare("SELECT memory_id, content_hash FROM memory_entries")
    .all()
    .map((row) => ({
      memory_id: String(row.memory_id ?? ""),
      content_hash: String(row.content_hash ?? ""),
    }));
}

/**
 * ファイル正本と index の差分を判定する。
 *
 * 「index が古い」ことを検出できる唯一の手段が content_hash なので、body 列を落としても
 * この照合は成立する。差分の内容ではなく差分の有無だけを返す (読み手が要るのは
 * 「この結果を信じてよいか」だけ)。
 */
export function compareIndexToCorpus(
  entries: readonly MemoryEntry[],
  fingerprints: readonly IndexFingerprint[],
): { fresh: boolean; reason?: string } {
  const indexed = new Map(fingerprints.map((row) => [row.memory_id, row.content_hash]));
  const missing: string[] = [];
  const changed: string[] = [];
  for (const entry of entries) {
    const hash = indexed.get(entry.memory_id);
    if (hash === undefined) missing.push(entry.memory_id);
    else if (hash !== entry.content_hash) changed.push(entry.memory_id);
    indexed.delete(entry.memory_id);
  }
  const removed = [...indexed.keys()];
  if (missing.length === 0 && changed.length === 0 && removed.length === 0) return { fresh: true };
  const parts = [
    missing.length > 0 ? `not-indexed=${missing.length}` : "",
    changed.length > 0 ? `content-drift=${changed.length}` : "",
    removed.length > 0 ? `index-only=${removed.length}` : "",
  ].filter(Boolean);
  return { fresh: false, reason: parts.join(" ") };
}

/**
 * 読み出しの単一入口。
 *
 * index が読めない場合も**正本ファイルから結果を返す**。これは fallback ではなく、
 * ファイルが正本である以上の唯一の read path (advisor 2 系統の 2 巡目合意、2026-07-28)。
 * ただし degraded であることは freshness で必ず可視化する。
 */
export function readMemory(input: {
  repoRoot: string;
  db?: MemoryIndexDb;
  options?: MemoryQueryOptions;
}): MemoryReadResult {
  const corpus = loadMemoryCorpus(input.repoRoot);
  const selected = queryMemoryEntries(corpus.entries, input.options);
  if (!input.db) {
    return {
      entries: selected,
      findings: corpus.findings,
      freshness: "index-unavailable",
      freshness_reason: "index-not-opened",
    };
  }
  let comparison: { fresh: boolean; reason?: string };
  try {
    comparison = compareIndexToCorpus(corpus.entries, readIndexFingerprints(input.db));
  } catch (error) {
    return {
      entries: selected,
      findings: corpus.findings,
      freshness: "index-unavailable",
      freshness_reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (comparison.fresh) return { entries: selected, findings: corpus.findings, freshness: "fresh" };
  return {
    entries: selected,
    findings: corpus.findings,
    freshness: "stale",
    freshness_reason: comparison.reason,
  };
}

/**
 * 劣化と破損を必ず 1 行で見せる。
 *
 * 「0 件」と「読めない」を呼び手が区別できない状態が本 PLAN の欠陥 3 なので、
 * fresh 以外は必ず可視行を返す。
 */
export function renderMemoryHealth(result: MemoryReadResult): string {
  const lines: string[] = [];
  if (result.freshness !== "fresh") {
    const reason = result.freshness_reason ? ` (${result.freshness_reason})` : "";
    lines.push(
      `  memory index ${result.freshness}${reason} — 本文は .ut-tdd/memory の正本ファイルから読み出した`,
    );
  }
  for (const finding of result.findings) {
    lines.push(`  memory unreadable: ${finding.source_path} — ${finding.reason}`);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
