import { NextResponse } from "next/server";
import { fetchCnyRate } from "@/lib/cost-currency";
import {
  readCostCurrencySettings,
  writeCostCurrencySettings,
} from "@/lib/cost-currency-settings";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// Settings › Cost display's refresh button: fetch the USD→CNY rate from the
// selected provider and persist it. The request goes out from the server, so
// the browser never hits the provider (and no CORS rule decides whether the
// button works). A failure is reported and leaves the stored rate untouched,
// which is how the UI keeps falling back to USD when there is no rate yet.

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const current = readCostCurrencySettings();
  try {
    const { rate, date } = await fetchCnyRate(current.provider);
    const next = {
      ...current,
      rate,
      rateUpdatedAt: Date.now(),
      rateDate: date,
      rateSource: current.provider,
    };
    writeCostCurrencySettings(next);
    return NextResponse.json(next);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
