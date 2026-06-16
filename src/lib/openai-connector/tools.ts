import {
  fetchConnectorRecord,
  getLatestScanForUser,
  getOwnedScanRun,
  getScanEmailDelivery,
  saveChatGptContextSnapshot,
  searchConnectorRecords,
} from "@/lib/db/scan-store";
import { persistConnectedProfile } from "@/lib/linkedin/connection";
import { hasUrlEnrichedLinkedInProfile } from "@/lib/linkedin/profile";
import { scrapeLinkedInProfileUrl } from "@/lib/linkedin/scraper-profile";
import { persistInstagramAccessRecord, persistInstagramProfile } from "@/lib/instagram/connection";
import { hasInstagramProfile } from "@/lib/instagram/profile";
import { scrapeInstagramProfileUrl } from "@/lib/instagram/scraper-profile";
import {
  connectorUserFromAuthorization,
  oauthChallengeMeta,
  requireConnectorScopes,
  verifiedOneUserFromConnector,
  type ConnectorUser,
} from "./oauth";

type JsonObject = Record<string, unknown>;

export class ConnectorToolError extends Error {
  constructor(
    message: string,
    readonly code = "connector_tool_error",
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "ConnectorToolError";
  }
}

const readSecurity = [{ type: "oauth2", scopes: ["one.profile.read", "one.social.read", "one.scan.read"] }];
const contextWriteSecurity = [{ type: "oauth2", scopes: ["one.profile.read", "one.context.write"] }];
const socialWriteSecurity = [{ type: "oauth2", scopes: ["one.profile.read", "one.social.read", "one.social.write"] }];

const searchOutputSchema = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          url: { type: "string" },
          metadata: { type: "object", additionalProperties: true },
        },
        required: ["id", "title", "url"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

const recordOutputSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    url: { type: "string" },
    text: { type: "string" },
    metadata: { type: "object", additionalProperties: true },
  },
  required: ["id", "title", "url", "text"],
  additionalProperties: false,
};

const accountOutputSchema = {
  type: "object",
  properties: {
    account: {
      type: ["object", "null"],
      additionalProperties: true,
    },
  },
  required: ["account"],
  additionalProperties: false,
};

const socialProfileOutputSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    normalizedUrl: { type: "string" },
    profile: { type: "object", additionalProperties: true },
    access: { type: "object", additionalProperties: true },
    code: { type: "string" },
  },
  required: ["ok", "normalizedUrl"],
  additionalProperties: true,
};

const scanStatusOutputSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    scanRunId: { type: ["string", "null"] },
    status: { type: "string" },
    result: { type: ["object", "array", "string", "number", "boolean", "null"] },
    error: { type: ["string", "null"] },
    emailDelivery: { type: ["object", "null"], additionalProperties: true },
    createdAt: { type: ["string", "null"] },
  },
  required: ["ok", "scanRunId", "status", "result", "error", "emailDelivery"],
  additionalProperties: false,
};

const chatGptContextOutputSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    snapshotId: { type: "string" },
    savedAt: { type: "string" },
    source: { type: "string" },
  },
  required: ["ok", "snapshotId", "savedAt", "source"],
  additionalProperties: false,
};

