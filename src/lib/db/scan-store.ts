import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { ScanEmailAudienceDelivery, ScanEmailDeliverySummary } from "@/lib/notifications/types";
import type { LinkedInProfileFull } from "@/lib/linkedin/profile";
import { getPrismaClient } from "./prisma";

const USER_NOTIFICATION_TYPE = "scan_user_full_result";
const ADMIN_NOTIFICATION_TYPE = "scan_admin_full_result";

interface UpsertUserInput {
  firebaseUid: string;
  email: string;
  name: string | null;
  photoUrl: string | null;
  /** Identity provider — "linkedin" for the LinkedIn-first flow, else defaults to "google". */
  provider?: string;
}

interface CreateScanInput {
  userId: string;
  mode: string;
  purpose: string;
  input: Prisma.InputJsonValue;
  latitude?: number;
  longitude?: number;
  zipCode?: string;
  ip?: string | null;
  userAgent?: string | null;
}

function hashValue(value?: string | null) {
  if (!value) return null;
  return crypto.createHash("sha256").update(value).digest("hex");
}

/* Per-phase scan timing + outcome, persisted onto ScanRun for durable, per-user
   reporting (how long Phase-1/Phase-2 took, and why a scan ended). */
export interface ScanTiming {
  phase1Ms?: number | null;
  phase2Ms?: number | null;
  totalMs?: number | null;
  outcome?: string | null; // completed | completed_via_recovery | deadline | failed
  sessionId?: string | null;
  deepResearchJobId?: string | null;
}

function timingData(timing?: ScanTiming): Prisma.ScanRunUpdateInput {
  const d: Prisma.ScanRunUpdateInput = {};
  if (!timing) return d;
  if (typeof timing.phase1Ms === "number") d.phase1Ms = Math.round(timing.phase1Ms);
  if (typeof timing.phase2Ms === "number") d.phase2Ms = Math.round(timing.phase2Ms);
  if (typeof timing.totalMs === "number") d.totalMs = Math.round(timing.totalMs);
  if (timing.outcome) d.outcome = timing.outcome;
  if (timing.sessionId) d.sessionId = timing.sessionId;
  if (timing.deepResearchJobId) d.deepResearchJobId = timing.deepResearchJobId;
  return d;
}

// The timing columns may not be migrated yet in a given environment (the deploy does
// not auto-migrate). A "column does not exist" error (P2022) must NEVER block a scan
// from completing/failing — so callers fall back to a timing-less write in that case.
function isMissingColumn(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "P2022";
}

export async function upsertOneUser(input: UpsertUserInput) {
  const prisma = getPrismaClient();
  if (!prisma) return null;

  return prisma.oneUser.upsert({
    where: { firebaseUid: input.firebaseUid },
    create: {
      firebaseUid: input.firebaseUid,
      email: input.email,
      name: input.name,
      photoUrl: input.photoUrl,
      ...(input.provider ? { provider: input.provider } : {}),
    },
    update: {
      email: input.email,
      name: input.name,
      photoUrl: input.photoUrl,
      ...(input.provider ? { provider: input.provider } : {}),
    },
  });
}

/* ── LinkedIn connection (the MCP "Connect LinkedIn" step) ──────────────────
   Persist the user's FULL LinkedIn profile (1:1 with OneUser) so a returning
   session re-scans with the ground truth without re-logging into LinkedIn. The
   LinkedInConnection table is added by a migration the deploy does NOT auto-run,
   so EVERY call here is fully defensive: a missing table/column (P2021/P2022) or
   any other error returns null and NEVER breaks the connect/sign-in flow (the
   client localStorage cache covers connected-state until the table lands). */
export async function upsertLinkedInConnection(firebaseUid: string, profile: LinkedInProfileFull) {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid }, select: { id: true } });
    if (!user) return null;
    const data = {
      profile: JSON.parse(JSON.stringify(profile)) as Prisma.InputJsonValue,
      publicId: profile.sub || null,
      sessionValid: true,
    };
    return await prisma.linkedInConnection.upsert({
      where: { userId: user.id },
      create: { userId: user.id, ...data },
      update: data,
    });
  } catch {
    return null;
  }
}

export async function getLinkedInConnection(firebaseUid: string): Promise<LinkedInProfileFull | null> {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid }, select: { id: true } });
    if (!user) return null;
    const row = await prisma.linkedInConnection.findUnique({
      where: { userId: user.id },
      select: { profile: true, sessionValid: true },
    });
    if (!row || row.sessionValid === false) return null;
    return (row.profile ?? null) as unknown as LinkedInProfileFull | null;
  } catch {
    return null;
  }
}

export async function deleteLinkedInConnection(firebaseUid: string): Promise<boolean> {
  const prisma = getPrismaClient();
  if (!prisma) return false;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid }, select: { id: true } });
    if (!user) return false;
    await prisma.linkedInConnection.deleteMany({ where: { userId: user.id } });
    return true;
  } catch {
    return false;
  }
}

