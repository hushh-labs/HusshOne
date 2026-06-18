import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ prisma: null as unknown }));

vi.mock("./prisma", () => ({
  getPrismaClient: () => h.prisma,
}));

import {
  completeBurstJob,
  createBurstJob,
  failBurstJob,
  getOwnedBurstJob,
  markBurstProvisioned,
} from "./burst-store";
import type { JobSpec } from "@/lib/burst/types";

const spec: JobSpec = {
  image: "busybox",
  acceleratorKind: "gpu",
  acceleratorCount: 1,
  estimate: { vramGb: 10, unifiedMemoryGb: 10, vcpus: 2, diskGb: 10, estimatedMinutes: 5 },
};

type Args = Record<string, unknown>;
function fakePrisma() {
  return {
    oneUser: { findUnique: vi.fn(async (_a: Args) => ({ id: "user-1" }) as { id: string } | null) },
    burstJob: {
      create: vi.fn(async (_a: Args) => ({ id: "burst-1" })),
      update: vi.fn(async (_a: Args) => ({})),
      findFirst: vi.fn(async (_a: Args) => ({ id: "burst-1", status: "running" })),
    },
  };
}

describe("burst-store (no DB configured)", () => {
  beforeEach(() => {
    h.prisma = null;
  });

  it("degrades to null/no-op when there is no Prisma client", async () => {
    expect(await createBurstJob({ firebaseUid: "u", provider: "gcp", spec, region: "r", machineType: "m", placement: "gcp", placementReason: "x", credsSource: "request" })).toEqual({ burstJobId: null });
    await expect(markBurstProvisioned("b", {})).resolves.toBeUndefined();
    await expect(completeBurstJob("b", {})).resolves.toBeUndefined();
    await expect(failBurstJob("b", "msg")).resolves.toBeUndefined();
    expect(await getOwnedBurstJob("u", "b")).toBeNull();
  });
});

describe("burst-store (with DB)", () => {
  let prisma: ReturnType<typeof fakePrisma>;
  beforeEach(() => {
    prisma = fakePrisma();
    h.prisma = prisma;
  });

  it("creates a burst job scoped to the user and never stores credentials", async () => {
    const { burstJobId } = await createBurstJob({
      firebaseUid: "u",
      provider: "gcp",
      spec,
      region: "us-central1",
      machineType: "n1-standard-8",
      placement: "gcp",
      placementReason: "too big",
      credsSource: "request",
      status: "provisioning",
    });
    expect(burstJobId).toBe("burst-1");
    const data = prisma.burstJob.create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.userId).toBe("user-1");
    expect(data.credsSource).toBe("request");
    // The persisted spec must not carry any credential material.
    expect(JSON.stringify(data.spec)).not.toMatch(/private_key|serviceAccountJson/);
  });

  it("returns null when the user is unknown", async () => {
    prisma.oneUser.findUnique.mockResolvedValueOnce(null as never);
    expect(await createBurstJob({ firebaseUid: "ghost", provider: "gcp", spec, region: "r", machineType: "m", placement: "gcp", placementReason: "x", credsSource: null })).toEqual({ burstJobId: null });
  });

  it("marks provisioned, completed, and failed with timing", async () => {
    await markBurstProvisioned("burst-1", { providerJobId: "p", instanceName: "vm", provisionMs: 1234 });
    expect(prisma.burstJob.update.mock.calls[0]?.[0]?.data).toMatchObject({ status: "running", provisionMs: 1234 });

    await completeBurstJob("burst-1", { ok: true }, { runMs: 10, totalMs: 20 });
    expect(prisma.burstJob.update.mock.calls[1]?.[0]?.data).toMatchObject({ status: "completed", outcome: "completed", runMs: 10, totalMs: 20 });

    await failBurstJob("burst-1", "boom", { totalMs: 5 });
    expect(prisma.burstJob.update.mock.calls[2]?.[0]?.data).toMatchObject({ status: "failed", outcome: "failed", error: "boom" });
  });

  it("looks up an owned burst job", async () => {
    const row = await getOwnedBurstJob("u", "burst-1");
    expect(row).toMatchObject({ id: "burst-1" });
    expect(prisma.burstJob.findFirst.mock.calls[0]?.[0]?.where).toMatchObject({ id: "burst-1", userId: "user-1" });
  });

  it("tolerates a not-yet-migrated table (P2021) without throwing", async () => {
    prisma.burstJob.create.mockRejectedValueOnce(Object.assign(new Error("no table"), { code: "P2021" }));
    expect(await createBurstJob({ firebaseUid: "u", provider: "gcp", spec, region: "r", machineType: "m", placement: "gcp", placementReason: "x", credsSource: null })).toEqual({ burstJobId: null });
  });

  it("re-throws an unexpected DB error", async () => {
    prisma.burstJob.update.mockRejectedValueOnce(Object.assign(new Error("deadlock"), { code: "P2034" }));
    await expect(markBurstProvisioned("burst-1", { providerJobId: "p" })).rejects.toThrow(/deadlock/);
  });

  it("tolerates a missing column (P2022) on complete/fail without throwing", async () => {
    prisma.burstJob.update.mockRejectedValueOnce(Object.assign(new Error("no column"), { code: "P2022" }));
    await expect(completeBurstJob("burst-1", { ok: true })).resolves.toBeUndefined();
    prisma.burstJob.update.mockRejectedValueOnce(Object.assign(new Error("no column"), { code: "P2022" }));
    await expect(failBurstJob("burst-1", "x")).resolves.toBeUndefined();
  });

  it("returns null (never throws) when the owned-job lookup errors", async () => {
    prisma.burstJob.findFirst.mockRejectedValueOnce(new Error("connection reset"));
    expect(await getOwnedBurstJob("u", "burst-1")).toBeNull();
  });

  it("skips work for a null job id", async () => {
    await expect(markBurstProvisioned(null, { providerJobId: "p" })).resolves.toBeUndefined();
    expect(prisma.burstJob.update).not.toHaveBeenCalled();
  });
});
