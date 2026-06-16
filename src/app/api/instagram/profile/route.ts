import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import { getConnectedInstagramProfiles, instagramErrorResponse } from "@/lib/instagram/connection";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const verified = await verifyOneRequest(request.headers.get("authorization"));
    const profiles = await getConnectedInstagramProfiles(verified.uid);
    if (!profiles.length) return NextResponse.json({ ok: false, error: "Instagram is not connected." }, { status: 404 });
    return NextResponse.json({ ok: true, profiles });
  } catch (error) {
    return instagramErrorResponse(error);
  }
}
