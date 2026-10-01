import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseStrictMarkdownTable } from "../disposition/adapters/strict-markdown-table.ts";
import { resolveAuthoringSourcePath, resolveDesignRoot } from "../shared/design-root.ts";
import {
  embeddedVModelDocumentCatalog,
  embeddedVModelTemplateAssets,
  embeddedVModelTemplatePortIndex,
} from "./vmodel-template-assets.ts";

const PORT_INDEX_PATH = "docs/templates/vmodel/README.md";
const DOCUMENT_CATALOG_PATH = "docs/governance/vmodel-document-catalog.md";
const TEMPLATE_ROOT = "docs/templates/vmodel/";

const SLOT_HEADERS = [
  "slot (doc_type_id)",
  "テンプレート file",
  "zip source (ZIP-DOC-NNN)",
] as const;
const OPTIONAL_HEADERS = [
  "zip 番号",
  "zip entry (decoded)",
  "sha256",
  "disposition (根拠: disposition catalog)",
  "テンプレート",
] as const;
const DOCUMENT_CATALOG_HEADERS = [
  "doc_type_id",
  "layer",
  "sub_doc",
  "category",
  "requirement_class",
  "applicability",
  "default_status",
  "source_doc_family",
  "authoring_source_path",
  "projection_table",
  "profile_controlled",
  "skip_reason_required",
] as const;

interface TemplateSource {
  readonly id: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
}

export interface VModelTemplateWriteOptions {
  readonly repoRoot?: string;
  readonly slot?: readonly string[];
  readonly required?: boolean;
  readonly optional?: readonly string[];
  readonly dryRun?: boolean;
}

export interface VModelTemplateWriteResult {
  readonly written: readonly string[];
  readonly skipped: readonly string[];
}

function strictRows(input: {
  readonly content: string;
  readonly subjectId: string;
  readonly expectedHeaders: readonly string[];
  readonly expectedRows?: number;
}): readonly Readonly<Record<string, string>>[] {
  const result = parseStrictMarkdownTable(Buffer.from(input.content, "utf8"), {
    subjectId: input.subjectId,
    expectedHeaders: input.expectedHeaders,
    expectedRows: input.expectedRows,
  });
  if (!result.ok)
    throw new Error(`vmodel-template-index-invalid: ${JSON.stringify(result.findings)}`);
  return result.rows;
}

function readSourceText(repoRoot: string, path: string): string {
  const assets = embeddedVModelTemplateAssets();
  if (assets.length === 0) return readFileSync(join(repoRoot, path), "utf8");
  const embedded = new Map<string, string>(
    assets.map((asset): [string, string] => [asset.path, asset.content]),
  );
  const content = embedded.get(path.slice(TEMPLATE_ROOT.length));
  if (content === undefined) throw new Error(`vmodel-template-asset-missing: ${path}`);
  return content;
}

function readPortIndex(repoRoot: string): string {
  return embeddedVModelTemplatePortIndex() ?? readFileSync(join(repoRoot, PORT_INDEX_PATH), "utf8");
}

function readDocumentCatalog(repoRoot: string): string {
  return (
    embeddedVModelDocumentCatalog() ?? readFileSync(join(repoRoot, DOCUMENT_CATALOG_PATH), "utf8")
  );
}

function validateRelativePath(path: string, subject: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    isAbsolute(normalized) ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`vmodel-template-index-invalid: unsafe path for ${subject}`);
  }
  return normalized;
}

