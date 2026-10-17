import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { formatCostWithCurrency, formatUsdCost, formatUsdCostCompact } = await jiti.import("./cost-format");

test("formats USD, never another currency, whatever the runtime locale", () => {
  const value = formatUsdCost(0.05, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // The currency stays USD: a `$` (plain or the locale's `US$`) and never a
  // local symbol such as ¥ or € that would misstate the amount.
  assert.match(value, /(US)?\$/);
  assert.doesNotMatch(value, /[¥€£₩]/);
  assert.match(value, /0[.,]05/);
});

test("defaults to four fraction digits, matching the session cost display", () => {
  assert.match(formatUsdCost(1.5), /1[.,]5000/);
});

test("maximumFractionDigits alone does not force trailing zeros", () => {
  const value = formatUsdCost(3, { maximumFractionDigits: 6 });
  assert.match(value, /(US)?\$3$/);
});

test("compact formatting keeps sub-cent costs readable", () => {
  assert.match(formatUsdCostCompact(0.05), /0[.,]05/);
  assert.match(formatUsdCostCompact(0.0056), /0[.,]0056/);
  assert.match(formatUsdCostCompact(0.00012), /0[.,]00012/);
});

test("converts to CNY only with a positive rate, otherwise it stays USD", () => {
  const converted = formatCostWithCurrency(1, "CNY", { rate: 7, locale: "zh-CN" });
  assert.match(converted, /¥/);
  assert.doesNotMatch(converted, /\$/);
  // 1 USD * 7 = 7.0000 CNY
  assert.match(converted, /7[.,]0000/);

  for (const rate of [0, undefined, Number.NaN]) {
    const fallback = formatCostWithCurrency(1, "CNY", { rate, locale: "zh-CN" });
    assert.match(fallback, /(US)?\$/);
    assert.doesNotMatch(fallback, /¥/);
  }
});

test("a Chinese locale still labels USD as US$", () => {
  const usd = formatCostWithCurrency(0.05, "USD", { locale: "zh-CN" }, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  assert.match(usd, /US\$0[.,]05/);
});
