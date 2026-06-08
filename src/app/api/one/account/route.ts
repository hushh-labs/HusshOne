import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import { deleteOneUser } from "@/lib/db/scan-store";
import { deleteFirebaseUser, revokeFirebaseTokens } from "@/lib/firebase/admin";

export const runtime = "nodejs";

/* Full account deletion. Order: revoke sessions first (so other live tokens die
   even if a later step throws), then delete the durable DB data (cascades to
   scans/consents/audits/notifications), then remove the Firebase Auth user
   (best-effort). Idempotent — a second call returns ok:true. */
export async function DELETE(request: Request) {
  try {
    const verified = await verifyOneRequest(request.headers.get("authorization"));

    await revokeFirebaseTokens(verified.uid).catch(() => undefined);
    // A real DB error here must surface (500) — we never fake a successful delete.
    await deleteOneUser(verified.uid);
    // The dev user has no Firebase Auth record; skip the admin delete for it.
    if (verified.uid !== "dev-one-user") {
      await deleteFirebaseUser(verified.uid).catch(() => undefined);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const statusCode =
      typeof error === "object" && error && "statusCode" in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const status = Number.isFinite(statusCode) && statusCode >= 400 ? statusCode : 500;
    const message = error instanceof Error ? error.message : "Could not delete account";
    const severity = status >= 500 ? "ERROR" : "WARNING";
    console[status >= 500 ? "error" : "warn"](
      JSON.stringify({ event: "one.account_delete.failed", severity, status, message }),
    );
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
