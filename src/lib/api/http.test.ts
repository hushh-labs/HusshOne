import { describe, expect, it } from "vitest";
import { apiError, apiJson, corsPreflight, sseFrame, sseHeaders, statusCodeOf, withCors } from "./http";

describe("api/http", () => {
  it("sseFrame serializes an event + JSON data frame", () => {
    expect(sseFrame("progress", { phase: "Reading", elapsedMs: 12000 })).toBe(
      'event: progress\ndata: {"phase":"Reading","elapsedMs":12000}\n\n',
    );
  });

  it("withCors always includes permissive CORS + merges extras", () => {
    const h = withCors({ "Content-Type": "text/plain" });
    expect(h["Access-Control-Allow-Origin"]).toBe("*");
    expect(h["Access-Control-Allow-Headers"]).toContain("Authorization");
    expect(h["Content-Type"]).toBe("text/plain");
  });

  it("corsPreflight is a 204 with CORS headers", () => {
    const res = corsPreflight();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("OPTIONS");
  });

  it("apiError returns the canonical envelope (flat error string + code) with CORS", async () => {
    const res = apiError(403, "consent_required", "consentAttestation must be true to run a scan.");
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: "consentAttestation must be true to run a scan.", code: "consent_required" });
  });

  it("apiJson sets JSON content type + status", async () => {
    const res = apiJson({ ok: true, scanId: "x" }, 202);
    expect(res.status).toBe(202);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(await res.json()).toEqual({ ok: true, scanId: "x" });
  });

  it("sseHeaders disable buffering + set event-stream", () => {
    const h = sseHeaders();
    expect(h["Content-Type"]).toContain("text/event-stream");
    expect(h["X-Accel-Buffering"]).toBe("no");
    expect(h["Cache-Control"]).toContain("no-transform");
  });

  it("statusCodeOf honors an attached statusCode, else falls back", () => {
    expect(statusCodeOf({ statusCode: 404 })).toBe(404);
    expect(statusCodeOf(new Error("x"), 502)).toBe(502);
  });
});
