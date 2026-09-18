import { build } from "esbuild";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(process.env.UT_TDD_REPO_ROOT ?? process.cwd());
const output = resolve(process.argv[2] ?? resolve(root, "dist/node-generations/manual/ut-tdd.mjs"));
const metafile = resolve(process.argv[3] ?? `${output}.metafile.json`);

if (process.version !== "v24.13.0") {
  throw new Error(`reviewed Node required: v24.13.0 (got ${process.version})`);
}
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
