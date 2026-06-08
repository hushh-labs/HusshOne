import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getPrismaClient } from "./prisma";

interface UpsertUserInput {
  firebaseUid: string;
  email: string;
  name: string | null;
  photoUrl: string | null;
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
    },
    update: {
      email: input.email,
      name: input.name,
      photoUrl: input.photoUrl,
    },
  });
}

export async function createConsentAndScan(input: CreateScanInput) {
  const prisma = getPrismaClient();
  if (!prisma) return { scanRunId: null };

  const scan = await prisma.$transaction(async (tx) => {
    await tx.consentEvent.create({
      data: {
        userId: input.userId,
        purpose: input.purpose,
        consentVersion: process.env.ONE_CONSENT_VERSION || "2026-06-05",
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

export async function completeScanRun(scanRunId: string | null, data: Prisma.InputJsonValue, summary?: string) {
  const prisma = getPrismaClient();
  if (!prisma || !scanRunId) return;
  await prisma.scanRun.update({
    where: { id: scanRunId },
    data: {
      status: "completed",
      normalizedResult: data,
      summary,
      completedAt: new Date(),
    },
  });
}

export async function failScanRun(scanRunId: string | null, message: string) {
  const prisma = getPrismaClient();
  if (!prisma || !scanRunId) return;
  await prisma.scanRun.update({
    where: { id: scanRunId },
    data: {
      status: "failed",
      error: message,
      completedAt: new Date(),
    },
  });
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
      select: { status: true, normalizedResult: true, error: true, input: true },
    });
    if (!scan) return null;
    return { ...scan, userId: user.id };
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
      select: { id: true, status: true, normalizedResult: true, error: true },
    });
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
