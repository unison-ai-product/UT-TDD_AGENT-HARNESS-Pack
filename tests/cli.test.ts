import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("cli entrypoint smoke", () => {
  it("keeps the TypeScript CLI entrypoint wired to commander", () => {
    const source = readFileSync(join(process.cwd(), "src", "cli.ts"), "utf8");

    expect(source).toContain("new Command()");
    expect(source).toContain('.command("doctor")');
  });
});
