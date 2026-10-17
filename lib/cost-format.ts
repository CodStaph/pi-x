/**
 * Cost formatting for the session UI.
 *
 * pi's catalog prices and every `usage.cost` value are USD amounts; neither
 * the model catalog nor `AgentUsage` carries a currency field. USD amounts
 * are formatted the way the runtime locale writes them — `$0.0500` in en-US,
 * `US$0.0500` in zh-CN — and converted to CNY only when a rate is available,
 * because relabeling an unconverted number with another symbol would show a
 * wrong amount under a plausible-looking symbol.
 */

export interface CurrencyFormatOptions {
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  maximumSignificantDigits?: number;
}

/** A cost formatter bound to a display currency (see hooks/useCostCurrency.ts). */
export type CostFormatter = (value: number, options?: CurrencyFormatOptions) => string;

export type DisplayCurrency = "USD" | "CNY";

export interface CostDisplay {
  currency: DisplayCurrency;
  /** USD→CNY; ignored for USD and treated as "no conversion" when not positive. */
  rate?: number;
  /** The interface locale; `undefined` uses the runtime (OS) locale. */
  locale?: string;
}

/** Backwards-compatible alias for the fraction-digit options. */
export type UsdCostFormatOptions = CurrencyFormatOptions;

const formatters = new Map<string, Intl.NumberFormat | null>();

function normalizeOptions(options: CurrencyFormatOptions): CurrencyFormatOptions {
  if (options.maximumSignificantDigits !== undefined) {
    return { maximumSignificantDigits: options.maximumSignificantDigits };
  }
  const max = options.maximumFractionDigits ?? options.minimumFractionDigits ?? 4;
  const min = options.minimumFractionDigits
    ?? (options.maximumFractionDigits !== undefined ? 0 : max);
  return { minimumFractionDigits: min, maximumFractionDigits: max };
}

function getFormatter(
  currency: string,
  locale: string | undefined,
  options: CurrencyFormatOptions,
): Intl.NumberFormat | null {
  const key = `${currency}|${locale ?? ""}|${options.minimumFractionDigits ?? ""}:${options.maximumFractionDigits ?? ""}:${options.maximumSignificantDigits ?? ""}`;
  if (formatters.has(key)) return formatters.get(key) ?? null;
  let created: Intl.NumberFormat | null = null;
  try {
    created = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      ...options,
    });
  } catch {
    created = null;
  }
  formatters.set(key, created);
  return created;
}

/** The fraction-digit options pi uses for a compact per-call cost. */
export function compactCostOptions(value: number): CurrencyFormatOptions {
  return value >= 0.01
    ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    : { maximumSignificantDigits: 2 };
}

/**
 * Format a USD amount, converting to `display.currency` when a positive rate
 * is available. Defaults to four fraction digits, matching the long-standing
 * session cost display. Falls back to a plain symbol when `Intl` currency
 * formatting is unavailable.
 */
export function formatCostWithCurrency(
  amountUsd: number,
  currency: DisplayCurrency,
  display: Omit<CostDisplay, "currency"> = {},
  options: CurrencyFormatOptions = {},
): string {
  const rate = display.rate && display.rate > 0 ? display.rate : 0;
  const converted = currency === "CNY" && rate > 0;
  const amount = converted ? amountUsd * rate : amountUsd;
  const code = converted ? "CNY" : "USD";
  const normalized = normalizeOptions(options);

  const formatter = getFormatter(code, display.locale, normalized);
  if (!formatter) {
    return `${converted ? "¥" : "$"}${amount.toFixed(normalized.maximumFractionDigits ?? 4)}`;
  }
  return formatter.format(amount);
}

/** Format a USD amount in the runtime locale (no conversion). */
export function formatUsdCost(value: number, options: UsdCostFormatOptions = {}): string {
  return formatCostWithCurrency(value, "USD", {}, options);
}

/**
 * pi's compact per-call cost: two decimals from one cent upward, otherwise
 * two significant digits so sub-cent values stay readable.
 */
export function formatUsdCostCompact(value: number): string {
  return formatUsdCost(value, compactCostOptions(value));
}
