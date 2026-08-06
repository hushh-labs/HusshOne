import { describe, expect, it } from "vitest";
import { SERVICE_CATALOG, feeBand, findServiceCategory } from "./pricing";
import { buildReservation, nextSlots } from "./reservation";

const advisor = findServiceCategory("financial-advisor")!;

describe("feeBand — the broker's price intelligence", () => {
  it("orders the band low < suggested < high and prices the session", () => {
    const band = feeBand(advisor, "established", 60);
    expect(band.sessionUsd).toBe(240);
    expect(band.feeLowUsd).toBeLessThan(band.feeSuggestedUsd);
    expect(band.feeSuggestedUsd).toBeLessThan(band.feeHighUsd);
    expect(band.feeSuggestedUsd).toBe(60); // 25% of the hour
  });

  it("scales with seniority and duration", () => {
    const top = feeBand(advisor, "top", 60);
    const rising30 = feeBand(advisor, "rising", 30);
    expect(top.feeSuggestedUsd).toBeGreaterThan(feeBand(advisor, "established", 60).feeSuggestedUsd);
    expect(rising30.feeSuggestedUsd).toBeLessThan(feeBand(advisor, "rising", 60).feeSuggestedUsd);
  });

  it("never suggests below the floor, for any catalog entry", () => {
    for (const c of SERVICE_CATALOG) {
      const band = feeBand(c, "rising", Math.min(...c.sessionMinutes));
      expect(band.feeLowUsd).toBeGreaterThanOrEqual(5);
    }
  });
});

describe("nextSlots — bookable windows", () => {
  it("returns future weekday slots only", () => {
    const from = new Date("2026-08-05T12:00:00Z"); // a Wednesday
    const slots = nextSlots(from, 30, 6);
    expect(slots).toHaveLength(6);
    for (const s of slots) {
      const d = new Date(s.startsAt);
      expect(d.getTime()).toBeGreaterThan(from.getTime());
      expect([0, 6]).not.toContain(d.getDay());
      expect(s.minutes).toBe(30);
    }
  });
});

describe("buildReservation — booking with the mandate attached", () => {
  const slot = nextSlots(new Date("2026-08-05T12:00:00Z"), 60, 1)[0];

  it("attaches an AP2-style mandate for exactly the chosen fee", () => {
    const { reservation, band } = buildReservation({
      category: advisor, seniority: "established", slot, feeUsd: band60().feeSuggestedUsd,
      id: "res-1", now: new Date("2026-08-05T12:00:00Z"),
    });
    expect(reservation.mandate.kind).toBe("ap2.payment-mandate");
    expect(reservation.mandate.mode).toBe("preview");
    expect(reservation.mandate.amountUsd).toBe(band.feeSuggestedUsd);
    expect(reservation.mandate.capture).toBe("on_confirmation");
    expect(reservation.status).toBe("reserved_pending_confirmation");
  });

  it("clamps a lowball or overshoot fee to the broker's band", () => {
    const now = new Date("2026-08-05T12:00:00Z");
    const low = buildReservation({ category: advisor, seniority: "established", slot, feeUsd: 1, id: "r", now });
    const high = buildReservation({ category: advisor, seniority: "established", slot, feeUsd: 10_000, id: "r", now });
    expect(low.reservation.feeUsd).toBe(low.band.feeLowUsd);
    expect(high.reservation.feeUsd).toBe(high.band.feeHighUsd);
  });

  function band60() {
    return feeBand(advisor, "established", 60);
  }
});
