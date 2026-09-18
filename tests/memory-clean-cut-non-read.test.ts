import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalAuthoredMemoryPath } from "../src/cli/review-live.ts";
import { canonicalProjectIdentityBytes } from "../src/kernel/project-identity.ts";
import { loadMemorySyncInput } from "../src/lint/memory-sync.ts";
import { loadMemoryEntries, type MemoryEntry, parseMemoryFile } from "../src/memory/index.ts";
import { LEGACY_MEMORY_ARCHIVE_ROOT, sha256Hex } from "../src/memory/legacy-archive-manifest.ts";
import { loadMemoryCorpus, readMemory } from "../src/memory/service.ts";
import { defaultHarnessDbPath, openHarnessDb } from "../src/state-db/index.ts";
import { removeTestTree } from "./support/temp-tree.ts";

// PLAN-L6-104 §3.1 判断 5 / PLAN-L7-566 §3: canonical root, tracked archive and linked-worktree
// legacy root are placed side by side; every reader, projection, CLI and doctor surface must
// return canonical-only results. Tokens below must never surface anywhere.
const ARCHIVE_B_TOKEN = "ARCHIVE-ONLY-TOKEN-b7f1";
const ARCHIVE_SHARED_TOKEN = "ARCHIVE-SHARED-BODY-TOKEN-3c9e";
const LINKED_C_TOKEN = "LINKED-LEGACY-TOKEN-51ad";
const NESTED_TOKEN = "NESTED-SUBDIR-TOKEN-9e02";
const CANON_A_BODY = "canonical entry a body";
const CANON_SHARED_BODY = "canonical shared-id body";
const FORBIDDEN = [ARCHIVE_B_TOKEN, ARCHIVE_SHARED_TOKEN, LINKED_C_TOKEN, NESTED_TOKEN];

// The CLI under test is spawned from the execution root (test-repository-isolation: 1 call).
const cliPath = join(process.cwd(), "src", "cli.ts");