export async function createConsentAndScan(input: CreateScanInput) {
  const prisma = getPrismaClient();
  if (!prisma) return { scanRunId: null };

  const scan = await prisma.$transaction(async (tx) => {
    await tx.consentEvent.create({
      data: {
        userId: input.userId,
        purpose: input.purpose,
        consentVersion: process.env.ONE_CONSENT_VERSION || "2026-06-12-mcp-linkedin",
        locationMode: input.mode,
        latitude: input.latitude,
        longitude: input.longitude,
        zipCode: input.zipCode,
        ipHash: hashValue(input.ip),
        userAgentHash: hashValue(input.userAgent),
      },
    });

    return tx.scanRun.create({
      data: {
        userId: input.userId,
        mode: input.mode,
        purpose: input.purpose,
        input: input.input,
      },
    });
  });

  return { scanRunId: scan.id };
}

export async function completeScanRun(
  scanRunId: string | null,
  data: Prisma.InputJsonValue,
  summary?: string,
  timing?: ScanTiming,
) {
  const prisma = getPrismaClient();
  if (!prisma || !scanRunId) return;
  const base: Prisma.ScanRunUpdateInput = {
    status: "completed",
    normalizedResult: data,
    summary,
    completedAt: new Date(),
  };
  try {
    await prisma.scanRun.update({ where: { id: scanRunId }, data: { ...base, ...timingData({ outcome: "completed", ...timing }) } });
  } catch (error) {
    if (!isMissingColumn(error)) throw error;
    console.warn(JSON.stringify({ event: "one.scan.timing_columns_missing", scanRunId, where: "complete" }));
    await prisma.scanRun.update({ where: { id: scanRunId }, data: base });
  }
}

export async function failScanRun(scanRunId: string | null, message: string, timing?: ScanTiming) {
  const prisma = getPrismaClient();
  if (!prisma || !scanRunId) return;
  const base: Prisma.ScanRunUpdateInput = {
    status: "failed",
    error: message,
    completedAt: new Date(),
  };
  try {
    await prisma.scanRun.update({ where: { id: scanRunId }, data: { ...base, ...timingData({ outcome: "failed", ...timing }) } });
  } catch (error) {
    if (!isMissingColumn(error)) throw error;
    console.warn(JSON.stringify({ event: "one.scan.timing_columns_missing", scanRunId, where: "fail" }));
    await prisma.scanRun.update({ where: { id: scanRunId }, data: base });
  }
}

/* Record a deadline handoff: the streamed request hit our soft deadline before the
   job finished. Status stays "running" (recovery will resume + finalize), so we only
   stamp the timing/outcome for observability. Best-effort — must never break the
   handoff, so all errors are swallowed. */
export async function recordScanDeadline(scanRunId: string | null, timing: ScanTiming) {
  const prisma = getPrismaClient();
  if (!prisma || !scanRunId) return;
  try {
    await prisma.scanRun.update({ where: { id: scanRunId }, data: timingData({ outcome: "deadline", ...timing }) });
  } catch (error) {
    if (!isMissingColumn(error)) {
      console.warn(
        JSON.stringify({
          event: "one.scan.deadline_persist_failed",
          scanRunId,
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
  }
}

/* Recovery net for a dropped result stream: return the saved scan only if it
   belongs to the requesting user. Returns null when the DB is unset or the scan
   isn't owned/found. */
export async function getOwnedScanRun(firebaseUid: string, scanRunId: string) {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid }, select: { id: true } });
    if (!user) return null;
    return await prisma.scanRun.findFirst({
      where: { id: scanRunId, userId: user.id },
      select: { status: true, normalizedResult: true, error: true },
    });
  } catch {
    return null;
  }
}

/* Like getOwnedScanRun but also returns the stored input (which carries the
   Deep Research jobId) and userId, so the research poll route can resume the
   upstream job and attribute the result. Null when unset/unowned. */
export async function getResearchJob(firebaseUid: string, scanRunId: string) {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid }, select: { id: true } });
    if (!user) return null;
    const scan = await prisma.scanRun.findFirst({
      where: { id: scanRunId, userId: user.id },
      // NOTE: only select columns guaranteed to exist (createdAt is from the init
      // migration). Don't select the new timing columns here — they may be unmigrated
      // in some envs and a missing-column read would throw and break recovery.
      select: { status: true, normalizedResult: true, error: true, input: true, createdAt: true },
    });
    if (!scan) return null;
    return { ...scan, userId: user.id };
  } catch {
    return null;
  }
}

/* Progressive Tier-2 / image tier: merge fields into a COMPLETED scan's normalizedResult
   (schemaless jsonb — no migration). ATOMIC top-level merge via the Postgres `||` operator
   in a single statement (NOT read-modify-write), so the /deep and /image pollers — which
   write concurrently to the SAME blob — can't clobber each other's keys (lost-update race).
   Returns the merged result (so the route can echo it to the client) or null on any miss. */
