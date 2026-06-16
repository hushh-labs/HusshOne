import { NextResponse } from "next/server";
import { exchangeAuthorizationCode, refreshConnectorAccessToken } from "@/lib/openai-connector/oauth";

export const runtime = "nodejs";

function oauthError(error: unknown) {
  const message = error instanceof Error ? error.message : "OAuth token exchange failed";
  return NextResponse.json({ error: "invalid_grant", error_description: message }, { status: 400 });
}

export async function POST(request: Request) {
  try {
    const form = new URLSearchParams(await request.text());
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      return NextResponse.json(exchangeAuthorizationCode(request, form), { headers: { "Cache-Control": "no-store" } });
    }
    if (grantType === "refresh_token") {
      return NextResponse.json(refreshConnectorAccessToken(request, form), { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json(
      { error: "unsupported_grant_type", error_description: "Use authorization_code or refresh_token." },
      { status: 400 },
    );
  } catch (error) {
    return oauthError(error);
  }
}
