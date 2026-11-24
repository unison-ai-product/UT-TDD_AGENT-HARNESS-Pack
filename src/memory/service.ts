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

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveDefaultBranchRef } from "../git/default-branch.ts";
import { loadProjectIdentityFromHead } from "../kernel/project-identity.ts";
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

export type MemoryArchiveCheckpointPoint =
  | "beforeIntentAppend"
  | "afterIntentAppendBeforeRename"
  | "afterRenameBeforeDbDelete"
  | "afterDbDeleteBeforeDoneAppend";

export interface MemoryEpisodeRetirable {
  memory_id: string;
  source_path: string;
  lifecycle_source: "declared" | "inferred";
  bound_to: string[];
}

export interface MemoryEpisodeMove {
  memory_id: string;
  source_path: string;
  destination_path: string;
  sha256: string;
}

export interface RetireMemoryEpisodesResult {
  ok: true;
  dryRun: boolean;
  total: number;
  counts: {
    tracked_durable: number;
    untracked_durable: number;
    episode_retirable_declared: number;
    episode_ok_declared: number;
    episode_unknown_declared: number;
    episode_retirable_inferred: number;
    episode_ok_inferred: number;
    episode_unknown_inferred: number;
    parse_failed: number;
    not_memory_entry: number;
  };
  retirable: MemoryEpisodeRetirable[];
  moved: MemoryEpisodeMove[];
}

export interface RetireMemoryEpisodesFailure {
  ok: false;
  reason: "memory_archive_recovery_conflict" | "memory_archive_io_failed";
}

export interface MemoryArchiveDbPort {
  inspectEntry(input: { memoryId: string; sourcePath: string; contentHash: string }): {
    status: "match" | "row_absent" | "row_mismatch" | "schema_unready";
  };
  deleteEntryRow(input: { memoryId: string; sourcePath: string }): { deleted: number };
}

export interface RetireMemoryEpisodesPorts {
  resolveGitHubStatus?: (input: { url: string }) => { state: "open" | "closed" | "unknown" };
  db: MemoryArchiveDbPort;
  checkpoint?: (input: {
    point: MemoryArchiveCheckpointPoint;
    memoryId: string;
    sourcePath: string;
    destinationPath: string;
    sha256: string;
  }) => void;
}

interface MemoryEpisodeArchiveEvent {
  schema: "ut-tdd.memory-episode-archive/v1";
  state: "intent" | "done";
  memory_id: string;
  source_path: string;
  destination_path: string;
  sha256: string;
  bytes: number;
  bound_to: string[];
  selection_basis: {
    kind: "memory-episode-closure/v1";
    lifecycle_source: "declared" | "inferred";
    closed_evidence: Array<
      | { url: string; via: "git_first_parent_merge"; commit_sha: string }
      | { url: string; via: "github_closed"; observed_state: "closed" }
    >;
  };
  recorded_at: string;
}

const MEMORY_EPISODE_MANIFEST_SCHEMA = "ut-tdd.memory-episode-archive/v1" as const;
const MEMORY_EPISODE_MANIFEST_RELATIVE = join(
  ".ut-tdd",
  "archive",
  "memory-episodes",
  "manifest.jsonl",
);

class MemoryArchiveFailure extends Error {
  readonly reason: RetireMemoryEpisodesFailure["reason"];

  constructor(reason: RetireMemoryEpisodesFailure["reason"]) {
    super(reason);
    this.reason = reason;
  }
}

class MemoryArchiveCheckpointThrown extends Error {
  readonly original: unknown;

  constructor(original: unknown) {
    super("memory archive checkpoint threw");
    this.original = original;
  }
}

