import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { isSecretLike } from "../secret";

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

function memoryRoot(repoRoot: string): string {
  return join(repoRoot, ".ut-tdd", "memory");
}

function assertMemorySafe(input: { title: string; body: string; tags?: string[] }): void {
  const payload = [input.title, input.body, ...(input.tags ?? [])].join("\n");
  if (isSecretLike(payload)) {
    throw new Error("memory must not contain secret-like values");
  }
}

export function memoryIdFor(input: { kind: MemoryKind; title: string }): string {
  return `memory:${input.kind}:${slugify(input.title)}`;
}

export function writeMemoryEntry(repoRoot: string, input: MemoryWriteInput): MemoryEntry {
  if (!VALID_KINDS.has(input.kind)) throw new Error(`unknown memory kind: ${input.kind}`);
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title) throw new Error("memory title is required");
  if (!body) throw new Error("memory body is required");
  const tags = [...new Set(input.tags ?? [])]
    .map((tag) => tag.trim())
    .filter(Boolean)
    .sort();
  assertMemorySafe({ title, body, tags });

  const root = memoryRoot(repoRoot);
  mkdirSync(root, { recursive: true });
  const id = memoryIdFor({ kind: input.kind, title });
  const fileName = `${input.kind}-${slugify(title)}.md`;
  const sourcePath = join(".ut-tdd", "memory", fileName).replaceAll("\\", "/");
  const updatedAt = input.now ?? new Date().toISOString();
  const content = [
    "---",
    `memory_id: ${id}`,
    `kind: ${input.kind}`,
    `title: ${JSON.stringify(title)}`,
    `tags: [${tags.map((tag) => JSON.stringify(tag)).join(", ")}]`,
    `updated_at: ${updatedAt}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
  writeFileSync(join(repoRoot, sourcePath), content, "utf8");
  return parseMemoryFile(repoRoot, sourcePath, content);
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
  const root = memoryRoot(repoRoot);
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
