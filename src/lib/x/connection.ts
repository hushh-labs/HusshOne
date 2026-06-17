import { NextResponse } from "next/server";
import type { VerifiedOneUser } from "@/lib/auth/verify";
import type { XAccessInfo, XProfileFull } from "./profile";
import { getSocialConnections, upsertOneUser, upsertSocialAccessRequest, upsertSocialConnection } from "@/lib/db/scan-store";

export function xErrorResponse(error: unknown) {
  const raw =
    typeof error === "object" && error && "statusCode" in error ? Number((error as { statusCode?: number }).statusCode) : NaN;
  const status = Number.isFinite(raw) && raw >= 400 ? raw : 500;
  const message = error instanceof Error ? error.message : "X request failed";
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function persistXProfile(verified: VerifiedOneUser, mapped: XProfileFull) {
  await upsertOneUser({
    firebaseUid: verified.uid,
    email: verified.email,
    name: verified.name || mapped.displayName,
    photoUrl: verified.picture ?? mapped.avatarUrl,
  }).catch(() => null);
  await upsertSocialConnection(verified.uid, "x", mapped.username, mapped).catch(() => null);
}

export async function persistXAccessRecord(
  verified: VerifiedOneUser,
  profileUrl: string,
  access: XAccessInfo,
  profileSnapshot?: XProfileFull | null,
  raw?: unknown,
) {
  const publicId = profileSnapshot?.username || new URL(profileUrl).pathname.split("/").filter(Boolean)[0] || "";
  if (!publicId) return null;
  await upsertOneUser({
    firebaseUid: verified.uid,
    email: verified.email,
    name: verified.name || profileSnapshot?.displayName || null,
    photoUrl: verified.picture ?? profileSnapshot?.avatarUrl ?? null,
  }).catch(() => null);
  return upsertSocialAccessRequest({
    firebaseUid: verified.uid,
    platform: "x",
    publicId,
    profileUrl,
    status: access.state,
    profileSnapshot: profileSnapshot ? { ...profileSnapshot, access } : { access, raw },
    requestedAt: access.requestedAction ? access.checkedAt || new Date().toISOString() : undefined,
    approvedAt: access.state === "approved_visible" || access.state === "public_visible" ? access.checkedAt || new Date().toISOString() : undefined,
    lastCheckedAt: access.checkedAt || new Date().toISOString(),
    nextCheckAt: access.nextCheckAfter || undefined,
    lastError: access.reason || null,
  }).catch(() => null);
}

export async function getConnectedXProfiles(firebaseUid: string): Promise<XProfileFull[]> {
  return getSocialConnections<XProfileFull>(firebaseUid, "x");
}
