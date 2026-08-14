import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NearbyClientResponse, NearbyClientResult } from "@/lib/nws/contracts";
import NearbyPeople from "./NearbyPeople";

const originalGeolocation = Object.getOwnPropertyDescriptor(navigator, "geolocation");

function emptyComponent(status: "UNKNOWN" | "NOT_PROVIDED" | "INCLUDED_IN_DECLARED_TOTAL" = "UNKNOWN") {
  return {
    status,
    low_usd: null,
    most_likely_usd: null,
    high_usd: null,
    confidence: null,
  } as const;
}

function result(rank: number, declaredTotal = false): NearbyClientResult {
  return {
    rank,
    person: {
      id: `public-official:${rank}`,
      name: `Person ${rank}`,
      headline: "Public official",
      organization: "State of Florida",
    },
    profile_status: "VERIFIED",
    estimated_net_worth: {
      status: "AVAILABLE",
      currency: "USD",
      p10_usd: declaredTotal ? 2_000_000 : 1_500_000,
      median_usd: 2_000_000,
      p90_usd: declaredTotal ? 2_000_000 : 2_700_000,
      method: declaredTotal ? "DECLARED_TOTAL_SIMULATION" : "MONTE_CARLO",
      as_of: "2025-12-31",
    },
    nws: { status: "AVAILABLE", value: 38, scale_version: "nws-us-log-v1" },
    confidence: { score: 0.91, grade: "B", coverage: 0.76 },
    components: declaredTotal
      ? {
          cash_and_near_cash: emptyComponent("INCLUDED_IN_DECLARED_TOTAL"),
          public_securities: emptyComponent("INCLUDED_IN_DECLARED_TOTAL"),
          private_business_equity: emptyComponent("INCLUDED_IN_DECLARED_TOTAL"),
          real_estate_equity: emptyComponent("INCLUDED_IN_DECLARED_TOTAL"),
          other_assets: emptyComponent("INCLUDED_IN_DECLARED_TOTAL"),
          liabilities: emptyComponent("INCLUDED_IN_DECLARED_TOTAL"),
        }
      : {
          cash_and_near_cash: {
            status: "SUPPORTED",
            low_usd: 100_000,
            most_likely_usd: 140_000,
            high_usd: 190_000,
            confidence: 0.9,
          },
          public_securities: {
            status: "MODELED_RANGE",
            low_usd: 350_000,
            most_likely_usd: 500_000,
            high_usd: 720_000,
            confidence: 0.65,
          },
          private_business_equity: emptyComponent("NOT_PROVIDED"),
          real_estate_equity: emptyComponent(),
          other_assets: emptyComponent("NOT_PROVIDED"),
          liabilities: emptyComponent("NOT_PROVIDED"),
        },
    liquid_wealth: {
      status: declaredTotal ? "UNKNOWN" : "AVAILABLE",
      currency: "USD",
      p10_usd: declaredTotal ? null : 450_000,
      median_usd: declaredTotal ? null : 640_000,
      p90_usd: declaredTotal ? null : 910_000,
    },
    liquidity_score: null,
    location_relationship: {
      label: "Florida public jurisdiction",
      association_kind: "PUBLIC_OFFICE_JURISDICTION",
      granularity: "STATE",
      approximate_distance_band: "within 25 km",
      note: "Public office relationship, not a residence or live location.",
    },
    last_financial_update: "2025-12-31",
    financial_update_precision: "DAY",
    sources: [
      {
        publisher: "Florida Commission on Ethics",
        title: "2025 Form 6 disclosure",
        url: `https://ethics.state.fl.us/example/${rank}`,
        fact_types: ["declared_asset"],
        source_date: "2025-12-31",
        retrieved_at: "2026-08-14T09:00:00+00:00",
      },
    ],
  };
}

