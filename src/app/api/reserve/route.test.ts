import { describe, expect, it } from "vitest";
import { GET, POST } from "./route";

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://test/api/reserve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function tomorrowAt(hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

describe("GET /api/reserve", () => {
  it("returns the catalog with fee bands and future slots per service", async () => {
    const data = await GET().json();
    expect(data.catalog.length).toBeGreaterThanOrEqual(6);
    const advisor = data.catalog.find((c: { id: string }) => c.id === "financial-advisor");
    expect(advisor.bands.top.feeSuggestedUsd).toBeGreaterThan(advisor.bands.rising.feeSuggestedUsd);
    expect(advisor.slots.length).toBeGreaterThan(0);
    for (const s of advisor.slots) expect(Date.parse(s.startsAt)).toBeGreaterThan(Date.now());
  });
});

describe("POST /api/reserve", () => {
  it("books a slot and attaches a payment mandate for the chosen fee", async () => {
    const res = await post({
      categoryId: "financial-advisor", seniority: "established",
      startsAt: tomorrowAt(15), minutes: 60, feeUsd: 60,
    });
    expect(res.status).toBe(201);
    const { reservation } = await res.json();
    expect(reservation.status).toBe("reserved_pending_confirmation");
    expect(reservation.mandate.kind).toBe("ap2.payment-mandate");
    expect(reservation.mandate.mode).toBe("preview");
    expect(reservation.mandate.amountUsd).toBe(60);
    expect(reservation.id).toMatch(/[0-9a-f-]{36}/);
  });

  it("clamps the fee to the broker's band", async () => {
    const res = await post({
      categoryId: "tutor", seniority: "rising",
      startsAt: tomorrowAt(10), minutes: 60, feeUsd: 0,
    });
    const { reservation, band } = await res.json();
    expect(reservation.feeUsd).toBe(band.feeLowUsd);
  });

  it("rejects past slots and unknown services", async () => {
    expect((await post({ categoryId: "financial-advisor", startsAt: "2020-01-01T10:00:00Z", minutes: 60, feeUsd: 60 })).status).toBe(400);
    expect((await post({ categoryId: "fortune-teller", startsAt: tomorrowAt(10), minutes: 60, feeUsd: 60 })).status).toBe(400);
  });
});
