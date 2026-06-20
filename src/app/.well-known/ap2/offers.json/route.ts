/* AP2 (Agent Payments Protocol)-compatible offer catalog. These are the indicative
   per-chip-hour rates One uses to ESTIMATE a burst's cost and request approval (an AP2
   mandate) before spending in the customer's OWN cloud (BYOC). Hushh does not resell
   compute — the customer's cloud bills them directly. Descriptor only, not a live
   payment endpoint. */
import { NextResponse } from "next/server";
import { burstOffers } from "@/lib/stories/case-studies";

export const dynamic = "force-static";

export function GET() {
  return NextResponse.json({
    protocol: "AP2",
    note: "AP2-compatible offer descriptor. Pricing is used to estimate a burst and request a spend mandate before running in the caller's own cloud (BYOC). Not a live charge endpoint.",
    merchant: { name: "Hushh", url: "https://hushh.ai" },
    product: "One — Xtreme Compute Burst",
    currency: "USD",
    billing: "pay-per-second, in the caller's own cloud project",
    offers: burstOffers(),
  });
}
