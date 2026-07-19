"use client";

// Top-level error boundary for errors thrown in the root layout itself (which
// app/error.tsx cannot catch). Reports to Sentry (no-op when unconfigured) and
// renders a minimal standalone document, since the app shell failed to mount.
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#001029",
          color: "#e6eef7",
          fontFamily: "Inter, system-ui, sans-serif",
        }}
      >
        <div style={{ textAlign: "center", padding: "2rem" }}>
          <h1 style={{ fontSize: "1.75rem", fontWeight: 600 }}>Something went wrong</h1>
          <p style={{ marginTop: "0.75rem", color: "#92A8C2", fontSize: "0.9rem" }}>
            Arcade hit an unexpected error. Please reload the page.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: "1.5rem",
              padding: "0.6rem 1.25rem",
              borderRadius: "0.5rem",
              border: "1px solid #345A78",
              background: "#123",
              color: "#e6eef7",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
