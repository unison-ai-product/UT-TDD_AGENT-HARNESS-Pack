import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface ReadabilityDoc {
  path: string;
  text: string;
}

/**
 * A loaded artifact carrying BOTH the raw bytes and the utf8-decoded text from a
 * single read. `analyzeReadability` (string-level marker denylist) consumes `.text`;
 * `analyzeByteIntegrity` (byte-level positive validation) consumes `.bytes`. Sharing
 * one read avoids double I/O on the 700+ doc corpus (PLAN-L7-395 §2, I3).
 */
export interface ReadabilityArtifact extends ReadabilityDoc {
  bytes: Buffer;
}

export interface ReadabilityViolation {
  path: string;
  marker: string;
  line: number;
}

export interface ReadabilityResult {
  checked: number;
  violations: ReadabilityViolation[];
  ok: boolean;
}

const MOJIBAKE_MARKERS: { marker: string; pattern: RegExp }[] = [
  { marker: "replacement-character", pattern: /\uFFFD/ },
  { marker: "em-space-before-ascii", pattern: /\u2001(?=[A-Za-z])/ },
  // Halfwidth katakana / halfwidth punctuation (U+FF61–U+FF9F) is the CP932 single-byte
  // (0xA1–0xDF) artifact range. UT-TDD prose uses fullwidth Japanese only, so any halfwidth
  // form is a high-recall CP932-mojibake signal. This catches the 工程表→蟾･遞玖｡ｨ /
  // 直列→逶ｴ蛻余 class that the curated kanji list below missed (PLAN-M-00/01, 2026-06-17).
  { marker: "halfwidth-katakana", pattern: /[｡-ﾟ]/ },
  // Curated high-signal UTF-8/CP932 mojibake tokens observed in A-106/A-110/A-111 and the
  // PLAN-M cutover docs (蟾=工, 逶=直). This is intentionally heuristic; confirmed docs must be
  // restored from a clean source or reconstructed from context, not guessed.
  {
    marker: "cp932-mojibake",
    pattern: /窶|繝|縺|荳|螳|譁|竊|笞|莉|蜀|邨|逅|逕|隱|髢|雋|譛|蠑|蟄|莠|蛹|螟|蜿|谿|豁|竍|蟾|逶/,
  },
];

// G5 freeze 時に PM review 対象だった L5 PLAN (Codex 製で過去 mojibake が出た系)。
// A-120 m-3: 全 PLAN-L5-*.md の動的収集にしない理由 = freeze 品質で守る review band を
// 意図的に明示固定する (単一正本)。新規 freeze review 対象 PLAN を増やすときは本リストへ追記する。
const PM_REVIEW_PLAN_PATHS = [
  join("docs", "plans", "PLAN-L5-03-internal-processing.md"),
  join("docs", "plans", "PLAN-L5-05-roster.md"),
  join("docs", "plans", "PLAN-L5-06-skill.md"),
  join("docs", "plans", "PLAN-L5-07-drift.md"),
];

function firstLineOf(text: string, pattern: RegExp): number {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (pattern.test(lines[i])) return i + 1;
  }
  return 1;
}

export function analyzeReadability(docs: ReadabilityDoc[]): ReadabilityResult {
  const violations: ReadabilityViolation[] = [];
  for (const doc of docs) {
    for (const { marker, pattern } of MOJIBAKE_MARKERS) {
      const re = new RegExp(pattern.source, pattern.flags);
      if (!re.test(doc.text)) continue;
      violations.push({ path: doc.path, marker, line: firstLineOf(doc.text, re) });
    }
  }
  return { checked: docs.length, violations, ok: violations.length === 0 };
}

/** 1-based line of a raw byte offset (counts preceding LF bytes). */
function lineOfByte(bytes: Buffer, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < bytes.length; i += 1) {
    if (bytes[i] === 0x0a) line += 1;
  }
  return line;
}

/**
 * A byte that is a C0 control (0x00–0x1F) other than TAB/LF/CR, or DEL (0x7F).
 * In UTF-8 every multi-byte sequence byte is >= 0x80, so a byte < 0x20 is always a
 * literal ASCII control — this reliably catches the NUL bytes a BOM-less UTF-16LE
 * mis-save leaves behind (IMP-086), which neither U+FFFD nor strict decode surfaces.
 */
