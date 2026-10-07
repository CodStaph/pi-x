"use client";

import { useEffect } from "react";

import { BoundaryRecovery } from "@/components/BoundaryRecovery";
import { reportClientError, shouldAutoReload } from "@/lib/client-error-report";

/**
 * Segment error boundary for the whole app (`app/page.tsx`).
 *
 * Without this file Next uses its built-in root boundary, which replaces the
 * entire window with a blank "This page couldn't load" page and offers only a
 * reload. Here the error is reported (so it lands in `server.log`) and the user
 * gets a "try again" that resets just this segment. A stale-chunk error is a
 * rebuild artefact a reload already fixes, so that one reloads itself once.
 */
export default function AppErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError(error, { boundary: "app" });
    if (shouldAutoReload(error)) window.location.reload();
  }, [error]);

  return <BoundaryRecovery error={error} reset={reset} />;
}
