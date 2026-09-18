import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { isSecretLike } from "../secret.ts";

export type MemoryKind = "project" | "feedback" | "reference" | "user";

export interface MemoryEntry {
  memory_id: string;
  kind: MemoryKind;
  title: string;
  body: string;
  tags: string[];
  source_path: string;
  updated_at: string;
  content_hash: string;
}

export interface MemoryWriteInput {
  kind: MemoryKind;
  title: string;
  body: string;
  tags?: string[];
  now?: string;
}

interface MemoryQueryDb {
  prepare(sql: string): {
    all(): Record<string, unknown>[];
  };
}

const VALID_KINDS = new Set<MemoryKind>(["project", "feedback", "reference", "user"]);

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "memory";
}

function slugLosesTitleInformation(value: string): boolean {
  // Spaces and hyphens are the existing human-readable separators. Anything
  // else (including non-ASCII and punctuation) needs an identity suffix.
  return !/^[a-z0-9]+(?:[ -]+[a-z0-9]+)*$/i.test(value);
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value))
    return value
      .map((v) => String(v).trim())
      .filter(Boolean)
      .sort();
  if (typeof value === "string") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .sort();
  }
  return [];
}

/** Canonical authored Memory storage location; callers may supply the canonical project root. */
export function memoryStorageRoot(repoRoot: string): string {
  return join(repoRoot, ".ut-tdd", "memory");
}

export function memoryIdFor(input: { kind: MemoryKind; title: string }): string {
  const slug = memorySlugFor(input.title);
  const suffix = slugLosesTitleInformation(input.title)
    ? `--${stableHash(input.title).slice(0, 12)}`
    : "";
  return `memory:${input.kind}:${slug}${suffix}`;
}

export function memorySlugFor(title: string): string {
  return slugify(title);
}

/**
 * filename の basename 上限 (拡張子込み)。
 *
 * `memory_id` は title 全長由来の slug なので、そのまま filename にすると Windows の
 * MAX_PATH (260) を超えて **checkout 自体が失敗**する (issue #353、実測 repo 相対 265 文字)。
 * 120 にすると repo 相対は `.ut-tdd/memory/` (16) + 120 = 136 で、CI の checkout root
 * (GitHub runner の `D:/a/<repo>/<repo>/` 相当で ~48) を足しても ~184 と余裕がある。
 */
export const MEMORY_FILENAME_MAX = 120;

/**
 * `memory_id` から正本ファイル名を導く。
 *
 * 契約 (issue #353、advisor gpt-5.6-sol 合議):
 * - `memory_id` は全長のまま。正本識別子であり projection / freshness / notification が鍵にする。
 * - 上限内の名前は現行形式を完全維持 (既存 corpus を移行させない)。
 * - 超過時だけ可読 prefix を切り詰め、切り詰め前の完全な `memory_id` の sha256 先頭 16 桁を
 *   付す。短縮 hash は確率的なので、衝突は書き込み側が既存ファイルの `memory_id` 照合で
 *   fail-close する (MemoryService の責務)。
 */
export function memoryFileNameFor(kind: MemoryKind, memoryId: string): string {
  const slug = memoryId.slice(`memory:${kind}:`.length);
  const plain = `${kind}-${slug}.md`;
  if (plain.length <= MEMORY_FILENAME_MAX) return plain;
  const digest = stableHash(memoryId).slice(0, 16);
  const budget = MEMORY_FILENAME_MAX - `${kind}-`.length - 1 - digest.length - ".md".length;
  const head = slug.slice(0, budget).replace(/-+$/, "");
  return `${kind}-${head}-${digest}.md`;
}

export function parseMemoryFile(
  repoRoot: string,
  sourcePath: string,
  content?: string,
): MemoryEntry {
  const text = content ?? readFileSync(join(repoRoot, sourcePath), "utf8");
  if (isSecretLike(text)) throw new Error(`memory contains secret-like value: ${sourcePath}`);
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error(`memory frontmatter is required: ${sourcePath}`);
  const fm = (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
  const kind = String(fm.kind ?? "").trim() as MemoryKind;
  if (!VALID_KINDS.has(kind)) throw new Error(`unknown memory kind in ${sourcePath}: ${kind}`);
  const title = String(fm.title ?? "").trim();
  if (!title) throw new Error(`memory title is required: ${sourcePath}`);
  const body = String(match[2] ?? "").trim();
  if (!body) throw new Error(`memory body is required: ${sourcePath}`);
  const tags = normalizeTags(fm.tags);
  const id = String(fm.memory_id ?? memoryIdFor({ kind, title })).trim();
  const updatedAt = String(fm.updated_at ?? "").trim();
  return {
    memory_id: id,
    kind,
    title,
    body,
    tags,
    source_path: sourcePath.replaceAll("\\", "/"),
    updated_at: updatedAt,
    content_hash: stableHash(text),
  };
}

export function loadMemoryEntries(repoRoot: string): MemoryEntry[] {
  const root = memoryStorageRoot(repoRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => parseMemoryFile(repoRoot, join(".ut-tdd", "memory", name)));
}

export function selectMemoryEntries(
  db: MemoryQueryDb,
  opts: { query?: string; limit?: number } = {},
): MemoryEntry[] {
  const limit = opts.limit ?? 8;
  const query = opts.query?.trim().toLowerCase() ?? "";
  const rows = db
    .prepare(
      "SELECT memory_id, kind, title, body, tags, source_path, updated_at, content_hash FROM memory_entries ORDER BY updated_at DESC, memory_id",
    )
    .all() as Array<Record<string, unknown>>;
  return rows
    .filter((row) => {
      if (!query) return true;
      return [row.title, row.body, row.tags, row.kind].join(" ").toLowerCase().includes(query);
    })
    .slice(0, limit)
    .map((row) => ({
      memory_id: String(row.memory_id ?? ""),
      kind: String(row.kind ?? "project") as MemoryKind,
      title: String(row.title ?? ""),
      body: String(row.body ?? ""),
      tags: normalizeTags(row.tags),
      source_path: String(row.source_path ?? ""),
      updated_at: String(row.updated_at ?? ""),
      content_hash: String(row.content_hash ?? ""),
    }));
}

export function renderMemorySurface(entries: MemoryEntry[]): string {
  if (entries.length === 0) return "";
  const lines = [
    `harness.db memory (items=${entries.length}) - source=.ut-tdd/memory projection, shared by Claude/Codex`,
  ];
  for (const entry of entries) {
    const tags = entry.tags.length > 0 ? ` tags=${entry.tags.join(",")}` : "";
    const body = entry.body.replace(/\s+/g, " ").slice(0, 160);
    lines.push(`  - ${entry.kind} ${entry.title}${tags}: ${body}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderMemoryList(entries: MemoryEntry[]): string {
  if (entries.length === 0) return "memory: no entries\n";
  return `${entries
    .map(
      (entry) =>
        `${entry.memory_id}\t${entry.kind}\t${entry.title}\t${basename(entry.source_path)}`,
    )
    .join("\n")}\n`;
}
