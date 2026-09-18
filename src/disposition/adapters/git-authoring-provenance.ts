import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthoringProvenancePort } from "../ports/authoring-provenance.ts";

export class GitAuthoringProvenance implements AuthoringProvenancePort {
  private readonly repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  receipts(paths: readonly string[]) {
    const sourceCommit = this.git(["rev-parse", "HEAD"]).trim();
    return paths.map((path) => {
      const entry = this.git(["ls-files", "-s", "--", path]).trim();
      const match = /^\d+ ([a-f0-9]{40}) 0\t/.exec(entry);
      if (!match)
        throw new Error(`catalog-provenance-invalid: untracked or staged-conflict ${path}`);
      const bytes = readFileSync(join(this.repoRoot, path));
      return Object.freeze({
        path,
        blobOid: match[1],
        contentDigest: createHash("sha256").update(bytes).digest("hex"),
        sourceCommit,
      });
    });
  }

  private git(args: readonly string[]): string {
    return execFileSync("git", ["-C", this.repoRoot, ...args], { encoding: "utf8" });
  }
}