function loadTemplateSources(repoRoot: string): {
  readonly slots: ReadonlyMap<string, TemplateSource>;
  readonly optional: ReadonlyMap<string, TemplateSource>;
} {
  const slotRows = strictRows({
    content: readPortIndex(repoRoot),
    subjectId: PORT_INDEX_PATH,
    expectedHeaders: SLOT_HEADERS,
    expectedRows: 21,
  });
  const optionalRows = strictRows({
    content: readPortIndex(repoRoot),
    subjectId: PORT_INDEX_PATH,
    expectedHeaders: OPTIONAL_HEADERS,
    expectedRows: 27,
  });
  const documentRows = strictRows({
    content: readDocumentCatalog(repoRoot),
    subjectId: DOCUMENT_CATALOG_PATH,
    expectedHeaders: DOCUMENT_CATALOG_HEADERS,
  });
  const documentPaths = new Map<string, string>();
  for (const row of documentRows) {
    const id = row.doc_type_id;
    if (!id || documentPaths.has(id)) throw new Error("vmodel-template-document-catalog-invalid");
    documentPaths.set(id, row.authoring_source_path);
  }

  const slots = new Map<string, TemplateSource>();
  for (const row of slotRows) {
    const id = row["slot (doc_type_id)"];
    const file = row["テンプレート file"];
    if (!/^DOC-[A-Z0-9-]+$/.test(id) || !/^[A-Za-z0-9][A-Za-z0-9.-]*\.md$/.test(file)) {
      throw new Error("vmodel-template-port-index-invalid");
    }
    const sourcePath = validateRelativePath(`${TEMPLATE_ROOT}${file}`, id);
    const authoringPath = documentPaths.get(id);
    if (!authoringPath?.startsWith("docs/")) {
      throw new Error(`vmodel-template-document-catalog-missing: ${id}`);
    }
    if (slots.has(id)) throw new Error(`vmodel-template-port-index-duplicate: ${id}`);
    slots.set(id, {
      id,
      sourcePath,
      destinationPath: validateRelativePath(
        resolveAuthoringSourcePath(repoRoot, authoringPath),
        id,
      ),
    });
  }

  const optional = new Map<string, TemplateSource>();
  for (const row of optionalRows) {
    const number = row["zip 番号"];
    const file = row.テンプレート;
    if (!/^\d{3}$/.test(number) || !/^optional\/[A-Za-z0-9][A-Za-z0-9.-]*\.md$/.test(file)) {
      throw new Error("vmodel-template-port-index-invalid");
    }
    const id = `ZIP-DOC-${number}`;
    if (optional.has(id)) throw new Error(`vmodel-template-port-index-duplicate: ${id}`);
    const sourcePath = validateRelativePath(`${TEMPLATE_ROOT}${file}`, id);
    optional.set(id, {
      id,
      sourcePath,
      destinationPath: validateRelativePath(
        join(resolveDesignRoot(repoRoot), "optional", file.slice("optional/".length)),
        id,
      ),
    });
  }

  return { slots, optional };
}

function insideRoot(repoRoot: string, relativePath: string): string {
  const absoluteRoot = resolve(repoRoot);
  const target = resolve(absoluteRoot, relativePath);
  const escaped = relative(absoluteRoot, target);
  if (escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
    throw new Error("vmodel-template-destination-escape");
  }
  return target;
}

function assertPhysicalDestination(realRoot: string, target: string, relativePath: string): void {
  let current = target;
  while (true) {
    let entry: ReturnType<typeof lstatSync>;
    try {
      entry = lstatSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
      continue;
    }

    if (current === target && entry.isSymbolicLink()) {
      throw new Error(`template destination outside consumer root ${relativePath}`);
    }

    let physicalAncestor: string;
    try {
      physicalAncestor = realpathSync.native(current);
    } catch {
      throw new Error(`template destination outside consumer root ${relativePath}`);
    }
    const physicalRelative = relative(realRoot, physicalAncestor);
    if (
      physicalRelative === ".." ||
      physicalRelative.startsWith(`..${sep}`) ||
      isAbsolute(physicalRelative)
    ) {
      throw new Error(`template destination outside consumer root ${relativePath}`);
    }
    return;
  }
}

export function writeVModelTemplates(
  options: VModelTemplateWriteOptions,
): VModelTemplateWriteResult {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const realRoot = realpathSync.native(repoRoot);
  const slots = options.slot ?? [];
  const optionalIds = options.optional ?? [];
  if (!options.required && slots.length === 0 && optionalIds.length === 0) {
    throw new Error("at least one template selector is required");
  }

  const catalog = loadTemplateSources(repoRoot);
  const requested: TemplateSource[] = [];
  const addKnown = (id: string, source: TemplateSource | undefined): void => {
    if (!source) throw new Error(`unknown template ${id}`);
    requested.push(source);
  };
  for (const id of slots) addKnown(id, catalog.slots.get(id));
  if (options.required) {
    for (const source of catalog.slots.values()) requested.push(source);
  }
  for (const id of optionalIds) addKnown(id, catalog.optional.get(id));

  // Resolve and read every requested payload before the first write so an
  // unknown/missing bundled template cannot cause a prefix of the request to land.
  const unique = new Map<string, { path: string; content: string }>();
  for (const source of requested) {
    const path = source.destinationPath;
    if (!unique.has(path)) {
      unique.set(path, {
        path,
        content: readSourceText(repoRoot, source.sourcePath),
      });
    }
  }

  const destinations = [...unique.values()].map((item) => {
    const target = insideRoot(repoRoot, item.path);
    assertPhysicalDestination(realRoot, target, item.path);
    return { item, target };
  });

  const written: string[] = [];
  const skipped: string[] = [];
  for (const { item, target } of destinations) {
    if (existsSync(target)) {
      skipped.push(item.path);
      continue;
    }
    if (!options.dryRun) {
      mkdirSync(dirname(target), { recursive: true });
      try {
        writeFileSync(target, item.content, { encoding: "utf8", flag: "wx" });
        written.push(item.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") skipped.push(item.path);
        else throw error;
      }
    } else {
      written.push(item.path);
    }
  }

  return Object.freeze({
    written: Object.freeze(written),
    skipped: Object.freeze(skipped),
  });
}
