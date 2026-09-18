export type TableFinding = {
  ruleId:
    | "catalog-authoring-schema-invalid"
    | "catalog-authoring-row-invalid"
    | "catalog-authoring-count-invalid";
  subjectId: string;
  message: string;
};

export type StrictTableResult =
  | { ok: true; rows: ReadonlyArray<Readonly<Record<string, string>>> }
  | { ok: false; findings: readonly TableFinding[] };

const divider = /^:?-{3,}:?$/;

function cells(line: string): string[] {
  return line
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function unwrap(value: string): string | undefined {
  const ticks = [...value].filter((character) => character === "`").length;
  if (ticks === 0) return value;
  return ticks % 2 === 0 ? value.replaceAll("`", "") : undefined;
}

function finding(ruleId: TableFinding["ruleId"], subjectId: string, message: string): TableFinding {
  return { ruleId, subjectId, message };
}

export function parseStrictMarkdownTable(
  input: Uint8Array,
  config: {
    subjectId: string;
    expectedHeaders: readonly string[];
    expectedRows?: number;
  },
): StrictTableResult {
  const { subjectId, expectedHeaders, expectedRows } = config;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    return {
      ok: false,
      findings: [finding("catalog-authoring-schema-invalid", subjectId, "invalid UTF-8")],
    };
  }
  const lines = text.split(/\r?\n/);
  const tableHeaders = lines.flatMap((line, index) => {
    if (!line.startsWith("|") || !line.endsWith("|")) return [];
    const next = lines[index + 1];
    const isHeader = Boolean(
      next?.startsWith("|") &&
        next.endsWith("|") &&
        cells(next).every((cell) => divider.test(cell)),
    );
    return isHeader ? [index] : [];
  });
  const matchingHeaders = tableHeaders.filter((index) => {
    const headers = cells(lines[index]).map(unwrap);
    return (
      headers.length === expectedHeaders.length &&
      headers.every((header, position) => header === expectedHeaders[position])
    );
  });
  if (matchingHeaders.length !== 1) {
    return {
      ok: false,
      findings: [
        finding(
          "catalog-authoring-schema-invalid",
          subjectId,
          matchingHeaders.length === 0 ? "table header missing" : "table header is ambiguous",
        ),
      ],
    };
  }
  const headerIndex = matchingHeaders[0];
  const rawHeaders = cells(lines[headerIndex]);
  const headers = rawHeaders.map(unwrap);
  if (
    headers.some((header) => header === undefined) ||
    headers.length !== expectedHeaders.length ||
    headers.some((header, index) => header !== expectedHeaders[index]) ||
    new Set(headers).size !== headers.length
  ) {
    return {
      ok: false,
      findings: [
        finding("catalog-authoring-schema-invalid", subjectId, "header mismatch or duplicate"),
      ],
    };
  }
  const rows: Array<Readonly<Record<string, string>>> = [];
  for (let index = headerIndex + 2; index < lines.length && lines[index].startsWith("|"); index++) {
    if (!lines[index].endsWith("|")) {
      return {
        ok: false,
        findings: [
          finding(
            "catalog-authoring-row-invalid",
            `${subjectId}:${index + 1}`,
            "row delimiter missing",
          ),
        ],
      };
    }
    const rawValues = cells(lines[index]);
    const values = rawValues.map(unwrap);
    if (values.length !== headers.length || values.some((value) => value === undefined)) {
      return {
        ok: false,
        findings: [
          finding(
            "catalog-authoring-row-invalid",
            `${subjectId}:${index + 1}`,
            "row width or inline-code delimiter invalid",
          ),
        ],
      };
    }
    rows.push(
      Object.freeze(
        Object.fromEntries(
          headers.map((header, cell) => [header as string, values[cell] as string]),
        ),
      ),
    );
  }
  if (expectedRows !== undefined && rows.length !== expectedRows) {
    return {
      ok: false,
      findings: [
        finding(
          "catalog-authoring-count-invalid",
          subjectId,
          `expected ${expectedRows} rows, got ${rows.length}`,
        ),
      ],
    };
  }
  return { ok: true, rows: Object.freeze(rows) };
}
