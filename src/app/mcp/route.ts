import { handleMcpRequest } from "@/lib/openai-connector/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ ok: true, service: "one-by-hushh-openai-connector", endpoint: "/mcp" });
}

export async function POST(request: Request) {
  return handleMcpRequest(request);
}