function isControlByte(b: number): boolean {
  return (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f;
}

/** Recursively test parsed-JSON keys and string values against the mojibake denylist. */
function jsonValueHasMojibake(value: unknown): boolean {
  const hit = (s: string) =>
    MOJIBAKE_MARKERS.some(({ pattern }) => new RegExp(pattern.source, pattern.flags).test(s));
  if (typeof value === "string") return hit(value);
  if (Array.isArray(value)) return value.some(jsonValueHasMojibake);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([k, v]) => hit(k) || jsonValueHasMojibake(v));
  }
  return false;
}

/**
 * Byte-level positive validation layer (PLAN-L7-395). Complements `analyzeReadability`'s
 * string-level marker denylist rather than replacing it: the denylist still catches the
 * double-encode class (`蟾･遞玖｡ｨ`) which is valid UTF-8 and passes strict decode, while this
 * layer deterministically catches signals the decoded string cannot express — a BOM
 * (invisible after utf8 decode), non-UTF-8 bytes, NUL/C0/C1 controls, and mojibake hidden
 * behind JSON escapes (`�` in raw text is only a literal U+FFFD after JSON.parse).
 */
export function analyzeByteIntegrity(files: ReadabilityArtifact[]): ReadabilityResult {
  const violations: ReadabilityViolation[] = [];
  for (const { path, bytes } of files) {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      violations.push({ path, marker: "utf8-bom", line: 1 });
    } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      violations.push({ path, marker: "utf16le-bom", line: 1 });
    } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      violations.push({ path, marker: "utf16be-bom", line: 1 });
    }

    // Strict UTF-8: a throw means non-well-formed bytes. Caught per-file so a single bad
    // artifact becomes an actionable violation, never an escaped exception that would
    // collapse into the generic I/O fail-close message (PLAN-L7-395 §2, I4).
    let decoded: string | null = null;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      violations.push({ path, marker: "invalid-utf8", line: 1 });
    }

    let controlLine: number | null = null;
    for (let i = 0; i < bytes.length; i += 1) {
      if (isControlByte(bytes[i])) {
        controlLine = lineOfByte(bytes, i);
        break;
      }
    }
    // C1 controls (U+0080–U+009F) are valid UTF-8 (encoded 0xC2 0x80..), so they only
    // surface on the decoded string, not the raw byte scan above.
    if (controlLine === null && decoded !== null) {
      for (let i = 0; i < decoded.length; i += 1) {
        const cp = decoded.charCodeAt(i);
        if (cp >= 0x80 && cp <= 0x9f) {
          controlLine = 1;
          break;
        }
      }
    }
    if (controlLine !== null) {
      violations.push({ path, marker: "control-character", line: controlLine });
    }

    if (path.endsWith(".json") && decoded !== null) {
      try {
        if (jsonValueHasMojibake(JSON.parse(decoded))) {
          violations.push({ path, marker: "json-escaped-mojibake", line: 1 });
        }
      } catch {
        // Malformed JSON: the raw-text marker scan in analyzeReadability already covers it.
      }
    }
  }
  return { checked: files.length, violations, ok: violations.length === 0 };
}

/**
 * Combined readability verdict over loaded artifacts: string-level marker denylist plus
 * byte-level integrity, merged into one ReadabilityResult. This is what the doctor gates
 * consume; both layers run off the single read carried by each ReadabilityArtifact.
 */
export function analyzeArtifacts(files: ReadabilityArtifact[]): ReadabilityResult {
  const text = analyzeReadability(files);
  const byte = analyzeByteIntegrity(files);
  return {
    checked: files.length,
    violations: [...text.violations, ...byte.violations],
    ok: text.ok && byte.ok,
  };
}

/** Single-read artifact loader: bytes + derived utf8 text (PLAN-L7-395 §2, I3). */
function readArtifact(fullPath: string, relPath: string): ReadabilityArtifact {
  const bytes = readFileSync(fullPath);
  return { path: relPath, bytes, text: bytes.toString("utf8") };
}

export function loadL6ReadabilityDocs(repoRoot: string = process.cwd()): ReadabilityArtifact[] {
  const dir = join(repoRoot, "docs", "design", "harness", "L6-function-design");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => {
      const path = join("docs", "design", "harness", "L6-function-design", name);
      return readArtifact(join(repoRoot, path), path);
    });
}

export function loadFreezeReadabilityDocs(repoRoot: string = process.cwd()): ReadabilityArtifact[] {
  const l6Docs = loadL6ReadabilityDocs(repoRoot);
  const pmReviewPlans = PM_REVIEW_PLAN_PATHS.filter((path) => existsSync(join(repoRoot, path))).map(
    (path) => readArtifact(join(repoRoot, path), path),
  );
  return [...l6Docs, ...pmReviewPlans];
}

