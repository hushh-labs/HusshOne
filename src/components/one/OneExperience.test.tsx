import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OneExperience from "./OneExperience";

const mocks = vi.hoisted(() => ({
  currentUser: null as null | {
    uid: string;
    email: string;
    displayName: string;
    photoURL: string | null;
    getIdToken: () => Promise<string>;
  },
}));

vi.mock("@/lib/firebase/client", () => ({
  completeGoogleRedirect: vi.fn(async () => null),
  getFirebaseBearer: vi.fn(async () => "Bearer test"),
  isFirebaseClientConfigured: vi.fn(() => true),
  makeDevUser: vi.fn(() => ({
    uid: "dev-one-user",
    email: "dev.one@hushh.ai",
    displayName: "One Preview",
    photoURL: null,
    getIdToken: async () => "DEV_TOKEN",
  })),
  observeAuth: vi.fn((onChange: (user: typeof mocks.currentUser) => void) => {
    queueMicrotask(() => onChange(mocks.currentUser));
    return () => undefined;
  }),
  signInWithGoogle: vi.fn(async () => mocks.currentUser),
  signOutOfGoogle: vi.fn(async () => undefined),
}));

vi.mock("./ParticleMorph", () => ({
  ParticleMorph: () => null,
}));

function signedInUser() {
  return {
    uid: "firebase-1",
    email: "ankit@example.com",
    displayName: "Ankit Kumar Singh",
    photoURL: null,
    getIdToken: async () => "token",
  };
}

function richLinkedInProfile() {
  return {
    sub: "ankit-kumar-singh",
    name: "Ankit Kumar Singh",
    givenName: "Ankit",
    familyName: "Kumar Singh",
    email: "ankit@example.com",
    emailVerified: false,
    locale: null,
    pictureUrl: null,
    profileUrl: "https://www.linkedin.com/in/ankit-kumar-singh",
    headline: "Founding Engineer at Hushh",
    verifications: [],
    grantedScopes: ["scraper:linkedin-profile-url"],
    source: "scraper",
    about: "Builder at Hushh.",
    experience: [{ title: "Founding Engineer", company: "Hushh Technologies LLC", current: true }],
    education: [],
    skills: ["AI"],
    certifications: [],
  };
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("OneExperience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    window.sessionStorage.clear();
    mocks.currentUser = null;
    mockFetch(async () => Response.json({ ok: false }, { status: 404 }));
  });

  it("renders the One landing with Google sign-in", async () => {
    render(<OneExperience />);

    expect(await screen.findByRole("button", { name: /continue with google/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /start with linkedin/i })).not.toBeInTheDocument();
    expect(screen.getByText("Your personal intelligence agent.")).toBeInTheDocument();
  });

  it("routes stale local active scans to LinkedIn URL capture when no rich profile exists", async () => {
    mocks.currentUser = signedInUser();
    window.localStorage.setItem("one_active_scan", "stale-scan");
    window.localStorage.setItem("one_active_started_at", String(Date.now() - 60_000));
    window.localStorage.setItem("one_last_scan", "old-completed");
    const fetchMock = mockFetch(async (url) => {
      if (url === "/api/linkedin/profile") return Response.json({ ok: false }, { status: 404 });
      return Response.json({ ok: false, status: "running", scanRunId: "stale-scan", result: null });
    });

    render(<OneExperience />);

    expect(await screen.findByText("Paste your LinkedIn profile URL.")).toBeInTheDocument();
    expect(screen.queryByText(/One is composing your report/i)).not.toBeInTheDocument();
    expect(window.localStorage.getItem("one_active_scan")).toBeNull();
    expect(window.localStorage.getItem("one_active_started_at")).toBeNull();
    expect(window.localStorage.getItem("one_last_scan")).toBeNull();
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain("/api/one/scans/stale-scan");
  });

  it("does not ask the server for latest running scans before LinkedIn URL capture", async () => {
    mocks.currentUser = signedInUser();
    const fetchMock = mockFetch(async (url) => {
      if (url === "/api/linkedin/profile") return Response.json({ ok: false }, { status: 404 });
      if (url === "/api/one/scans/latest") {
        return Response.json({ ok: false, status: "running", scanRunId: "server-running", result: null });
      }
      return Response.json({ ok: false }, { status: 404 });
    });

    render(<OneExperience />);

    expect(await screen.findByText("Paste your LinkedIn profile URL.")).toBeInTheDocument();
    expect(screen.queryByText(/One is composing your report/i)).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain("/api/one/scans/latest");
  });

  it("still resumes an active scan after a rich URL-enriched LinkedIn profile exists", async () => {
    mocks.currentUser = signedInUser();
    window.localStorage.setItem("one_li_full", JSON.stringify(richLinkedInProfile()));
    window.localStorage.setItem("one_active_scan", "active-rich-scan");
    window.localStorage.setItem("one_active_started_at", String(Date.now() - 30_000));
    mockFetch(async (url) => {
      if (url === "/api/one/scans/active-rich-scan") {
        return Response.json({ ok: false, status: "running", result: null });
      }
      return Response.json({ ok: false }, { status: 404 });
    });

    render(<OneExperience />);

    expect(await screen.findByText("Your intelligence is assembling.")).toBeInTheDocument();
    expect(screen.getAllByText("Preference intelligence").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Phase 1 dossier").length).toBeGreaterThan(0);
    expect(screen.queryByText("Paste your LinkedIn profile URL.")).not.toBeInTheDocument();
  });

  it("routes stale completed reports with no rich profile back to LinkedIn URL capture", async () => {
    mocks.currentUser = signedInUser();
    window.localStorage.setItem("one_last_scan", "old-completed");
    mockFetch(async (url) => {
      if (url === "/api/linkedin/profile") return Response.json({ ok: false }, { status: 404 });
      if (url === "/api/one/scans/old-completed") {
        return Response.json({
          ok: true,
          status: "completed",
          result: { intelligenceVersion: "old-version", report: "# Old", categories: {} },
          emailDelivery: null,
        });
      }
      return Response.json({ ok: false }, { status: 404 });
    });

    render(<OneExperience />);

    expect(await screen.findByText("Paste your LinkedIn profile URL.")).toBeInTheDocument();
    expect(screen.queryByText(/Your deep research dossier/i)).not.toBeInTheDocument();
    expect(window.localStorage.getItem("one_last_scan")).toBeNull();
  });
});
