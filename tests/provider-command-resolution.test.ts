import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAdapterPlanForCli } from "../src/cli/delegation.ts";
import {
  buildAdapterPlan,
  buildProviderInvocation,
  isProviderCommandSpawnable,
  type ProviderCommandResolutionOptions,
  type ProviderProbeInput,
  type ProviderProbeOptions,
  resolveClaudeNativeCommand,
  resolveCodexNativeCommand,
} from "../src/runtime/adapter.ts";
import { findOnPath, type PathFs } from "../src/runtime/path-lookup.ts";
import { removeTestTree } from "./support/temp-tree.ts";

// issue #1694 (L7 provider-command-resolution-test-design.md CANDIDATE-U-PCMDRES-001〜014)。
// 登録と Red の PR: src は stub (findOnPath は常に null) だけなので、全 oracle を it.fails で登録する。
// 期待値の path は literal で書く (production の code から生成しない)。

// Red では adapter.ts を変えない (design-protection-diff-gate §10.3 手順 1')。pathFs は production の型にまだ無いので、
// test 局所の交差型で受けて既存の型へ渡す。Green が ProviderCommandResolutionOptions に pathFs を足したらこの型を外す。
type OptionsWithPathFs = ProviderCommandResolutionOptions & { pathFs?: PathFs };
function withFs<T extends ProviderProbeOptions>(opts: T & OptionsWithPathFs): T {
  return opts;
}

type Scenario = {
  platform: NodeJS.Platform;
  sep: string;
  delim: string;
  real: string;
  file: string;
  extra: NodeJS.ProcessEnv;
};
const WIN: Scenario = {
  platform: "win32",
  sep: "\\",
  delim: ";",
  real: "C:\\real",
  file: "claude.cmd",
  extra: { PATHEXT: ".CMD" },
};
const POSIX: Scenario = {
  platform: "linux",
  sep: "/",
  delim: ":",
  real: "/real",
  file: "claude",
  extra: {},
};

type FakeFs = { fs: PathFs; checked: string[]; files: Set<string>; executable: Set<string> };

/** fake の file の集合を持つ PathFs。Windows の path は大小を区別せず、isFile に渡された path を記録する。 */
function fakeFs(platform: NodeJS.Platform, files: string[], executable: string[] = []): FakeFs {
  const key = (p: string) => (platform === "win32" ? p.toLowerCase() : p);
  const fileSet = new Set(files.map(key));
  const execSet = new Set(executable.map(key));
  const checked: string[] = [];
  return {
    checked,
    files: fileSet,
    executable: execSet,
    fs: {
      isFile: (p) => {
        checked.push(p);
        return fileSet.has(key(p));
      },
      canExecute: (p) => platform === "win32" || execSet.has(key(p)),
    },
  };
}

const temps: string[] = [];
function emptyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ut-pcmdres-"));
  temps.push(dir);
  return dir;
}
const cwdSpies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of cwdSpies.splice(0)) spy.mockRestore();
  for (const dir of temps.splice(0)) removeTestTree(dir);
});

/** process.cwd() を platform 別の固定値にして返す (実 repo を読まず、decoy の位置を test が決める)。 */
function mockCwd(s: Scenario): string {
  const cwd = s.platform === "win32" ? "C:\\work\\repo" : "/work/repo";
  cwdSpies.push(vi.spyOn(process, "cwd").mockReturnValue(cwd));
  return cwd;
}

function pathEnv(s: Scenario, dirs: string[], extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: dirs.join(s.delim), ...s.extra, ...extra };
}
function cwdFile(s: Scenario, cwd: string, ...parts: string[]): string {
  return [cwd, ...parts].join(s.sep);
}
function touchesCwd(checked: string[], cwd: string): boolean {
  return checked.some((p) => p.toLowerCase().startsWith(cwd.toLowerCase()));
}

