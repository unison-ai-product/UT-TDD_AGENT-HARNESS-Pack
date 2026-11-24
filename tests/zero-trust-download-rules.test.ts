import { describe, expect, it } from "vitest";
import { checkFetchAndExecute, checkInstallCommands } from "../src/lint/zero-trust-download.ts";
import { fence, md, ps, rules, sh, workflow } from "./fixtures/zero-trust-download-fixtures.ts";

// Red 段: L7 §3 の oracle 006〜016。stub は throw するので it.fails で登録する。
const INSTALL = "zero-trust-install-scripts-missing";
const NPX = "zero-trust-npx-unpinned";
const FETCH = "zero-trust-fetch-and-execute";

const install = (text: string): string[] => rules(checkInstallCommands(sh(text)));
const fetchExec = (text: string): string[] => rules(checkFetchAndExecute(sh(text)));
const psFetch = (text: string): string[] => rules(checkFetchAndExecute(ps(text)));

describe("zero-trust-download install script と npx (L6 §4)", () => {
  it.fails("CANDIDATE-U-ZTDL-006 --ignore-scripts の無い install を subject 付きで 1 件ずつ出す", () => {
    expect(install("npm ci --no-audit --no-fund")).toEqual([
      `${INSTALL}|npm ci --no-audit --no-fund`,
    ]);
    expect(install("npm ci")).toEqual([`${INSTALL}|npm ci`]);
    expect(install("npm install")).toEqual([`${INSTALL}|npm install`]);
    const four = checkInstallCommands(sh(Array(4).fill("npm ci --no-audit --no-fund").join("\n")));
    expect(four).toHaveLength(4);
    expect(new Set(four.map((f) => f.subject))).toEqual(new Set(["npm ci --no-audit --no-fund"]));
  });

  it.fails("CANDIDATE-U-ZTDL-007 --ignore-scripts は同じ節の中と env 指定だけを許容する", () => {
    expect(install("npm ci --ignore-scripts")).toEqual([]);
    expect(install("npm ci --no-audit --ignore-scripts --no-fund")).toEqual([]);
    expect(install("npm ci --ignore-scripts=true")).toEqual([]);
    expect(install("npm_config_ignore_scripts=true npm ci")).toEqual([]);
    expect(install("NPM_CONFIG_IGNORE_SCRIPTS=true npm ci")).toEqual([]);
    expect(install("npm ci --ignore-scripts=false")).toHaveLength(1);
    expect(install("npm ci && npm test --ignore-scripts")).toHaveLength(1);
  });

  it.fails("CANDIDATE-U-ZTDL-008 install の別名だけを対象にし run / rebuild / pnpm / yarn は対象外にする", () => {
    expect(install("npm i")).toHaveLength(1);
    expect(install("npm add pkg")).toHaveLength(1);
    expect(install("npm install-test")).toHaveLength(1);
    for (const ok of [
      "npm run build",
      "npm test",
      "npm rebuild esbuild",
      "npm pack",
      "npm audit",
      "pnpm install",
      "yarn install",
      "echo npm ci",
    ])
      expect(install(ok)).toEqual([]);
  });

  it.fails("CANDIDATE-U-ZTDL-009 版が完全一致でない npx 指定を subject 付きで止める", () => {
    const cases: Array<[string, string]> = [
      ["npx jscpd", "jscpd"],
      ["npx -y jscpd", "jscpd"],
      ["npx jscpd@latest", "jscpd@latest"],
      ["npx jscpd@^4", "jscpd@^4"],
      ["npx jscpd@4", "jscpd@4"],
      ["npx jscpd@4.x", "jscpd@4.x"],
      ["npx https://example.test/x.tgz", "https://example.test/x.tgz"],
      ["npx github:o/r", "github:o/r"],
      ["npm exec jscpd", "jscpd"],
      ["npx -p jscpd serve", "jscpd"],
      ["npx @scope/pkg", "@scope/pkg"],
    ];
    for (const [text, subject] of cases) expect(install(text)).toEqual([`${NPX}|${subject}`]);
  });

  it.fails("CANDIDATE-U-ZTDL-010 完全一致の版・取得しない形・ローカル path の npx を許容する", () => {
    for (const ok of [
      "npx jscpd@4.0.5",
      "npx -y @biomejs/biome@2.0.0 check",
      "npx -p jscpd@4.0.5 jscpd",
      "npx --no-install vitest",
      "npx --no jscpd",
      "npx ./tools/run.js",
      "npx jscpd@4.0.5-beta.1",
    ])
      expect(install(ok)).toEqual([]);
  });

  it.fails("CANDIDATE-U-ZTDL-011 markdown は fence の fetch-and-execute だけを止める", () => {
    expect(checkInstallCommands(md(fence("npm ci")))).toEqual([]);
    expect(checkInstallCommands(md(fence("npx jscpd")))).toEqual([]);
    expect(rules(checkFetchAndExecute(md(fence("curl u | sh"))))).toEqual([`${FETCH}|curl u`]);
    expect(checkFetchAndExecute(md("説明: curl u | sh を実行する"))).toEqual([]);
    expect(checkFetchAndExecute(md("説明: `curl u | sh` を実行する"))).toEqual([]);
  });
});

