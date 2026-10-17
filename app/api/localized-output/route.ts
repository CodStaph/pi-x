import { NextResponse } from "next/server";
import type { LocalizedOutputResponse } from "@/lib/api-types";
import {
  clearLocalizedOutput,
  isLocalizedOutputLocale,
  readLocalizedOutputState,
  writeLocalizedOutput,
} from "@/lib/localized-output";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// Settings › Chat's "reply in the interface language" switch. The global
// APPEND_SYSTEM.md is the only thing it edits, so a GET can report whether the
// managed block is present and a PUT writes or removes it. The mode is not a
// separate setting: the block's absence is "off".

function errorResponse(error: unknown) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 500 },
  );
}

export async function GET() {
  try {
    const state: LocalizedOutputResponse = readLocalizedOutputState();
    return NextResponse.json(state);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
  }

  const { enabled, locale } = body as { enabled?: unknown; locale?: unknown };
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  if (!isLocalizedOutputLocale(locale)) {
    return NextResponse.json({ error: "locale must be en, zh-CN or zh-TW" }, { status: 400 });
  }

  try {
    const state: LocalizedOutputResponse = enabled
      ? writeLocalizedOutput(locale)
      : clearLocalizedOutput();
    return NextResponse.json(state);
  } catch (error) {
    return errorResponse(error);
  }
}
