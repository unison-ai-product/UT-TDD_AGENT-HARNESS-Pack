import { describe, expect, it } from "vitest";
import { parseStrictMarkdownTable } from "../../src/disposition/adapters/strict-markdown-table.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const valid = "| `id` | name |\n|---|---|\n| `A` | Alpha |\n";

describe("strict V-model authoring table", () => {
  it("loads an exact table without normalizing authored values", () => {
    expect(
      parseStrictMarkdownTable(encode(valid), {
        subjectId: "fixture",
        expectedHeaders: ["id", "name"],
        expectedRows: 1,
      }),
    ).toEqual({
      ok: true,
      rows: [{ id: "A", name: "Alpha" }],
    });
  });

  it.each([
    ["unknown column", "| `id` | extra |\n|---|---|\n| `A` | Alpha |\n"],
    ["duplicate column", "| `id` | id |\n|---|---|\n| `A` | Alpha |\n"],
    ["missing column", "| `id` |\n|---|\n| `A` |\n"],
  ])("fails closed for %s", (_, markdown) => {
    const result = parseStrictMarkdownTable(encode(markdown), {
      subjectId: "fixture",
      expectedHeaders: ["id", "name"],
    });
    expect(result).toMatchObject({
      ok: false,
      findings: [{ ruleId: "catalog-authoring-schema-invalid" }],
    });
  });

  it.each([
    ["row width", "| id | name |\n|---|---|\n| A | Alpha | extra |\n"],
    ["unbalanced inline code", "| id | name |\n|---|---|\n| `A | Alpha |\n"],
  ])("fails closed for %s", (_, markdown) => {
    const result = parseStrictMarkdownTable(encode(markdown), {
      subjectId: "fixture",
      expectedHeaders: ["id", "name"],
    });
    expect(result).toMatchObject({
      ok: false,
      findings: [{ ruleId: "catalog-authoring-row-invalid" }],
    });
  });

  it("fails closed for invalid UTF-8", () => {
    const result = parseStrictMarkdownTable(Uint8Array.of(0xc3, 0x28), {
      subjectId: "fixture",
      expectedHeaders: ["id"],
    });
    expect(result).toMatchObject({ ok: false, findings: [{ message: "invalid UTF-8" }] });
  });

  it("fails closed when an expected row is silently omitted", () => {
    const result = parseStrictMarkdownTable(encode(valid), {
      subjectId: "fixture",
      expectedHeaders: ["id", "name"],
      expectedRows: 2,
    });
    expect(result).toMatchObject({
      ok: false,
      findings: [{ ruleId: "catalog-authoring-count-invalid" }],
    });
  });

  it("fails closed when the same schema appears in more than one table", () => {
    const result = parseStrictMarkdownTable(encode(`${valid}\n${valid}`), {
      subjectId: "fixture",
      expectedHeaders: ["id", "name"],
    });
    expect(result).toMatchObject({
      ok: false,
      findings: [
        { ruleId: "catalog-authoring-schema-invalid", message: "table header is ambiguous" },
      ],
    });
  });
});
