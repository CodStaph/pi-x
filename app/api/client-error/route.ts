import { NextResponse } from "next/server";

import { MAX_CLIENT_ERROR_REPORT_BYTES } from "@/lib/client-error-report";

function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Receives a client render crash from `app/error.tsx` / `app/global-error.tsx`.
 *
 * The error is written to stdout/stderr, which the packaged desktop app
 * captures in `<app log dir>/server.log` (and `next dev` prints in the
 * terminal), so the next white screen leaves a stack behind. There is no other
 * sink: nothing is persisted to disk, cached, or echoed back.
 */
export async function POST(request: Request) {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return NextResponse.json({ error: "unreadable body" }, { status: 400 });
  }
  if (raw.length > MAX_CLIENT_ERROR_REPORT_BYTES) {
    return NextResponse.json({ error: "report too large" }, { status: 413 });
  }

  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const boundary = clean(payload.boundary, 32) ?? "unknown";
  const message = clean(payload.message, 2_000) ?? "(no message)";
  const digest = clean(payload.digest, 200);
  const url = clean(payload.url, 2_000);
  const userAgent = clean(payload.userAgent, 500);
  const stack = clean(payload.stack, 8_000);
  const at = clean(payload.at, 64);

  console.error(`[pi-web] client render error (${boundary}) at ${at ?? "?"}: ${message}`);
  if (digest) console.error(`[pi-web] client render error digest: ${digest}`);
  if (url) console.error(`[pi-web] client render error url: ${url}`);
  if (userAgent) console.error(`[pi-web] client render error user agent: ${userAgent}`);
  if (stack) console.error(`[pi-web] client render error stack:\n${stack}`);

  return NextResponse.json({ ok: true });
}