export async function updateDeepTier(
  firebaseUid: string,
  scanRunId: string,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const patch = JSON.stringify(fields);
    const rows = await prisma.$queryRaw<Array<{ normalizedResult: Record<string, unknown> | null }>>`
      UPDATE "ScanRun" sr
      SET "normalizedResult" = sr."normalizedResult" || ${patch}::jsonb
      FROM "OneUser" u
      WHERE sr."id" = ${scanRunId}::uuid
        AND sr."userId" = u."id"
        AND u."firebaseUid" = ${firebaseUid}
        AND sr."normalizedResult" IS NOT NULL
        AND jsonb_typeof(sr."normalizedResult") = 'object'
      RETURNING sr."normalizedResult" AS "normalizedResult"
    `;
    return rows[0]?.normalizedResult ?? null;
  } catch {
    return null;
  }
}

/* Full account deletion. Removing the OneUser cascades (per schema) to its
   consent events, scan runs — and through them audit jobs and notifications —
   and data requests. Returns false when the DB is unset or the user was already
   gone (P2025), true on a real delete. Other DB errors bubble so the caller
   never reports a fake success. */
export async function deleteOneUser(firebaseUid: string): Promise<boolean> {
  const prisma = getPrismaClient();
  if (!prisma) return false;
  try {
    await prisma.oneUser.delete({ where: { firebaseUid } });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "P2025") return false; // already deleted
    throw error;
  }
}

/* The user's most recent scan (running or completed), so the client can
   re-attach after a full app close when it has no local scan id. Uses the
   [userId, createdAt] index. Null when the DB is unset, the user is unknown,
   or there are no scans. */
export async function getLatestScanForUser(firebaseUid: string) {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid }, select: { id: true } });
    if (!user) return null;
    return await prisma.scanRun.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, normalizedResult: true, error: true, createdAt: true },
    });
  } catch {
    return null;
  }
}

/* Reconstruct the email-delivery summary for a completed scan from the persisted
   OneNotification rows, so a RECOVERED dashboard (dropped stream / app re-open) can
   still show the "emailed to you" banner — the live send only runs once, in the
   streaming POST route. Null when the DB is unset, unowned, or nothing was logged
   (e.g. a scan finalized on the resume path, which doesn't send email). */
export async function getScanEmailDelivery(
  firebaseUid: string,
  scanRunId: string,
): Promise<ScanEmailDeliverySummary | null> {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid }, select: { id: true } });
    if (!user) return null;
    const owns = await prisma.scanRun.findFirst({ where: { id: scanRunId, userId: user.id }, select: { id: true } });
    if (!owns) return null;

    const rows = await prisma.oneNotification.findMany({
      where: { scanRunId, notificationType: { in: [USER_NOTIFICATION_TYPE, ADMIN_NOTIFICATION_TYPE] } },
      select: { notificationType: true, recipientEmail: true, status: true, providerMessageId: true, errorMessage: true },
    });
    if (!rows.length) return null;

    const audience = (type: string): ScanEmailAudienceDelivery => {
      const recipients = rows
        .filter((row) => row.notificationType === type)
        .map((row) => ({
          recipient: row.recipientEmail,
          status: (row.status === "sent" ? "sent" : "failed") as "sent" | "failed" | "skipped",
          messageId: row.providerMessageId ?? null,
          error: row.errorMessage ?? null,
        }));
      const status: ScanEmailAudienceDelivery["status"] = !recipients.length
        ? "skipped"
        : recipients.every((r) => r.status === "sent")
          ? "sent"
          : recipients.every((r) => r.status === "failed")
            ? "failed"
            : "partial";
      return { status, recipients, error: status === "sent" ? null : recipients.find((r) => r.error)?.error ?? null };
    };

    return { user: audience(USER_NOTIFICATION_TYPE), admins: audience(ADMIN_NOTIFICATION_TYPE) };
  } catch {
    return null;
  }
}

export async function createAuditJob(params: {
  scanRunId: string | null;
  upstreamJobId?: string | null;
  status?: string;
  totalShards?: number;
  completedShards?: number;
  failedShards?: number;
  reportAvailable?: boolean;
  errors?: string[];
}) {
  const prisma = getPrismaClient();
  if (!prisma || !params.scanRunId || !params.upstreamJobId) return null;

  const audit = await prisma.auditJob.upsert({
    where: { upstreamJobId: params.upstreamJobId },
    create: {
      scanRunId: params.scanRunId,
      upstreamJobId: params.upstreamJobId,
      status: params.status || "running",
      totalShards: params.totalShards || 0,
      completedShards: params.completedShards || 0,
      failedShards: params.failedShards || 0,
      reportAvailable: Boolean(params.reportAvailable),
      errors: params.errors || [],
    },
    update: {
      status: params.status || "running",
      totalShards: params.totalShards || 0,
      completedShards: params.completedShards || 0,
      failedShards: params.failedShards || 0,
      reportAvailable: Boolean(params.reportAvailable),
      errors: params.errors || [],
    },
  });

  return audit.id;
}
