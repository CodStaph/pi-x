import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import {
  DEFAULT_COST_CURRENCY_SETTINGS,
  normalizeCostCurrencySettings,
  type CostCurrencySettings,
} from "./cost-currency";

/**
 * Persistence for the cost-display currency and its exchange rate. A small
 * JSON file beside the other desktop config (`<agentDir>/desktop/`), not
 * pi's own settings.json, so the setting survives across the desktop
 * WebView's changing origin/port and never touches keys pi owns.
 */

export function getCostCurrencySettingsPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "desktop", "cost-currency.json");
}

/** Read the settings; a missing or malformed file reads as the USD default. */
export function readCostCurrencySettings(agentDir?: string): CostCurrencySettings {
  const path = getCostCurrencySettingsPath(agentDir);
  try {
    return normalizeCostCurrencySettings(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error(`cost-currency: failed to read ${path}:`, error);
    }
    return { ...DEFAULT_COST_CURRENCY_SETTINGS };
  }
}

/** Write the settings atomically with owner-only permissions. */
export function writeCostCurrencySettings(
  settings: CostCurrencySettings,
  agentDir?: string,
): void {
  const path = getCostCurrencySettingsPath(agentDir);
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}
