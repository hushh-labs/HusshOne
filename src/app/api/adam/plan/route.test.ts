import { describe, expect, it } from "vitest";
import { GET, POST } from "./route";

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://test/api/adam/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("GET /api/adam/plan", () => {
  it("lists presets and device profiles including the iPhone 17 Pro", async () => {
    const res = GET();
    const data = await res.json();
    expect(data.presets.length).toBeGreaterThanOrEqual(6);
    expect(data.devices.map((d: { id: string }) => d.id)).toContain("iphone-17-pro");
  });
});

describe("POST /api/adam/plan", () => {
  it("bursts a 70B fine-tune from an iPhone to newest-generation GCP hardware", async () => {
    const res = await post({ presetId: "finetune-70b", deviceId: "iphone-17-pro" });
    expect(res.status).toBe(200);
    const plan = await res.json();
    expect(plan.placement.target).toBe("gcp");
    expect(plan.recommendation.fits).toBe(true);
    expect(["h200-141", "b200-180", "gb200-186"]).toContain(plan.recommendation.accel.id);
    expect(plan.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("keeps a small clip enhancement on the phone at $0", async () => {
    const res = await post({ presetId: "clip-edit", deviceId: "iphone-17-pro" });
    const plan = await res.json();
    expect(plan.placement.target).toBe("puppy");
    expect(plan.recommendation).toBeNull();
    expect(plan.estimatedCostUsd).toBe(0);
  });

  it("runs the same photos job on-device on a Mac Studio but bursts it from an iPhone", async () => {
    const onMac = await (await post({ presetId: "photos-model", deviceId: "puppy-m3-ultra" })).json();
    const onPhone = await (await post({ presetId: "photos-model", deviceId: "iphone-17-pro" })).json();
    expect(onMac.placement.target).toBe("puppy");
    expect(onPhone.placement.target).toBe("gcp");
  });

  it("always sends TPU work to the cloud (no TPU in a phone or Mac)", async () => {
    const res = await post({ presetId: "fold-protein", deviceId: "puppy-m3-ultra" });
    const plan = await res.json();
    expect(plan.placement.target).toBe("gcp");
    expect(plan.recommendation.accel.kind).toBe("tpu");
  });

  it("accepts a raw custom estimate", async () => {
    const res = await post({
      estimate: { vramGb: 200, unifiedMemoryGb: 64, vcpus: 16, diskGb: 100, estimatedMinutes: 45 },
      acceleratorKind: "gpu",
      deviceId: "windows-laptop",
    });
    expect(res.status).toBe(200);
    const plan = await res.json();
    expect(plan.placement.target).toBe("gcp");
    expect(plan.recommendation.usdPerHour).toBeGreaterThan(0);
  });

  it("rejects a body with neither preset nor estimate", async () => {
    const res = await post({ deviceId: "iphone-17-pro" });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown device", async () => {
    const res = await post({ presetId: "clip-edit", deviceId: "commodore-64" });
    expect(res.status).toBe(400);
  });
});
