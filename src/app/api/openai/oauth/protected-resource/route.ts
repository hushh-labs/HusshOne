import { protectedResourceMetadata } from "@/lib/openai-connector/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return Response.json(protectedResourceMetadata(request), { headers: { "Cache-Control": "no-store" } });
}
