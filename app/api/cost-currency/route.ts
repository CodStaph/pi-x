import { NextResponse } from "next/server";
import {
  isCostCurrencyMode,
  isExchangeRateProvider,
  type CostCurrencySettings,
} from "@/lib/cost-currency";
import {
  readCostCurrencySettings,
  writeCostCurrencySettings,
} from "@/lib/cost-currency-settings";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// Settings › Cost display: the currency preference and the last fetched
// USD→CNY rate. GET reports the stored file; PUT changes only the mode and
// provider (the rate is written by /api/cost-currency/refresh after a
// successful network fetch, never supplied by the client).

function refusal(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

export async function GET() {
  try {
    return NextResponse.json(readCostCurrencySettings());
  } catch (error) {
    return refusal(500, error instanceof Error ? error.message : String(error));
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return refusal(403, "Untrusted API request");
  }
  if (!hasJsonContentType(req)) {
    return refusal(415, "Content-Type must be application/json");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refusal(400, "Invalid JSON body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return refusal(400, "Expected a JSON object");
  }

  const { mode, provider } = body as { mode?: unknown; provider?: unknown };
  if (mode !== undefined && !isCostCurrencyMode(mode)) {
    return refusal(400, 'mode must be "auto", "USD" or "CNY"');
  }
  if (provider !== undefined && !isExchangeRateProvider(provider)) {
    return refusal(400, 'provider must be "frankfurter" or "exchangerate"');
  }
  if (mode === undefined && provider === undefined) {
    return refusal(400, "Send mode or provider");
  }

  try {
    const current = readCostCurrencySettings();
    const next: CostCurrencySettings = {
      ...current,
      mode: mode ?? current.mode,
      provider: provider ?? current.provider,
    };
    writeCostCurrencySettings(next);
    return NextResponse.json(next);
  } catch (error) {
    return refusal(500, error instanceof Error ? error.message : String(error));
  }
}
