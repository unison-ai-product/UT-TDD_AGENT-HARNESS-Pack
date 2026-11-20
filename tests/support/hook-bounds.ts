import { afterAll, afterEach, beforeAll, beforeEach, it } from "vitest";

// Issue #1673 1b: Vitest 4 は同期 hook にも既定 10000ms の上限を課す。負荷のかかった Windows runner では
// fixture の準備・後始末が 10s を超えるため、重い hook にだけ有限の上限を明示する (hookTimeout の一括設定はしない)。
// 値は「fixture の準備・後始末の許容時間」であり、`[hook-timing]` の実測 (CI log) から後で締め直す。
// code-size の baseline は非空行数を数える。import を 1 行足せない巨大 test file は、vitest の
// describe / expect / it をここから import して vitest の import 行と置き換える (行数は増えない)。
// `vi` は vi.mock の hoist が "vitest" からの import を前提とするため、ここへは通さない。
export { afterAll, beforeAll, describe, expect, it } from "vitest";

export const HOOK_BOUND_MS = {
  // git の init / commit / worktree / bare remote / clone と repo tree の複製を伴う fixture。
  // 負荷時は git 1 回が数秒かかり、数十回の連続実行を含むため 2 分を許容する。
  git: 120_000,
  // sqlite の作成・migrate・rebuild・projection、または CLI を子 process で回す fixture。
  // DB の再構築は git より重く、同種の既存上限 (180_000) に合わせる。
  db: 180_000,
  // npm pack / dist build / 配布物の展開など、外部 process の長い連鎖を伴う fixture。
  // 既存の consumer fixture の上限 (300_000) に合わせる。
  pack: 300_000,
  // 上記 fixture の再帰削除 (Windows の handle 解放待ちで retry する)。
  teardown: 60_000,
} as const;

export type HookBoundClass = keyof typeof HOOK_BOUND_MS;
type HookBody<R> = () => R | Promise<R>;
/** 種別だけ、または既存の個別上限を保つ `[種別, ms]`。 */
type HookBound = HookBoundClass | readonly [HookBoundClass, number];

/** 呼び出し元 (hook を宣言した test file の行) を stack から取る。取れなければ unknown。 */
function callerLocation(): string {
  const frames = (new Error().stack ?? "").split("\n").slice(2);
  const frame = frames.find((line) => !line.includes("hook-bounds.ts")) ?? "";
  const match = /([^/()\s]+\.ts):(\d+):\d+\)?$/.exec(frame.trim());
  return match ? `${match[1]}:${match[2]}` : "unknown";
}

/**
 * hook 本体の所要時間を 1 行 (`[hook-timing] <file>:<line> <class> <ms>ms`) で出力し、有限の上限と組にして返す。
 * 戻り値 (teardown 関数を含む) と例外はそのまま通す。`[種別, ms]` は既存の個別上限を保つために使う。
 */
function bounded<R>(bound: HookBound, fn: HookBody<R>): [() => Promise<R>, number] {
  const [boundClass, explicitMs] = typeof bound === "string" ? [bound, undefined] : bound;
  const where = callerLocation();
  return [
    async () => {
      const start = Date.now();
      try {
        return await fn();
      } finally {
        console.log(`[hook-timing] ${where} ${boundClass} ${Date.now() - start}ms`);
      }
    },
    explicitMs ?? HOOK_BOUND_MS[boundClass],
  ];
}

// 呼び出し形は元の hook に近い (`heavyBeforeAll("git", () => {...})`、既存の上限は `["git", 300_000]`)。
export function heavyBeforeAll<R>(bound: HookBound, fn: HookBody<R>): void {
  beforeAll(...bounded(bound, fn));
}
export function heavyAfterAll<R>(bound: HookBound, fn: HookBody<R>): void {
  afterAll(...bounded(bound, fn));
}
export function heavyBeforeEach<R>(bound: HookBound, fn: HookBody<R>): void {
  beforeEach(...bounded(bound, fn));
}
export function heavyAfterEach<R>(bound: HookBound, fn: HookBody<R>): void {
  afterEach(...bounded(bound, fn));
}

/**
 * hook ではなく test 本体が重い (子 process の CLI 起動など) 場合の `it`。上限は test ごとの明示値で、
 * 所要時間を `[hook-timing] <file>:<line> <class> <ms>ms` と同じ形式で出力する (一括の testTimeout 引き上げはしない)。
 * 例外 (assertion 失敗を含む) はそのまま通す。
 */
export function heavyIt<R>(name: string, bound: HookBound, fn: HookBody<R>): void {
  const [timed, ms] = bounded(bound, fn);
  it(name, timed, ms);
}
