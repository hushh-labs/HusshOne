/* Developer API — GET /api/v1/openapi.json
   Machine-readable OpenAPI 3.1 contract for the One developer API. Public (no auth) so tools can import
   it; the endpoints it describes are Bearer-key gated. Hand-authored to stay in lockstep with the routes. */
import { apiJson, corsPreflight } from "@/lib/api/http";

export const runtime = "nodejs";

export function OPTIONS() {
  return corsPreflight();
}

const SPEC = {
  openapi: "3.1.0",
  info: {
    title: "One by hushh — Developer API",
    version: "1.0.0",
    description:
      "Run One's intelligence over HTTP: submit a subject, stream live progress (SSE), and receive the deep-research dossier plus the 6-section preference profile and lifestyle facts — the same pipeline that powers one.hushh.ai. All endpoints require an Authorization: Bearer <key> issued by hushh.",
  },
  servers: [{ url: "https://one.hushh.ai" }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "hushh-issued developer API key." } },
    schemas: {
      Error: {
        type: "object",
        properties: { ok: { const: false }, error: { type: "string" }, code: { type: "string" } },
        required: ["ok", "error"],
      },
      ScanRequest: {
        type: "object",
        required: ["name", "email"],
        properties: {
          name: { type: "string", maxLength: 80, description: "Subject's full name. Required." },
          email: { type: "string", format: "email", description: "Subject's contact email. Required (not identity-matched)." },
          latitude: { type: "number", description: "With longitude → precise mode. Provide lat+lon OR zipCode." },
          longitude: { type: "number" },
          zipCode: { type: "string", description: "Fallback location → limited mode. Required if no lat/lon." },
          phone: { type: "string", description: "Optional footprint enrichment." },
          linkedinUrl: { type: "string", description: "Optional. Scraped in parallel; drives professional + preference signal." },
          instagramUrl: { type: "string", description: "Optional." },
          xUrl: { type: "string", description: "Optional." },
          threadsUrl: { type: "string", description: "Optional." },
          consentAttestation: { type: "boolean", default: true, description: "The API-key holder attests authorization. Default true; false → 403." },
          socialPreferenceConsent: { type: "boolean", default: true, description: "Build the preference/lifestyle layer. Default true; false → dossier only." },
        },
      },
      ScanAccepted: {
        type: "object",
        properties: {
          ok: { const: true },
          scanId: { type: "string" },
          status: { type: "string", enum: ["running"] },
          links: {
            type: "object",
            properties: { self: { type: "string" }, stream: { type: "string" }, preferences: { type: "string" } },
          },
          preferences: { type: "object", properties: { enabled: { type: "boolean" }, status: { type: "string" } } },
          profiles: { type: "object", description: "Per-platform scraped contracts (linkedin/instagram/threads/x)." },
        },
      },
      Health: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          status: { type: "string", enum: ["operational", "degraded", "down"] },
          checkedAt: { type: "string", format: "date-time" },
          components: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "api | database | research | scrapers" },
                name: { type: "string" },
                status: { type: "string", enum: ["operational", "degraded", "down"] },
                description: { type: "string" },
                latencyMs: { type: "number" },
              },
            },
          },
        },
      },
      DirectoryRow: {
        type: "object",
        properties: {
          vertical: { type: "string", enum: ["hotels", "healthcare", "ria", "insurance"] },
          id: { type: "string" },
          name: { type: "string" },
          subtitle: { type: "string", nullable: true },
          distanceM: { type: "number", description: "Distance from the query point, in metres." },
          geoPrecision: { type: "string", enum: ["rooftop", "zip_centroid"], description: "rooftop = exact coordinates; zip_centroid = ZIP-level until per-address geocoding lands." },
          lat: { type: "number", nullable: true },
          lng: { type: "number", nullable: true },
          fields: { type: "object", description: "Vertical-specific columns (address, phone, and e.g. rating / aum / specialty / license types)." },
        },
      },
      DirectoryResult: {
        type: "object",
        properties: {
          ok: { const: true },
          query: {
            type: "object",
            properties: {
              lat: { type: "number" },
              lng: { type: "number" },
              radiusM: { type: "number" },
              limit: { type: "number" },
              verticals: { type: "array", items: { type: "string" } },
              resolvedFrom: { type: "string", enum: ["coordinates", "zip"] },
              zip: { type: "string", description: "Present only when resolvedFrom = zip." },
            },
          },
          count: { type: "integer" },
          results: { type: "array", items: { $ref: "#/components/schemas/DirectoryRow" } },
          warnings: { type: "array", items: { type: "string" }, description: "Non-fatal notes (excluded/unknown verticals, per-vertical query failures)." },
        },
      },
      ScanResult: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          scanId: { type: "string" },
          status: { type: "string", enum: ["running", "completed", "failed", "unknown"] },
          profiles: { type: "object" },
          result: { type: "object", nullable: true, description: "OneDashboardResult: dossier report, footprint categories, deep-tier + image intelligence." },
          preferences: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["skipped", "running", "completed"] },
              profile: { type: "object", nullable: true, description: "6-section preference profile + v5 lifestyle facts." },
            },
          },
        },
      },
    },
  },
  paths: {
    "/api/v1/health": {
      get: {
        summary: "Service status (public, no auth)",
        description:
          "Sanitized health of the Developer API and its dependencies — components: api, database, research, scrapers. 200 when operational/degraded, 503 when a critical component is down. Cached ~30s.",
        security: [],
        responses: {
          "200": { description: "Operational or degraded", content: { "application/json": { schema: { $ref: "#/components/schemas/Health" } } } },
          "503": { description: "A critical component is down", content: { "application/json": { schema: { $ref: "#/components/schemas/Health" } } } },
        },
      },
    },
    "/api/v1/directory": {
      get: {
        summary: "Proximity directory search",
        description:
          "Returns directory rows within `radius` metres of (`lat`,`lng`) across four verticals (hotels, healthcare, ria, insurance), merged and sorted by distance (nearest first), capped at `limit`. Each row carries a `geoPrecision` flag. `social` is excluded (no coordinates). If `lat`/`lng` are omitted, a `zip` is resolved to its centroid (backward-compat).",
        parameters: [
          { name: "lat", in: "query", required: false, schema: { type: "number", minimum: -90, maximum: 90 }, description: "Latitude. Required unless `zip` is given." },
          { name: "lng", in: "query", required: false, schema: { type: "number", minimum: -180, maximum: 180 }, description: "Longitude. Required unless `zip` is given." },
          { name: "radius", in: "query", required: false, schema: { type: "integer", default: 5000, minimum: 100, maximum: 50000 }, description: "Search radius in metres (clamped to [100, 50000])." },
          { name: "limit", in: "query", required: false, schema: { type: "integer", default: 50, minimum: 1, maximum: 200 }, description: "Max merged results (clamped to [1, 200])." },
          { name: "verticals", in: "query", required: false, schema: { type: "string" }, description: "CSV subset of hotels,healthcare,ria,insurance. Default: all four." },
          { name: "zip", in: "query", required: false, schema: { type: "string" }, description: "Backward-compat fallback used only when `lat`/`lng` are absent." },
        ],
        responses: {
          "200": { description: "Merged, distance-sorted directory rows", content: { "application/json": { schema: { $ref: "#/components/schemas/DirectoryResult" } } } },
          "400": { description: "Missing or invalid coordinates", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "401": { description: "Missing/invalid API key", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "503": { description: "Directory database not configured", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/api/v1/scan": {
      post: {
        summary: "Start a scan",
        description: "Scrapes any provided social URLs in parallel, starts Deep Research, and (with consent + a feed) enables the preference/lifestyle layer. Returns 202 with links to poll or stream.",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ScanRequest" } } } },
        responses: {
          "202": { description: "Scan accepted", content: { "application/json": { schema: { $ref: "#/components/schemas/ScanAccepted" } } } },
          "400": { description: "Invalid input (missing name/email/location)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "401": { description: "Missing/invalid API key", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "403": { description: "consentAttestation was false", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/api/v1/scan/{id}": {
      get: {
        summary: "Poll scan status + result + preferences",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Current status; result present when completed", content: { "application/json": { schema: { $ref: "#/components/schemas/ScanResult" } } } },
          "401": { description: "Unauthorized" },
          "404": { description: "Scan not found for this key" },
        },
      },
    },
    "/api/v1/scan/{id}/stream": {
      get: {
        summary: "Live progress (Server-Sent Events)",
        description:
          "text/event-stream. Multiplexes two parallel tracks. Events: `start`, `progress` (phase + elapsedMs), `dossier` (final research result), `preferences` (fast-pass → v3 + lifestyle), `ping` (~7s heartbeat), and one terminal `done` | `error` | `pending`. Re-attachable.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "SSE stream", content: { "text/event-stream": { schema: { type: "string" } } } },
          "401": { description: "Unauthorized" },
          "404": { description: "Scan not found for this key" },
        },
      },
    },
    "/api/v1/scan/{id}/preferences": {
      get: {
        summary: "Preference profile + lifestyle facts",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Preference status + profile",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { const: true },
                    scanId: { type: "string" },
                    status: { type: "string", enum: ["skipped", "running", "completed"] },
                    preferences: { type: "object", nullable: true },
                  },
                },
              },
            },
          },
          "401": { description: "Unauthorized" },
          "404": { description: "Scan not found for this key" },
        },
      },
    },
  },
} as const;

export function GET() {
  return apiJson(SPEC, 200);
}
