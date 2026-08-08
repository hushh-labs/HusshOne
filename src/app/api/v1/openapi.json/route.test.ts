import { describe, expect, it } from "vitest";
import { GET, OPTIONS } from "./route";

describe("GET /api/v1/openapi.json", () => {
  it("returns a valid OpenAPI 3.1 spec covering the documented endpoints + bearer auth", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const spec = (await res.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      components: { securitySchemes: { bearerAuth?: { scheme: string } } };
    };
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        "/api/v1/directory",
        "/api/v1/scan",
        "/api/v1/scan/{id}",
        "/api/v1/scan/{id}/stream",
        "/api/v1/scan/{id}/preferences",
      ]),
    );
    expect(spec.components.securitySchemes.bearerAuth?.scheme).toBe("bearer");
  });

  it("ScanRequest documents optional confirmedProfiles anchors (lockstep with the scan route)", async () => {
    const res = await GET();
    const spec = (await res.json()) as {
      components: { schemas: { ScanRequest: { required: string[]; properties: Record<string, { type?: string; maxItems?: number; items?: { required?: string[] } }> } } };
    };
    const prop = spec.components.schemas.ScanRequest.properties.confirmedProfiles;
    expect(prop).toMatchObject({ type: "array", maxItems: 8 });
    expect(prop.items?.required).toEqual(["url"]);
    expect(spec.components.schemas.ScanRequest.required).not.toContain("confirmedProfiles");
  });

  it("OPTIONS preflight is 204", () => {
    expect(OPTIONS().status).toBe(204);
  });
});