/** Retire closed declared project-memory episodes through the injected storage port. */
export function retireMemoryEpisodes(
  input: { repoRoot: string; nowISO: string; dryRun?: boolean; includeInferred?: boolean },
  ports: RetireMemoryEpisodesPorts,
): RetireMemoryEpisodesResult | RetireMemoryEpisodesFailure {
  if (!isUtcIsoTimestamp(input.nowISO))
    throw new TypeError("nowISO must be a valid UTC ISO-8601 timestamp");

  const db = ports?.db;
  if (!db || typeof db.inspectEntry !== "function" || typeof db.deleteEntryRow !== "function") {
    return { ok: false, reason: "memory_archive_io_failed" };
  }

  const dryRun = input.dryRun ?? true;
  function failRecovery(): never {
    throw new MemoryArchiveFailure("memory_archive_recovery_conflict");
  }
  const emptyCounts = (): RetireMemoryEpisodesResult["counts"] => ({
    tracked_durable: 0,
    untracked_durable: 0,
    episode_retirable_declared: 0,
    episode_ok_declared: 0,
    episode_unknown_declared: 0,
    episode_retirable_inferred: 0,
    episode_ok_inferred: 0,
    episode_unknown_inferred: 0,
    parse_failed: 0,
    not_memory_entry: 0,
  });

  try {
    // Inferred entries remain outside this narrow archive operation.
    if (input.includeInferred === true) failRecovery();
    const repoRoot = canonicalMainRepositoryRoot(input.repoRoot);
    const manifestPath = join(repoRoot, MEMORY_EPISODE_MANIFEST_RELATIVE);
    const completedIds = new Set<string>();
    let manifestExists = false;
    let manifestBefore: string | null = null;
    if (pathExistsNoFollow(manifestPath)) {
      manifestExists = true;
      const manifestStat = lstatSync(manifestPath);
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) failRecovery();
      const manifestText = readFileSync(manifestPath, "utf8");
      manifestBefore = manifestText;
      if (manifestText !== "" && !manifestText.endsWith("\n")) failRecovery();
      const lines = manifestText === "" ? [] : manifestText.slice(0, -1).split("\n");
      if (lines.some((line) => line.trim() === "")) failRecovery();
      const events: MemoryEpisodeArchiveEvent[] = [];
      for (const line of lines) {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          failRecovery();
        }
        if (isStateChannelArchiveEvent(value)) continue;
        if (!isMemoryEpisodeArchiveEvent(value)) failRecovery();
        events.push(value);
      }
      for (let index = 0; index < events.length; index += 1) {
        const intent = events[index];
        if (!intent || intent.state !== "intent") failRecovery();
        const done = events[index + 1];
        if (!done || done.state !== "done" || !sameMemoryEpisodePayload(intent, done)) {
          failRecovery();
        }
        index += 1;
        const sourceParts = done.source_path.replaceAll("\\", "/").split("/");
        const source = resolve(repoRoot, intent.source_path);
        const destination = resolve(repoRoot, done.destination_path);
        if (
          !isCanonicalMemorySourcePath(done.source_path) ||
          sourceParts.length !== 3 ||
          done.source_path !== sourceParts.join("/") ||
          intent.source_path !== done.source_path ||
          !isContainedWithin(repoRoot, source) ||
          !isContainedWithin(repoRoot, destination)
        ) {
          failRecovery();
        }
        if (pathExistsNoFollow(source) || !pathExistsNoFollow(destination)) failRecovery();
        const destinationParts = done.destination_path.replaceAll("\\", "/").split("/");
        if (
          destinationParts.length !== 5 ||
          destinationParts[0] !== ".ut-tdd" ||
          destinationParts[1] !== "archive" ||
          destinationParts[2] !== "memory-episodes" ||
          !/^\d{4}-\d{2}$/.test(destinationParts[3] ?? "") ||
          destinationParts[3] !== done.recorded_at.slice(0, 7) ||
          destinationParts[4] !== sourceParts[2]
        ) {
          failRecovery();
        }
        assertSafeArchiveParents(repoRoot, destinationParts[3] as string);
        const destinationStat = lstatSync(destination);
        if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) failRecovery();
        const archivedBytes = readFileSync(destination);
        if (
          archivedBytes.byteLength !== done.bytes ||
          createHash("sha256").update(archivedBytes).digest("hex") !== done.sha256
        ) {
          failRecovery();
        }
        let archivedEntry: MemoryEntry;
        try {
          archivedEntry = parseMemoryFile(
            repoRoot,
            done.source_path,
            archivedBytes.toString("utf8"),
          );
        } catch {
          failRecovery();
        }
        if (
          archivedEntry.memory_id !== done.memory_id ||
          archivedEntry.source_path !== done.source_path ||
          memoryFileNameFor(archivedEntry.kind, archivedEntry.memory_id) !== sourceParts[2]
        ) {
          failRecovery();
        }
        completedIds.add(done.memory_id);
      }
    }
    const memoryDir = join(repoRoot, MEMORY_SOURCE_ROOT);
    const memoryDirStat = lstatSync(memoryDir);
    if (!memoryDirStat.isDirectory() || memoryDirStat.isSymbolicLink()) failRecovery();
    const memoryDirReal = realpathSync(memoryDir);
    if (!isContainedWithin(repoRoot, memoryDirReal)) failRecovery();

    const directoryEntries = readdirSync(memoryDir).sort();
    const candidates = directoryEntries.filter((name) => name.toLowerCase().endsWith(".md"));
    if (candidates.length > 1 || directoryEntries.length !== candidates.length) {
      failRecovery();
    }
    if (candidates.length === 0) {
      const counts = emptyCounts();
      return { ok: true, dryRun: input.dryRun ?? true, total: 0, counts, retirable: [], moved: [] };
    }

    const sourceName = candidates[0];
    const sourcePath = join(MEMORY_SOURCE_ROOT, sourceName).replaceAll("\\", "/");
    if (isTrackedMemoryPath(repoRoot, sourcePath)) failRecovery();
    const sourceAbsolute = resolve(repoRoot, sourcePath);
    const sourceStat = lstatSync(sourceAbsolute);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) failRecovery();
    const sourceReal = realpathSync(sourceAbsolute);
    if (!isContainedWithin(memoryDirReal, sourceReal) || dirname(sourceReal) !== memoryDirReal) {
      failRecovery();
    }

    const rawBytes = readFileSync(sourceAbsolute);
    const rawText = rawBytes.toString("utf8");
    const entry = parseMemoryFile(repoRoot, sourcePath, rawText);
    if (
      resolveMemoryTaskFile({ repoRoot, memoryId: entry.memory_id, memoryPath: sourcePath }) !==
      sourceAbsolute
    ) {
      failRecovery();
    }
    const frontmatterMatch = rawText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!frontmatterMatch) failRecovery();
    const frontmatter = parseYaml(frontmatterMatch[1]) as Record<string, unknown> | null;
    if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter))
      failRecovery();

    if (
      frontmatter.lifecycle !== "episode" ||
      frontmatter.lifecycle_source !== "declared" ||
      !Array.isArray(frontmatter.bound_to) ||
      frontmatter.bound_to.length === 0 ||
      !frontmatter.bound_to.every((url) => typeof url === "string")
    ) {
      failRecovery();
    }

    const identity = loadProjectIdentityFromHead({ repoRoot });
    if (!identity.ok) failRecovery();
    const boundTo = [...(frontmatter.bound_to as string[])].sort();
    if (boundTo.length === 0) failRecovery();
    const parsedBounds = boundTo.map((url) =>
      parseBoundGitHubUrl(url, identity.value.repositoryIdentity),
    );
    if (parsedBounds.some((bound) => bound === null)) failRecovery();
    if (completedIds.has(entry.memory_id)) failRecovery();

    const projection = { memoryId: entry.memory_id, sourcePath, contentHash: entry.content_hash };
    if (db.inspectEntry(projection).status !== "match") failRecovery();
    const month = input.nowISO.slice(0, 7);
    assertSafeArchiveParents(repoRoot, month);

    const destinationPath = join(
      ".ut-tdd",
      "archive",
      "memory-episodes",
      month,
      sourceName,
    ).replaceAll("\\", "/");
    const destinationAbsolute = resolve(repoRoot, destinationPath);
    if (pathExistsNoFollow(destinationAbsolute)) failRecovery();
    if (!isContainedWithin(repoRoot, destinationAbsolute)) failRecovery();

    const closedEvidence: MemoryEpisodeArchiveEvent["selection_basis"]["closed_evidence"] = [];
    const states: Array<"open" | "closed" | "unknown"> = [];
    const defaultBranch = resolveDefaultBranchRef(repoRoot);
    for (let index = 0; index < boundTo.length; index += 1) {
      const url = boundTo[index];
      const parsed = parsedBounds[index];
      if (!url || !parsed) failRecovery();
      let commitSha: string | null = null;
      if (parsed.kind === "pull" && defaultBranch) {
        try {
          const mergeLog = execFileSync(
            "git",
            [
              "-C",
              repoRoot,
              "log",
              "--first-parent",
              "--merges",
              "--format=%H%x00%s",
              defaultBranch.ref,
            ],
            { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
          ).trimEnd();
          const expectedSubjectPrefix = `Merge pull request #${parsed.number} `;
          for (const line of mergeLog.split(/\r?\n/)) {
            const separator = line.indexOf("\0");
            if (separator < 0) continue;
            const sha = line.slice(0, separator);
            const subject = line.slice(separator + 1);
            if (/^[0-9a-f]{40}$/.test(sha) && subject.startsWith(expectedSubjectPrefix)) {
              commitSha = sha;
              break;
            }
          }
        } catch {
          commitSha = null;
        }
      }
      if (commitSha) {
        states.push("closed");
        closedEvidence.push({ url, via: "git_first_parent_merge", commit_sha: commitSha });
        continue;
      }
      let state: "open" | "closed" | "unknown" = "unknown";
      if (ports.resolveGitHubStatus) {
        try {
          const resolved = ports.resolveGitHubStatus({ url });
          if (
            resolved &&
            typeof resolved === "object" &&
            (resolved.state === "open" ||
              resolved.state === "closed" ||
              resolved.state === "unknown")
          ) {
            state = resolved.state;
          }
        } catch {
          state = "unknown";
        }
      }
      states.push(state);
      if (state === "closed")
        closedEvidence.push({ url, via: "github_closed", observed_state: "closed" });
    }
    const status = states.includes("open")
      ? "open"
      : states.every((state) => state === "closed")
        ? "closed"
        : "unknown";
    const closed = status === "closed";
    const counts = emptyCounts();
    counts[
      closed
        ? "episode_retirable_declared"
        : status === "open"
          ? "episode_ok_declared"
          : "episode_unknown_declared"
    ] = 1;
    const retirable: MemoryEpisodeRetirable[] = closed
      ? [
          {
            memory_id: entry.memory_id,
            source_path: sourcePath,
            lifecycle_source: "declared",
            bound_to: boundTo,
          },
        ]
      : [];
    const move: MemoryEpisodeMove = {
      memory_id: entry.memory_id,
      source_path: sourcePath,
      destination_path: destinationPath,
      sha256: createHash("sha256").update(rawBytes).digest("hex"),
    };
    const moved = closed ? [move] : [];
    if (dryRun || !closed) {
      return { ok: true, dryRun, total: 1, counts, retirable, moved };
    }

    // Repeat path and projection checks at the mutation boundary; no file/DB writes occurred above.
    if (
      pathExistsNoFollow(destinationAbsolute) ||
      pathExistsNoFollow(manifestPath) !== manifestExists ||
      (manifestExists && readFileSync(manifestPath, "utf8") !== manifestBefore)
    ) {
      failRecovery();
    }
    const currentStat = lstatSync(sourceAbsolute);
    if (!currentStat.isFile() || currentStat.isSymbolicLink()) failRecovery();
    const currentBytes = readFileSync(sourceAbsolute);
    if (!currentBytes.equals(rawBytes)) failRecovery();
    if (db.inspectEntry(projection).status !== "match") failRecovery();
    const event: MemoryEpisodeArchiveEvent = {
      schema: MEMORY_EPISODE_MANIFEST_SCHEMA,
      state: "intent",
      memory_id: entry.memory_id,
      source_path: sourcePath,
      destination_path: destinationPath,
      sha256: move.sha256,
      bytes: rawBytes.byteLength,
      bound_to: boundTo,
      selection_basis: {
        kind: "memory-episode-closure/v1",
        lifecycle_source: frontmatter.lifecycle_source as "declared" | "inferred",
        closed_evidence: closedEvidence,
      },
      recorded_at: input.nowISO,
    };
    const checkpointInput = (point: MemoryArchiveCheckpointPoint) => ({
      point,
      memoryId: entry.memory_id,
      sourcePath,
      destinationPath,
      sha256: move.sha256,
    });
    const checkpoint = (point: MemoryArchiveCheckpointPoint): void => {
      if (!ports.checkpoint) return;
      try {
        ports.checkpoint(checkpointInput(point));
      } catch (error) {
        throw new MemoryArchiveCheckpointThrown(error);
      }
    };

    checkpoint("beforeIntentAppend");
    ensureDir(dirname(manifestPath), { recursive: true });
    if (manifestExists) appendFileSync(manifestPath, `${JSON.stringify(event)}\n`, "utf8");
    else
      writeFileSync(manifestPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "wx" });
    checkpoint("afterIntentAppendBeforeRename");
    ensureDir(dirname(destinationAbsolute), { recursive: true });
    renameSync(sourceAbsolute, destinationAbsolute);
    checkpoint("afterRenameBeforeDbDelete");
    const result = db.deleteEntryRow({ memoryId: entry.memory_id, sourcePath });
    if (result.deleted !== 1) failRecovery();
    checkpoint("afterDbDeleteBeforeDoneAppend");
    appendFileSync(
      manifestPath,
      `${JSON.stringify({ ...event, state: "done" } satisfies MemoryEpisodeArchiveEvent)}\n`,
      "utf8",
    );
    return { ok: true, dryRun, total: 1, counts, retirable, moved };
  } catch (error) {
    if (error instanceof MemoryArchiveCheckpointThrown) throw error.original;
    if (error instanceof MemoryArchiveFailure) return { ok: false, reason: error.reason };
    return { ok: false, reason: "memory_archive_io_failed" };
  }
}

function isUtcIsoTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, fraction = ""] = match;
  const milliseconds = Number(fraction.padEnd(3, "0"));
  const date = new Date(value);
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString() ===
      `${year}-${month}-${day}T${hour}:${minute}:${second}.${String(milliseconds).padStart(3, "0")}Z`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameJsonValue(left[key], right[key]))
  );
}

function sameMemoryEpisodePayload(
  intent: MemoryEpisodeArchiveEvent,
  done: MemoryEpisodeArchiveEvent,
): boolean {
  const { state: intentState, ...intentPayload } = intent;
  const { state: doneState, ...donePayload } = done;
  return (
    intentState === "intent" && doneState === "done" && sameJsonValue(intentPayload, donePayload)
  );
}

function isMemoryEpisodeArchiveEvent(value: unknown): value is MemoryEpisodeArchiveEvent {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schema",
      "state",
      "memory_id",
      "source_path",
      "destination_path",
      "sha256",
      "bytes",
      "bound_to",
      "selection_basis",
      "recorded_at",
    ]) ||
    value.schema !== MEMORY_EPISODE_MANIFEST_SCHEMA ||
    (value.state !== "intent" && value.state !== "done") ||
    typeof value.memory_id !== "string" ||
    value.memory_id.length === 0 ||
    typeof value.source_path !== "string" ||
    typeof value.destination_path !== "string" ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 0 ||
    !Array.isArray(value.bound_to) ||
    !value.bound_to.every((url) => typeof url === "string") ||
    !isUtcIsoTimestamp(String(value.recorded_at))
  ) {
    return false;
  }
  const basis = value.selection_basis;
  if (
    !isRecord(basis) ||
    !hasExactKeys(basis, ["kind", "lifecycle_source", "closed_evidence"]) ||
    basis.kind !== "memory-episode-closure/v1" ||
    (basis.lifecycle_source !== "declared" && basis.lifecycle_source !== "inferred") ||
    !Array.isArray(basis.closed_evidence)
  ) {
    return false;
  }
  const evidenceUrls: string[] = [];
  for (const evidence of basis.closed_evidence) {
    if (!isRecord(evidence) || typeof evidence.url !== "string") return false;
    if (
      hasExactKeys(evidence, ["url", "via", "commit_sha"]) &&
      evidence.via === "git_first_parent_merge" &&
      typeof evidence.commit_sha === "string" &&
      /^[0-9a-f]{40}$/.test(evidence.commit_sha)
    ) {
      evidenceUrls.push(evidence.url);
      continue;
    }
    if (
      hasExactKeys(evidence, ["url", "via", "observed_state"]) &&
      evidence.via === "github_closed" &&
      evidence.observed_state === "closed"
    ) {
      evidenceUrls.push(evidence.url);
      continue;
    }
    return false;
  }
  const boundTo = value.bound_to as string[];
  return (
    boundTo.length > 0 &&
    JSON.stringify(boundTo) === JSON.stringify([...boundTo].sort()) &&
    JSON.stringify(evidenceUrls) === JSON.stringify(boundTo)
  );
}