export const connectorTools = [
  {
    name: "search",
    title: "Search one by hushh",
    description: "Use this when the user asks to search their one.hushh.ai profile, approved ChatGPT context imports, connected social context, scan reports, or public-footprint findings.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query over the linked user's one.hushh.ai records." },
        type: { type: "string", enum: ["all", "account", "chatgpt_context", "linkedin", "social", "social_access", "scan"], default: "all" },
        limit: { type: "number", minimum: 1, maximum: 20, default: 10 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: searchOutputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    securitySchemes: readSecurity,
  },
  {
    name: "fetch",
    title: "Fetch one by hushh record",
    description: "Use this when the user needs the full contents of a one.hushh.ai search result by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Opaque id returned by search." } },
      required: ["id"],
      additionalProperties: false,
    },
    outputSchema: recordOutputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    securitySchemes: readSecurity,
  },
  {
    name: "one_get_account_context",
    title: "Get one by hushh account context",
    description: "Use this when the user asks what one.hushh.ai knows about their linked account, approved ChatGPT context imports, profile connections, or latest scan state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: accountOutputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    securitySchemes: readSecurity,
  },
  {
    name: "one_connect_linkedin_url",
    title: "Connect LinkedIn URL",
    description: "Use this when the user explicitly asks to connect or refresh their LinkedIn profile URL in one.hushh.ai.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "LinkedIn personal profile URL, usually https://www.linkedin.com/in/<handle>/." } },
      required: ["url"],
      additionalProperties: false,
    },
    outputSchema: socialProfileOutputSchema,
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    securitySchemes: socialWriteSecurity,
  },
  {
    name: "one_connect_instagram_url",
    title: "Connect Instagram URL",
    description: "Use this when the user explicitly asks to connect or refresh an Instagram profile URL in one.hushh.ai. This can request access for private profiles.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Instagram profile URL, usually https://www.instagram.com/<handle>/." } },
      required: ["url"],
      additionalProperties: false,
    },
    outputSchema: socialProfileOutputSchema,
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    securitySchemes: socialWriteSecurity,
  },
  {
    name: "one_get_scan_status",
    title: "Get one by hushh scan status",
    description: "Use this when the user asks for a specific one.hushh.ai scan status by scanRunId, or asks for their latest saved scan state.",
    inputSchema: {
      type: "object",
      properties: { scanRunId: { type: "string", description: "Optional scan id returned by one.hushh.ai. Omit to return the linked user's latest scan." } },
      additionalProperties: false,
    },
    outputSchema: scanStatusOutputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    securitySchemes: [{ type: "oauth2", scopes: ["one.scan.read"] }],
  },
  {
    name: "one_save_chatgpt_context",
    title: "Save ChatGPT context",
    description:
      "Use this when the user explicitly asks to import or save a ChatGPT-generated summary of their work style, goals, preferences, or other approved context into one.hushh.ai.",
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "User-approved ChatGPT context summary to save into one.hushh.ai. Do not include raw chat history or secrets.",
        },
        categories: {
          type: "array",
          items: { type: "string" },
          description: "Optional context categories, such as work_style, goals, preferences, projects, or communication_style.",
        },
        userPrompt: { type: "string", description: "Optional exact user prompt that requested the save." },
        consentText: { type: "string", description: "Optional consent wording confirming the user asked to save this summary." },
      },
      required: ["summary"],
      additionalProperties: false,
    },
    outputSchema: chatGptContextOutputSchema,
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    securitySchemes: contextWriteSecurity,
  },
];