// 001〜003: 空・`.`・相対の要素を飛ばす。
const RELATIVE_CASES = [
  { id: "001 empty element", first: "", decoyDir: [] as string[] },
  { id: "002 dot element", first: ".", decoyDir: [] as string[] },
  { id: "003 relative element", first: "rel", decoyDir: ["rel"] },
];
describe("CANDIDATE-U-PCMDRES-001..003 PATH の空・相対の要素", () => {
  for (const c of RELATIVE_CASES) {
    for (const s of [WIN, POSIX]) {
      it.fails(`CANDIDATE-U-PCMDRES-${c.id} (${s.platform})`, () => {
        const cwd = mockCwd(s);
        const real = `${s.real}${s.sep}${s.file}`;
        const decoys = [
          cwdFile(s, cwd, ...c.decoyDir, s.file),
          cwdFile(s, cwd, ...c.decoyDir, "claude"),
        ];
        const f = fakeFs(s.platform, [...decoys, real], [...decoys, real]);
        const env = pathEnv(s, [c.first, s.real]);
        expect(findOnPath({ command: "claude", env: env, platform: s.platform, fs: f.fs })).toBe(
          real,
        );
        expect(touchesCwd(f.checked, cwd)).toBe(false);
      });
    }
  }
});

describe("CANDIDATE-U-PCMDRES-004..008 走査の規則", () => {
  it.fails("CANDIDATE-U-PCMDRES-004 PATHEXT の順 (win32)", () => {
    const f = fakeFs("win32", ["C:\\real\\claude.bat", "C:\\real\\claude.cmd"]);
    const withExt = { PATH: "C:\\real", PATHEXT: ".COM;.EXE;.CMD;.BAT" };
    const noExt = { PATH: "C:\\real" };
    expect(findOnPath({ command: "claude", env: withExt, platform: "win32", fs: f.fs })).toBe(
      "C:\\real\\claude.cmd",
    );
    expect(findOnPath({ command: "claude", env: noExt, platform: "win32", fs: f.fs })).toBe(
      "C:\\real\\claude.bat",
    );
  });

  it.fails("CANDIDATE-U-PCMDRES-005 拡張子の限定 (win32)", () => {
    const a = fakeFs("win32", ["C:\\a\\claude.ps1", "C:\\a\\claude.js"]);
    expect(
      findOnPath({
        command: "claude",
        env: { PATH: "C:\\a", PATHEXT: ".PS1;.JS;.EXE" },
        platform: "win32",
        fs: a.fs,
      }),
    ).toBe(null);
    const b = fakeFs("win32", ["C:\\a\\claude", "C:\\a\\claude.ps1", "C:\\b\\claude.cmd"]);
    expect(
      findOnPath({
        command: "claude",
        env: { PATH: "C:\\a;C:\\b", PATHEXT: ".PS1;.CMD" },
        platform: "win32",
        fs: b.fs,
      }),
    ).toBe("C:\\b\\claude.cmd");
  });

  it.fails("CANDIDATE-U-PCMDRES-006 実行権限 (linux)", () => {
    const a = fakeFs("linux", ["/a/claude", "/b/claude"], ["/b/claude"]);
    expect(
      findOnPath({ command: "claude", env: { PATH: "/a:/b" }, platform: "linux", fs: a.fs }),
    ).toBe("/b/claude");
    const b = fakeFs("linux", ["/a/claude"], []);
    expect(
      findOnPath({ command: "claude", env: { PATH: "/a" }, platform: "linux", fs: b.fs }),
    ).toBe(null);
  });

  for (const s of [WIN, POSIX]) {
    it.fails(`CANDIDATE-U-PCMDRES-007 最初の候補 (${s.platform})`, () => {
      // Windows の絶対 path はドライブ付き (claude-version-probe.md §3)。期待値は literal で持つ。
      const a = s.platform === "win32" ? "C:\\a\\claude.cmd" : "/a/claude";
      const b = s.platform === "win32" ? "C:\\b\\claude.cmd" : "/b/claude";
      const dirA = s.platform === "win32" ? "C:\\a" : "/a";
      const dirB = s.platform === "win32" ? "C:\\b" : "/b";
      const f = fakeFs(s.platform, [a, b], [a, b]);
      expect(
        findOnPath({
          command: "claude",
          env: pathEnv(s, [dirA, dirB]),
          platform: s.platform,
          fs: f.fs,
        }),
      ).toBe(a);
      const none = fakeFs(s.platform, [], []);
      expect(
        findOnPath({
          command: "claude",
          env: pathEnv(s, [dirA, dirB]),
          platform: s.platform,
          fs: none.fs,
        }),
      ).toBe(null);
    });
  }

  it.fails("CANDIDATE-U-PCMDRES-008 PATH の変数名 Path (win32)", () => {
    const f = fakeFs("win32", ["C:\\real\\claude.cmd"]);
    expect(
      findOnPath({
        command: "claude",
        env: { Path: "C:\\real", PATHEXT: ".CMD" },
        platform: "win32",
        fs: f.fs,
      }),
    ).toBe("C:\\real\\claude.cmd");
  });
});

