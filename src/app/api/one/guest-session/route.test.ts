import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  createOneCustomToken: vi.fn(async (uid: string, claims: { email?: string; name?: string; provider?: string }) => {
    if (!uid || !claims.email) throw new Error("bad guest token input");
    return "guest-custom-token";
  }),
  upsertOneUser: vi.fn(async () => ({ id: "one-user-id" })),
}));

vi.mock("@/lib/firebase/admin", () => ({
  createOneCustomToken: mocks.createOneCustomToken,
}));

vi.mock("@/lib/db/scan-store", () => ({
  upsertOneUser: mocks.upsertOneUser,
}));

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/one/guest-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/one/guest-session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects invalid guest identity", async () => {
    const res = await POST(makeRequest({ name: "A", email: "bad" }));
    const json = (await res.json()) as { ok?: boolean; error?: string };

    expect(res.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(json.error).toBe("Name is required.");
    expect(mocks.createOneCustomToken).not.toHaveBeenCalled();
    expect(mocks.upsertOneUser).not.toHaveBeenCalled();
  });

  it("creates a guest Firebase custom token and One user", async () => {
    const res = await POST(makeRequest({ name: "  Guest   User ", email: "Guest@Example.COM" }));
    const json = (await res.json()) as {
      ok?: boolean;
      customToken?: string;
      identity?: { name?: string; email?: string };
      provider?: string;
    };

    expect(res.status).toBe(200);
    expect(json).toEqual({
      ok: true,
      customToken: "guest-custom-token",
      identity: { name: "Guest User", email: "guest@example.com" },
      provider: "guest",
    });
    expect(mocks.createOneCustomToken).toHaveBeenCalledWith(
      expect.stringMatching(/^guest:/),
      { email: "guest@example.com", name: "Guest User", provider: "guest" },
    );
    const uid = mocks.createOneCustomToken.mock.calls[0]?.[0] as string;
    expect(mocks.upsertOneUser).toHaveBeenCalledWith({
      firebaseUid: uid,
      email: "guest@example.com",
      name: "Guest User",
      photoUrl: null,
      provider: "guest",
    });
  });
});
