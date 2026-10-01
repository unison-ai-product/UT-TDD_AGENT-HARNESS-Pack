import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(process.env.UT_TDD_REPO_ROOT ?? process.cwd());
const output = resolve(process.argv[2] ?? resolve(root, "dist/node-generations/manual/ut-tdd.mjs"));
const metafile = resolve(process.argv[3] ?? `${output}.metafile.json`);

if (process.version !== "v24.13.0") {
  throw new Error(`reviewed Node required: v24.13.0 (got ${process.version})`);
}
const trackedSkillPaths = execFileSync("git", ["ls-files", "--", "skills"], {
  cwd: root,
  encoding: "utf8",
})
  .split(/\r?\n/)
  .filter((path) => path.startsWith("skills/") && /\.(md|ya?ml)$/i.test(path));
if (trackedSkillPaths.length === 0) throw new Error("tracked skill assets are missing");
const skillAliases = Object.fromEntries(
  trackedSkillPaths.map((path) => [
    `ut-tdd-skills/${path.slice("skills/".length)}`,
    resolve(root, path),
  ]),
);
const gateAssetPaths = [
  "docs/governance/gate-design.md",
  "docs/process/gates.md",
  "docs/process/vmodel-contract.yaml",
];
const gateAliases = Object.fromEntries(
  gateAssetPaths.map((path) => [`ut-tdd-gate-assets/${path}`, resolve(root, path)]),
);
const vmodelTemplatePaths = execFileSync(
  "git",
  ["ls-files", "-z", "--", "docs/templates/vmodel", "docs/governance/vmodel-document-catalog.md"],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  .filter((path) =>
    path === "docs/governance/vmodel-document-catalog.md" ||
    (path.startsWith("docs/templates/vmodel/") &&
      path.endsWith(".md") &&
      !path.startsWith("docs/templates/vmodel/review-examples/")),
  );
const vmodelTemplateAliases = Object.fromEntries(
  vmodelTemplatePaths.map((path) =>
    path === "docs/governance/vmodel-document-catalog.md"
      ? ["ut-tdd-vmodel-document-catalog", resolve(root, path)]
      : [`ut-tdd-vmodel-templates/${path.slice("docs/templates/vmodel/".length)}`, resolve(root, path)],
  ),
);
await mkdir(dirname(output), { recursive: true });
const temporary = `${output}.staging-${process.pid}`;
try {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [resolve(root, "src/cli.ts")],
    outfile: temporary,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    loader: { ".md": "text", ".yaml": "text", ".yml": "text" },
    alias: { ...skillAliases, ...gateAliases, ...vmodelTemplateAliases },
    define: { __UT_TDD_BUNDLED__: "true" },
    // commander is CommonJS and uses a dynamic builtin require. Provide the
    // Node ESM bridge so the sealed output is executable by the Node authority.
    banner: {
      js: 'import { createRequire as __nodeCreateRequire } from "node:module"; import { fileURLToPath as __nodeFileURLToPath } from "node:url"; import { dirname as __nodeDirname } from "node:path"; const require = __nodeCreateRequire(import.meta.url); const __filename = __nodeFileURLToPath(import.meta.url); const __dirname = __nodeDirname(__filename);',
    },
    metafile: true,
    sourcemap: false,
  });
  if (!result.metafile) throw new Error("authoritative Node builder did not produce metafile");
  await writeFile(metafile, `${JSON.stringify(result.metafile)}\n`, "utf8");
  await rename(temporary, output);
} finally {
  await rm(temporary, { force: true });
}
await readFile(output);
