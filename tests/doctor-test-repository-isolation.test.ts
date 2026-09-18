import { describe, expect, it } from "vitest";
import {
  analyzeTestRepositoryIsolation,
  checkTestRepositoryIsolation,
} from "../src/doctor/test-repository-isolation.ts";

describe("doctor test repository isolation", () => {
  it("U-TESTHYGIENE-013: rejects a new unclassified live repository read", () => {
    const result = analyzeTestRepositoryIsolation({
      files: [
        {
          path: "tests/new.test.ts",
          source: "const root = process" + ".cwd();",
        },
      ],
      contracts: {},
    });
    expect(result.ok).toBe(false);
    expect(result.messages).toContain(
      "test-repository-isolation - violation: unclassified:tests/new.test.ts:repository-read=1",
    );
  });

  it("U-TESTHYGIENE-024: rejects implicit cwd repository reads without process.cwd", () => {
    const result = analyzeTestRepositoryIsolation({
      files: [
        {
          path: "tests/fs.test.ts",
          source: "readFileSync('docs/governance/README.md', 'utf8');",
        },
        { path: "tests/bun.test.ts", source: "Bun.file('src/cli.ts');" },
      ],
      contracts: {},
    });
    expect(result.messages).toEqual(
      expect.arrayContaining([
        "test-repository-isolation - violation: unclassified:tests/fs.test.ts:repository-read=1",
        "test-repository-isolation - violation: unclassified:tests/bun.test.ts:repository-read=1",
      ]),
    );
  });

  it("U-TESTHYGIENE-025: rejects composed paths and alternate process references", () => {
    const result = analyzeTestRepositoryIsolation({
      files: [
        {
          path: "tests/join.test.ts",
          source: "readFileSync(join('docs', 'README.md'));",
        },
        {
          path: "tests/resolve.test.ts",
          source: "readFileSync(resolve('src/cli.ts'));",
        },
        { path: "tests/global.test.ts", source: "globalThis.process.cwd();" },
        {
          path: "tests/require.test.ts",
          source: "require('node:process').cwd();",
        },
        {
          path: "tests/destructure.test.ts",
          source: "const { cwd } = process; cwd();",
        },
      ],
      contracts: {},
    });
    expect(result.messages).toEqual(
      expect.arrayContaining([
        "test-repository-isolation - violation: unclassified:tests/join.test.ts:repository-read=1",
        "test-repository-isolation - violation: unclassified:tests/resolve.test.ts:repository-read=1",
        "test-repository-isolation - violation: unclassified:tests/global.test.ts:repository-read=1",
        "test-repository-isolation - violation: unclassified:tests/require.test.ts:repository-read=1",
        "test-repository-isolation - violation: forbidden-live-root-source:tests/destructure.test.ts",
      ]),
    );
  });

  it("U-TESTHYGIENE-029: rejects read aliases, async reads, and bracket live-root access", () => {
    const result = analyzeTestRepositoryIsolation({
      files: [
        {
          path: "tests/import-alias.test.ts",
          source: "import { readFile as load } from 'node:fs/promises'; load('docs/README.md');",
        },
        {
          path: "tests/const-alias.test.ts",
          source: "const load = readFileSync; load('src/cli.ts');",
        },
        {
          path: "tests/destructure-read.test.ts",
          source: "const { readFileSync: load } = require('node:fs'); load('docs/README.md');",
        },
        { path: "tests/env-bracket.test.ts", source: "process.env['PWD'];" },
        { path: "tests/global-bracket.test.ts", source: "globalThis['process'].cwd();" },
      ],
      contracts: {},
    });
    expect(result.messages).toEqual(
      expect.arrayContaining([
        "test-repository-isolation - violation: unclassified:tests/import-alias.test.ts:repository-read=1",
        "test-repository-isolation - violation: unclassified:tests/const-alias.test.ts:repository-read=1",
        "test-repository-isolation - violation: unclassified:tests/destructure-read.test.ts:repository-read=1",
        "test-repository-isolation - violation: forbidden-live-root-source:tests/env-bracket.test.ts",
        "test-repository-isolation - violation: forbidden-live-root-source:tests/global-bracket.test.ts",
      ]),
    );
  });

  it("U-TESTHYGIENE-031: does not let a bare headSnapshotRoot decoy satisfy a contract", () => {
    const result = analyzeTestRepositoryIsolation({
      files: [{ path: "tests/decoy-root.test.ts", source: "headSnapshotRoot();" }],
      contracts: {
        "tests/decoy-root.test.ts": {
          mode: "head_snapshot",
          calls: 1,
          reason: "must be consumed",
        },
      },
    });
    expect(result.messages).toContain(
      "test-repository-isolation - violation: stale-contract:tests/decoy-root.test.ts",
    );
  });

  it("U-TESTHYGIENE-035: traces local path/read/process aliases and rejects root decoys", () => {
    const result = analyzeTestRepositoryIsolation({
      files: [
        {
          path: "tests/path-alias.test.ts",
          source: "const p='docs/README.md'; readFileSync(p);",
        },
        {
          path: "tests/local-alias.test.ts",
          source: "function f(){ const load=readFileSync; load('src/cli.ts'); }",
        },
        {
          path: "tests/process-alias.test.ts",
          source: "const p=require('node:process'); p.cwd();",
        },
        {
          path: "tests/void-root.test.ts",
          source: "void headSnapshotRoot();",
        },
        {
          path: "tests/unused-root.test.ts",
          source: "const unused=headSnapshotRoot();",
        },
      ],
      contracts: {
        "tests/void-root.test.ts": { mode: "head_snapshot", calls: 1, reason: "decoy" },
        "tests/unused-root.test.ts": { mode: "head_snapshot", calls: 1, reason: "decoy" },
      },
    });
    expect(result.messages).toEqual(
      expect.arrayContaining([
        "test-repository-isolation - violation: unclassified:tests/path-alias.test.ts:repository-read=1",
        "test-repository-isolation - violation: unclassified:tests/local-alias.test.ts:repository-read=1",
        "test-repository-isolation - violation: unclassified:tests/process-alias.test.ts:repository-read=1",
        "test-repository-isolation - violation: stale-contract:tests/void-root.test.ts",
        "test-repository-isolation - violation: stale-contract:tests/unused-root.test.ts",
      ]),
    );
  });

  it("U-TESTHYGIENE-037: separates read provenance modes and rejects derived HEAD mutation sinks", () => {
    const result = analyzeTestRepositoryIsolation({
      files: [
        {
          path: "tests/provenance.test.ts",
          source:
            "import { headSnapshotRoot as root } from '../src/test/workspace-roots'; import { writeFileSync as save } from 'node:fs'; const get=root; const base=get(); const target=join(base, 'docs/x'); save(target, 'x'); process.cwd();",
        },
        {
          path: "tests/dead-root.test.ts",
          source: "if (false) check(headSnapshotRoot());",
        },
        {
          path: "tests/mutation-sinks.test.ts",
          source:
            "import { createWriteStream as stream, truncateSync as cut } from 'node:fs'; const root=headSnapshotRoot(); const target=join(root, 'docs/x'); stream(target); cut(target); Bun.write(target, 'x');",
        },
      ],
      contracts: {
        "tests/provenance.test.ts": {
          mode_calls: { head_snapshot: 1, isolated_fixture: 1 },
          reason: "separate capabilities",
        },
        "tests/dead-root.test.ts": { mode: "head_snapshot", calls: 1, reason: "dead decoy" },
        "tests/mutation-sinks.test.ts": {
          mode: "head_snapshot",
          calls: 1,
          reason: "all supported mutation sinks reject derived HEAD paths",
        },
      },
    });
    expect(result.messages).toEqual(
      expect.arrayContaining([
        "test-repository-isolation - violation: forbidden-live-root-source:tests/provenance.test.ts",
        "test-repository-isolation - violation: forbidden-live-root-source:tests/mutation-sinks.test.ts",
        "test-repository-isolation - violation: stale-contract:tests/dead-root.test.ts",
      ]),
    );
  });

  it("U-TESTHYGIENE-038: rejects supported Node and Bun mutation destinations below HEAD", () => {
    const result = analyzeTestRepositoryIsolation({
      files: [
        {
          path: "tests/all-sinks.test.ts",
          source:
            "import { chmodSync, copyFileSync, createWriteStream, linkSync, mkdtempSync, openSync, renameSync, symlinkSync, truncateSync, utimesSync } from 'node:fs'; const root=headSnapshotRoot(); const target=join(root, 'docs/x'); createWriteStream(target); openSync(target, 'w'); truncateSync(target); chmodSync(target, 0o644); utimesSync(target, 0, 0); mkdtempSync(join(root, 'tmp-')); copyFileSync('tmp', target); linkSync('tmp', target); symlinkSync('tmp', target); renameSync(target, 'tmp'); renameSync('tmp', target); Bun.write(target, 'x'); Bun.write(Bun.file(target), 'x');",
        },
        {
          path: "tests/read-only-open.test.ts",
          source: "const root=headSnapshotRoot(); openSync(join(root, 'docs/x'), 'r');",
        },
      ],
      contracts: {
        "tests/all-sinks.test.ts": { mode: "head_snapshot", calls: 1, reason: "sink coverage" },
        "tests/read-only-open.test.ts": { mode: "head_snapshot", calls: 1, reason: "read only" },
      },
    });
    expect(result.messages).toContain(
      "test-repository-isolation - violation: forbidden-live-root-source:tests/all-sinks.test.ts",
    );
    expect(result.messages).not.toContain(
      "test-repository-isolation - violation: forbidden-live-root-source:tests/read-only-open.test.ts",
    );
  });

  it("U-TESTHYGIENE-041: rejects a symlink destination below HEAD in isolation", () => {
    const result = analyzeTestRepositoryIsolation({
      files: [
        {
          path: "tests/symlink-sink.test.ts",
          source: "const root=headSnapshotRoot(); symlinkSync('tmp', join(root, 'docs/x'));",
        },
      ],
      contracts: {
        "tests/symlink-sink.test.ts": {
          mode: "head_snapshot",
          calls: 1,
          reason: "symlink destination",
        },
      },
    });
    expect(result.messages).toContain(
      "test-repository-isolation - violation: forbidden-live-root-source:tests/symlink-sink.test.ts",
    );
  });

  it("U-TESTHYGIENE-014: rejects callsite drift and stale contracts", () => {
    const result = analyzeTestRepositoryIsolation({
      files: [
        {
          path: "tests/a.test.ts",
          source: "process" + ".cwd(); process" + ".cwd();",
        },
      ],
      contracts: {
        "tests/a.test.ts": {
          mode: "isolated_fixture",
          calls: 1,
          reason: "fixture",
        },
        "tests/stale.test.ts": {
          mode: "head_snapshot",
          calls: 1,
          reason: "fixture",
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.messages).toEqual(
      expect.arrayContaining([
        "test-repository-isolation - violation: callsite-drift:tests/a.test.ts:isolated_fixture:expected=1:actual=2",
        "test-repository-isolation - violation: stale-contract:tests/stale.test.ts",
      ]),
    );
  });

  it("U-TESTHYGIENE-017: rejects direct root aliases that bypass snapshot cwd", () => {
    const result = analyzeTestRepositoryIsolation({
      files: [
        {
          path: "tests/dirname.test.ts",
          source: "const root = __" + "dirname;",
        },
        {
          path: "tests/meta.test.ts",
          source: "const root = import.meta." + "dirname;",
        },
        { path: "tests/element.test.ts", source: "process['" + "cwd']();" },
      ],
      contracts: {},
    });
    expect(result.messages).toEqual(
      expect.arrayContaining([
        "test-repository-isolation - violation: forbidden-live-root-source:tests/dirname.test.ts",
        "test-repository-isolation - violation: forbidden-live-root-source:tests/meta.test.ts",
        "test-repository-isolation - violation: forbidden-live-root-source:tests/element.test.ts",
      ]),
    );
  });

  it("U-TESTHYGIENE-018: AST detection rejects aliases and ignores comment or string decoys", () => {
    const result = analyzeTestRepositoryIsolation({
      files: [
        {
          path: "tests/alias.test.ts",
          source: "const get = process.cwd; get();",
        },
        {
          path: "tests/import.test.ts",
          source: "import { cwd as get } from 'node:process'; get();",
        },
        {
          path: "tests/env.test.ts",
          source: "const root = process.env.INIT_CWD;",
        },
        {
          path: "tests/decoy.test.ts",
          source: "// process.cwd()\nconst text = 'process.cwd()';",
        },
      ],
      contracts: {},
    });
    expect(result.messages).toEqual(
      expect.arrayContaining([
        "test-repository-isolation - violation: forbidden-live-root-source:tests/alias.test.ts",
        "test-repository-isolation - violation: forbidden-live-root-source:tests/import.test.ts",
        "test-repository-isolation - violation: forbidden-live-root-source:tests/env.test.ts",
      ]),
    );
    expect(result.messages).not.toContain(
      "test-repository-isolation - violation: forbidden-live-root-source:tests/decoy.test.ts",
    );
  });

  it("U-TESTHYGIENE-015: classifies every real repository test access", () => {
    expect(checkTestRepositoryIsolation(process.cwd()).ok).toBe(true);
  });
});