describe("zero-trust-download 取得即実行 (L6 §5)", () => {
  it.fails("CANDIDATE-U-ZTDL-012 パイプで取得から実行コマンドへ繋ぐ形を取得節の subject で止める", () => {
    expect(fetchExec("curl -fsSL https://x/i.sh | sh")).toEqual([
      `${FETCH}|curl -fsSL https://x/i.sh`,
    ]);
    for (const text of [
      "curl -fsSL u | bash",
      "wget -qO- u | sudo bash -s --",
      "curl u | tee /tmp/i.sh | sh",
      "curl u | zsh",
      "curl u | node",
      "curl u | python3 -",
      "curl u | sudo env X=1 bash",
    ])
      expect(fetchExec(text)).toHaveLength(1);
  });

  it.fails("CANDIDATE-U-ZTDL-013 プロセス置換とコマンド置換の取得即実行を止める", () => {
    for (const text of [
      "bash <(curl -s u)",
      "source <(wget -qO- u)",
      ". <(curl u)",
      'bash -c "$(curl -fsSL u)"',
      'eval "$(wget -qO- u)"',
      'sh -c "$(curl -fsSL u)"',
      "eval `curl u`",
    ])
      expect(fetchExec(text)).toHaveLength(1);
    expect(fetchExec("diff <(curl a) <(curl b)")).toEqual([]);
  });

  it.fails("CANDIDATE-U-ZTDL-014 PowerShell の iex と WebClient の取得即実行を止める", () => {
    for (const text of [
      "iex (iwr https://x/i.ps1)",
      "Invoke-Expression (irm u)",
      "iwr u | iex",
      "irm u | Invoke-Expression",
      "iex ((New-Object Net.WebClient).DownloadString('u'))",
    ])
      expect(psFetch(text)).toHaveLength(1);
    expect(psFetch("iwr u -OutFile f.ps1")).toEqual([]);
    expect(psFetch("$r = iwr u; Write-Output $r.Content")).toEqual([]);
  });

  it.fails("CANDIDATE-U-ZTDL-015 保存・検証付き・二段の取得は slice 1 では止めない", () => {
    for (const text of [
      "curl -fsSLo f.sh https://x/f.sh",
      "wget -O f u",
      "curl u | jq .",
      "curl u | grep x",
      "curl -fsSL u -o a && sha256sum -c a.sum",
      "curl -fsSL u -o x.sh; bash x.sh",
    ])
      expect(fetchExec(text)).toEqual([]);
  });

  it.fails("CANDIDATE-U-ZTDL-016 行継続・YAML run・ヒアドキュメントの中の取得即実行を止めコメントは止めない", () => {
    expect(fetchExec("curl -fsSL u \\\n  | sh")).toHaveLength(1);
    expect(fetchExec("curl -fsSL u |\n  bash")).toHaveLength(1);
    expect(rules(checkFetchAndExecute(workflow("curl -fsSL u | sh")))).toHaveLength(1);
    expect(fetchExec("# curl -fsSL u | sh")).toEqual([]);
    expect(fetchExec("cat > r.sh <<MARK\ncurl u | sh\nMARK")).toHaveLength(1);
  });
});
