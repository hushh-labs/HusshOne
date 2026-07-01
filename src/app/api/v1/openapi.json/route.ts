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
