"use client";

/* Branded top-level fallback — replaces Next's raw "This page couldn't load" for any
   error not caught by an in-app boundary. Must render its own <html>/<body>. */

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#FCFBFA",
          color: "#111113",
          fontFamily: "Inter, Arial, sans-serif",
          textAlign: "center",
          padding: 24,
        }}
      >
        <div style={{ maxWidth: 420 }}>
          <div style={{ fontSize: 12, letterSpacing: "0.14em", textTransform: "uppercase", color: "#9A9A9A", marginBottom: 12 }}>
            One by hussh
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 600, lineHeight: 1.15, margin: "0 0 10px" }}>Something didn&apos;t load.</h1>
          <p style={{ color: "#3B3B3B", lineHeight: 1.6, margin: "0 0 20px" }}>A reload usually fixes it — your data is safe.</p>
          <button
            onClick={() => reset()}
            style={{ background: "#0a0a0a", color: "#fff", border: "none", borderRadius: 2, padding: "12px 24px", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