function isStateChannelArchiveEvent(value: unknown): boolean {
  if (!isRecord(value) || value.schema !== "ut-tdd.state-channel-memory-archive/v1") return false;
  if (
    !hasExactKeys(value, [
      "schema",
      "state",
      "memory_id",
      "source_path",
      "destination_path",
      "sha256",
      "bytes",
      "bound_to",
      "selection_basis",
      "recorded_at",
    ]) ||
    (value.state !== "intent" && value.state !== "done") ||
    typeof value.memory_id !== "string" ||
    value.memory_id.length === 0 ||
    typeof value.source_path !== "string" ||
    typeof value.destination_path !== "string" ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 0 ||
    !Array.isArray(value.bound_to) ||
    value.bound_to.length !== 0 ||
    !isUtcIsoTimestamp(String(value.recorded_at))
  ) {
    return false;
  }
  const basis = value.selection_basis;
  return (
    isRecord(basis) &&
    hasExactKeys(basis, ["kind", "snapshot_sha256", "memory_id", "content_sha256"]) &&
    basis.kind === "state-channel-target-snapshot/v1" &&
    typeof basis.snapshot_sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(basis.snapshot_sha256) &&
    basis.memory_id === value.memory_id &&
    basis.content_sha256 === value.sha256
  );
}

