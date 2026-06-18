/* Persistence for Xtreme Compute Burst jobs. Mirrors src/lib/db/scan-store.ts:
   null-guards getPrismaClient() (DB optional in some envs) and tolerates a not-yet-
   migrated table/columns (P2021/P2022) so a burst is never blocked by a lagging
   migration. The SA private key is NEVER persisted — only projectId/region/credsSource. */
import type { Prisma } from "@prisma/client";
import type { JobSpec, PlacementTarget, ResolvedGcpCreds } from "@/lib/burst/types";
import { getPrismaClient } from "./prisma";

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

// A missing table (P2021) or column (P2022) must never crash a burst — degrade to no-op.
function isMissingSchema(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "P2021" || code === "P2022";
}

export interface CreateBurstJobInput {
  firebaseUid: string;
  provider: string;
  spec: JobSpec;
  region: string;
  machineType: string;
  placement: PlacementTarget;
  placementReason: string;
  credsSource: ResolvedGcpCreds["source"] | null;
  /** When the placement is resolved up front (e.g. "puppy" completes immediately). */
  status?: string;
}

export interface BurstTiming {
  provisionMs?: number | null;
  runMs?: number | null;
  totalMs?: number | null;
}

export async function createBurstJob(input: CreateBurstJobInput): Promise<{ burstJobId: string | null }> {
  const prisma = getPrismaClient();
  if (!prisma) return { burstJobId: null };
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid: input.firebaseUid }, select: { id: true } });
    if (!user) return { burstJobId: null };
    const row = await prisma.burstJob.create({
      data: {
        userId: user.id,
        provider: input.provider,
        acceleratorKind: input.spec.acceleratorKind,
        acceleratorCount: input.spec.acceleratorCount,
        machineType: input.machineType,
        region: input.region,
        placement: input.placement,
        placementReason: input.placementReason,
        status: input.status ?? "pending",
        spec: toJsonValue(input.spec),
        credsSource: input.credsSource,
      },
      select: { id: true },
    });
    return { burstJobId: row.id };
  } catch (error) {
    if (isMissingSchema(error)) return { burstJobId: null };
    throw error;
  }
}

export async function markBurstProvisioned(
  burstJobId: string | null,
  data: { providerJobId?: string; instanceName?: string; provisionMs?: number },
): Promise<void> {
  const prisma = getPrismaClient();
  if (!prisma || !burstJobId) return;
  try {
    await prisma.burstJob.update({
      where: { id: burstJobId },
      data: {
        status: "running",
        providerJobId: data.providerJobId,
        instanceName: data.instanceName,
        ...(typeof data.provisionMs === "number" ? { provisionMs: Math.round(data.provisionMs) } : {}),
      },
    });
  } catch (error) {
    if (!isMissingSchema(error)) throw error;
  }
}

export async function completeBurstJob(
  burstJobId: string | null,
  result: unknown,
  timing?: BurstTiming,
): Promise<void> {
  const prisma = getPrismaClient();
  if (!prisma || !burstJobId) return;
  try {
    await prisma.burstJob.update({
      where: { id: burstJobId },
      data: {
        status: "completed",
        outcome: "completed",
        result: toJsonValue(result ?? null),
        completedAt: new Date(),
        ...timingData(timing),
      },
    });
  } catch (error) {
    if (!isMissingSchema(error)) throw error;
  }
}

export async function failBurstJob(
  burstJobId: string | null,
  message: string,
  timing?: BurstTiming,
): Promise<void> {
  const prisma = getPrismaClient();
  if (!prisma || !burstJobId) return;
  try {
    await prisma.burstJob.update({
      where: { id: burstJobId },
      data: {
        status: "failed",
        outcome: "failed",
        error: message,
        completedAt: new Date(),
        ...timingData(timing),
      },
    });
  } catch (error) {
    if (!isMissingSchema(error)) throw error;
  }
}

function timingData(timing?: BurstTiming): Prisma.BurstJobUpdateInput {
  const d: Prisma.BurstJobUpdateInput = {};
  if (!timing) return d;
  if (typeof timing.provisionMs === "number") d.provisionMs = Math.round(timing.provisionMs);
  if (typeof timing.runMs === "number") d.runMs = Math.round(timing.runMs);
  if (typeof timing.totalMs === "number") d.totalMs = Math.round(timing.totalMs);
  return d;
}

/* Owner-scoped lookup for the recovery route: returns the burst only if it belongs
   to the requesting user. Null when the DB is unset or the job isn't owned/found. */
export async function getOwnedBurstJob(firebaseUid: string, burstJobId: string) {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid }, select: { id: true } });
    if (!user) return null;
    return await prisma.burstJob.findFirst({
      where: { id: burstJobId, userId: user.id },
      select: {
        id: true,
        status: true,
        placement: true,
        provider: true,
        acceleratorKind: true,
        result: true,
        error: true,
        providerJobId: true,
        instanceName: true,
        region: true,
        createdAt: true,
      },
    });
  } catch (error) {
    if (isMissingSchema(error)) return null;
    return null;
  }
}

/* Owner-scoped status read used by the Puppy result callback: returns just enough to
   authorize and route the report. Null when unset/unowned. */
export async function getOwnedBurstJobStatus(firebaseUid: string, burstJobId: string) {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid }, select: { id: true } });
    if (!user) return null;
    return await prisma.burstJob.findFirst({
      where: { id: burstJobId, userId: user.id },
      select: { id: true, status: true, placement: true },
    });
  } catch (error) {
    if (isMissingSchema(error)) return null;
    return null;
  }
}