function str(value: unknown, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function strList(value: unknown, maxItems = 12, maxLen = 80) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const text = str(item, maxLen);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function safeContent(value: unknown) {
  return [{ type: "text", text: JSON.stringify(value) }];
}

function ok(structuredContent: unknown, text?: string) {
  return { structuredContent, content: safeContent(text ? { message: text, data: structuredContent } : structuredContent) };
}

function toolArgs(args: unknown): JsonObject {
  return args && typeof args === "object" && !Array.isArray(args) ? (args as JsonObject) : {};
}

async function authedTool(request: Request): Promise<ConnectorUser> {
  return connectorUserFromAuthorization(request);
}

export async function callConnectorToolForUser(user: ConnectorUser, name: string, rawArgs: unknown) {
  const args = toolArgs(rawArgs);
  try {
    if (name === "search") {
      requireConnectorScopes(user, ["one.profile.read"]);
      const results = await searchConnectorRecords(user.firebaseUid, str(args.query, 300), str(args.type, 40) || "all", Number(args.limit) || 10);
      return ok({ results: results.map(({ id, title, url, metadata }) => ({ id, title, url, metadata })) });
    }
    if (name === "fetch") {
      requireConnectorScopes(user, ["one.profile.read"]);
      const id = str(args.id, 300);
      const doc = id ? await fetchConnectorRecord(user.firebaseUid, id) : null;
      if (!doc) throw new ConnectorToolError("one.hushh.ai record not found.", "record_not_found", 404);
      return ok(doc);
    }
    if (name === "one_get_account_context") {
      requireConnectorScopes(user, ["one.profile.read"]);
      const doc = await fetchConnectorRecord(user.firebaseUid, "account:me");
      return ok({ account: doc });
    }
    if (name === "one_get_scan_status") {
      requireConnectorScopes(user, ["one.scan.read"]);
      const scanRunId = str(args.scanRunId, 120);
      const scan = scanRunId ? await getOwnedScanRun(user.firebaseUid, scanRunId) : await getLatestScanForUser(user.firebaseUid);
      if (!scan) throw new ConnectorToolError("Scan not found.", "scan_not_found", 404);
      const resolvedScanRunId = "id" in scan ? scan.id : scanRunId;
      const createdAt = "createdAt" in scan && scan.createdAt instanceof Date ? scan.createdAt.toISOString() : null;
      const emailDelivery = scan.status === "completed" && resolvedScanRunId ? await getScanEmailDelivery(user.firebaseUid, resolvedScanRunId) : null;
      return ok({
        ok: scan.status === "completed",
        scanRunId: resolvedScanRunId || null,
        status: scan.status,
        result: scan.normalizedResult ?? null,
        error: scan.error ?? null,
        emailDelivery,
        createdAt,
      });
    }
    if (name === "one_save_chatgpt_context") {
      requireConnectorScopes(user, ["one.context.write"]);
      const summary = str(args.summary, 4000);
      if (!summary) {
        throw new ConnectorToolError(
          "A user-approved ChatGPT context summary is required.",
          "chatgpt_context_summary_required",
          400,
        );
      }
      const saved = await saveChatGptContextSnapshot({
        firebaseUid: user.firebaseUid,
        summary,
        categories: strList(args.categories),
        userPrompt: str(args.userPrompt, 1000) || null,
        consentText: str(args.consentText, 600) || null,
      });
      if (!saved) {
        throw new ConnectorToolError("Could not save ChatGPT context into one.hushh.ai.", "chatgpt_context_save_failed", 503);
      }
      return ok({ ok: true, ...saved });
    }
    if (name === "one_connect_linkedin_url") {
      requireConnectorScopes(user, ["one.social.write"]);
      const verified = verifiedOneUserFromConnector(user);
      const { profile, normalizedUrl } = await scrapeLinkedInProfileUrl(args.url, user.email);
      if (!hasUrlEnrichedLinkedInProfile(profile)) {
        throw new ConnectorToolError("LinkedIn profile did not include enough detail.", "linkedin_profile_incomplete", 422);
      }
      await persistConnectedProfile(verified, profile);
      return ok({ ok: true, normalizedUrl, profile });
    }
    if (name === "one_connect_instagram_url") {
      requireConnectorScopes(user, ["one.social.write"]);
      const verified = verifiedOneUserFromConnector(user);
      const result = await scrapeInstagramProfileUrl(args.url);
      if (result.status === "access_pending") {
        await persistInstagramAccessRecord(verified, result.normalizedUrl, result.access, result.profileSnapshot, result.raw);
        return ok({ ok: false, code: "instagram_access_pending", access: result.access, profile: result.profileSnapshot, normalizedUrl: result.normalizedUrl });
      }
      const { profile, normalizedUrl, raw, access } = result;
      if (!hasInstagramProfile(profile)) throw new ConnectorToolError("Instagram profile did not include enough detail.", "instagram_profile_incomplete", 422);
      await persistInstagramProfile(verified, profile);
      if (access) await persistInstagramAccessRecord(verified, normalizedUrl, access, profile, raw);
      return ok({ ok: true, normalizedUrl, profile });
    }
    throw new ConnectorToolError(`Unknown tool: ${name}`, "unknown_tool", 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connector tool failed.";
    const code = error instanceof ConnectorToolError ? error.code : "connector_tool_failed";
    return { isError: true, structuredContent: { ok: false, code, error: message }, content: [{ type: "text", text: message }] };
  }
}

export async function callConnectorTool(request: Request, name: string, rawArgs: unknown) {
  let user: ConnectorUser;
  try {
    user = await authedTool(request);
  } catch {
    return {
      isError: true,
      content: [{ type: "text", text: "Authentication required: link your one.hushh.ai account to continue." }],
      _meta: oauthChallengeMeta(request),
    };
  }
  return callConnectorToolForUser(user, name, rawArgs);
}
