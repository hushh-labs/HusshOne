import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyOneRequest } from "@/lib/auth/verify";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  persistThreadsProfile: vi.fn(async () => undefined),
}));

vi.mock("@/lib/auth/verify", () => ({
  verifyOneRequest: vi.fn(async () => ({
    uid: "firebase-1",
    email: "user@example.com",
    name: "User Example",
    picture: null,
  })),
}));

vi.mock("@/lib/threads/connection", () => ({
  persistThreadsProfile: mocks.persistThreadsProfile,
}));

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/threads/enrich-url", {
    method: "POST",
    headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/threads/enrich-url (handshake)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(async () => {
      throw new Error("handshake must not call the scraper");
    }) as never;
  });

  it("requires Firebase auth", async () => {
    vi.mocked(verifyOneRequest).mockRejectedValueOnce(Object.assign(new Error("Unauthorized"), { statusCode: 401 }));

    const res = await POST(makeRequest({ url: "https://www.threads.com/@ankit" }));
    const json = (await res.json()) as { ok?: boolean; error?: string };

    expect(res.status).toBe(401);
    expect(json).toMatchObject({ ok: false, error: "Unauthorized" });
    expect(mocks.persistThreadsProfile).not.toHaveBeenCalled();
  });

  it("rejects invalid Threads URLs with 422", async () => {
    const res = await POST(makeRequest({ url: "https://www.threads.com/@ankit/post/abc123" }));
    const json = (await res.json()) as { ok?: boolean };

    expect(res.status).toBe(422);
    expect(json.ok).toBe(false);
    expect(mocks.persistThreadsProfile).not.toHaveBeenCalled();
  });

  it("connects instantly: normalizes the URL, persists a minimal profile, never scrapes", async () => {
    const res = await POST(makeRequest({ url: "threads.net/@ankit_ya_i_am?hl=en" }));
    const json = (await res.json()) as {
      ok?: boolean;
      normalizedUrl?: string;
      profile?: { username?: string; source?: string; profileUrl?: string; platform?: string };
    };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.normalizedUrl).toBe("https://www.threads.com/@ankit_ya_i_am");
    expect(json.profile).toMatchObject({
      platform: "Threads",
      username: "ankit_ya_i_am",
      source: "scraper",
      profileUrl: "https://www.threads.com/@ankit_ya_i_am",
    });
    expect(mocks.persistThreadsProfile).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