interface Fixture {
  root: string;
  primary: string;
  linked: string;
  canonicalRoot: string;
  archiveRoot: string;
  linkedLegacyRoot: string;
}
const fixtures: Fixture[] = [];
afterAll(() => {
  for (const fixture of fixtures) removeTestTree(fixture.root);
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function entry(id: string, title: string, body: string): string {
  return [
    "---",
    `memory_id: memory:feedback:${id}`,
    "kind: feedback",
    `title: "${title}"`,
    'tags: ["fixture"]',
    "updated_at: 2026-09-16T00:00:00.000Z",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ut-memcut-nonread-"));
  const primary = join(root, "primary");
  const linked = join(root, "linked");
  mkdirSync(primary, { recursive: true });
  git(primary, ["init", "-q", "-b", "main"]);
  git(primary, ["config", "user.email", "test@example.invalid"]);
  git(primary, ["config", "user.name", "UT-TDD Test"]);
  git(primary, ["config", "core.autocrlf", "false"]);
  git(primary, ["remote", "add", "origin", "git@github.com:example/memcut-nonread.git"]);
  writeFileSync(
    join(primary, "ut-tdd.project.json"),
    canonicalProjectIdentityBytes("example/memcut-nonread"),
  );
  writeFileSync(join(primary, "README.md"), "# fixture\n", "utf8");
  git(primary, ["add", "ut-tdd.project.json", "README.md"]);
  git(primary, ["commit", "-q", "-m", "test: seed project identity"]);
  git(primary, ["worktree", "add", "-q", "-b", "linked", linked]);

  const canonicalRoot = join(primary, ".ut-tdd", "memory");
  const archiveRoot = join(primary, ...LEGACY_MEMORY_ARCHIVE_ROOT.split("/"));
  const linkedLegacyRoot = join(linked, ".ut-tdd", "memory");
  mkdirSync(canonicalRoot, { recursive: true });
  mkdirSync(join(canonicalRoot, "sub"), { recursive: true });
  mkdirSync(archiveRoot, { recursive: true });
  mkdirSync(linkedLegacyRoot, { recursive: true });
  writeFileSync(
    join(canonicalRoot, "feedback-canonical-a.md"),
    entry("canonical-a", "Canonical A", CANON_A_BODY),
  );
  writeFileSync(
    join(canonicalRoot, "feedback-shared-id.md"),
    entry("shared-id", "Shared id", CANON_SHARED_BODY),
  );
  // A nested directory under the canonical root: the reader is flat, a recursive walk mutant is not.
  writeFileSync(
    join(canonicalRoot, "sub", "feedback-nested.md"),
    entry("nested", "Nested", NESTED_TOKEN),
  );
  // Archive: a valid foreign entry, the adversarial same-id/different-digest twin, a broken entry.
  writeFileSync(
    join(archiveRoot, "feedback-archive-b.md"),
    entry("archive-b", "Archive B", ARCHIVE_B_TOKEN),
  );
  writeFileSync(
    join(archiveRoot, "feedback-shared-id.md"),
    entry("shared-id", "Shared id", ARCHIVE_SHARED_TOKEN),
  );
  writeFileSync(join(archiveRoot, "feedback-broken.md"), "no frontmatter at all\n", "utf8");
  // Linked worktree legacy root: a different entry that the runtime must never read.
  writeFileSync(
    join(linkedLegacyRoot, "feedback-linked-c.md"),
    entry("linked-c", "Linked C", LINKED_C_TOKEN),
  );
  const fixture = { root, primary, linked, canonicalRoot, archiveRoot, linkedLegacyRoot };
  fixtures.push(fixture);
  return fixture;
}

function snapshotDigests(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else out.set(relative(dir, full), sha256Hex(readFileSync(full)));
    }
  };
  walk(dir);
  return out;
}

function fakeIndexDb(rows: Array<{ memory_id: string; content_hash: string }>) {
  return {
    prepare(_sql: string) {
      return { all: () => rows as unknown as Record<string, unknown>[] };
    },
  };
}

/** The canonical-only oracle shared by every row: ids, bodies and paths. */
function assertCanonicalOnly(entries: readonly MemoryEntry[], fixture: Fixture): void {
  const ids = entries.map((e) => e.memory_id).sort();
  if (ids.join(",") !== "memory:feedback:canonical-a,memory:feedback:shared-id")
    throw new Error(`non-canonical entry set: ${ids.join(",")}`);
  for (const e of entries) {
    for (const token of FORBIDDEN) {
      if (e.body.includes(token) || e.title.includes(token))
        throw new Error(`forbidden token surfaced: ${token}`);
    }
    const real = realpathSync(join(fixture.primary, e.source_path));
    const rel = relative(realpathSync(fixture.canonicalRoot), real);
    if (rel.startsWith("..") || rel.includes("/") || rel.includes("\\"))
      throw new Error(`entry outside canonical root: ${e.source_path}`);
  }
}

function runCli(
  cwd: string,
  args: readonly string[],
): { stdout: string; stderr: string; status: number } {
  const result = execFileSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, UT_TDD_DISABLE_HOOKS: "1" },
  });
  return { stdout: result, stderr: "", status: 0 };
}

function canSymlink(dir: string): boolean {
  try {
    const target = join(dir, "probe-target.txt");
    writeFileSync(target, "probe\n", "utf8");
    symlinkSync(target, join(dir, "probe-link.txt"), "file");
    rmSync(join(dir, "probe-link.txt"));
    rmSync(target);
    return true;
  } catch {
    return false;
  }
}

