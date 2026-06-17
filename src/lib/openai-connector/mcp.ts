import { connectorTools, callConnectorTool } from "./tools";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function result(id: JsonRpcRequest["id"], value: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result: value };
}

function error(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleOne(request: Request, rpc: JsonRpcRequest) {
  if (!rpc.id && String(rpc.method || "").startsWith("notifications/")) return null;
  switch (rpc.method) {
    case "initialize":
      return result(rpc.id, {
        protocolVersion: typeof rpc.params?.protocolVersion === "string" ? rpc.params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "one-by-hushh-openai-connector", version: "0.1.0" },
        instructions:
          "Use this connector only for the linked user's one.hushh.ai account, approved ChatGPT context imports, profiles, social context, and scan records. Never expose secrets, raw ChatGPT chats, raw memories, or scraper session data.",
      });
    case "tools/list":
      return result(rpc.id, { tools: connectorTools });
    case "tools/call": {
      const name = typeof rpc.params?.name === "string" ? rpc.params.name : "";
      const args = rpc.params?.arguments;
      return result(rpc.id, await callConnectorTool(request, name, args));
    }
    case "ping":
      return result(rpc.id, {});
    default:
      return error(rpc.id, -32601, `Unsupported MCP method: ${rpc.method || "unknown"}`);
  }
}

export async function handleMcpRequest(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(error(null, -32700, "Invalid JSON-RPC body"), { status: 400 });
  }
  const calls = Array.isArray(body) ? body : [body];
  const responses = (await Promise.all(calls.map((item) => handleOne(request, item as JsonRpcRequest)))).filter(Boolean);
  if (!responses.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? responses : responses[0], {
    headers: {
      "Cache-Control": "no-store",
      "Mcp-Session-Id": "hushhone-stateless",
    },
  });
}
