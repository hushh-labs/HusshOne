/* Reserve — price intelligence (pure, no I/O).
   The "broker's" side of a booking: before anyone haggles, the system already has a
   grounded idea of what a slice of someone's time is worth — a willingness-to-pay band
   per service category and seniority, from which we suggest a reservation fee. The user
   still chooses (within the band); the point is they never face a blank "name a price"
   box. Rates are MODELED inputs (market-survey shaped, not live data) — edit as real
   booking analytics accumulate, exactly like hardware.ts's modeled catalog. */

export type Seniority = "rising" | "established" | "top";

export interface ServiceCategory {
  id: string;
  emoji: string;
  title: string;
  subtitle: string;
  /** Modeled median market rate for one hour with an "established" provider, USD. */
  baseUsdPerHour: number;
  /** Session lengths this category is actually booked in, minutes. First = default. */
  sessionMinutes: number[];
}

export const SERVICE_CATALOG: ServiceCategory[] = [
  { id: "financial-advisor", emoji: "📊", title: "Financial advisor", subtitle: "A real conversation about your money", baseUsdPerHour: 240, sessionMinutes: [30, 60] },
  { id: "ai-engineer",       emoji: "🤖", title: "AI engineer",       subtitle: "Unblock your model, pipeline, or burst job", baseUsdPerHour: 220, sessionMinutes: [30, 60] },
  { id: "designer",          emoji: "🎨", title: "Designer",          subtitle: "An eye on your product before it ships", baseUsdPerHour: 160, sessionMinutes: [30, 60] },
  { id: "photographer",      emoji: "📷", title: "Photographer",      subtitle: "Book the shoot, hold the golden hour", baseUsdPerHour: 150, sessionMinutes: [60, 120] },
  { id: "tutor",             emoji: "📚", title: "Tutor",             subtitle: "The exact hour before the exam", baseUsdPerHour: 90,  sessionMinutes: [60, 30] },
  { id: "trainer",           emoji: "💪", title: "Personal trainer",  subtitle: "A session that actually happens", baseUsdPerHour: 80,  sessionMinutes: [60, 45] },
];

export function findServiceCategory(id: string): ServiceCategory | undefined {
  return SERVICE_CATALOG.find((c) => c.id === id);
}

const SENIORITY_MULT: Record<Seniority, number> = {
  rising: 0.6,
  established: 1.0,
  top: 1.9,
};

/** Fraction of the session price paid up-front to make the booking real. */
const RESERVATION_FRACTION = 0.25;
const MIN_FEE_USD = 5;

const round = (n: number) => Math.round(n * 100) / 100;

export interface FeeBand {
  /** The session's full modeled price for this category/seniority/duration. */
  sessionUsd: number;
  /** Willingness-to-pay band for the up-front reservation fee (p25 / p50 / p75). */
  feeLowUsd: number;
  feeSuggestedUsd: number;
  feeHighUsd: number;
}

/**
 * The band the "broker" already has in mind: a low / suggested / high reservation fee.
 * Suggested = RESERVATION_FRACTION of the modeled session price; the band spans what
 * comparable bookings clear at (±35% around the median, floored at MIN_FEE_USD).
 */
export function feeBand(category: ServiceCategory, seniority: Seniority, minutes: number): FeeBand {
  const sessionUsd = round(category.baseUsdPerHour * SENIORITY_MULT[seniority] * (minutes / 60));
  const suggested = Math.max(MIN_FEE_USD, round(sessionUsd * RESERVATION_FRACTION));
  return {
    sessionUsd,
    feeLowUsd: Math.max(MIN_FEE_USD, round(suggested * 0.65)),
    feeSuggestedUsd: suggested,
    feeHighUsd: round(suggested * 1.35),
  };
}
