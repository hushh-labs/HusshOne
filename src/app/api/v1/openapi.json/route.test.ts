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

  it("OPTIONS preflight is 204", () => {
    expect(OPTIONS().status).toBe(204);
  });
});
