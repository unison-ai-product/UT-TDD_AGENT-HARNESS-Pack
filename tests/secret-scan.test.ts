import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeSecretScan,
  loadSystemSecretScanArtifacts,
  secretScanMessages,
} from "../src/lint/secret-scan.ts";

describe("docs-wide secret scan", () => {
  it("U-DOCSECRET-001: detects credential families required by PLAN-L6-62", () => {
    const ghp = `ghp_${"a".repeat(20)}`;
    const aws = `AKIA${"A".repeat(16)}`;
    const bearer = `Authorization: Bearer ${"b".repeat(20)}`;
    const password = `password=${"c".repeat(12)}`;
    const privateKey = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");

    const result = analyzeSecretScan([
      {
        path: "docs/plans/leak.md",
        text: [ghp, aws, bearer, password, privateKey].join("\n"),
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.marker).sort()).toEqual([
      "authorization-bearer",
      "aws-access-key",
      "github-token",
      "narrow-secret-token",
      "private-key-block",
      "secret-assignment",
    ]);
  });

  it("U-DOCSECRET-002: allows explicit dummy and placeholder examples without weakening real leaks", () => {
    const dummy = `password=${"d".repeat(12)} dummy`;
    const placeholder = `Authorization: Bearer ${"e".repeat(20)} placeholder`;
    const real = `access_token=${"f".repeat(12)}`;

    const result = analyzeSecretScan([
      { path: "docs/design/security.md", text: [dummy, placeholder, real].join("\n") },
    ]);

    expect(result.violations).toEqual([
      { path: "docs/design/security.md", line: 3, marker: "secret-assignment" },
    ]);
  });

  it("U-DOCSECRET-004: loads docs and runtime memory/audit surfaces as the system scan band", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-secret-scan-"));
    try {
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      mkdirSync(join(root, ".ut-tdd", "memory"), { recursive: true });
      writeFileSync(join(root, "docs", "plans", "ok.md"), "# OK\n", "utf8");
      writeFileSync(join(root, ".ut-tdd", "memory", "ok.md"), "# memory\n", "utf8");

      const paths = loadSystemSecretScanArtifacts(root).map((doc) => doc.path);

      expect(paths).toContain("docs/plans/ok.md");
      expect(paths).toContain(".ut-tdd/memory/ok.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-DOCSECRET-003: formats actionable doctor messages", () => {
    const token = `ghp_${"g".repeat(20)}`;
    const messages = secretScanMessages(
      analyzeSecretScan([{ path: "docs/plans/x.md", text: token }]),
    );

    expect(messages[0]).toContain("secret-scan — violation credential markers");
    expect(messages[0]).toContain("docs/plans/x.md:1:narrow-secret-token");
  });
});