describe("CANDIDATE-U-PCMDRES-009..010 解決の順序と配線", () => {
  it.fails("CANDIDATE-U-PCMDRES-009 明示 → native → PATH (win32)", () => {
    const home = emptyDir();
    const explicit = join(home, "explicit", "claude.exe");
    const native = join(home, "Claude", "claude-code", "1.0.0", "claude.exe");
    for (const p of [explicit, native]) {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "");
    }
    const pathFile = "C:\\real\\claude.cmd";
    const f = fakeFs("win32", [pathFile]);
    const base = { PATH: "C:\\real", PATHEXT: ".CMD", USERPROFILE: home };
    const noNativeHome = emptyDir();
    const a = resolveClaudeNativeCommand(
      withFs({
        platform: "win32",
        env: { ...base, APPDATA: home, UT_TDD_CLAUDE_BIN: explicit },
        pathFs: f.fs,
      }),
    );
    const b = resolveClaudeNativeCommand(
      withFs({
        platform: "win32",
        env: { ...base, APPDATA: home },
        pathFs: f.fs,
      }),
    );
    const c = resolveClaudeNativeCommand(
      withFs({
        platform: "win32",
        env: { ...base, APPDATA: noNativeHome, USERPROFILE: noNativeHome },
        pathFs: f.fs,
      }),
    );
    expect([a, b, c]).toEqual([explicit, native, pathFile]);
  });

  it.fails("CANDIDATE-U-PCMDRES-010 claude と codex の配線 (win32)", () => {
    const home = emptyDir();
    const cwd = mockCwd(WIN);
    const decoys = [cwdFile(WIN, cwd, "claude.cmd"), cwdFile(WIN, cwd, "codex.cmd")];
    const reals = ["C:\\real\\claude.cmd", "C:\\real\\codex.cmd"];
    const f = fakeFs("win32", [...decoys, ...reals]);
    const opts = {
      platform: "win32" as const,
      env: { PATH: "C:\\real", PATHEXT: ".CMD", APPDATA: home, USERPROFILE: home },
      pathFs: f.fs,
    };
    expect([resolveClaudeNativeCommand(opts), resolveCodexNativeCommand(opts)]).toEqual(reals);
    expect(touchesCwd(f.checked, cwd)).toBe(false);
  });
});

