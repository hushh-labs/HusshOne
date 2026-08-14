import { describe, expect, it } from "vitest";
import {
  TEST_V4_AUDIT_ACTOR_REFERENCE,
  validV4UpstreamResponse,
} from "@/test/nws-v4-fixtures";
import {
  CoordinateConsentReceiptSchema,
  NWS_V4_PROJECT_ID,
  curateNearbyV4UpstreamResponse,
  validateNearbyV4ClientRequest,
} from "./v4-contracts";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("NWS v4 browser request contract", () => {
  it("normalizes a U.S. ZIP and applies the approved count", () => {
    const parsed = validateNearbyV4ClientRequest({
      query: { postal_code: " 98033-1234 ", country_code: "us" },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        query: { postal_code: "98033-1234", country_code: "US" },
        count: 100,
      });
    }
  });

  it("coarsens consented coordinates at the browser boundary", () => {
    const parsed = validateNearbyV4ClientRequest({
      query: { latitude: 47.6715, longitude: -122.2133 },
      count: 150,
      consent_granted: true,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.query).toEqual({ latitude: 47.67, longitude: -122.21 });
    }
  });

  it.each([
    { query: { latitude: 47.67, longitude: -122.21 } },
    { query: { latitude: 47.67 }, consent_granted: true },
    { query: { postal_code: "98033" }, consent_granted: true },
    { query: { postal_code: "980-33" } },
    { query: { postal_code: "98033" }, count: 101 },
    { query: { postal_code: "98033" }, count: "100" },
    { query: { postal_code: "98033" }, unexpected: true },
    { query: { latitude: Number.NaN, longitude: -122.21 }, consent_granted: true },
    { query: { latitude: 47.67, longitude: Number.POSITIVE_INFINITY }, consent_granted: true },
  ])("rejects an unapproved request shape: %#", (input) => {
    expect(validateNearbyV4ClientRequest(input).success).toBe(false);
  });

  it("accepts a maximum-length v4 coordinate receipt", () => {
    const parsed = CoordinateConsentReceiptSchema.safeParse({
      receipt_id: "a".repeat(512),
      purpose_id: "NET_WORTH_LOOKUP",
      audit_actor: `one-user:${"b".repeat(32)}`,
      scope: "APPROXIMATE_LOCATION_QUERY",
      issued_at: "2026-08-14T10:00:00+00:00",
      expires_at: "2026-08-14T10:05:00+00:00",
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects oversized and mismatched coordinate receipts", () => {
    expect(
      CoordinateConsentReceiptSchema.safeParse({
        receipt_id: "a".repeat(513),
        purpose_id: "NET_WORTH_LOOKUP",
        audit_actor: `one-user:${"b".repeat(32)}`,
        scope: "APPROXIMATE_LOCATION_QUERY",
        issued_at: "2026-08-14T10:05:00+00:00",
        expires_at: "2026-08-14T10:00:00+00:00",
      }).success,
    ).toBe(false);
  });
});

describe("NWS v4 upstream curation", () => {
  it("returns an explicit partial result without raw policy or financial internals", () => {
    const curated = curateNearbyV4UpstreamResponse(
      validV4UpstreamResponse({ resultCount: 2, discoveredCount: 7 }),
      {
        auditActorReference: TEST_V4_AUDIT_ACTOR_REFERENCE,
        count: 100,
        queryMode: "POSTAL_CODE",
      },
    );
    const wire = JSON.stringify(curated);

    expect(curated).toMatchObject({
      contract_version: "nws-nearby-net-worth-v4-preview-1",
      financial_coverage: { discovered_count: 7, eligible_count: 2 },
      result_set: { returned_count: 2, shortfall_count: 98, target_satisfied: false },
      limitations: {
        financial_coverage_nationwide: false,
        geographic_hierarchy_complete: false,
        association_is_live_presence: false,
      },
    });
    expect(wire).not.toContain("audit_actor_reference");
    expect(wire).not.toContain("components");
    expect(wire).not.toContain("why_ranked");
    expect(wire).not.toContain("generated_at");
    expect(wire).not.toContain("latitude");
    expect(wire).not.toContain("longitude");
    expect(wire).not.toContain("https://");
    expect(wire).not.toContain("@");
  });

  it("preserves discovered and shortfall counts when no profile is eligible", () => {
    const curated = curateNearbyV4UpstreamResponse(
      validV4UpstreamResponse({ resultCount: 0, discoveredCount: 60 }),
      {
        auditActorReference: TEST_V4_AUDIT_ACTOR_REFERENCE,
        count: 100,
        queryMode: "POSTAL_CODE",
      },
    );

    expect(curated.results).toEqual([]);
    expect(curated.financial_coverage).toMatchObject({ discovered_count: 60, eligible_count: 0 });
    expect(curated.result_set).toMatchObject({ returned_count: 0, shortfall_count: 100 });
  });

  it.each([
    (value: ReturnType<typeof validV4UpstreamResponse>) =>
      Object.assign(value, { unexpected: true }),
    (value: ReturnType<typeof validV4UpstreamResponse>) =>
      Object.assign(value.request_policy, { project_id: `${NWS_V4_PROJECT_ID}-other` }),
    (value: ReturnType<typeof validV4UpstreamResponse>) =>
      Object.assign(value.request_policy, { audit_actor_reference: "actor_deadbeefdeadbeef" }),
    (value: ReturnType<typeof validV4UpstreamResponse>) => value.disclosures.pop(),
    (value: ReturnType<typeof validV4UpstreamResponse>) =>
      Object.assign(value.result_set, { shortfall_count: 1 }),
    (value: ReturnType<typeof validV4UpstreamResponse>) =>
      Object.assign(value.results[0]!.person, { name: "person@example.com" }),
    (value: ReturnType<typeof validV4UpstreamResponse>) =>
      Object.assign(value.results[0]!, { rank: 2 }),
  ])("fails closed when the upstream contract drifts: %#", (mutate) => {
    const upstream = clone(validV4UpstreamResponse());
    mutate(upstream);

    expect(() =>
      curateNearbyV4UpstreamResponse(upstream, {
        auditActorReference: TEST_V4_AUDIT_ACTOR_REFERENCE,
        count: 100,
        queryMode: "POSTAL_CODE",
      }),
    ).toThrow();
  });

  it("rejects duplicate people", () => {
    const upstream = clone(validV4UpstreamResponse({ resultCount: 2 }));
    upstream.results[1]!.person.id = upstream.results[0]!.person.id;

    expect(() =>
      curateNearbyV4UpstreamResponse(upstream, {
        auditActorReference: TEST_V4_AUDIT_ACTOR_REFERENCE,
        count: 100,
        queryMode: "POSTAL_CODE",
      }),
    ).toThrow();
  });
});
