import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { User } from "firebase/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NearbyV4ClientResponse } from "@/lib/nws/v4-contracts";
import { validV4ClientResponse } from "@/test/nws-v4-fixtures";

const firebase = vi.hoisted(() => ({
  currentUser: null as User | null,
  completeRedirect: vi.fn(),
  getBearer: vi.fn(),
  observe: vi.fn(),
  signIn: vi.fn(),
}));

vi.mock("@/lib/firebase/client", () => ({
  completeGoogleRedirect: firebase.completeRedirect,
  getFirebaseBearer: firebase.getBearer,
  isFirebaseClientConfigured: () => true,
  makeDevUser: () => ({ uid: "dev-one-user" }),
  observeAuth: firebase.observe,
  signInWithGoogle: firebase.signIn,
}));

import NearbyPeople from "./NearbyPeople";

const signedInUser = { uid: "firebase-user-a" } as User;
const originalGeolocation = Object.getOwnPropertyDescriptor(navigator, "geolocation");

function mockSuccess(body: NearbyV4ClientResponse = validV4ClientResponse()) {
  const fetchMock = vi.fn<typeof fetch>(async () => Response.json(body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mockError(status: number, code: string) {
  const fetchMock = vi.fn<typeof fetch>(async () =>
    Response.json({ ok: false, code, message: "internal detail", retryable: status >= 429 }, { status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function search(zip = "32301") {
  const input = await screen.findByRole("textbox", { name: "U.S. ZIP code" });
  fireEvent.change(input, { target: { value: zip } });
  fireEvent.click(screen.getByRole("button", { name: "Find people" }));
}

beforeEach(() => {
  firebase.currentUser = signedInUser;
  firebase.completeRedirect.mockReset().mockResolvedValue(null);
  firebase.getBearer.mockReset().mockResolvedValue("Bearer firebase-token");
  firebase.observe.mockReset().mockImplementation((callback: (user: User | null) => void) => {
    callback(firebase.currentUser);
    return () => undefined;
  });
  firebase.signIn.mockReset().mockResolvedValue(signedInUser);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalGeolocation) {
    Object.defineProperty(navigator, "geolocation", originalGeolocation);
  } else {
    Reflect.deleteProperty(navigator, "geolocation");
  }
});

describe("NearbyPeople v4", () => {
  it("shows a calm signed-in search surface", async () => {
    render(<NearbyPeople />);

    expect(screen.getByRole("heading", { name: "Net worth nearby" })).toBeInTheDocument();
    expect(screen.getByText("Public financial signals by U.S. area.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Find people" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use location" })).toBeInTheDocument();
    expect(screen.getByText("Approximate location. Public records only.")).toBeInTheDocument();
  });

  it("fails closed behind sign-in", async () => {
    firebase.currentUser = null;
    render(<NearbyPeople />);

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByText("Sign in to search.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "U.S. ZIP code" })).not.toBeInTheDocument();
  });

  it("rejects a malformed ZIP before any request", async () => {
    const fetchMock = mockSuccess();
    render(<NearbyPeople />);
    await search("980-33");

    expect(screen.getByText("Enter a valid U.S. ZIP.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the additive v4 BFF with Firebase auth and explicit shortfall", async () => {
    const fetchMock = mockSuccess(validV4ClientResponse({ resultCount: 25, discoveredCount: 30 }));
    render(<NearbyPeople />);
    await search();

    expect(await screen.findByRole("heading", { name: "25 NWS results" })).toBeInTheDocument();
    expect(screen.getByText(/75 short/)).toBeInTheDocument();
    expect(screen.getByText("Partial public coverage · 25 eligible from 30 found")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/nws/v4/nearby");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer firebase-token");
    expect(JSON.parse(String(init?.body))).toEqual({
      query: { postal_code: "32301", country_code: "US" },
      count: 100,
    });
    expect(screen.getByText("Person 20")).toBeInTheDocument();
    expect(screen.queryByText("Person 21")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByText("Person 25")).toBeInTheDocument();
  });

  it("keeps result details public and concise", async () => {
    mockSuccess();
    render(<NearbyPeople />);
    await search();
    await screen.findByRole("heading", { name: "1 NWS result" });

    const row = screen.getByRole("listitem");
    fireEvent.click(within(row).getByRole("button", { name: "Details" }));

    expect(within(row).getByText("Available-set rank")).toBeInTheDocument();
    expect(within(row).getByText("Sources · floridaethics.gov")).toBeInTheDocument();
    expect(within(row).getByText("Public association, not live presence.")).toBeInTheDocument();
    const wire = row.textContent ?? "";
    expect(wire).not.toContain("components");
    expect(wire).not.toContain("why_ranked");
    expect(wire).not.toContain("https://");
  });

  it("distinguishes discovered people from eligible NWS results", async () => {
    mockSuccess(validV4ClientResponse({ resultCount: 0, discoveredCount: 60 }));
    render(<NearbyPeople />);
    await search("98033");

    expect(await screen.findByRole("heading", { name: "No eligible NWS" })).toBeInTheDocument();
    expect(screen.getByText("60 found · 100 short")).toBeInTheDocument();
    expect(screen.getByText("Partial public coverage · 0 eligible from 60 found")).toBeInTheDocument();
  });

  it("shows explicit outside-coverage and unresolved states", async () => {
    const outside = validV4ClientResponse({ resultCount: 0, discoveredCount: 0 });
    outside.coverage = {
      status: "NOT_COVERED",
      reason_code: "COUNTRY_NOT_SUPPORTED",
      market_label: null,
      country_code: "IN",
    };
    const fetchMock = mockSuccess(outside);
    render(<NearbyPeople />);
    await search("32301");
    expect(await screen.findByRole("heading", { name: "Outside U.S. coverage" })).toBeInTheDocument();
    expect(screen.getByText("Use a U.S. ZIP.")).toBeInTheDocument();

    const unresolved = validV4ClientResponse({ resultCount: 0, discoveredCount: 0 });
    unresolved.coverage.status = "LOCATION_UNRESOLVED";
    fetchMock.mockResolvedValueOnce(Response.json(unresolved));
    await search("60637");
    expect(await screen.findByRole("heading", { name: "Location not found" })).toBeInTheDocument();
  });

  it.each([
    [401, "authentication_required", "Sign in required", "Sign in to search."],
    [409, "coverage_unavailable", "Coverage unavailable", "Try another U.S. ZIP."],
    [429, "rate_limited", "Too many searches", "Try again shortly."],
    [503, "service_unavailable", "Source unavailable", "Try again soon."],
    [504, "upstream_timeout", "Search timed out", "Try again."],
  ])("maps %s to calm recovery copy", async (status, code, title, detail) => {
    mockError(status, code);
    render(<NearbyPeople />);
    await search();

    expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
    expect(screen.getByText(detail)).toBeInTheDocument();
    expect(screen.queryByText("internal detail")).not.toBeInTheDocument();
  });

  it("coarsens real-time location and sends affirmative consent", async () => {
    const fetchMock = mockSuccess(validV4ClientResponse({ queryMode: "COARSE_COORDINATE" }));
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: vi.fn((success: PositionCallback) =>
          success({ coords: { latitude: 47.6715, longitude: -122.2133 } } as GeolocationPosition),
        ),
      },
    });
    render(<NearbyPeople />);
    fireEvent.click(await screen.findByRole("button", { name: "Use location" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      query: { latitude: 47.67, longitude: -122.21 },
      count: 100,
      consent_granted: true,
    });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer firebase-token",
    );
  });

  it("falls back to ZIP when location is denied", async () => {
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: vi.fn(
          (_success: PositionCallback, failure: PositionErrorCallback) =>
            failure({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError),
        ),
      },
    });
    render(<NearbyPeople />);
    fireEvent.click(await screen.findByRole("button", { name: "Use location" }));

    expect(await screen.findByRole("heading", { name: "Location not shared" })).toBeInTheDocument();
    expect(screen.getByText("Enter a ZIP instead.")).toBeInTheDocument();
  });
});
