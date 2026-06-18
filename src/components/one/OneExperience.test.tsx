import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signInWithOneCustomToken } from "@/lib/firebase/client";
import { INTELLIGENCE_VERSION } from "@/lib/research/version";
import OneExperience from "./OneExperience";

const mocks = vi.hoisted(() => ({
  currentUser: null as null | {
    uid: string;
    email: string | null;
    displayName: string | null;
    photoURL: string | null;
    getIdToken: () => Promise<string>;
    getIdTokenResult?: () => Promise<{ claims: Record<string, unknown> }>;
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
    getIdTokenResult: async () => ({ claims: { email: "dev.one@hushh.ai", name: "One Preview", provider: "dev" } }),
  })),
  observeAuth: vi.fn((onChange: (user: typeof mocks.currentUser) => void) => {
    queueMicrotask(() => onChange(mocks.currentUser));
    return () => undefined;
  }),
  signInWithGoogle: vi.fn(async () => mocks.currentUser),
  signInWithOneCustomToken: vi.fn(async () => ({
    uid: "guest:1",
    email: null,
    displayName: null,
    photoURL: null,
    getIdToken: async () => "guest-token",
    getIdTokenResult: async () => ({ claims: { email: "guest@example.com", name: "Guest User", provider: "guest" } }),
  })),
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
    getIdTokenResult: async () => ({
      signInProvider: "google.com",
      claims: { email: "ankit@example.com", name: "Ankit Kumar Singh", firebase: { sign_in_provider: "google.com" } },
    }),
  };
}

