import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBurstProvider, mockBurstEnabled } from "./provider-factory";

describe("provider-factory", () => {
  beforeEach(() => {
    delete process.env.ONE_ENABLE_MOCK_BURST;
  });
  afterEach(() => {
    delete process.env.ONE_ENABLE_MOCK_BURST;
  });

  it("mockBurstEnabled reflects the env flag", () => {
    expect(mockBurstEnabled()).toBe(false);
    process.env.ONE_ENABLE_MOCK_BURST = "true";
    expect(mockBurstEnabled()).toBe(true);
  });

  it("returns the gcp provider by default", () => {
    expect(getBurstProvider("gcp").id).toBe("gcp");
  });

  it("returns the mock provider when explicitly requested", () => {
    expect(getBurstProvider("mock").id).toBe("mock");
  });

  it("forces the mock provider when ONE_ENABLE_MOCK_BURST=true, even for gcp", () => {
    process.env.ONE_ENABLE_MOCK_BURST = "true";
    expect(getBurstProvider("gcp").id).toBe("mock");
  });

  it("rejects an unknown provider id with 400", () => {
    try {
      getBurstProvider("aws" as never);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { statusCode?: number }).statusCode).toBe(400);
    }
  });
});