describe("CANDIDATE-U-PCMDRES-011..012 probe", () => {
  for (const s of [WIN, POSIX]) {
    for (const provider of ["claude", "codex"] as const) {
      it.fails(`CANDIDATE-U-PCMDRES-011 解決できない ${provider} は probe しない (${s.platform})`, () => {
        const home = emptyDir();
        const probe = vi.fn(() => ({ status: 0 }));
        const f = fakeFs(s.platform, []);
        const ok = isProviderCommandSpawnable(
          provider,
          withFs({
            platform: s.platform,
            env: pathEnv(s, [s.real], { APPDATA: home, USERPROFILE: home, HOME: home }),
            pathFs: f.fs,
            runProbe: probe,
          }),
        );
        expect(ok).toBe(false);
        expect(probe).toHaveBeenCalledTimes(0);
      });
    }
  }

  it.fails("CANDIDATE-U-PCMDRES-012 解決した絶対 path で probe する (win32)", () => {
    const home = emptyDir();
    const base = {
      PATH: "C:\\real",
      PATHEXT: ".CMD",
      APPDATA: home,
      USERPROFILE: home,
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    };
    // exe 側は PATHEXT に .EXE を含め、cmd 側 (.CMD) とは env を分ける。
    const exeBase = { ...base, PATHEXT: ".EXE" };
    const exeProbe = vi.fn((_input: ProviderProbeInput) => ({ status: 0 }));
    isProviderCommandSpawnable(
      "claude",
      withFs({
        platform: "win32",
        env: exeBase,
        pathFs: fakeFs("win32", ["C:\\real\\claude.exe"]).fs,
        runProbe: exeProbe,
      }),
    );
    expect(exeProbe).toHaveBeenCalledTimes(1);
    expect(exeProbe.mock.calls[0]?.[0]).toMatchObject({
      command: "C:\\real\\claude.exe",
      args: ["--version"],
    });
    const cmdProbe = vi.fn((_input: ProviderProbeInput) => ({ status: 0 }));
    isProviderCommandSpawnable(
      "claude",
      withFs({
        platform: "win32",
        env: base,
        pathFs: fakeFs("win32", ["C:\\real\\claude.cmd"]).fs,
        runProbe: cmdProbe,
      }),
    );
    expect(cmdProbe).toHaveBeenCalledTimes(1);
    const input = cmdProbe.mock.calls[0]?.[0];
    expect(input?.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(input?.args[3]).toContain('"C:\\real\\claude.cmd"');
  });
});

describe.skipIf(process.platform !== "win32")(
  "CANDIDATE-U-PCMDRES-013 実 process (win32 のみ)",
  () => {
    it.fails("CANDIDATE-U-PCMDRES-013 cwd の decoy を起動しない", () => {
      const root = emptyDir();
      const decoyDir = join(root, "decoy");
      const realDir = join(root, "real");
      const emptyHome = join(root, "home");
      for (const dir of [decoyDir, realDir, emptyHome]) mkdirSync(dir, { recursive: true });
      const script = '@echo off\r\ntype nul > "%~dp0ran.txt"\r\nexit /b 0\r\n';
      for (const dir of [decoyDir, realDir]) writeFileSync(join(dir, "claude.cmd"), script);
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const childEnv = {
        PATH: `${realDir};${join(systemRoot, "System32")}`,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        APPDATA: emptyHome,
        USERPROFILE: emptyHome,
        SystemRoot: systemRoot,
        ComSpec: process.env.ComSpec ?? join(systemRoot, "System32", "cmd.exe"),
      };
      // 実行中の test file の位置から adapter を辿る (process.cwd() や repo root の関数を使わない)。
      const testPath = expect.getState().testPath ?? "";
      const adapterUrl = pathToFileURL(
        join(dirname(testPath), "..", "src", "runtime", "adapter.ts"),
      ).href;
      const code = `import(${JSON.stringify(adapterUrl)}).then((m) => { process.stdout.write(JSON.stringify(m.isProviderCommandSpawnable("claude", { env: JSON.parse(process.env.PCR_ENV) }))); });`;
      const child = spawnSync(process.execPath, ["-e", code], {
        cwd: decoyDir,
        env: { ...process.env, PCR_ENV: JSON.stringify(childEnv) },
        encoding: "utf8",
        windowsHide: true,
      });
      expect(JSON.parse(child.stdout)).toBe(true);
      expect(existsSync(join(realDir, "ran.txt"))).toBe(true);
      expect(existsSync(join(decoyDir, "ran.txt"))).toBe(false);
    });
  },
);

describe("CANDIDATE-U-PCMDRES-014 全起動経路で素の名前を spawn しない", () => {
  const WIN_OPTS = (home: string, pathFs: PathFs) => ({
    platform: "win32" as const,
    env: {
      PATH: "C:\\real",
      PATHEXT: ".CMD",
      APPDATA: home,
      USERPROFILE: home,
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    },
    pathFs,
  });
  const invocation = (provider: "claude" | "codex", opts: ReturnType<typeof WIN_OPTS>) =>
    buildProviderInvocation({ provider, command: provider, args: ["--version"], opts });

  it.fails("CANDIDATE-U-PCMDRES-014a 解決できなければ例外 (invocation を返さない)", () => {
    const opts = WIN_OPTS(emptyDir(), fakeFs("win32", []).fs);
    expect(() => invocation("claude", opts)).toThrow("provider_command_unresolved");
    expect(() => invocation("codex", opts)).toThrow("provider_command_unresolved");
  });

  it.fails("CANDIDATE-U-PCMDRES-014b probe 後に候補が消えたら再解決して例外", () => {
    const f = fakeFs("win32", ["C:\\real\\claude.cmd"]);
    const opts = WIN_OPTS(emptyDir(), f.fs);
    const probe = vi.fn(() => ({ status: 0 }));
    expect(isProviderCommandSpawnable("claude", { ...opts, runProbe: probe })).toBe(true);
    f.files.clear();
    expect(() => invocation("claude", opts)).toThrow("provider_command_unresolved");
  });

  it.fails("CANDIDATE-U-PCMDRES-014c available=true でも解決できなければ spawn しない", () => {
    // 実 filesystem (空の一時 directory) と process.env を使う。変更前に全 env を保存する。
    // Windows の process.env は大文字小文字を区別しないので、path / pathext の別名 key を別物として扱わない。
    const home = emptyDir();
    const before: NodeJS.ProcessEnv = { ...process.env };
    const isPathKey = (key: string) => ["path", "pathext"].includes(key.toLowerCase());
    const setEnv = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(home);
    const spawn = vi.fn(() => ({ status: 0, signal: null }));
    try {
      for (const key of Object.keys(process.env)) if (isPathKey(key)) delete process.env[key];
      setEnv("PATH", home);
      setEnv("APPDATA", home);
      setEnv("USERPROFILE", home);
      setEnv("HOME", home);
      setEnv("UT_TDD_CLAUDE_BIN", undefined);
      // mode を明示した plan は detectMode の probe を通らず available=true になる (team run --mode hybrid と同じ)。
      const plan = buildAdapterPlan(
        { provider: "claude", role: "se", task: "probe unresolved", execute: true },
        "hybrid",
      );
      expect(plan.available).toBe(true);
      let thrown: unknown;
      try {
        executeAdapterPlanForCli(
          plan,
          { sessionPrefix: "issue1694-unresolved", toolName: "claude" },
          {
            gitHead: () => "deadbee",
            runSessionStartSideEffects: () => {},
            writeHandoverWarnings: () => {},
            spawnSync: spawn,
          },
        );
      } catch (error) {
        thrown = error;
      }
      expect(spawn).toHaveBeenCalledTimes(0);
      expect((thrown as Error | undefined)?.message).toBe("provider_command_unresolved");
    } finally {
      cwd.mockRestore();
      // 現在の key を全て消してから、保存した key をそのまま戻す (別名 key を残さない)。
      for (const key of Object.keys(process.env)) delete process.env[key];
      for (const [key, value] of Object.entries(before)) setEnv(key, value);
    }
    expect({ ...process.env }).toEqual(before);
  });
});
