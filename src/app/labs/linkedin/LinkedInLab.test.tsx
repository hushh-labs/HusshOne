import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LinkedInLab from "./LinkedInLab";

describe("LinkedInLab — sign-in hero", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders the Sign in with LinkedIn button and default scopes", () => {
    // Mount now always probes /me; logged-out returns 401 → stay on the hero.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ connected: false, error: "not_connected" }), { status: 401 })));
    window.history.replaceState(null, "", "/labs/linkedin");
    render(<LinkedInLab />);
    expect(screen.getByRole("button", { name: /sign in with linkedin/i })).toBeInTheDocument();
    expect(screen.getByText(/requesting/i)).toBeInTheDocument();
    // The scope string appears in both the "Requesting…" line and the footer.
    expect(screen.getAllByText(/openid · profile · email · w_member_social/).length).toBeGreaterThan(0);
  });
});

describe("LinkedInLab — connected view (post-OAuth data)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows profile, granted scopes, decoded id_token claims and per-scope probes", async () => {
    const me = {
      ok: true,
      connected: true,
      granted_scopes: ["openid", "profile", "email", "w_member_social"],
      token_meta: {
        token_type: "Bearer",
        masked_token: "AQXf12…ab34",
        token_length: 380,
        expires_at: Date.now() + 3_600_000,
        expires_in_seconds: 3600,
        has_id_token: true,
        has_refresh_token: false,
      },
      id_token: {
        present: true,
        header: { alg: "RS256", typ: "JWT" },
        payload: {
          iss: "https://www.linkedin.com",
          aud: "client123",
          sub: "oidcSubABC",
          name: "Ankit Kumar Singh",
          email: "ankit@hushh.ai",
          iat: 1_700_000_000,
          exp: 1_700_003_600,
        },
      },
      userinfo: {
        ok: true,
        status: 200,
        data: { sub: "oidcSubABC", name: "Ankit Kumar Singh", email: "ankit@hushh.ai", picture: "https://media.licdn.com/x.jpg", locale: "en-US" },
      },
      probes: [
        {
          key: "legacy_me",
          label: "Lite/basic profile",
          description: "Legacy /v2/me",
          kind: "read",
          requiredAnyScope: ["r_liteprofile", "r_basicprofile"],
          method: "GET",
          url: "https://api.linkedin.com/v2/me",
          granted: false,
          attempted: false,
          note: "Not granted — needs r_liteprofile or r_basicprofile (LinkedIn partner approval).",
        },
        {
          key: "w_member_social",
          label: "Share on LinkedIn",
          description: "Write-only",
          kind: "write-only",
          requiredAnyScope: ["w_member_social"],
          method: "POST",
          url: "https://api.linkedin.com/v2/ugcPosts",
          granted: true,
          attempted: false,
          note: "Granted — but write-only; there is no endpoint to read member data with this scope.",
        },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(me), { status: 200, headers: { "content-type": "application/json" } })),
    );

    // Simulate the OAuth redirect landing back on the page.
    window.history.replaceState(null, "", "/labs/linkedin?connected=1");
    render(<LinkedInLab />);

    // Profile + signed-in state
    expect(await screen.findByText(/signed in with linkedin/i)).toBeInTheDocument();
    expect(screen.getAllByText("Ankit Kumar Singh").length).toBeGreaterThan(0);

    // Granted scope chip
    expect(screen.getAllByText("w_member_social").length).toBeGreaterThan(0);

    // Decoded id_token claim value
    expect(screen.getAllByText("https://www.linkedin.com").length).toBeGreaterThan(0);

    // Per-scope battery: a not-granted read probe + the write-only label
    expect(screen.getByText("Lite/basic profile")).toBeInTheDocument();
    expect(screen.getByText("not granted")).toBeInTheDocument();
    expect(screen.getAllByText(/write-only/).length).toBeGreaterThan(0);

    // Sign-in button is gone once connected
    expect(screen.queryByRole("button", { name: /sign in with linkedin/i })).not.toBeInTheDocument();

    // Copy controls: the whole-response copy, the id_token claims copy, and a
    // per-probe "Copy JSON" on any probe that returned data (here: userinfo).
    expect(screen.getByRole("button", { name: /copy all json/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy claims/i })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /copy json/i }).length).toBeGreaterThan(0);
  });

  it("writes the per-probe JSON to the clipboard when its Copy button is clicked", async () => {
    const writeText = vi.fn(async (text: string) => {
      void text;
    });
    vi.stubGlobal("navigator", { ...globalThis.navigator, clipboard: { writeText } } as unknown as Navigator);

    const me = {
      ok: true,
      connected: true,
      granted_scopes: ["openid"],
      userinfo: { ok: true, status: 200, data: { sub: "oidcSubABC", name: "Ankit Kumar Singh" } },
      probes: [],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(me), { status: 200, headers: { "content-type": "application/json" } })));
    window.history.replaceState(null, "", "/labs/linkedin?connected=1");

    render(<LinkedInLab />);

    const copyJson = await screen.findByRole("button", { name: /copy json/i });
    fireEvent.click(copyJson);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain("oidcSubABC");
    expect(await screen.findByText(/✓ copied/i)).toBeInTheDocument();
  });
});
