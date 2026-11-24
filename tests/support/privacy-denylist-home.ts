import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, onTestFinished, vi } from "vitest";
import { removeTestTree } from "./temp-tree.ts";

// Issue #1391: `distribution package` / `sync-pack` require `<home>/.ut-tdd/privacy-denylist.txt`
// outside the source repo. tests/ ship in the Pack, so the synthetic word is joined at runtime
// (L7 privacy-scan §2) and never matches a real Pack artifact. No helper reads the real home.
const SYNTHETIC_DENYLIST_TERM = ["example", "fixture", "denylist", "term"].join("-");

/** Writes a synthetic denylist into `home` (which must lie outside the scanned repo). */
export function writeSyntheticPrivacyDenylist(home: string): string {
  mkdirSync(join(home, ".ut-tdd"), { recursive: true });
  writeFileSync(
    join(home, ".ut-tdd", "privacy-denylist.txt"),
    `${SYNTHETIC_DENYLIST_TERM}\n`,
    "utf8",
  );
  return home;
}

/** Creates a fresh temp home under the OS temp directory with a synthetic denylist. */
export function createSyntheticPrivacyHome(): string {
  return writeSyntheticPrivacyDenylist(mkdtempSync(join(tmpdir(), "ut-tdd-privacy-home-")));
}

/** One synthetic home for the calling test file: created before its tests, removed after. */
export function useSyntheticPrivacyHome(): { readonly path: string } {
  const home = { path: "" };
  beforeAll(() => {
    home.path = createSyntheticPrivacyHome();
  });
  afterAll(() => {
    if (home.path) removeTestTree(home.path);
  });
  return home;
}

/** Points HOME / USERPROFILE at a synthetic home for the current test (child processes inherit). */
export function stubSyntheticPrivacyHome(): void {
  const home = createSyntheticPrivacyHome();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  onTestFinished(() => {
    vi.unstubAllEnvs();
    removeTestTree(home);
  });
}
