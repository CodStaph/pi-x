import assert from "node:assert/strict";
import test from "node:test";

const {
  COST_CURRENCY_MODES,
  DEFAULT_COST_CURRENCY_SETTINGS,
  EXCHANGE_RATE_PROVIDERS,
  fetchCnyRate,
  isChineseLocale,
  isCostCurrencyMode,
  isExchangeRateProvider,
  normalizeCostCurrencySettings,
  resolveDisplayCurrency,
  usableCnyRate,
} = await import("./cost-currency.ts");

test("guards the mode and provider vocabularies", () => {
  assert.deepEqual(COST_CURRENCY_MODES, ["auto", "USD", "CNY"]);
  assert.deepEqual(EXCHANGE_RATE_PROVIDERS, ["frankfurter", "exchangerate"]);
  assert.equal(isCostCurrencyMode("auto"), true);
  assert.equal(isCostCurrencyMode("EUR"), false);
  assert.equal(isExchangeRateProvider("frankfurter"), true);
  assert.equal(isExchangeRateProvider("ecb"), false);
});

test("auto follows the interface language, an explicit choice wins", () => {
  assert.equal(resolveDisplayCurrency("auto", "zh-CN"), "CNY");
  assert.equal(resolveDisplayCurrency("auto", "zh-TW"), "CNY");
  assert.equal(resolveDisplayCurrency("auto", "en"), "USD");
  assert.equal(resolveDisplayCurrency("auto", undefined), "USD");
  assert.equal(resolveDisplayCurrency("USD", "zh-CN"), "USD");
  assert.equal(resolveDisplayCurrency("CNY", "en"), "CNY");
  assert.equal(isChineseLocale("ZH-hans"), true);
});

test("normalizes stored settings and drops unusable rates", () => {
  assert.deepEqual(normalizeCostCurrencySettings(undefined), DEFAULT_COST_CURRENCY_SETTINGS);
  assert.deepEqual(normalizeCostCurrencySettings("nope"), DEFAULT_COST_CURRENCY_SETTINGS);
  const normalized = normalizeCostCurrencySettings({
    mode: "CNY",
    provider: "exchangerate",
    rate: 7.12,
    rateUpdatedAt: 1_700_000_000_000,
    rateDate: "2026-10-06",
    rateSource: "exchangerate",
  });
  assert.deepEqual(normalized, {
    mode: "CNY",
    provider: "exchangerate",
    rate: 7.12,
    rateUpdatedAt: 1_700_000_000_000,
    rateDate: "2026-10-06",
    rateSource: "exchangerate",
  });
  assert.equal(normalizeCostCurrencySettings({ mode: "EUR", provider: "x", rate: -1 }).rate, null);
  assert.equal(normalizeCostCurrencySettings({ rate: Number.NaN }).rate, null);
  assert.equal(normalizeCostCurrencySettings({ rate: "7" }).rate, null);
  assert.equal(usableCnyRate({ rate: 6.7 }), 6.7);
  assert.equal(usableCnyRate({ rate: null }), 0);
  assert.equal(usableCnyRate({ rate: 0 }), 0);
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("fetchCnyRate reads both providers' payloads", async () => {
  const frankfurter = await fetchCnyRate("frankfurter", async (url) => {
    assert.match(String(url), /api\.frankfurter\.dev/);
    return jsonResponse({ amount: 1, base: "USD", date: "2026-10-06", rates: { CNY: 6.7046 } });
  });
  assert.deepEqual(frankfurter, { rate: 6.7046, date: "2026-10-06" });

  const exchangerate = await fetchCnyRate("exchangerate", async (url) => {
    assert.match(String(url), /api\.exchangerate\.fun/);
    return jsonResponse({ timestamp: 1, base: "USD", rates: { CNY: 6.70464 } });
  });
  assert.equal(exchangerate.rate, 6.70464);
  assert.match(exchangerate.date, /^\d{4}-\d{2}-\d{2}$/);
});

test("fetchCnyRate rejects non-OK, malformed and zero rates", async () => {
  await assert.rejects(
    fetchCnyRate("frankfurter", async () => jsonResponse({}, 503)),
    /HTTP 503/,
  );
  await assert.rejects(
    fetchCnyRate("frankfurter", async () => jsonResponse({ rates: {} })),
    /no CNY rate/,
  );
  await assert.rejects(
    fetchCnyRate("frankfurter", async () => jsonResponse({ rates: { CNY: 0 } })),
    /no CNY rate/,
  );
  await assert.rejects(
    fetchCnyRate("frankfurter", async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
});