function canonicalMainRepositoryRoot(repoRoot: string): string {
  const root = realpathSync(repoRoot);
  const gitDirectory = lstatSync(join(root, ".git"));
  if (!gitDirectory.isDirectory() || gitDirectory.isSymbolicLink()) {
    throw new MemoryArchiveFailure("memory_archive_recovery_conflict");
  }
  const gitRoot = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const commonDir = execFileSync(
    "git",
    ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  ).trim();
  if (
    realpathSync(gitRoot) !== root ||
    realpathSync(commonDir) !== realpathSync(join(root, ".git"))
  ) {
    throw new MemoryArchiveFailure("memory_archive_recovery_conflict");
  }
  return root;
}

function isContainedWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel !== "" && rel !== "." && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)
  );
}

function isTrackedMemoryPath(repoRoot: string, sourcePath: string): boolean {
  try {
    execFileSync("git", ["-C", repoRoot, "ls-files", "--error-unmatch", "--", sourcePath], {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

function parseBoundGitHubUrl(
  value: string,
  repositoryIdentity: string,
): { kind: "pull" | "issue"; number: number } | null {
  const escapedIdentity = repositoryIdentity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `^https://github\\.com/${escapedIdentity}/(pull|issues)/([1-9][0-9]*)$`,
  ).exec(value);
  if (!match) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) return null;
  return { kind: match[1] === "pull" ? "pull" : "issue", number };
}

function pathExistsNoFollow(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertSafeArchiveParents(repoRoot: string, month: string): void {
  const parts = [".ut-tdd", "archive", "memory-episodes", month];
  let current = repoRoot;
  for (const part of parts) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !isContainedWithin(repoRoot, realpathSync(current))
      ) {
        throw new MemoryArchiveFailure("memory_archive_recovery_conflict");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}