function response(overrides: Partial<NearbyClientResponse> = {}): NearbyClientResponse {
  const results = Array.from({ length: 25 }, (_, index) => result(index + 1));
  return {
    query: {
      label: "Tallahassee, Florida 32301 query area",
      mode: "POSTAL_CODE",
      postal_code: "32301",
      country_code: "US",
      approximate: true,
    },
    coverage: {
      status: "COVERED",
      reason_code: "US_PUBLIC_JURISDICTION_INDEX",
      market_label: "Florida public financial disclosures",
      country_code: "US",
      complete: false,
      message: "Search ran over supported public jurisdictions.",
    },
    snapshot: {
      score_kind: "NET_WORTH_SCORE",
      scale_version: "nws-us-log-v1",
      model_version: "net-worth-monte-carlo-v1",
      complete: false,
      as_of: "2026-08-14",
      semantics: "Location selects candidates only; NWS uses public financial evidence.",
    },
    financial_coverage: {
      status: "AVAILABLE",
      candidate_count: 25,
      discovered_count: 25,
      evaluated_count: 25,
      unevaluated_count: 0,
      scored_count: 25,
      insufficient_evidence_count: 0,
    },
    result_set: {
      status: "PARTIAL",
      requested_count: 100,
      returned_count: 25,
      shortfall_count: 75,
      target_satisfied: false,
      reasons: ["LOCATION_CANDIDATE_POOL_BELOW_TARGET"],
    },
    search: {
      performed: true,
      scope: "PUBLIC_JURISDICTION",
      expanded: true,
      expansion_steps_km: [20, 40],
      initial_radius_km: 20,
      effective_radius_km: 40,
      maximum_radius_km: 100,
      maximum_radius_reached: false,
    },
    source_status: [
      {
        source: "PUBLIC_ASSOCIATION_CANDIDATES",
        purpose: "CANDIDATE_DISCOVERY",
        status: "OK",
        as_of: "2026-08-14",
        reason_code: null,
      },
      {
        source: "FLORIDA_FORM_6",
        purpose: "FINANCIAL_EVIDENCE",
        status: "OK",
        as_of: "2025-12-31",
        reason_code: null,
      },
    ],
    generated_at: "2026-08-14T10:00:00+00:00",
    results,
    ...overrides,
  };
}

function emptyResponse(
  overrides: Partial<NearbyClientResponse> = {},
): NearbyClientResponse {
  return response({
    financial_coverage: {
      status: "FINANCIAL_COVERAGE_INSUFFICIENT",
      candidate_count: 0,
      discovered_count: 0,
      evaluated_count: 0,
      unevaluated_count: 0,
      scored_count: 0,
      insufficient_evidence_count: 0,
    },
    result_set: {
      status: "EMPTY",
      requested_count: 100,
      returned_count: 0,
      shortfall_count: 100,
      target_satisfied: false,
      reasons: ["NO_LOCATION_CANDIDATES"],
    },
    results: [],
    ...overrides,
  });
}

