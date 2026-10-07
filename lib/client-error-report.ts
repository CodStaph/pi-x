/**
 * Client-side crash reporting for the App Router error boundaries.
 *
 * This app ships no `error.tsx` of its own, so Next falls back to its built-in
 * root boundary: any render-time throw anywhere in the tree replaces the whole
 * window with a bare "This page couldn't load" page and the error itself is
 * only visible in a WebView console nobody reads. `app/error.tsx` and
 * `app/global-error.tsx` use this helper to hand the error to the server,
 * which writes it into the packaged server's `server.log` (desktop) or the
 * terminal (dev). The next crash leaves a stack instead of only a screenshot.
 */

const reported = new Set<string>();

/**
 * Largest report the server route will read (shared so the client, the route
 * and its test cannot drift apart).
 */
export const MAX_CLIENT_ERROR_REPORT_BYTES = 16 * 1024;

export interface ClientErrorContext {
  boundary: "app" | "global";
}

interface DescribedError {
  message: string;
  stack?: string;
  digest?: string;
}

/** Normalize anything thrown (Error, string, DOMException, …) into fields. */
export function describeClientError(error: unknown): DescribedError {
  if (error instanceof Error) {
    const digest = (error as Error & { digest?: unknown }).digest;
    return {
      message: error.message || error.name,
      stack: typeof error.stack === "string" ? error.stack : undefined,
      digest: typeof digest === "string" ? digest : undefined,
    };
  }
  return { message: String(error) };
}

/**
 * POST the error to `/api/client-error` once per distinct crash. Reporting is
 * best-effort: it must never throw, because it runs inside the boundary that
 * is already handling a failure.
 */
export function reportClientError(error: unknown, context: ClientErrorContext): void {
  if (typeof window === "undefined") return;
  const described = describeClientError(error);
  const fingerprint = `${described.message}\u0000${described.digest ?? ""}\u0000${described.stack ?? ""}`;
  if (reported.has(fingerprint)) return;
  reported.add(fingerprint);

  try {
    void fetch("/api/client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...described,
        boundary: context.boundary,
        url: window.location.href,
        userAgent: navigator.userAgent,
        at: new Date().toISOString(),
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Ignore: reporting is diagnostic only.
  }
}

// A stale or missing client chunk after a rebuild throws this and a plain
// reload fixes it, but the boundary would stay on screen until the user acts.
const CHUNK_ERROR = /Loading chunk|ChunkLoadError|Failed to fetch dynamically imported module|error loading dynamically imported module/i;

let recoveryAttempted = false;

/**
 * True once for a chunk-load error, so the boundary can reload itself instead
 * of waiting for a click. Only once per page load: a genuinely broken build
 * must not turn the reload into a loop.
 */
export function shouldAutoReload(error: unknown): boolean {
  if (recoveryAttempted || typeof window === "undefined") return false;
  if (!CHUNK_ERROR.test(describeClientError(error).message)) return false;
  recoveryAttempted = true;
  return true;
}
