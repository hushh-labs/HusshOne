/**
 * Node-only OpenTelemetry setup → Google Cloud Trace.
 *
 * On Cloud Run the project id + credentials are auto-detected from the
 * metadata server (ADC), so no keys are required. Auto-instrumentation wraps
 * inbound HTTP and outbound `fetch` (undici), which both creates spans AND
 * injects the W3C `traceparent` header on the Shadow API call — that header is
 * what stitches one → hushh-ria-intelligence-api into a single end-to-end
 * trace, without touching the upstream service.
 *
 * Imported only when NEXT_RUNTIME === "nodejs" (see instrumentation.ts).
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { TraceExporter } from "@google-cloud/opentelemetry-cloud-trace-exporter";

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "one",
  }),
  // SimpleSpanProcessor (not the default Batch): Cloud Run throttles a request's
  // CPU to ~0 after the response is sent, so a batched export timer never fires
  // and buffered spans are lost. Simple exports each span as it ends — while the
  // request still has CPU. Recommended by the Next.js OpenTelemetry guide.
  spanProcessors: [new SimpleSpanProcessor(new TraceExporter())],
  instrumentations: [
    getNodeAutoInstrumentations({
      // fs spans are extremely noisy and add no observability value here.
      "@opentelemetry/instrumentation-fs": { enabled: false },
    }),
  ],
});

sdk.start();

// Best-effort flush of buffered spans when Cloud Run sends SIGTERM on scale-in.
process.on("SIGTERM", () => {
  void sdk.shutdown();
});