interface WalkContext {
  repoRoot: string;
  extensions: readonly string[];
  acc: ReadabilityArtifact[];
}

function walkFiles(dir: string, ctx: WalkContext): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      // A statSync failure here is a transient race on live generated state
      // (entry deleted between readdir and statSync) — skip rather than crash
      // the whole gate, matching the original walkMarkdown contract. This does
      // NOT weaken fail-close: any file we DO select is read with readFileSync
      // below, whose failure propagates to checkRuntimeReadability's catch and
      // turns the gate red.
      continue;
    }
    if (st.isDirectory()) {
      walkFiles(full, ctx);
      continue;
    }
    if (!ctx.extensions.some((ext) => name.endsWith(ext))) continue;
    ctx.acc.push(readArtifact(full, relative(ctx.repoRoot, full)));
  }
}

function walkMarkdown(dir: string, repoRoot: string, acc: ReadabilityArtifact[]): void {
  walkFiles(dir, { repoRoot, extensions: [".md"], acc });
}

// Canonical instruction prose outside docs/ that must also stay mojibake-free.
const ROOT_READABILITY_DOCS = ["README.md", "CLAUDE.md", "AGENTS.md", join(".claude", "CLAUDE.md")];

// System-wide readability band: every active UT-TDD prose surface (full docs/ tree + canonical
// root instruction docs). vendor source snapshot and legacy local state are intentionally
// excluded — they are read-only migration material that may legitimately quote source-era
// encodings, so scanning them would create false positives, not protect active prose.
export function loadSystemReadabilityDocs(repoRoot: string = process.cwd()): ReadabilityArtifact[] {
  const acc: ReadabilityArtifact[] = [];
  const docsDir = join(repoRoot, "docs");
  if (existsSync(docsDir)) walkMarkdown(docsDir, repoRoot, acc);
  for (const rel of ROOT_READABILITY_DOCS) {
    const full = join(repoRoot, rel);
    if (existsSync(full)) acc.push(readArtifact(full, rel));
  }
  return acc.sort((a, b) => a.path.localeCompare(b.path));
}

export function readabilityMessages(result: ReadabilityResult): string[] {
  if (result.ok) {
    return [`readability — OK (prose docs ${result.checked}件 mojibake marker 0)`];
  }
  const sample = result.violations
    .slice(0, 8)
    .map((v) => `${v.path}:${v.line}:${v.marker}`)
    .join(", ");
  return [
    `readability — ⚠ mojibake markers ${result.violations.length}件 (${sample})。confirmed doc は復元してから freeze する (IMP-089/091)`,
  ];
}

// Generated runtime artifacts that must stay readable even though they live
// outside docs/. handover/audit text and cross-agent provider JSON are the
// highest-risk mojibake surface (Codex-generated payloads), yet the prose band
// only covers docs/. PLAN-L7-69 §2-3 extends the guard here: .ut-tdd/audit/**
// markdown + .ut-tdd/handover/** JSON (provider cross-agent payloads included).
// .ut-tdd/ is active product-owned runtime state, NOT a vendor source snapshot,
// so scanning it is safe — historical vendor snapshots and legacy local state
// live elsewhere and stay excluded (PLAN-L7-69 §3 scoping AC).
const RUNTIME_READABILITY_DIRS: { rel: string; extensions: readonly string[] }[] = [
  { rel: join(".ut-tdd", "audit"), extensions: [".md"] },
  { rel: join(".ut-tdd", "handover"), extensions: [".json"] },
];

export function loadRuntimeArtifactReadabilityDocs(
  repoRoot: string = process.cwd(),
): ReadabilityArtifact[] {
  const acc: ReadabilityArtifact[] = [];
  for (const { rel, extensions } of RUNTIME_READABILITY_DIRS) {
    const dir = join(repoRoot, rel);
    if (existsSync(dir)) walkFiles(dir, { repoRoot, extensions, acc });
  }
  return acc.sort((a, b) => a.path.localeCompare(b.path));
}

export function runtimeReadabilityMessages(result: ReadabilityResult): string[] {
  if (result.ok) {
    return [
      `runtime-readability — OK (.ut-tdd audit/handover artifacts ${result.checked}件 mojibake marker 0)`,
    ];
  }
  const sample = result.violations
    .slice(0, 8)
    .map((v) => `${v.path}:${v.line}:${v.marker}`)
    .join(", ");
  return [
    `runtime-readability — ⚠ mojibake markers ${result.violations.length}件 (${sample})。provider JSON / audit は clean source から復元する (PLAN-L7-69)`,
  ];
}
