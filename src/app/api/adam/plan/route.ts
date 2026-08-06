/* Adam's planning API — public, pure math, no secrets.
   GET  → the workload presets + device profiles the client renders from.
   POST → a full plan for one ask: where it runs (placement), the matched Google Cloud
   SKU + cost (recommendation), and matched-vs-naive benchmark rows. Composes the same
   pure engine the authenticated burst route uses; actually RUNNING a burst stays behind
   sign-in + BYOC at /api/one/burst. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { DEVICE_PROFILES, WORKLOAD_PRESETS, findDeviceProfile, findWorkloadPreset } from "@/lib/burst/devices";
import { benchmarkHardware, recommendHardware } from "@/lib/burst/hardware";
import { decidePlacement } from "@/lib/burst/placement";
import type { WorkloadEstimate } from "@/lib/burst/types";

const estimateSchema = z.object({
  vramGb: z.number().min(0).max(100_000),
  unifiedMemoryGb: z.number().min(0).max(100_000),
  vcpus: z.number().min(1).max(1_024),
  diskGb: z.number().min(0).max(1_000_000),
  estimatedMinutes: z.number().min(1).max(10_080),
});

const planRequestSchema = z
  .object({
    presetId: z.string().optional(),
    estimate: estimateSchema.optional(),
    acceleratorKind: z.enum(["gpu", "tpu"]).optional(),
    deviceId: z.string().default("iphone-17-pro"),
    parallelChips: z.number().int().min(1).max(8).optional(),
  })
  .refine((body) => body.presetId || body.estimate, {
    message: "Provide presetId or estimate.",
  });

export function GET() {
  return NextResponse.json({ presets: WORKLOAD_PRESETS, devices: DEVICE_PROFILES });
}

export async function POST(request: Request) {
  let parsed: z.infer<typeof planRequestSchema>;
  try {
    parsed = planRequestSchema.parse(await request.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues.map((i) => i.message).join("; ") : "Invalid JSON body.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const preset = parsed.presetId ? findWorkloadPreset(parsed.presetId) : undefined;
  if (parsed.presetId && !preset) {
    return NextResponse.json({ error: `Unknown preset "${parsed.presetId}".` }, { status: 400 });
  }
  const device = findDeviceProfile(parsed.deviceId);
  if (!device) {
    return NextResponse.json({ error: `Unknown device "${parsed.deviceId}".` }, { status: 400 });
  }

  const estimate: WorkloadEstimate = preset?.estimate ?? parsed.estimate!;
  const kind = parsed.acceleratorKind ?? preset?.acceleratorKind ?? "gpu";
  const parallel = parsed.parallelChips ?? preset?.parallelChips ?? 1;
  const runtimeMin = preset?.matchedRuntimeMin ?? estimate.estimatedMinutes;

  const placement = decidePlacement(estimate, device, kind);
  const recommendation = recommendHardware(estimate.vramGb, kind, parallel);
  const benchmark = benchmarkHardware(estimate.vramGb, kind, parallel, runtimeMin);
  const matched = benchmark.find((row) => row.role === "matched");

  return NextResponse.json({
    device: { id: device.id, label: device.label },
    placement,
    recommendation:
      placement.target === "puppy"
        ? null // fits the device in hand — no cloud hardware needed, no cost
        : recommendation,
    benchmark: placement.target === "puppy" ? [] : benchmark,
    estimatedCostUsd: placement.target === "puppy" ? 0 : (matched?.costUsd ?? null),
    estimatedMinutes: placement.target === "puppy" ? estimate.estimatedMinutes : (matched?.wallMinutes ?? null),
  });
}
