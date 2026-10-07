"use client";

import { useEffect } from "react";

import { BoundaryRecovery } from "@/components/BoundaryRecovery";
import { reportClientError, shouldAutoReload } from "@/lib/client-error-report";

/**
 * Last-resort boundary for errors thrown in the root layout itself. Next
 * requires it to render its own `<html>`/`<body>`; `BoundaryRecovery` carries
 * inline styles for exactly this case, since the root layout's stylesheets are
 * not part of this render. The error is reported to `/api/client-error` and
 * written into the server log.
 */
export default function GlobalErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError(error, { boundary: "global" });
    if (shouldAutoReload(error)) window.location.reload();
  }, [error]);

  return (
    <html lang="en" translate="no">
      <body translate="no">
        <BoundaryRecovery error={error} reset={reset} />
      </body>
    </html>
  );
}