describe("memory clean-cut PR-2: canonical-only non-read composition (U-MEMCUT-001..005, 011)", () => {
  it("U-MEMCUT-001: loadMemoryEntries reads the canonical root only, does not throw on the broken archive entry, and mutates no root", () => {
    const fixture = createFixture();
    const before = snapshotDigests(fixture.root);
    const entries = loadMemoryEntries(fixture.primary);
    assertCanonicalOnly(entries, fixture);
    expect(snapshotDigests(fixture.root)).toEqual(before);
  });

  it("U-MEMCUT-002: loadMemoryCorpus / readMemory findings never name an archive or linked legacy path", () => {
    const fixture = createFixture();
    const corpus = loadMemoryCorpus(fixture.primary);
    assertCanonicalOnly(corpus.entries, fixture);
    expect(corpus.findings).toEqual([]);
    const fresh = corpus.entries.map((e) => ({
      memory_id: e.memory_id,
      content_hash: e.content_hash,
    }));
    const read = readMemory({ repoRoot: fixture.primary, db: fakeIndexDb(fresh) });
    assertCanonicalOnly(read.entries, fixture);
    expect(read.freshness).toBe("fresh");
    expect(
      read.findings.filter(
        (f) => f.source_path.includes("archive") || f.source_path.includes("linked"),
      ),
    ).toEqual([]);
  });

  it("U-MEMCUT-003: a same memory_id / different digest twin in the archive never wins; no conflict finding is derived from it", () => {
    const fixture = createFixture();
    const corpus = loadMemoryCorpus(fixture.primary);
    const shared = corpus.entries.find((e) => e.memory_id === "memory:feedback:shared-id");
    expect(shared?.body).toBe(CANON_SHARED_BODY);
    const canonicalFile = parseMemoryFile(fixture.primary, ".ut-tdd/memory/feedback-shared-id.md");
    expect(shared?.content_hash).toBe(canonicalFile.content_hash);
    expect(corpus.findings).toEqual([]);
    expect(JSON.stringify(corpus)).not.toContain(ARCHIVE_SHARED_TOKEN);
  });

  it("U-MEMCUT-004: symlinks inside the archive change nothing; every returned entry realpath stays under the canonical root", (ctx) => {
    const fixture = createFixture();
    if (!canSymlink(fixture.root)) {
      ctx.skip();
      return;
    }
    symlinkSync(
      join(fixture.linkedLegacyRoot, "feedback-linked-c.md"),
      join(fixture.archiveRoot, "feedback-link.md"),
      "file",
    );
    symlinkSync(fixture.linkedLegacyRoot, join(fixture.archiveRoot, "linked-dir"), "junction");
    const entries = loadMemoryEntries(fixture.primary);
    assertCanonicalOnly(entries, fixture);
    const corpus = loadMemoryCorpus(fixture.primary);
    assertCanonicalOnly(corpus.entries, fixture);
    expect(JSON.stringify(corpus)).not.toContain(LINKED_C_TOKEN);
  });

  it("U-MEMCUT-005: an archive-derived index row (no canonical file) degrades freshness visibly and never supplies a body", () => {
    const fixture = createFixture();
    const corpus = loadMemoryCorpus(fixture.primary);
    const rows = corpus.entries.map((e) => ({
      memory_id: e.memory_id,
      content_hash: e.content_hash,
    }));
    rows.push({ memory_id: "memory:feedback:archive-b", content_hash: sha256Hex(ARCHIVE_B_TOKEN) });
    const read = readMemory({ repoRoot: fixture.primary, db: fakeIndexDb(rows) });
    assertCanonicalOnly(read.entries, fixture);
    expect(read.freshness).not.toBe("fresh");
    expect(read.freshness_reason ?? "").not.toBe("");
    expect(JSON.stringify(read)).not.toContain(ARCHIVE_B_TOKEN);
  });

  it("U-MEMCUT-011: each production-reader mutant (recursive walk, archive root as candidate, cwd root) turns at least one oracle Red", () => {
    const fixture = createFixture();
    // Mutant (i): recursive walk of the canonical root.
    const recursive = (): MemoryEntry[] => {
      const out: MemoryEntry[] = [];
      const walk = (d: string): void => {
        for (const name of readdirSync(d)) {
          const full = join(d, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (name.endsWith(".md"))
            out.push(parseMemoryFile(fixture.primary, relative(fixture.primary, full)));
        }
      };
      walk(fixture.canonicalRoot);
      return out;
    };
    // Mutant (ii): archive root added as a read candidate.
    const withArchive = (): MemoryEntry[] => [
      ...loadMemoryEntries(fixture.primary),
      ...readdirSync(fixture.archiveRoot)
        .filter((n) => n.endsWith(".md") && n !== "feedback-broken.md")
        .map((n) => parseMemoryFile(fixture.primary, `${LEGACY_MEMORY_ARCHIVE_ROOT}/${n}`)),
    ];
    // Mutant (iii): projection root taken from the cwd (a linked worktree) instead of the canonical root.
    const cwdRoot = (): MemoryEntry[] => loadMemoryEntries(fixture.linked);
    expect(() => assertCanonicalOnly(loadMemoryEntries(fixture.primary), fixture)).not.toThrow();
    for (const mutant of [recursive, withArchive, cwdRoot]) {
      expect(() => assertCanonicalOnly(mutant(), fixture)).toThrow();
    }
  });
});

describe("memory clean-cut PR-2: projection, CLI and doctor surfaces (P-MEMCUT-006, 007, 009, 010, 029)", () => {
  it("P-MEMCUT-006 / P-MEMCUT-029: db rebuild from the primary and from a linked worktree both project the canonical corpus only, and readMemory is fresh against that index", () => {
    const fixture = createFixture();
    const dbPath = defaultHarnessDbPath(fixture.primary);
    const expected = loadMemoryCorpus(fixture.primary)
      .entries.map((e) => `${e.memory_id}|${e.content_hash}`)
      .sort();
    for (const cwd of [fixture.primary, fixture.linked]) {
      rmSync(dbPath, { force: true });
      const result = runCli(cwd, ["db", "rebuild", "--json"]);
      expect(result.status, cwd).toBe(0);
      expect(existsSync(dbPath), `rebuild from ${cwd} must write the canonical db`).toBe(true);
      expect(existsSync(defaultHarnessDbPath(fixture.linked))).toBe(false);
      const db = openHarnessDb(dbPath, { repoRoot: fixture.primary });
      try {
        const rows = db
          .prepare(
            "SELECT memory_id, content_hash, source_path, body FROM memory_entries ORDER BY memory_id",
          )
          .all() as Array<Record<string, unknown>>;
        expect(rows.map((r) => `${r.memory_id}|${r.content_hash}`).sort(), cwd).toEqual(expected);
        for (const r of rows) {
          expect(String(r.source_path).startsWith(".ut-tdd/memory/")).toBe(true);
          for (const token of FORBIDDEN) expect(String(r.body)).not.toContain(token);
        }
        const nodes = db
          .prepare(
            "SELECT path FROM graph_nodes WHERE path LIKE '%memory-legacy-2026-09%' OR path LIKE '%linked%'",
          )
          .all() as Array<Record<string, unknown>>;
        expect(nodes, `${cwd}: archive / linked paths in relation graph`).toEqual([]);
        const read = readMemory({ repoRoot: fixture.primary, db });
        assertCanonicalOnly(read.entries, fixture);
        expect(read.freshness).toBe("fresh");
      } finally {
        db.close();
      }
    }
    // Negative (029): a broken canonical entry makes the rebuild fail-close instead of projecting a partial corpus.
    writeFileSync(
      join(fixture.canonicalRoot, "feedback-broken-canonical.md"),
      "no frontmatter\n",
      "utf8",
    );
    expect(() => runCli(fixture.primary, ["db", "rebuild", "--json"])).toThrow();
    rmSync(join(fixture.canonicalRoot, "feedback-broken-canonical.md"));
  });

  it("P-MEMCUT-007: memory list / recall from the primary and the linked worktree are canonical-only and identical; archive and linked tokens query to zero", () => {
    const fixture = createFixture();
    const outputs = [fixture.primary, fixture.linked].map((cwd) => ({
      list: runCli(cwd, ["memory", "list"]).stdout,
      archiveQuery: runCli(cwd, ["memory", "list", "--query", ARCHIVE_B_TOKEN]).stdout,
      linkedQuery: runCli(cwd, ["memory", "recall", "--query", LINKED_C_TOKEN]).stdout,
    }));
    expect(outputs[0]).toEqual(outputs[1]);
    expect(outputs[0].list).toContain("memory:feedback:canonical-a");
    expect(outputs[0].list).toContain("memory:feedback:shared-id");
    expect(outputs[0].list).not.toContain("archive-b");
    expect(outputs[0].list).not.toContain("linked-c");
    expect(outputs[0].archiveQuery).toBe("memory: no entries\n");
    expect(outputs[0].linkedQuery).toBe("memory: no entries\n");
    for (const token of FORBIDDEN) expect(JSON.stringify(outputs)).not.toContain(token);
  });

  it("P-MEMCUT-009: review live-dispatch refuses a memory path outside the canonical authored root before any read", () => {
    const fixture = createFixture();
    expect(
      canonicalAuthoredMemoryPath(fixture.primary, ".ut-tdd/memory/feedback-canonical-a.md"),
    ).toBe(".ut-tdd/memory/feedback-canonical-a.md");
    for (const bad of [
      `${LEGACY_MEMORY_ARCHIVE_ROOT}/feedback-archive-b.md`,
      "../linked/.ut-tdd/memory/feedback-linked-c.md",
      ".ut-tdd/memory/../../docs/archive/memory-legacy-2026-09/feedback-archive-b.md",
      ".ut-tdd/memory/sub/feedback-nested.md",
      ".ut-tdd/memory",
      ".ut-tdd/memory/notes.txt",
      resolve(fixture.linked, ".ut-tdd", "memory", "feedback-linked-c.md"),
    ]) {
      expect(() => canonicalAuthoredMemoryPath(fixture.primary, bad), bad).toThrow(
        /review_memory_path_outside_canonical_root/,
      );
    }
  });

  it("P-MEMCUT-010: memory-sync counts only .ut-tdd/memory; the DB projection's memory rows are canonical-only; `ut-tdd status` / `status --json` never surface memory-derived tokens", () => {
    const fixture = createFixture();
    const input = loadMemorySyncInput(fixture.primary);
    expect(input.files.length).toBeGreaterThan(0);
    for (const file of input.files) {
      expect(file.source_path.startsWith(".ut-tdd/memory/")).toBe(true);
      expect(file.source_path).not.toContain("memory-legacy-2026-09");
    }

    // DB projection memory rows must stay canonical-only for this fixture.
    const dbPath = defaultHarnessDbPath(fixture.primary);
    rmSync(dbPath, { force: true });
    const rebuild = runCli(fixture.primary, ["db", "rebuild", "--json"]);
    expect(rebuild.status).toBe(0);
    const db = openHarnessDb(dbPath, { repoRoot: fixture.primary });
    try {
      const rows = db
        .prepare("SELECT memory_id, source_path, body FROM memory_entries ORDER BY memory_id")
        .all() as Array<Record<string, unknown>>;
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(String(r.source_path).startsWith(".ut-tdd/memory/")).toBe(true);
        expect(String(r.source_path)).not.toContain("memory-legacy-2026-09");
        for (const token of FORBIDDEN) expect(String(r.body)).not.toContain(token);
      }
    } finally {
      db.close();
    }

    // `ut-tdd status` reads mode / outstanding-work / update-check, never memory. It must never
    // surface a memory-derived token even though the fixture's archive / linked-legacy corpus
    // carries forbidden tokens elsewhere in the same tree (invariant regression guard).
    const statusText = runCli(fixture.primary, ["status"]).stdout;
    const statusJson = runCli(fixture.primary, ["status", "--json"]).stdout;
    for (const token of FORBIDDEN) {
      expect(statusText).not.toContain(token);
      expect(statusJson).not.toContain(token);
    }
  });
});

