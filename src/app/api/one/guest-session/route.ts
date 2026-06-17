import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { isValidEmail, normalizeEmail, normalizeName } from "@/lib/auth/identity";
import { upsertOneUser } from "@/lib/db/scan-store";
import { createOneCustomToken } from "@/lib/firebase/admin";

export const runtime = "nodejs";

async function parseBody(request: Request) {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { statusCode: 400 });
  }
}

function errorResponse(error: unknown) {
  const raw =
    typeof error === "object" && error && "statusCode" in error ? Number((error as { statusCode?: number }).statusCode) : NaN;
  const status = Number.isFinite(raw) && raw >= 400 ? raw : 500;
  const message = error instanceof Error ? error.message : "Could not create a guest session.";
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(request: Request) {
  try {
    const body = await parseBody(request);
    const name = normalizeName(body.name).slice(0, 80);
    const email = normalizeEmail(body.email);

    if (name.length < 2) throw Object.assign(new Error("Name is required."), { statusCode: 400 });
    if (!isValidEmail(email)) throw Object.assign(new Error("Valid email is required."), { statusCode: 400 });

    const uid = `guest:${randomUUID()}`;
    const customToken = await createOneCustomToken(uid, { email, name, provider: "guest" });

    await upsertOneUser({
      firebaseUid: uid,
      email,
      name,
      photoUrl: null,
      provider: "guest",
    }).catch(() => null);

    return NextResponse.json({
      ok: true,
      customToken,
      identity: { name, email },
      provider: "guest",
    });
  } catch (error) {
    return errorResponse(error);
  }
}
