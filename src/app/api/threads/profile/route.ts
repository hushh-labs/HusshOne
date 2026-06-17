import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import { getConnectedThreadsProfiles, threadsErrorResponse } from "@/lib/threads/connection";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const verified = await verifyOneRequest(request.headers.get("authorization"));
    const profiles = await getConnectedThreadsProfiles(verified.uid);
    if (!profiles.length) return NextResponse.json({ ok: false, error: "Threads is not connected." }, { status: 404 });
    return NextResponse.json({ ok: true, profiles });
  } catch (error) {
    return threadsErrorResponse(error);
  }
}
