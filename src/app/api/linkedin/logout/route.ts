import { NextResponse } from "next/server";
import { COOKIE_PATH, LEGACY_COOKIE_PATH } from "@/lib/linkedin/oauth";

export const runtime = "nodejs";

/* Disconnect: clear the LinkedIn cookies for this lab. Does not revoke the token
   on LinkedIn's side (this is a local experiment) — it just drops our session.
   We emit RAW Set-Cookie headers (not res.cookies.set, which dedupes by name) so we
   can expire each cookie at BOTH "/" and the legacy "/api/linkedin" path — a stale
   path-scoped cookie from an earlier build was otherwise keeping a revoked token alive. */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  for (const name of ["li_token", "li_idtoken", "li_oauth_state"]) {
    for (const path of [COOKIE_PATH, LEGACY_COOKIE_PATH]) {
      res.headers.append("Set-Cookie", `${name}=; Path=${path}; Max-Age=0; HttpOnly; SameSite=Lax`);
    }
  }
  return res;
}
