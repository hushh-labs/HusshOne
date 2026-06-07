/**
 * Next.js 16 instrumentation hook (stable since v15). Runs once when a new
 * server instance starts. The Node-only OpenTelemetry SDK is imported lazily
 * so the edge runtime is never loaded with Node APIs.
 *
 * See node_modules/next/dist/docs/01-app/02-guides/open-telemetry.md
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation.node");
  }
}
