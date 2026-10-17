/**
 * Cost display currency and its USD→CNY exchange rate.
 *
 * pi's catalog prices and every `usage.cost` value are USD amounts; this
 * module is the display layer that converts them for a Chinese interface (or
 * an explicit CNY choice). The rate is fetched on demand from one of two
 * public providers and persisted by `lib/cost-currency-settings.ts`, so an
 * offline app falls back to USD instead of showing a stale or wrong amount.
 */

export type CostCurrencyMode = "auto" | "USD" | "CNY";
export type ExchangeRateProvider = "frankfurter" | "exchangerate";
export type DisplayCurrency = "USD" | "CNY";

export interface CostCurrencySettings {
  mode: CostCurrencyMode;
  provider: ExchangeRateProvider;
  /** USD→CNY, the last time a refresh succeeded; null until then. */
  rate: number | null;
  rateUpdatedAt: number | null;
  /** The provider's own quote date, when it reports one. */
  rateDate: string | null;
  /** The provider that produced `rate`. */
  rateSource: ExchangeRateProvider | null;
}

export const COST_CURRENCY_MODES: readonly CostCurrencyMode[] = ["auto", "USD", "CNY"];
export const EXCHANGE_RATE_PROVIDERS: readonly ExchangeRateProvider[] = ["frankfurter", "exchangerate"];

export const DEFAULT_COST_CURRENCY_SETTINGS: CostCurrencySettings = {
  mode: "auto",
  provider: "frankfurter",
  rate: null,
  rateUpdatedAt: null,
  rateDate: null,
  rateSource: null,
};

export function isCostCurrencyMode(value: unknown): value is CostCurrencyMode {
  return value === "auto" || value === "USD" || value === "CNY";
}

export function isExchangeRateProvider(value: unknown): value is ExchangeRateProvider {
  return value === "frankfurter" || value === "exchangerate";
}

/** Chinese interface locales show RMB in "auto" mode. */
export function isChineseLocale(locale: string | undefined): boolean {
  return typeof locale === "string" && locale.toLowerCase().startsWith("zh");
}

/** "auto" follows the interface language; an explicit choice wins over it. */
export function resolveDisplayCurrency(
  mode: CostCurrencyMode,
  locale: string | undefined,
): DisplayCurrency {
  if (mode === "USD") return "USD";
  if (mode === "CNY") return "CNY";
  return isChineseLocale(locale) ? "CNY" : "USD";
}

/** The rate to use for display: a positive stored rate, or 0 (meaning "no conversion"). */
export function usableCnyRate(settings: Pick<CostCurrencySettings, "rate">): number {
  return typeof settings.rate === "number" && Number.isFinite(settings.rate) && settings.rate > 0
    ? settings.rate
    : 0;
}

function normalizeRate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1_000_000
    ? value
    : null;
}

export function normalizeCostCurrencySettings(value: unknown): CostCurrencySettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ...DEFAULT_COST_CURRENCY_SETTINGS };
  }
  const record = value as Record<string, unknown>;
  return {
    mode: isCostCurrencyMode(record.mode) ? record.mode : "auto",
    provider: isExchangeRateProvider(record.provider) ? record.provider : "frankfurter",
    rate: normalizeRate(record.rate),
    rateUpdatedAt:
      typeof record.rateUpdatedAt === "number" && Number.isFinite(record.rateUpdatedAt)
        ? record.rateUpdatedAt
        : null,
    rateDate: typeof record.rateDate === "string" && record.rateDate ? record.rateDate : null,
    rateSource: isExchangeRateProvider(record.rateSource) ? record.rateSource : null,
  };
}

const PROVIDER_URLS: Record<ExchangeRateProvider, string> = {
  frankfurter: "https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY",
  exchangerate: "https://api.exchangerate.fun/latest?base=USD&symbols=CNY",
};

export interface FetchedExchangeRate {
  rate: number;
  date: string | null;
}

/**
 * Fetch the USD→CNY rate. The URL is fixed, so the request cannot be
 * redirected to another host. Throws on a non-OK response, a timeout, or a
 * payload without a positive `rates.CNY`.
 */
export async function fetchCnyRate(
  provider: ExchangeRateProvider,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<FetchedExchangeRate> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(PROVIDER_URLS[provider], {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Exchange-rate provider answered HTTP ${response.status}`);
    }
    const payload = (await response.json()) as {
      rates?: Record<string, unknown>;
      date?: unknown;
    };
    const rate = normalizeRate(payload?.rates?.CNY);
    if (rate === null) {
      throw new Error("Exchange-rate provider returned no CNY rate");
    }
    const date = typeof payload.date === "string" && payload.date
      ? payload.date
      : new Date().toISOString().slice(0, 10);
    return { rate, date };
  } finally {
    clearTimeout(timer);
  }
}