function guestSignedInUser() {
  return {
    uid: "guest:cached",
    email: null,
    displayName: null,
    photoURL: null,
    getIdToken: async () => "guest-token",
    getIdTokenResult: async () => ({ claims: { email: "guest@example.com", name: "Guest User", provider: "guest" } }),
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

function scopedLocal(uid: string, key: string, value: string) {
  window.localStorage.setItem(key, JSON.stringify({ __oneScoped: true, uid, value }));
}

const instagramProfile = {
  platform: "Instagram",
  username: "ankit_ya_i_am",
  displayName: "Ankit Kumar Singh",
  bio: "Builder at Hushh",
  avatarUrl: null,
  externalUrl: null,
  profileUrl: "https://www.instagram.com/ankit_ya_i_am/",
  isVerified: false,
  isPrivate: false,
  source: "scraper",
};

const threadsProfile = {
  platform: "Threads",
  username: "ankit_ya_i_am",
  displayName: "Ankit Kumar Singh",
  bio: "Builder at Hushh",
  avatarUrl: null,
  profileUrl: "https://www.threads.com/@ankit_ya_i_am",
  isVerified: false,
  isPrivate: false,
  source: "scraper",
};

const xProfile = {
  platform: "X",
  username: "ankit",
  displayName: "Ankit Kumar Singh",
  bio: "Builder at Hushh",
  avatarUrl: null,
  bannerUrl: null,
  location: null,
  website: null,
  joinedDate: null,
  followersCount: null,
  followingCount: null,
  profileUrl: "https://x.com/ankit",
  isVerified: false,
  isProtected: false,
  source: "scraper",
};

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
    expect(screen.getByRole("button", { name: /continue as guest/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /start with linkedin/i })).not.toBeInTheDocument();
    expect(screen.getByText("Your personal intelligence agent.")).toBeInTheDocument();
  });

  it("creates a guest session from manual identity and routes to the unified social URL intake", async () => {
    mockFetch(async (url) => {
      if (url === "/api/one/guest-session") {
        return Response.json({
          ok: true,
          customToken: "guest-custom-token",
          identity: { name: "Guest User", email: "guest@example.com" },
          provider: "guest",
        });
      }
      if (url === "/api/linkedin/profile") return Response.json({ ok: false }, { status: 404 });
      return Response.json({ ok: false }, { status: 404 });
    });

    render(<OneExperience />);

    fireEvent.click(await screen.findByRole("button", { name: /continue as guest/i }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Guest User" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "guest@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));

    expect(await screen.findByText("Choose what One can read.")).toBeInTheDocument();
    expect(screen.getByText(/LinkedIn is required for guest sessions/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /linkedin/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /instagram/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /threads/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^x/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/LinkedIn profile URL/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /linkedin/i }));
    expect(screen.getByLabelText(/LinkedIn profile URL/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /continue with profiles/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /use linkedin profile/i })).not.toBeInTheDocument();
    expect(vi.mocked(signInWithOneCustomToken)).toHaveBeenCalledWith("guest-custom-token");
  });

  it("routes guest stale local active scans to social URL intake when no rich profile exists", async () => {
    mocks.currentUser = guestSignedInUser();
    window.localStorage.setItem("one_active_scan", "stale-scan");
    window.localStorage.setItem("one_active_started_at", String(Date.now() - 60_000));
    window.localStorage.setItem("one_last_scan", "old-completed");
    const fetchMock = mockFetch(async (url) => {
      if (url === "/api/linkedin/profile") return Response.json({ ok: false }, { status: 404 });
      return Response.json({ ok: false, status: "running", scanRunId: "stale-scan", result: null });
    });

    render(<OneExperience />);

    expect(await screen.findByText("Choose what One can read.")).toBeInTheDocument();
    expect(screen.queryByText(/One is composing your report/i)).not.toBeInTheDocument();
    expect(window.localStorage.getItem("one_active_scan")).toBeNull();
    expect(window.localStorage.getItem("one_active_started_at")).toBeNull();
    expect(window.localStorage.getItem("one_last_scan")).toBeNull();
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain("/api/one/scans/stale-scan");
  });

  it("does not ask the server for latest running scans before guest social URL intake", async () => {
    mocks.currentUser = guestSignedInUser();
    const fetchMock = mockFetch(async (url) => {
      if (url === "/api/linkedin/profile") return Response.json({ ok: false }, { status: 404 });
      if (url === "/api/one/scans/latest") {
        return Response.json({ ok: false, status: "running", scanRunId: "server-running", result: null });
      }
      return Response.json({ ok: false }, { status: 404 });
    });

    render(<OneExperience />);

    expect(await screen.findByText("Choose what One can read.")).toBeInTheDocument();
    expect(screen.queryByText(/One is composing your report/i)).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain("/api/one/scans/latest");
  });

  it("routes Google users with no LinkedIn straight to precollect", async () => {
    mocks.currentUser = signedInUser();
    mockFetch(async (url) => {
      if (url === "/api/linkedin/profile") return Response.json({ ok: false }, { status: 404 });
      if (url === "/api/one/scans/latest") return Response.json({ ok: false }, { status: 404 });
      return Response.json({ ok: false }, { status: 404 });
    });

    render(<OneExperience />);

    expect(await screen.findByText("Verified via Google")).toBeInTheDocument();
    // LinkedIn is recommended for Google users and its URL field auto-opens (low-friction nudge).
    expect(screen.getByText(/Recommended — One reads your real career/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/LinkedIn profile URL/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send one/i })).not.toBeDisabled();
    expect(screen.queryByText("Add your social profile URLs.")).not.toBeInTheDocument();
  });

  it("lets Google users optionally add LinkedIn from precollect", async () => {
    mocks.currentUser = signedInUser();
    mockFetch(async (url) => {
      if (url === "/api/linkedin/profile") return Response.json({ ok: false }, { status: 404 });
      if (url === "/api/one/scans/latest") return Response.json({ ok: false }, { status: 404 });
      if (url === "/api/linkedin/enrich-url") return Response.json({ ok: true, profile: richLinkedInProfile() });
      return Response.json({ ok: false }, { status: 404 });
    });

    render(<OneExperience />);

    // The LinkedIn field auto-opens for Google users — no need to expand the connector first.
    fireEvent.change(await screen.findByLabelText(/LinkedIn profile URL/i), {
      target: { value: "https://www.linkedin.com/in/ankit-kumar-singh" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add linkedin/i }));

    expect(await screen.findByLabelText("Connected LinkedIn profile URL")).toHaveValue("https://www.linkedin.com/in/ankit-kumar-singh");
    expect(screen.getByText(/One now reads your real career, not just your name/i)).toBeInTheDocument();
  });

  it("still resumes an active scan after a rich URL-enriched LinkedIn profile exists", async () => {
    mocks.currentUser = signedInUser();
    scopedLocal("firebase-1", "one_li_full", JSON.stringify(richLinkedInProfile()));
    scopedLocal("firebase-1", "one_active_scan", "active-rich-scan");
    scopedLocal("firebase-1", "one_active_started_at", String(Date.now() - 30_000));
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

  it("restores a current completed scan when the v3 preference profile is missing legacy counters", async () => {
    mocks.currentUser = signedInUser();
    scopedLocal("firebase-1", "one_last_scan", "completed-v3-partial-profile");
    mockFetch(async (url) => {
      if (url === "/api/linkedin/profile") return Response.json({ ok: false }, { status: 404 });
      if (url === "/api/one/scans/completed-v3-partial-profile") {
        return Response.json({
          ok: true,
          status: "completed",
          emailDelivery: null,
          result: {
            scanRunId: "completed-v3-partial-profile",
            intelligenceVersion: INTELLIGENCE_VERSION,
            report: "# Current report",
            categories: { goals: ["Build durable AI products"] },
            preferenceStatus: "completed",
            preferenceProfile: {
              version: "preference-synthesis-v3",
              generatedAt: "2026-06-18T15:00:00.000Z",
              summary: "One answered 30/30 preference questions.",
              questionAnswers: [
                {
                  questionId: "q1",
                  sectionId: "taste",
                  sectionTitle: "Taste",
                  prompt: "What does this person enjoy?",
                  status: "answered",
                  answer: "Product launches and thoughtful AI demos.",
                  confidence: { level: "medium", score: 0.65, rationale: "" },
                  evidenceIds: [],
                },
              ],
              questionCoverage: { total: 30, answered: 30, inferred: 0, needsConfirmation: 0, unknown: 0, blockedByAccess: 0 },
              sectionSummaries: [{ sectionId: "taste", title: "Taste", summary: "", answeredCount: 1, totalCount: 1, confidence: "medium" }],
              archiveDepth: { perPlatform: { instagram: { items: 33, mediaTotal: 66, mediaAnalyzed: 0 } }, totals: { items: 33, mediaTotal: 66, mediaAnalyzed: 0 } },
            },
          },
        });
      }
      return Response.json({ ok: false }, { status: 404 });
    });

    render(<OneExperience />);

    expect(await screen.findByText("One answered 30/30 preference questions.", undefined, { timeout: 7000 })).toBeInTheDocument();
    expect(screen.getByText(/instagram/i)).toBeInTheDocument();
    expect(screen.queryByText(/One couldn't show that/i)).not.toBeInTheDocument();
  });

  it("shows the preference building state when a profile is below the 20/30 surface gate", async () => {
    mocks.currentUser = signedInUser();
    scopedLocal("firebase-1", "one_last_scan", "completed-weak-profile");
    mockFetch(async (url) => {
      if (url === "/api/linkedin/profile") return Response.json({ ok: false }, { status: 404 });
      if (url === "/api/one/scans/completed-weak-profile") {
        return Response.json({
          ok: true,
          status: "completed",
          emailDelivery: null,
          result: {
            scanRunId: "completed-weak-profile",
            intelligenceVersion: INTELLIGENCE_VERSION,
            report: "# Current report",
            categories: { goals: ["Build durable AI products"] },
            // Layer still running and only 6/30 answered → building state, not the full layer.
            preferenceStatus: "running",
            preferenceProfile: {
              version: "preference-synthesis-v3",
              generatedAt: "2026-06-18T15:00:00.000Z",
              summary: "One answered 30/30 preference questions.",
              questionAnswers: [
                {
                  questionId: "q1",
                  sectionId: "taste",
                  sectionTitle: "Taste",
                  prompt: "What does this person enjoy?",
                  status: "answered",
                  answer: "Product launches and thoughtful AI demos.",
                  confidence: { level: "medium", score: 0.65, rationale: "" },
                  evidenceIds: [],
                },
              ],
              questionCoverage: { total: 30, answered: 5, inferred: 1, needsConfirmation: 4, unknown: 20, blockedByAccess: 0 },
              sectionSummaries: [{ sectionId: "taste", title: "Taste", summary: "", answeredCount: 1, totalCount: 1, confidence: "medium" }],
            },
          },
        });
      }
      return Response.json({ ok: false }, { status: 404 });
    });

    render(<OneExperience />);

    expect(
      await screen.findByText(/Reading the through-lines in what you share — 6 of 30 understood so far/i, undefined, { timeout: 7000 }),
    ).toBeInTheDocument();
    // Building state hides the full layer (no per-question summary copy renders yet).
    expect(screen.queryByText("One answered 30/30 preference questions.")).not.toBeInTheDocument();
  });

  it("shows the connected LinkedIn URL on the social intake page", async () => {
    mocks.currentUser = signedInUser();
    scopedLocal("firebase-1", "one_li_full", JSON.stringify(richLinkedInProfile()));
    mockFetch(async () => Response.json({ ok: false }, { status: 404 }));

    render(<OneExperience />);

    fireEvent.click(await screen.findByRole("button", { name: /linkedin/i }));
    expect(screen.getByLabelText("Connected LinkedIn profile URL")).toHaveValue("https://www.linkedin.com/in/ankit-kumar-singh");
    expect(screen.getByRole("button", { name: /change/i })).toBeInTheDocument();
  });

  it("shows connected optional social URLs inside expanded connector fields", async () => {
    mocks.currentUser = signedInUser();
    scopedLocal("firebase-1", "one_li_full", JSON.stringify(richLinkedInProfile()));
    scopedLocal("firebase-1", "one_ig_full", JSON.stringify([instagramProfile]));
    scopedLocal("firebase-1", "one_threads_full", JSON.stringify([threadsProfile]));
    scopedLocal("firebase-1", "one_x_full", JSON.stringify([xProfile]));
    mockFetch(async () => Response.json({ ok: false }, { status: 404 }));

    render(<OneExperience />);

    expect(await screen.findByText("Verified via LinkedIn")).toBeInTheDocument();
    expect(screen.getAllByText(/@ankit_ya_i_am added/i).length).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole("button", { name: /instagram/i }));
    expect(screen.getByLabelText("Connected Instagram profile URL")).toHaveValue("https://www.instagram.com/ankit_ya_i_am/");

    fireEvent.click(screen.getByRole("button", { name: /threads/i }));
    expect(screen.getByLabelText("Connected Threads profile URL")).toHaveValue("https://www.threads.com/@ankit_ya_i_am");

    fireEvent.click(screen.getByRole("button", { name: /^x/i }));
    expect(screen.getByLabelText("Connected X profile URL")).toHaveValue("https://x.com/ankit");
  });

  it("can connect optional socials from the first social URL intake before LinkedIn unlocks Send One", async () => {
    mocks.currentUser = guestSignedInUser();
    const fetchMock = mockFetch(async (url) => {
      if (url === "/api/linkedin/profile") return Response.json({ ok: false }, { status: 404 });
      if (url === "/api/instagram/enrich-url") {
        return Response.json({ ok: true, profile: instagramProfile });
      }
      if (url === "/api/linkedin/enrich-url") {
        return Response.json({ ok: true, profile: richLinkedInProfile() });
      }
      return Response.json({ ok: false }, { status: 404 });
    });

    render(<OneExperience />);

    expect(await screen.findByText("Choose what One can read.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /instagram/i }));
    fireEvent.change(screen.getByLabelText(/Instagram profile URL/i), {
      target: { value: "https://www.instagram.com/ankit_ya_i_am/" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add instagram/i }));
    await waitFor(() =>
      expect(screen.getAllByText((_, element) => element?.textContent?.includes("@ankit_ya_i_am added") ?? false).length).toBeGreaterThan(0),
    );
    fireEvent.click(screen.getByRole("button", { name: /linkedin/i }));
    fireEvent.change(screen.getByLabelText(/LinkedIn profile URL/i), {
      target: { value: "https://www.linkedin.com/in/ankit-kumar-singh" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add linkedin/i }));

    expect(await screen.findByText("Verified via LinkedIn")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /career context connected/i }));
    expect(await screen.findByLabelText("Connected LinkedIn profile URL")).toHaveValue("https://www.linkedin.com/in/ankit-kumar-singh");
    expect(screen.getAllByText((_, element) => element?.textContent?.includes("@ankit_ya_i_am added") ?? false).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /send one/i })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/instagram/enrich-url",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/linkedin/enrich-url",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not block guest intake when optional X enrichment hangs", async () => {
    mocks.currentUser = guestSignedInUser();
    const fetchMock = mockFetch(async (url) => {
      if (url === "/api/linkedin/profile") return Response.json({ ok: false }, { status: 404 });
      if (url === "/api/x/enrich-url") {
        return new Promise<Response>(() => undefined);
      }
      if (url === "/api/linkedin/enrich-url") {
        return Response.json({ ok: true, profile: richLinkedInProfile() });
      }
      return Response.json({ ok: false }, { status: 404 });
    });

    render(<OneExperience />);

    expect(await screen.findByText("Choose what One can read.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^x/i }));
    fireEvent.change(screen.getByLabelText(/X profile URL/i), {
      target: { value: "https://x.com/sundarpichai" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add x/i }));
    fireEvent.click(screen.getByRole("button", { name: /linkedin/i }));
    fireEvent.change(screen.getByLabelText(/LinkedIn profile URL/i), {
      target: { value: "https://www.linkedin.com/in/ankit-kumar-singh" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add linkedin/i }));

    expect(await screen.findByText("Verified via LinkedIn")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /career context connected/i }));
    expect(await screen.findByLabelText("Connected LinkedIn profile URL")).toHaveValue("https://www.linkedin.com/in/ankit-kumar-singh");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/x/enrich-url",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("ignores scoped LinkedIn cache owned by another user", async () => {
    mocks.currentUser = signedInUser();
    scopedLocal("other-user", "one_li_full", JSON.stringify(richLinkedInProfile()));
    mockFetch(async (url) => {
      if (url === "/api/linkedin/profile") return Response.json({ ok: false }, { status: 404 });
      return Response.json({ ok: false }, { status: 404 });
    });

    render(<OneExperience />);

    expect(await screen.findByText("Verified via Google")).toBeInTheDocument();
    expect(window.localStorage.getItem("one_li_full")).toBeNull();
  });

  it("requires social preference consent only after optional socials are connected", async () => {
    mocks.currentUser = signedInUser();
    scopedLocal("firebase-1", "one_li_full", JSON.stringify(richLinkedInProfile()));
    scopedLocal("firebase-1", "one_ig_full", JSON.stringify([instagramProfile]));
    mockFetch(async () => Response.json({ ok: false }, { status: 404 }));

    render(<OneExperience />);

    expect(await screen.findByText(/@ankit_ya_i_am added/i)).toBeInTheDocument();
    const send = screen.getByRole("button", { name: /send one/i });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/Allow One to analyze/i));
    await waitFor(() => expect(send).not.toBeDisabled());
  });

  it("routes stale completed reports with no rich profile back to Google precollect", async () => {
    mocks.currentUser = signedInUser();
    window.localStorage.setItem("one_last_scan", "old-completed");
    scopedLocal("firebase-1", "one_ig_full", JSON.stringify([instagramProfile]));
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

    expect(await screen.findByText("Verified via Google")).toBeInTheDocument();
    expect(await screen.findByText(/@ankit_ya_i_am added/i)).toBeInTheDocument();
    expect(screen.queryByText(/Your deep research dossier/i)).not.toBeInTheDocument();
    expect(window.localStorage.getItem("one_last_scan")).toBeNull();
    expect(window.localStorage.getItem("one_ig_full")).not.toBeNull();
  });

  it("routes stale active scan recovery back to precollect instead of revealing the old dashboard", async () => {
    mocks.currentUser = signedInUser();
    scopedLocal("firebase-1", "one_active_scan", "active-old");
    scopedLocal("firebase-1", "one_active_started_at", String(Date.now() - 20_000));
    mockFetch(async (url) => {
      if (url === "/api/linkedin/profile") return Response.json({ ok: false }, { status: 404 });
      if (url === "/api/one/scans/active-old") {
        return Response.json({
          ok: true,
          status: "completed",
          result: { intelligenceVersion: "old-version", report: "# Old active", categories: {} },
          emailDelivery: null,
        });
      }
      if (url === "/api/one/scans/latest") return Response.json({ ok: false }, { status: 404 });
      return Response.json({ ok: false }, { status: 404 });
    });

    render(<OneExperience />);

    expect(await screen.findByText("Verified via Google")).toBeInTheDocument();
    expect(screen.queryByText(/Your deep research dossier/i)).not.toBeInTheDocument();
    expect(window.localStorage.getItem("one_active_scan")).toBeNull();
    expect(window.localStorage.getItem("one_active_started_at")).toBeNull();
  });
});
