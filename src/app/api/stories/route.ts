/* Public, machine-readable feed of the case studies + offers — for agents, MCP servers,
   and any general consumer. Same source of truth as the /customers pages. */
import { NextResponse } from "next/server";
import { CASE_STUDIES, PORTFOLIO, burstOffers } from "@/lib/stories/case-studies";

export const dynamic = "force-static";

export function GET() {
  return NextResponse.json(
    {
      product: "One — Xtreme Compute Burst",
      provider: { organization: "Hushh", url: "https://hushh.ai" },
      summary: "Personal supercomputing for Apple Silicon: runs on-device when it fits, bursts to the best-matched accelerator in your own cloud when it doesn't.",
      portfolio: PORTFOLIO,
      offers: burstOffers(),
      caseStudies: CASE_STUDIES,
      links: { web: "https://one.hushh.ai/customers", agentCard: "https://one.hushh.ai/.well-known/agent.json", offers: "https://one.hushh.ai/.well-known/ap2/offers.json" },
    },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
