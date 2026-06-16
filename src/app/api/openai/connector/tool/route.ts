import { NextResponse } from "next/server";
import { callConnectorToolForUser } from "@/lib/openai-connector/tools";
import type { ConnectorUser } from "@/lib/openai-connector/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
}

function asConnectorUser(value: unknown): ConnectorUser | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const firebaseUid = typeof candidate.firebaseUid === "string" ? candidate.firebaseUid.trim() : "";
  const email = typeof candidate.email === "string" ? candidate.email.trim() : "";
  const name = typeof candidate.name === "string" ? candidate.name : null;
  const scopes = Array.isArray(candidate.scopes) ? candidate.scopes.filter((scope): scope is string => typeof scope === "string") : [];
  if (!firebaseUid || !email || !scopes.length) return null;
  return { firebaseUid, email, name, picture: null, scopes };
}

export async function POST(request: Request) {
  const expected = (process.env.OPENAI_CONNECTOR_SERVICE_API_KEY || "").trim();
  if (!expected) {
    return NextResponse.json({ ok: false, error: "OpenAI connector service bridge key is not configured." }, { status: 503 });
  }
  if (bearerToken(request) !== expected) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const user = asConnectorUser(body.user);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!user || !name) {
    return NextResponse.json({ ok: false, error: "`user` and `name` are required." }, { status: 400 });
  }

  const result = await callConnectorToolForUser(user, name, body.arguments);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
