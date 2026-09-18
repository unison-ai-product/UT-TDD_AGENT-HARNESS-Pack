import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalProjectIdentityBytes } from "../src/kernel/project-identity.ts";
import {
  CURATION_LEDGER_PATH,
  type CurationLedger,
  type CurationRow,
  canonicalMemoryContentDigest,
  custodyIdFor,
  parseCurationLedgerDocument,
  type RegistrationReceipt,
  registrationReceiptDigest,
  renderCurationLedgerDocument,
  screenAdoptText,
  verifyAdoptRegistrationReplay,
  verifyCurationCoverage,
  verifyCurationReviewer,
  verifyCurationRows,
} from "../src/memory/curation-ledger.ts";
import { loadMemoryEntries, parseMemoryFile } from "../src/memory/index.ts";
import { readLegacyArchiveManifest, sha256Hex } from "../src/memory/legacy-archive-manifest.ts";

// The shipped ledger, manifest and canonical corpus are repository facts read from the execution
// root once (test-repository-isolation contract: 1 call).
const root = process.cwd();
const cliPath = join(root, "src", "cli.ts");

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function ledgerOf(): CurationLedger {
  return parseCurationLedgerDocument(readFileSync(join(root, CURATION_LEDGER_PATH), "utf8"));
}

function adoptRows(ledger: CurationLedger): CurationRow[] {
  return ledger.rows.filter((row) => row.decision === "adopt");
}

function scratchProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ut-memcut-ledger-"));
  scratch.push(dir);
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "UT-TDD Test"]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:example/ledger.git"]);
  writeFileSync(join(dir, "ut-tdd.project.json"), canonicalProjectIdentityBytes("example/ledger"));
  execFileSync("git", ["-C", dir, "add", "ut-tdd.project.json"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "seed"]);
  mkdirSync(join(dir, ".ut-tdd", "memory"), { recursive: true });
  return dir;
}

/** The `--operation-id` pin for one adopt row, derived from the archived source bytes (tracked
 * rows: the archive file under `docs/archive/`) or, for untracked sources whose bytes are not in
 * the repository, from the manifest-bound `source_digest` — never from the ledger's own
 * `registration.operation_id`, so a ledger row cannot echo a fabricated id back to itself. */
function operationIdFor(row: CurationRow): string {
  const digest = row.archive_path
    ? sha256Hex(readFileSync(join(root, row.archive_path), "utf8"))
    : row.source_digest;
  return `curation-424:${digest.slice(0, 16)}`;
}

/** Replays one adopt row's registration through the real `ut-tdd memory add --receipt-json`
 * subprocess against a scratch canonical project and returns the receipt the CLI printed plus the
 * bytes it actually wrote. Nothing in the returned receipt is test-built or ledger-supplied
 * (U-MEMCUT-026: an independent CLI registration receipt oracle). */
