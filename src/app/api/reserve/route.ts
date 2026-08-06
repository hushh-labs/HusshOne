/* Reserve API — book a person's time with the payment attached, in one call.
   GET  → the service catalog + fee bands + next bookable slots (everything the client
          needs to render a booking with zero extra requests).
   POST → create the reservation: slot + chosen fee (clamped to the broker's band) +
          an AP2-style payment mandate. Stateless in preview mode — the receipt IS the
          artifact; durable persistence + live rail execution are deploy-time wiring. */
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { SERVICE_CATALOG, feeBand, findServiceCategory } from "@/lib/reserve/pricing";
import { buildReservation, nextSlots } from "@/lib/reserve/reservation";

export function GET() {
  const now = new Date();
  return NextResponse.json({
    catalog: SERVICE_CATALOG.map((c) => {
      const minutes = c.sessionMinutes[0];
      return {
        ...c,
        bands: {
          rising: feeBand(c, "rising", minutes),
          established: feeBand(c, "established", minutes),
          top: feeBand(c, "top", minutes),
        },
        slots: nextSlots(now, minutes),
      };
    }),
  });
}

const reserveSchema = z.object({
  categoryId: z.string(),
  seniority: z.enum(["rising", "established", "top"]).default("established"),
  startsAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: "startsAt must be an ISO datetime." }),
  minutes: z.number().int().min(15).max(240),
  feeUsd: z.number().min(0).max(50_000),
});

export async function POST(request: Request) {
  let parsed: z.infer<typeof reserveSchema>;
  try {
    parsed = reserveSchema.parse(await request.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues.map((i) => i.message).join("; ") : "Invalid JSON body.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const category = findServiceCategory(parsed.categoryId);
  if (!category) {
    return NextResponse.json({ error: `Unknown service "${parsed.categoryId}".` }, { status: 400 });
  }
  const now = new Date();
  const starts = new Date(parsed.startsAt);
  if (starts.getTime() <= now.getTime()) {
    return NextResponse.json({ error: "That slot is in the past." }, { status: 400 });
  }

  const { reservation, band } = buildReservation({
    category,
    seniority: parsed.seniority,
    slot: {
      startsAt: starts.toISOString(),
      minutes: parsed.minutes,
      label: starts.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    },
    feeUsd: parsed.feeUsd,
    id: randomUUID(),
    now,
  });

  return NextResponse.json({ reservation, band }, { status: 201 });
}
