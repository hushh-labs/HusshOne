/* Reserve — the booking itself (pure, no I/O).
   A reservation is a time slot made REAL by a payment mandate attached in the same act:
   "you're booked, and they know you're good for it." The mandate is an AP2-shaped
   descriptor (like /.well-known/ap2/offers.json for bursts): it names the rail, amount,
   and capture terms — execution against a live payment rail is the deploy-time concern,
   so every mandate carries an explicit `mode` and nothing here fakes a charge. */
import { type FeeBand, type Seniority, type ServiceCategory, feeBand } from "./pricing";

export interface SlotOption {
  /** ISO start time. */
  startsAt: string;
  minutes: number;
  label: string;
}

/** The next bookable windows: tomorrow onward, morning + afternoon, skipping weekends. */
export function nextSlots(from: Date, minutes: number, count = 4): SlotOption[] {
  const slots: SlotOption[] = [];
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  while (slots.length < count) {
    cursor.setDate(cursor.getDate() + 1);
    const day = cursor.getDay();
    if (day === 0 || day === 6) continue;
    for (const hour of [10, 15]) {
      if (slots.length >= count) break;
      const start = new Date(cursor);
      start.setHours(hour, 0, 0, 0);
      slots.push({
        startsAt: start.toISOString(),
        minutes,
        label: start.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
      });
    }
  }
  return slots;
}

export interface PaymentMandate {
  /** AP2-style mandate descriptor — a priced, user-approved intent to pay. */
  kind: "ap2.payment-mandate";
  mode: "preview"; // becomes "live" only when a real rail is configured at deploy time
  rail: "card"; // settled over the standard card rails at execution time
  amountUsd: number;
  currency: "USD";
  capture: "on_confirmation"; // provider confirms the slot -> fee captures -> booking is legit
  refund: "full_if_declined"; // provider declines/no-shows -> automatic full refund
}

export interface Reservation {
  id: string;
  categoryId: string;
  categoryTitle: string;
  seniority: Seniority;
  slot: SlotOption;
  feeUsd: number;
  sessionUsd: number;
  mandate: PaymentMandate;
  status: "reserved_pending_confirmation";
  createdAt: string;
}

export interface ReservationInput {
  category: ServiceCategory;
  seniority: Seniority;
  slot: SlotOption;
  /** The fee the user chose. Clamped to the band — the broker's floor/ceiling hold. */
  feeUsd: number;
  id: string;
  now: Date;
}

export function buildReservation(input: ReservationInput): { reservation: Reservation; band: FeeBand } {
  const band = feeBand(input.category, input.seniority, input.slot.minutes);
  const feeUsd = Math.min(Math.max(input.feeUsd, band.feeLowUsd), band.feeHighUsd);
  return {
    band,
    reservation: {
      id: input.id,
      categoryId: input.category.id,
      categoryTitle: input.category.title,
      seniority: input.seniority,
      slot: input.slot,
      feeUsd,
      sessionUsd: band.sessionUsd,
      mandate: {
        kind: "ap2.payment-mandate",
        mode: "preview",
        rail: "card",
        amountUsd: feeUsd,
        currency: "USD",
        capture: "on_confirmation",
        refund: "full_if_declined",
      },
      status: "reserved_pending_confirmation",
      createdAt: input.now.toISOString(),
    },
  };
}
