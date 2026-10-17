"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  DEFAULT_COST_CURRENCY_SETTINGS,
  normalizeCostCurrencySettings,
  resolveDisplayCurrency,
  usableCnyRate,
  type CostCurrencyMode,
  type CostCurrencySettings,
  type DisplayCurrency,
  type ExchangeRateProvider,
} from "@/lib/cost-currency";
import {
  formatCostWithCurrency,
  type CurrencyFormatOptions,
} from "@/lib/cost-format";

/**
 * Client store for the cost-display currency: the saved preference, the last
 * USD→CNY rate, and the load/refresh state. It is shared by every component
 * that formats a cost, so one fetch and one refresh button update the whole
 * UI. `currency` is resolved from the preference and the interface language;
 * without a usable rate it falls back to USD.
 */

export interface CostCurrencyState {
  settings: CostCurrencySettings;
  loading: boolean;
  refreshing: boolean;
  saving: boolean;
  error: string | null;
  loaded: boolean;
}

const SERVER_STATE: CostCurrencyState = {
  settings: DEFAULT_COST_CURRENCY_SETTINGS,
  loading: false,
  refreshing: false,
  saving: false,
  error: null,
  loaded: false,
};

let state: CostCurrencyState = SERVER_STATE;
let loadPromise: Promise<void> | null = null;
let rateAttempted = false;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

function setState(patch: Partial<CostCurrencyState>): void {
  state = { ...state, ...patch };
  emit();
}

export function getCostCurrencySnapshot(): CostCurrencyState {
  return state;
}

export function getCostCurrencyServerSnapshot(): CostCurrencyState {
  return SERVER_STATE;
}

export function subscribeCostCurrency(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Load the stored settings once. A failure leaves the USD default in place. */
export function loadCostCurrency(): Promise<void> {
  if (state.loaded) return Promise.resolve();
  if (loadPromise) return loadPromise;
  setState({ loading: true });
  loadPromise = fetch("/api/cost-currency")
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setState({ settings: normalizeCostCurrencySettings(data), loaded: true, loading: false, error: null });
    })
    .catch((cause) => {
      setState({ loading: false, loaded: true, error: cause instanceof Error ? cause.message : String(cause) });
    })
    .finally(() => {
      loadPromise = null;
    });
  return loadPromise;
}

function applySettings(data: unknown): void {
  setState({ settings: normalizeCostCurrencySettings(data) });
}

/** Fetch a fresh rate for the selected provider. Throws on failure. */
export async function refreshCostCurrency(): Promise<void> {
  setState({ refreshing: true, error: null });
  try {
    const response = await fetch("/api/cost-currency/refresh", { method: "POST" });
    const data = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    applySettings(data);
    setState({ refreshing: false });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    setState({ refreshing: false, error: message });
    throw cause;
  }
}

/** Change the preference (mode / provider). Throws on failure. */
export async function saveCostCurrencySettings(patch: {
  mode?: CostCurrencyMode;
  provider?: ExchangeRateProvider;
}): Promise<void> {
  setState({ saving: true, error: null });
  try {
    const response = await fetch("/api/cost-currency", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    applySettings(data);
    setState({ saving: false });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    setState({ saving: false, error: message });
    throw cause;
  }
}

/** One silent attempt when a Chinese interface needs a rate that is not stored yet. */
export function ensureCnyRateOnce(): void {
  if (rateAttempted) return;
  rateAttempted = true;
  void refreshCostCurrency().catch(() => {});
}

export function useCostCurrency() {
  const { locale } = useI18n();
  const snapshot = useSyncExternalStore(
    subscribeCostCurrency,
    getCostCurrencySnapshot,
    getCostCurrencyServerSnapshot,
  );

  useEffect(() => {
    void loadCostCurrency();
  }, []);

  const currency: DisplayCurrency = resolveDisplayCurrency(snapshot.settings.mode, locale);
  const rate = currency === "CNY" ? usableCnyRate(snapshot.settings) : 0;

  useEffect(() => {
    if (currency === "CNY" && rate <= 0) ensureCnyRateOnce();
  }, [currency, rate]);

  const formatCost = useCallback(
    (value: number, options?: CurrencyFormatOptions) =>
      formatCostWithCurrency(value, currency, { rate, locale }, options),
    [currency, rate, locale],
  );

  const setMode = useCallback(async (mode: CostCurrencyMode) => {
    await saveCostCurrencySettings({ mode });
  }, []);

  const setProvider = useCallback(async (provider: ExchangeRateProvider) => {
    await saveCostCurrencySettings({ provider });
  }, []);

  return {
    ...snapshot,
    currency,
    rate,
    locale,
    formatCost,
    setMode,
    setProvider,
    refresh: refreshCostCurrency,
  };
}