function cliReplay(
  row: CurationRow,
): Promise<{ receipt: RegistrationReceipt; rawText: string } | null> {
  const adopt = row.adopt;
  if (!adopt) return Promise.resolve(null);
  const canonicalEntry = parseMemoryFile(root, adopt.registration.source_path);
  const dir = scratchProject();
  const bodyFile = join(dir, "body.txt");
  writeFileSync(bodyFile, canonicalEntry.body, "utf8");
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        cliPath,
        "memory",
        "add",
        "--kind",
        adopt.kind,
        "--title",
        adopt.title,
        "--body-file",
        bodyFile,
        "--tags",
        adopt.tags.join(","),
        "--operation-id",
        operationIdFor(row),
        "--receipt-json",
      ],
      { cwd: dir, encoding: "utf8", env: { ...process.env, UT_TDD_DISABLE_HOOKS: "1" } },
      (error, stdout) => {
        if (error) return resolve(null);
        const line = String(stdout)
          .split(/\r?\n/)
          .find((l) => l.startsWith("{"));
        if (!line) return resolve(null);
        try {
          const receipt = JSON.parse(line) as RegistrationReceipt;
          const rawText = readFileSync(join(dir, receipt.source_path), "utf8");
          resolve({ receipt, rawText });
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/** Runs `fn` over `items` with at most `limit` in flight (46 CLI subprocess spawns). */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

describe("memory clean-cut PR-2: curation ledger binding (U-MEMCUT-024..028)", () => {
  it("U-MEMCUT-024: every ledger row binds to the manifest, carries the six criteria and a reason; adopt rows carry a matching registration receipt digest — each negative is Red", () => {
    const ledger = ledgerOf();
    const manifest = readLegacyArchiveManifest(root);
    expect(ledger.rows.length).toBe(manifest.tracked.length + manifest.untracked.count);
    expect(verifyCurationRows({ ledger, manifest })).toEqual([]);
    const adopt = adoptRows(ledger)[0];
    expect(adopt, "at least one adopt row").toBeDefined();
    const mutate = (fn: (rows: CurationRow[]) => void): CurationLedger => {
      const copy = JSON.parse(JSON.stringify(ledger)) as CurationLedger;
      fn(copy.rows);
      return copy;
    };
    const kinds = (l: CurationLedger) =>
      verifyCurationRows({ ledger: l, manifest }).map((f) => f.kind);
    // digest changed by one character
    expect(
      kinds(
        mutate((rows) => {
          rows[0].source_digest = `${rows[0].source_digest.slice(0, -1)}${rows[0].source_digest.endsWith("0") ? "1" : "0"}`;
        }),
      ),
    ).toContain(rows0IsTracked(ledger) ? "row-digest-mismatch" : "untracked-custody-id-mismatch");
    // tracked row pointing at a path the manifest does not know
    expect(
      kinds(
        mutate((rows) => {
          const t = rows.find((r) => r.source === "tracked");
          if (t) t.archive_path = "docs/archive/memory-legacy-2026-09/not-in-manifest.md";
        }),
      ),
    ).toContain("row-path-not-in-manifest");
    // untracked row leaking a path
    expect(
      kinds(
        mutate((rows) => {
          const u = rows.find((r) => r.source === "untracked");
          if (u) u.archive_path = ".ut-tdd/archive/memory-legacy-2026-09/leak.md";
        }),
      ),
    ).toContain("untracked-row-carries-path");
    // adopt row without registration receipt
    expect(
      kinds(
        mutate((rows) => {
          const a = rows.find((r) => r.decision === "adopt");
          if (a?.adopt) a.adopt = { ...a.adopt, registration: undefined as never };
        }),
      ),
    ).toContain("adopt-registration-missing");
    // adopt row with a tampered receipt digest
    expect(
      kinds(
        mutate((rows) => {
          const a = rows.find((r) => r.decision === "adopt");
          if (a?.adopt) a.adopt.receipt_digest = "0".repeat(64);
        }),
      ),
    ).toContain("adopt-receipt-digest-mismatch");
    // reason removed
    expect(
      kinds(
        mutate((rows) => {
          rows[0].reason = "";
        }),
      ),
    ).toContain("reason-missing");
    // reject row evidence removed
    expect(
      kinds(
        mutate((rows) => {
          const r = rows.find((row) => row.decision === "reject");
          if (r) r.evidence = [];
        }),
      ),
    ).toContain("reject-evidence-missing");
  });

  it("U-MEMCUT-024b: every reject row carries non-empty, non-leaking evidence substantiating the six-criterion decision", () => {
    const ledger = ledgerOf();
    const rejects = ledger.rows.filter((row) => row.decision === "reject");
    expect(rejects.length).toBeGreaterThan(0);
    // (a) the shipped ledger has zero reject rows with empty evidence.
    const emptyEvidence = rejects.filter((row) => !row.evidence || row.evidence.length === 0);
    expect(emptyEvidence.map((row) => row.archive_path ?? row.custody_id)).toEqual([]);
    for (const row of rejects) {
      if (row.source === "tracked") {
        // (c) for tracked reject rows, the recorded `screen:` tags match a recomputation from the
        // archived file. The verifier itself has no archive content access (manifest + ledger
        // only), so this recomputation runs here in the test.
        if (!row.archive_path) throw new Error("tracked reject row missing archive_path");
        const content = readFileSync(join(root, row.archive_path), "utf8");
        const expectedTags = new Set(screenAdoptText(content).map((tag) => `screen:${tag}`));
        const recordedTags = new Set(row.evidence.filter((e) => e.startsWith("screen:")));
        expect(recordedTags, row.archive_path).toEqual(expectedTags);
      } else {
        // (d) no untracked row's evidence leaks a path, title or body: only `custody:` and
        // `criterion:` prefixed references are allowed.
        for (const item of row.evidence) {
          expect(item, row.custody_id).not.toMatch(/\/|\.md/);
          expect(item, row.custody_id).toMatch(/^(custody:|criterion:)/);
        }
      }
    }
    // (b) deleting one reject row's evidence (in memory, on a copy) is Red.
    const manifest = readLegacyArchiveManifest(root);
    const mutated = JSON.parse(JSON.stringify(ledger)) as CurationLedger;
    const target = mutated.rows.find((row) => row.decision === "reject");
    if (target) target.evidence = [];
    expect(verifyCurationRows({ ledger: mutated, manifest }).map((f) => f.kind)).toContain(
      "reject-evidence-missing",
    );
  });

  it("U-MEMCUT-025: the adopt memory_id set equals the canonical root entry set; an unlisted canonical entry or an entry-less adopt row is Red", () => {
    const ledger = ledgerOf();
    const canonical = loadMemoryEntries(root).map((e) => e.memory_id);
    expect(verifyCurationCoverage({ ledger, canonicalMemoryIds: canonical })).toEqual([]);
    expect(
      verifyCurationCoverage({
        ledger,
        canonicalMemoryIds: [...canonical, "memory:feedback:not-in-ledger"],
      }).map((f) => f.kind),
    ).toEqual(["canonical-not-in-ledger"]);
    const [first, ...rest] = canonical;
    expect(first).toBeDefined();
    expect(verifyCurationCoverage({ ledger, canonicalMemoryIds: rest }).map((f) => f.kind)).toEqual(
      ["adopt-not-in-canonical"],
    );
    // merged duplicates stay in the ledger as reject rows pointing at their canonical row
    for (const row of adoptRows(ledger)) {
      for (const merged of row.merged_from ?? []) {
        const source = ledger.rows.find((r) => r.source_digest === merged);
        expect(source?.decision, merged).toBe("reject");
      }
    }
  });

  it("U-MEMCUT-026: replaying `memory add --receipt-json` for every adopt row reproduces the registration receipt through the verifier from the CLI's own printed receipt; each negative goes through the same verifier and is single-axis Red", async () => {
    const ledger = ledgerOf();
    const allAdopt = adoptRows(ledger);
    expect(allAdopt.length).toBeGreaterThan(0);
    // Full-corpus replay through the real CLI (no sampling, no in-process stand-in): every adopt
    // row is re-registered by a `ut-tdd memory add --receipt-json` subprocess in its own scratch
    // canonical project, and the receipt the verifier checks is the JSON line that subprocess
    // printed — memory id / source path / exit code / content digest / operation id all come from
    // the CLI, never from the ledger's self-declared registration (Sol r2–r4 FLAG).
    const replays = await mapLimit(allAdopt, 6, cliReplay);
    for (const [i, row] of allAdopt.entries()) {
      const adopt = row.adopt;
      if (!adopt) throw new Error("adopt row without adopt block");
      const canonicalRawText = readFileSync(join(root, adopt.registration.source_path), "utf8");
      const replayed = replays[i];
      expect(replayed, adopt.memory_id).not.toBeNull();
      expect(
        verifyAdoptRegistrationReplay({
          row,
          canonicalRawText,
          replay: replayed?.receipt ?? null,
          replayRawText: replayed?.rawText,
        }),
        adopt.memory_id,
      ).toEqual([]);
      // The CLI's file carries every required frontmatter key (no silent omission).
      const cliEntry = parseMemoryFile(root, adopt.registration.source_path, replayed?.rawText);
      expect(cliEntry.memory_id, adopt.memory_id).toBe(adopt.memory_id);
      expect(cliEntry.kind).toBe(adopt.kind);
      expect(cliEntry.title).toBe(adopt.title);
      expect(cliEntry.tags).toEqual(adopt.tags);
      expect(cliEntry.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  }, 180_000);

  it("U-MEMCUT-026 negatives: verifyAdoptRegistrationReplay is Red for a receipt-less handwritten twin, a fabricated ledger digest, a failed replay, an out-of-root replay path, an altered canonical body, a dishonest CLI receipt and a foreign operation id — each single-axis", async () => {
    const ledger = ledgerOf();
    const row = adoptRows(ledger)[0];
    const adopt = row?.adopt;
    expect(adopt, "at least one adopt row with a registration").toBeDefined();
    if (!row || !adopt) throw new Error("no adopt row available for negatives");
    const canonicalRawText = readFileSync(join(root, adopt.registration.source_path), "utf8");
    const replayed = await cliReplay(row);
    expect(replayed, adopt.memory_id).not.toBeNull();
    if (!replayed) throw new Error("CLI replay failed for negatives fixture row");
    const validReplay = replayed.receipt;
    const replayRawText = replayed.rawText;
    const verify = (input: Partial<Parameters<typeof verifyAdoptRegistrationReplay>[0]>) =>
      verifyAdoptRegistrationReplay({
        row,
        canonicalRawText,
        replay: validReplay,
        replayRawText,
        ...input,
      }).map((f) => f.kind);

    // Sanity: the valid CLI replay is Green through the verifier (baseline for the mutations).
    expect(verify({})).toEqual([]);

    // (a) receipt-less handwritten twin: the canonical file exists, but no replay was obtained.
    expect(verify({ replay: null })).toEqual(["adopt-replay-missing"]);

    // (b) fabricated ledger row: registration content_digest changed (receipt_digest recomputed to
    // stay self-consistent). The ledger lies about the canonical bytes; the real replay does not.
    const fabricatedRegistration = { ...adopt.registration, content_digest: "1".repeat(64) };
    const fabricatedRow: CurationRow = {
      ...row,
      adopt: {
        ...adopt,
        registration: fabricatedRegistration,
        receipt_digest: registrationReceiptDigest(fabricatedRegistration),
      },
    };
    expect(verify({ row: fabricatedRow })).toEqual(["adopt-replay-content-digest-mismatch"]);

    // (c) replay exit_code 1 (a failed replay that still reported a receipt shape).
    expect(verify({ replay: { ...validReplay, exit_code: 1 } })).toContain(
      "adopt-replay-exit-nonzero",
    );

    // (d) replay source_path outside `.ut-tdd/memory/`'s direct children.
    expect(
      verify({ replay: { ...validReplay, source_path: "docs/archive/escaped.md" } }),
    ).toContain("adopt-replay-source-path-outside-canonical");
    expect(
      verify({ replay: { ...validReplay, source_path: ".ut-tdd/memory/sub/escaped.md" } }),
    ).toContain("adopt-replay-source-path-outside-canonical");

    // (e) altered canonical body (a temp copy, never written into the repo): the replay is
    // unchanged and correct, but the canonical bytes no longer match it or the ledger digest.
    expect(verify({ canonicalRawText: `${canonicalRawText}\naltered body line\n` })).toEqual([
      "adopt-replay-content-digest-mismatch",
    ]);

    // (f) dishonest receipt: the printed content_digest is not the digest of the bytes written.
    expect(
      verify({ replay: { ...validReplay, content_digest: `sha256:${"2".repeat(64)}` } }),
    ).toEqual(["adopt-replay-content-digest-mismatch"]);

    // (g) Sol r4 FLAG reproduction: a foreign operation id. The CLI receipt echoes whatever pin the
    // caller passed; a ledger registration that declares a different operation id cannot match it.
    expect(verify({ replay: { ...validReplay, operation_id: "fabricated-op-id" } })).toEqual([
      "adopt-replay-receipt-digest-mismatch",
    ]);

    // (h) fully handwritten twin (Sol r3): internally self-consistent fabricated registration,
    // real canonical bytes, but `memory add` never ran. Red on the missing replay alone.
    const fullyFabricatedRegistration: RegistrationReceipt = {
      operation_id: "fabricated-op-id-not-from-any-invocation",
      memory_id: adopt.memory_id,
      source_path: adopt.registration.source_path,
      content_digest: canonicalMemoryContentDigest(canonicalRawText),
      exit_code: 0,
    };
    const fullyFabricatedRow: CurationRow = {
      ...row,
      adopt: {
        ...adopt,
        registration: fullyFabricatedRegistration,
        receipt_digest: registrationReceiptDigest(fullyFabricatedRegistration),
      },
    };
    expect(verify({ row: fullyFabricatedRow, replay: null })).toEqual(["adopt-replay-missing"]);
  }, 60_000);

  it("U-MEMCUT-027: adopted titles and bodies pass the episode / secret / personal-path screen; each negative fixture is Red", () => {
    const ledger = ledgerOf();
    for (const row of adoptRows(ledger)) {
      const entry = parseMemoryFile(root, row.adopt?.registration.source_path ?? "");
      expect(screenAdoptText(`${entry.title}\n${entry.body}`), entry.memory_id).toEqual([]);
    }
    const negatives: Array<[string, string]> = [
      ["PR #612 で直した", "pr-number"],
      ["commit 3a516df6 の後", "commit-hash"],
      ["verdict: FLAG を受領した receipt 5b33f566 を待つ", "review-episode"],
      [`${"AK"}${"IA"}${"ABCDEFGHIJKLMNOP"} を使う`, "secret-like"],
      ["C:\\Users\\someone\\dev に置く", "personal-path"],
      ["2026-09-16T10:00 時点", "timestamp"],
    ];
    for (const [text, tag] of negatives) expect(screenAdoptText(text), text).toContain(tag);
  });

  it("U-MEMCUT-028: the reviewer record is a non-author frontier model bound to a real, non-placeholder exact head and receipt; same family, missing/placeholder head, or a placeholder receipt is Red", () => {
    const ledger = ledgerOf();
    // The shipped ledger must carry the real non-author (Codex Sol) PASS receipt bound to the
    // exact head it judged; a missing or placeholder reviewer record is Red.
    expect(verifyCurationReviewer(ledger)).toEqual([]);
    expect(ledger.reviewer?.family).not.toBe(ledger.author.family);
    expect(ledger.reviewer?.verdict).toBe("PASS");

    // A fully-bound, non-placeholder reviewer record: frontier tier, non-author family, a real
    // 40-hex exact head (not all zero) and an `rv1-<sha256>` review receipt id shaped like the
    // ones written under `.ut-tdd/review/receipts/`.
    const validReviewer: NonNullable<CurationLedger["reviewer"]> = {
      model: "gpt-5.6-sol",
      family: "codex" as const,
      exact_head: "1".repeat(40),
      verdict: "PASS",
      receipt: `rv1-${"a".repeat(64)}`,
    };
    const reviewedLedger = { ...ledger, reviewer: validReviewer };
    expect(verifyCurationReviewer(reviewedLedger)).toEqual([]);
    const sameFamily = {
      ...reviewedLedger,
      reviewer: { ...validReviewer, family: ledger.author.family },
    };
    expect(verifyCurationReviewer(sameFamily).map((f) => f.kind)).toContain("reviewer-same-family");
    const noHead = { ...reviewedLedger, reviewer: { ...validReviewer, exact_head: "" } };
    expect(verifyCurationReviewer(noHead).map((f) => f.kind)).toContain("reviewer-head-invalid");
    const allZeroHead = {
      ...reviewedLedger,
      reviewer: { ...validReviewer, exact_head: "0".repeat(40) },
    };
    expect(verifyCurationReviewer(allZeroHead).map((f) => f.kind)).toContain(
      "reviewer-head-invalid",
    );
    const placeholderReceipt = {
      ...reviewedLedger,
      reviewer: { ...validReviewer, receipt: "pending-review-receipt" },
    };
    expect(verifyCurationReviewer(placeholderReceipt).map((f) => f.kind)).toContain(
      "reviewer-receipt-invalid",
    );
    const workerTier = {
      ...reviewedLedger,
      reviewer: { ...validReviewer, model: "gpt-5.6-luna" },
    };
    expect(verifyCurationReviewer(workerTier).map((f) => f.kind)).toContain(
      "reviewer-not-frontier",
    );
    expect(verifyCurationReviewer({ ...ledger, reviewer: undefined }).map((f) => f.kind)).toEqual([
      "reviewer-missing",
    ]);
  });

  it("ledger document round-trips and the archive directory matches the tracked row count", () => {
    const ledger = ledgerOf();
    expect(parseCurationLedgerDocument(renderCurationLedgerDocument(ledger))).toEqual(ledger);
    const tracked = ledger.rows.filter((row) => row.source === "tracked");
    const archiveFiles = readdirSync(join(root, "docs/archive/memory-legacy-2026-09")).filter(
      (n) => n.endsWith(".md") && n !== "SUMMARY.md",
    );
    expect(tracked.length).toBe(archiveFiles.length);
    for (const row of ledger.rows.filter((r) => r.source === "untracked")) {
      expect(row.custody_id).toBe(custodyIdFor(row.source_digest));
    }
  });
});

function rows0IsTracked(ledger: CurationLedger): boolean {
  return ledger.rows[0]?.source === "tracked";
}
