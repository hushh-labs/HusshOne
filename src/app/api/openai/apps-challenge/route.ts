import { NextResponse } from "next/server";

export const runtime = "nodejs";

export function GET() {
  const token = (process.env.OPENAI_APPS_CHALLENGE_TOKEN || "").trim();
  if (!token) {
    return NextResponse.json({ error: "OpenAI app domain challenge token is not configured." }, { status: 404 });
  }
  return new NextResponse(token, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