describe("memory clean-cut PR-2: db rebuild fails closed on a linked worktree with unresolved project identity (P-MEMCUT-006 negative, Sol r2 FLAG 1)", () => {
  interface DriftFixture {
    root: string;
    primary: string;
    linked: string;
  }
  const driftFixtures: DriftFixture[] = [];
  afterAll(() => {
    for (const fixture of driftFixtures) removeTestTree(fixture.root);
  });

  /**
   * Builds a primary repo plus a `git worktree add` linked checkout (git-dir distinct from
   * git-common-dir, i.e. `isLinkedWorktreeCheckout` is true). `mutateLinked` then breaks the
   * linked worktree's own project-identity resolution (unavailable or drifted) so
   * `resolveProjectMemoryRoot(linked)` fails with a reason other than
   * "git_topology_unavailable" — the case the U-TESTHYGIENE-043 nested-snapshot fallback must
   * never cover. A legacy `.ut-tdd/memory` entry unique to the linked worktree stands in for the
   * corpus P-MEMCUT-006 forbids projecting.
   */
  function createDriftFixture(
    suffix: string,
    mutateLinked: (linked: string) => void,
  ): DriftFixture & { legacyToken: string } {
    const root = mkdtempSync(join(tmpdir(), `ut-memcut-drift-${suffix}-`));
    const primary = join(root, "primary");
    const linked = join(root, "linked");
    mkdirSync(primary, { recursive: true });
    git(primary, ["init", "-q", "-b", "main"]);
    git(primary, ["config", "user.email", "test@example.invalid"]);
    git(primary, ["config", "user.name", "UT-TDD Test"]);
    git(primary, ["config", "core.autocrlf", "false"]);
    git(primary, ["remote", "add", "origin", `git@github.com:example/memcut-drift-${suffix}.git`]);
    writeFileSync(
      join(primary, "ut-tdd.project.json"),
      canonicalProjectIdentityBytes(`example/memcut-drift-${suffix}`),
    );
    writeFileSync(join(primary, "README.md"), "# fixture\n", "utf8");
    git(primary, ["add", "ut-tdd.project.json", "README.md"]);
    git(primary, ["commit", "-q", "-m", "test: seed project identity"]);
    git(primary, ["worktree", "add", "-q", "-b", `linked-${suffix}`, linked]);

    mutateLinked(linked);

    const legacyToken = `LINKED-DRIFT-${suffix.toUpperCase()}-TOKEN-4f21`;
    const linkedLegacyRoot = join(linked, ".ut-tdd", "memory");
    mkdirSync(linkedLegacyRoot, { recursive: true });
    writeFileSync(
      join(linkedLegacyRoot, "feedback-linked-drift.md"),
      entry("linked-drift", "Linked drift", legacyToken),
    );

    const fixture = { root, primary, linked, legacyToken };
    driftFixtures.push(fixture);
    return fixture;
  }

  function runCliExpectFailure(cwd: string, args: readonly string[]) {
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, UT_TDD_DISABLE_HOOKS: "1" },
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status ?? -1,
    };
  }

  it("project_identity_unavailable: db rebuild from a linked worktree with no ut-tdd.project.json fails closed and writes no db", () => {
    const fixture = createDriftFixture("unavailable", (linked) => {
      // Orphan branch with the identity file removed reproduces the measured
      // "project_identity_unavailable" deny reason from a *resolvable* git topology
      // (distinct from the nested-snapshot "git_topology_unavailable" case).
      git(linked, ["checkout", "-q", "--orphan", "driftbranch"]);
      git(linked, ["rm", "-rf", "-q", "."]);
      writeFileSync(join(linked, "other.txt"), "no identity file\n", "utf8");
      git(linked, ["add", "other.txt"]);
      git(linked, ["commit", "-q", "-m", "test: drop project identity"]);
    });
    const dbPath = defaultHarnessDbPath(fixture.primary);
    rmSync(dbPath, { force: true });
    const result = runCliExpectFailure(fixture.linked, ["db", "rebuild", "--json"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing to project memory");
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(defaultHarnessDbPath(fixture.linked))).toBe(false);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(fixture.legacyToken);
  });

  it("project_identity_drift: db rebuild from a linked worktree whose identity file disagrees with the canonical root fails closed and writes no db", () => {
    const fixture = createDriftFixture("drift", (linked) => {
      // Valid schema, different repository_identity value: reproduces "project_identity_drift"
      // from a resolvable git topology.
      writeFileSync(
        join(linked, "ut-tdd.project.json"),
        canonicalProjectIdentityBytes("example/memcut-drift-drift-DIFFERENT"),
      );
      git(linked, ["add", "ut-tdd.project.json"]);
      git(linked, ["commit", "-q", "-m", "test: drift project identity"]);
    });
    const dbPath = defaultHarnessDbPath(fixture.primary);
    rmSync(dbPath, { force: true });
    const result = runCliExpectFailure(fixture.linked, ["db", "rebuild", "--json"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing to project memory");
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(defaultHarnessDbPath(fixture.linked))).toBe(false);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(fixture.legacyToken);
  });
});
