// Red (`it.fails`) と、同じ準備処理を通る対の通常 `it` を登録する (L7 snapshot runner lock test design §1)。
// 本体は 1 つで、準備 (fixture・hook・対象の呼び出し) は素の文として書き、oracle の assertion は `t.expect`
// で書く。Red は `t.expect` を本物の expect にして走らせる。対の通常 `it` は同じ本体を `t.expect` を
// 何もしない形にして最後まで走らせるので、全ケースの準備が実行され、準備の中の失敗 (素の `expect` の
// AssertionError を含む) はそのまま失敗になる。
import { expect, it } from "vitest";

export interface RedContext {
  /** oracle の assertion。Red では本物、対の通常 `it` では何もしない。 */
  expect: typeof expect;
  /** 実装に依らない準備を使うかどうか (対の `it` は stub の戻り値に頼らない)。 */
  mode: "red" | "pair";
}

const noop: unknown = new Proxy(() => noop, {
  get: () => noop,
  apply: () => noop,
});

export function redWithPreparationPair(name: string, body: (t: RedContext) => void): void {
  it.fails(name, () => {
    body({ expect, mode: "red" });
  });
  it(`${name} [preparation pair]`, () => {
    let completed = false;
    body({ expect: noop as typeof expect, mode: "pair" });
    completed = true;
    expect(completed).toBe(true);
  });
}