function mockFetch(body: NearbyClientResponse = response()) {
  const fetchMock = vi.fn<typeof fetch>(async () => Response.json(body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function search(zip = "32301") {
  fireEvent.change(screen.getByRole("textbox", { name: "U.S. ZIP code" }), {
    target: { value: zip },
  });
  fireEvent.click(screen.getByRole("button", { name: "Find people" }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalGeolocation) {
    Object.defineProperty(navigator, "geolocation", originalGeolocation);
  } else {
    Reflect.deleteProperty(navigator, "geolocation");
  }
});

describe("NearbyPeople", () => {
  it("opens with the exact calm Net Worth Score action and privacy copy", () => {
    render(<NearbyPeople />);

    expect(screen.getByRole("heading", { name: "Net worth nearby" })).toBeInTheDocument();
    expect(screen.getByText("Verified public financial disclosures.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Find people" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use location" })).toBeInTheDocument();
    expect(screen.getByText("Approximate location. Public filings only.")).toBeInTheDocument();
  });

  it("rejects a malformed ZIP before making a request", () => {
    const fetchMock = mockFetch();
    render(<NearbyPeople />);
    search("980-33");

    expect(screen.getByText("Enter a valid U.S. ZIP.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders scored people, the v3 request, and public financial detail", async () => {
    const fetchMock = mockFetch();
    render(<NearbyPeople />);
    search();

    await screen.findByRole("heading", { name: "25 scored people" });
    const payload = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(payload).toEqual({
      query: { postal_code: "32301", country_code: "US" },
      top_n: 100,
      initial_radius_km: 20,
      max_radius_km: 100,
      auto_expand: true,
    });
    expect(payload).not.toHaveProperty("filters");
    expect(payload).not.toHaveProperty("diversity");
    expect(screen.getAllByText("Estimated net worth")).toHaveLength(20);
    expect(screen.getAllByText("NWS · 100")).toHaveLength(20);
    expect(screen.getAllByText("Confidence · 91%")).toHaveLength(20);
    expect(screen.getByText("Person 20")).toBeInTheDocument();
    expect(screen.queryByText("Person 21")).not.toBeInTheDocument();

    const firstRow = screen.getByText("Person 1").closest("article");
    expect(firstRow).not.toBeNull();
    fireEvent.click(within(firstRow!).getByRole("button", { name: "Details" }));
    expect(within(firstRow!).getByText("Cash and near cash")).toBeInTheDocument();
    expect(within(firstRow!).getByText("Public securities")).toBeInTheDocument();
    expect(within(firstRow!).getByText("Private business equity")).toBeInTheDocument();
    expect(within(firstRow!).getByText("Real estate equity")).toBeInTheDocument();
    expect(within(firstRow!).getByText("Other assets")).toBeInTheDocument();
    expect(within(firstRow!).getByText("Liabilities")).toBeInTheDocument();
    expect(within(firstRow!).getByText("Liquid wealth")).toBeInTheDocument();
    expect(within(firstRow!).getByRole("link", { name: "2025 Form 6 disclosure" })).toHaveAttribute(
      "href",
      "https://ethics.state.fl.us/example/1",
    );

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByText("Person 25")).toBeInTheDocument();
  });

  it("does not invent component values for a whole declared total", async () => {
    const annualResult = result(1, true);
    annualResult.estimated_net_worth.as_of = "2025";
    annualResult.last_financial_update = "2025";
    annualResult.financial_update_precision = "YEAR";
    annualResult.sources[0]!.source_date = "2025";
    mockFetch(response({
      financial_coverage: {
        status: "AVAILABLE",
        candidate_count: 1,
        discovered_count: 1,
        evaluated_count: 1,
        unevaluated_count: 0,
        scored_count: 1,
        insufficient_evidence_count: 0,
      },
      result_set: {
        status: "PARTIAL",
        requested_count: 100,
        returned_count: 1,
        shortfall_count: 99,
        target_satisfied: false,
        reasons: ["LOCATION_CANDIDATE_POOL_BELOW_TARGET"],
      },
      results: [annualResult],
    }));
    render(<NearbyPeople />);
    search();

    const person = await screen.findByText("Person 1");
    const row = person.closest("article")!;
    fireEvent.click(within(row).getByRole("button", { name: "Details" }));
    expect(within(row).getByText("Disclosed total only. Components were not itemized.")).toBeInTheDocument();
    expect(within(row).getAllByText("Included, not itemized")).toHaveLength(6);
    expect(within(row).getByText("Declared-total coverage")).toBeInTheDocument();
    expect(within(row).queryByText("$100–$300")).not.toBeInTheDocument();
    expect(within(row).getByText("2025", { selector: "strong" })).toBeInTheDocument();
  });

  it.each([
    ["NOT_COVERED", "Location not covered", "Try another U.S. ZIP."],
    ["LOCATION_UNRESOLVED", "Location unresolved", "Check the ZIP and try again."],
  ] as const)("distinguishes %s coverage", async (status, title, detail) => {
    mockFetch(emptyResponse({
      coverage: {
        status,
        reason_code: status,
        market_label: null,
        country_code: status === "NOT_COVERED" ? "IN" : "US",
        complete: false,
        message: "Not searched.",
      },
      financial_coverage: {
        status: "NOT_SEARCHED",
        candidate_count: 0,
        discovered_count: 0,
        evaluated_count: 0,
        unevaluated_count: 0,
        scored_count: 0,
        insufficient_evidence_count: 0,
      },
      result_set: {
        status: "NOT_SEARCHED",
        requested_count: 100,
        returned_count: 0,
        shortfall_count: 100,
        target_satisfied: false,
        reasons: [status],
      },
      search: {
        performed: false,
        scope: "NOT_SEARCHED",
        expanded: false,
        expansion_steps_km: [],
        initial_radius_km: 20,
        effective_radius_km: 0,
        maximum_radius_km: 100,
        maximum_radius_reached: false,
      },
    }));
    render(<NearbyPeople />);
    search();

    expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
    expect(screen.getByText(detail)).toBeInTheDocument();
  });

  it("distinguishes no location candidates from insufficient financial evidence", async () => {
    mockFetch(emptyResponse({
      search: {
        performed: true,
        scope: "ASSOCIATION_RADIUS",
        expanded: true,
        expansion_steps_km: [20, 40],
        initial_radius_km: 20,
        effective_radius_km: 40,
        maximum_radius_km: 100,
        maximum_radius_reached: false,
      },
    }));
    const first = render(<NearbyPeople />);
    search();
    expect(await screen.findByRole("heading", { name: "No public candidates nearby" })).toBeInTheDocument();
    first.unmount();

    mockFetch(emptyResponse({
      search: {
        performed: true,
        scope: "ASSOCIATION_RADIUS",
        expanded: true,
        expansion_steps_km: [20, 40],
        initial_radius_km: 20,
        effective_radius_km: 40,
        maximum_radius_km: 100,
        maximum_radius_reached: false,
      },
      financial_coverage: {
        status: "FINANCIAL_COVERAGE_INSUFFICIENT",
        candidate_count: 12,
        discovered_count: 12,
        evaluated_count: 12,
        unevaluated_count: 0,
        scored_count: 0,
        insufficient_evidence_count: 12,
      },
      result_set: {
        status: "EMPTY",
        requested_count: 100,
        returned_count: 0,
        shortfall_count: 100,
        target_satisfied: false,
        reasons: ["FINANCIAL_COVERAGE_INSUFFICIENT"],
      },
    }));
    render(<NearbyPeople />);
    search();
    expect(await screen.findByRole("heading", { name: "Financial evidence unavailable" })).toBeInTheDocument();
    expect(screen.getByText("12 nearby candidates lack enough public evidence.")).toBeInTheDocument();
  });

  it("treats an empty public jurisdiction as no verified NWS, not no candidates", async () => {
    mockFetch(emptyResponse());
    render(<NearbyPeople />);
    search();

    expect(await screen.findByRole("heading", { name: "No verified NWS" })).toBeInTheDocument();
    expect(screen.getByText("No matching public declarations in the current partial source.")).toBeInTheDocument();
  });

  it("marks a partial scored set and source unavailability without hiding results", async () => {
    mockFetch(response({
      financial_coverage: {
        status: "PARTIAL",
        candidate_count: 30,
        discovered_count: 30,
        evaluated_count: 30,
        unevaluated_count: 0,
        scored_count: 25,
        insufficient_evidence_count: 5,
      },
      source_status: [
        {
          source: "FLORIDA_FORM_6",
          purpose: "FINANCIAL_EVIDENCE",
          status: "UNAVAILABLE",
          as_of: null,
          reason_code: "SOURCE_TIMEOUT",
        },
      ],
    }));
    render(<NearbyPeople />);
    search();

    expect(await screen.findByRole("heading", { name: "Financial source unavailable" })).toBeInTheDocument();
    expect(screen.getByText("Partial coverage · 5 without enough public evidence")).toBeInTheDocument();
    expect(screen.getByText("Financial source unavailable. Some scores may be missing.")).toBeInTheDocument();
    expect(screen.getByText("Person 1")).toBeInTheDocument();
  });

  it("labels a partial source roster even when the requested result count is met", async () => {
    mockFetch(response({
      financial_coverage: {
        status: "PARTIAL",
        candidate_count: 25,
        discovered_count: 25,
        evaluated_count: 25,
        unevaluated_count: 0,
        scored_count: 25,
        insufficient_evidence_count: 0,
      },
      result_set: {
        status: "TARGET_MET",
        requested_count: 25,
        returned_count: 25,
        shortfall_count: 0,
        target_satisfied: true,
        reasons: ["SOURCE_INDEX_PARTIAL"],
      },
    }));
    render(<NearbyPeople />);
    search();

    expect(await screen.findByText("Source roster is partial")).toBeInTheDocument();
    expect(screen.queryByText(/0 without enough public evidence/)).not.toBeInTheDocument();
  });

  it.each([
    [429, "rate_limited", "Too many searches", "Try again shortly."],
    [504, "upstream_timeout", "Search timed out", "Try again."],
    [503, "service_unavailable", "Source unavailable", "Try again soon."],
  ] as const)("maps %s errors", async (status, code, title, detail) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json(
      { ok: false, code, message: detail, retryable: true },
      { status },
    )));
    render(<NearbyPeople />);
    search();

    expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
    expect(screen.getByText(detail)).toBeInTheDocument();
  });

  it("keeps denied location on the ZIP fallback", async () => {
    const getCurrentPosition = vi.fn((_success, failure) => failure({ code: 1, TIMEOUT: 3 }));
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: { getCurrentPosition },
    });
    render(<NearbyPeople />);
    fireEvent.click(screen.getByRole("button", { name: "Use location" }));

    expect(await screen.findByRole("heading", { name: "Location not shared" })).toBeInTheDocument();
    expect(screen.getByText("Enter a ZIP instead.")).toBeInTheDocument();
  });

  it("sends only coarsened consented coordinates", async () => {
    const fetchMock = mockFetch();
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (success: PositionCallback) => success({
          coords: { latitude: 30.4383, longitude: -84.2807, accuracy: 10 } as GeolocationCoordinates,
          timestamp: Date.now(),
        } as GeolocationPosition),
      },
    });
    render(<NearbyPeople />);
    fireEvent.click(screen.getByRole("button", { name: "Use location" }));

    await screen.findByRole("heading", { name: "25 scored people" });
    const payload = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(payload.query).toEqual({ latitude: 30.44, longitude: -84.28 });
    expect(payload.query).not.toHaveProperty("country_code");
  });
});
