import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { ScanEmailAudienceDelivery, ScanEmailDeliverySummary } from "@/lib/notifications/types";
import type { LinkedInProfileFull } from "@/lib/linkedin/profile";
import type { PreferenceEvidence } from "@/lib/social-intelligence/preference-profile";
import { extractSocialArchive } from "@/lib/social-intelligence/archive";
import type { SocialProfileFull } from "@/lib/ria/types";
import { getPrismaClient } from "./prisma";

const USER_NOTIFICATION_TYPE = "scan_user_full_result";
const ADMIN_NOTIFICATION_TYPE = "scan_admin_full_result";

interface UpsertUserInput {
  firebaseUid: string;
  email: string;
  name: string | null;
  photoUrl: string | null;
  /** Identity provider — "linkedin" for the LinkedIn-first flow, else defaults to "google". */
  provider?: string;
}

interface CreateScanInput {
  userId: string;
  mode: string;
  purpose: string;
  input: Prisma.InputJsonValue;
  latitude?: number;
  longitude?: number;
  zipCode?: string;
  ip?: string | null;
  userAgent?: string | null;
}

interface UpsertSocialAccessRequestInput {
  firebaseUid: string;
  platform: string;
  publicId: string;
  profileUrl: string;
  status: string;
  profileSnapshot?: unknown;
  requestedAt?: string | null;
  approvedAt?: string | null;
  lastCheckedAt?: string | null;
  nextCheckAt?: string | null;
  lastError?: string | null;
}

interface SaveChatGptContextSnapshotInput {
  firebaseUid: string;
  summary: string;
  categories: string[];
  userPrompt?: string | null;
  consentText?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface SaveUserPreferenceProfileInput {
  firebaseUid: string;
  scanRunId?: string | null;
  status: string;
  version: string;
  profile: unknown;
  inputHash?: string | null;
  generatedAt?: string | null;
  staleAfter?: string | null;
}

interface LogUserPreferenceRunInput {
  firebaseUid: string;
  scanRunId?: string | null;
  status: string;
  event: string;
  version?: string | null;
  inputHash?: string | null;
  platforms?: unknown;
  counts?: unknown;
  selectedEvidenceIds?: unknown;
  selectedSignalIds?: unknown;
  durationMs?: number | null;
  error?: string | null;
}

interface IndexSocialPreferenceEvidenceInput {
  firebaseUid: string;
  scanRunId?: string | null;
  version: string;
  evidence: PreferenceEvidence[];
}

interface IndexedPreferenceEvidenceResult {
  contentItems: number;
  mediaAssets: number;
}

function hashValue(value?: string | null) {
  if (!value) return null;
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function parseDate(value?: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function publicIdFromEvidence(item: PreferenceEvidence): string {
  const fallback = "visible-feed";
  if (!item.url) return fallback;
  try {
    const url = new URL(item.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (item.platform === "threads") return (parts.find((part) => part.startsWith("@")) || fallback).replace(/^@/, "").toLowerCase();
    if (item.platform === "x") return (parts[0] || fallback).toLowerCase();
    if (item.platform === "instagram" && parts.length === 1) return parts[0].toLowerCase();
    return fallback;
  } catch {
    return fallback;
  }
}

function normalizeSocialPlatform(platform: PreferenceEvidence["platform"]) {
  return platform.trim().toLowerCase();
}

/* Per-phase scan timing + outcome, persisted onto ScanRun for durable, per-user
   reporting (how long Phase-1/Phase-2 took, and why a scan ended). */
export interface ScanTiming {
  phase1Ms?: number | null;
  phase2Ms?: number | null;
  totalMs?: number | null;
  outcome?: string | null; // completed | completed_via_recovery | deadline | failed
  sessionId?: string | null;
  deepResearchJobId?: string | null;
}

function timingData(timing?: ScanTiming): Prisma.ScanRunUpdateInput {
  const d: Prisma.ScanRunUpdateInput = {};
  if (!timing) return d;
  if (typeof timing.phase1Ms === "number") d.phase1Ms = Math.round(timing.phase1Ms);
  if (typeof timing.phase2Ms === "number") d.phase2Ms = Math.round(timing.phase2Ms);
  if (typeof timing.totalMs === "number") d.totalMs = Math.round(timing.totalMs);
  if (timing.outcome) d.outcome = timing.outcome;
  if (timing.sessionId) d.sessionId = timing.sessionId;
  if (timing.deepResearchJobId) d.deepResearchJobId = timing.deepResearchJobId;
  return d;
}

// The timing columns may not be migrated yet in a given environment (the deploy does
// not auto-migrate). A "column does not exist" error (P2022) must NEVER block a scan
// from completing/failing — so callers fall back to a timing-less write in that case.
function isMissingColumn(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "P2022";
}

export async function upsertOneUser(input: UpsertUserInput) {
  const prisma = getPrismaClient();
  if (!prisma) return null;

  return prisma.oneUser.upsert({
    where: { firebaseUid: input.firebaseUid },
    create: {
      firebaseUid: input.firebaseUid,
      email: input.email,
      name: input.name,
      photoUrl: input.photoUrl,
      ...(input.provider ? { provider: input.provider } : {}),
    },
    update: {
      email: input.email,
      name: input.name,
      photoUrl: input.photoUrl,
      ...(input.provider ? { provider: input.provider } : {}),
    },
  });
}

/* ── LinkedIn connection (the MCP "Connect LinkedIn" step) ──────────────────
   Persist the user's FULL LinkedIn profile (1:1 with OneUser) so a returning
   session re-scans with the ground truth without re-logging into LinkedIn. The
   LinkedInConnection table is added by a migration the deploy does NOT auto-run,
   so EVERY call here is fully defensive: a missing table/column (P2021/P2022) or
   any other error returns null and NEVER breaks the connect/sign-in flow (the
   client localStorage cache covers connected-state until the table lands). */
export async function upsertLinkedInConnection(firebaseUid: string, profile: LinkedInProfileFull) {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid }, select: { id: true } });
    if (!user) return null;
    const data = {
      profile: JSON.parse(JSON.stringify(profile)) as Prisma.InputJsonValue,
      publicId: profile.sub || null,
      sessionValid: true,
    };
    return await prisma.linkedInConnection.upsert({
      where: { userId: user.id },
      create: { userId: user.id, ...data },
      update: data,
    });
  } catch {
    return null;
  }
}

export async function getLinkedInConnection(firebaseUid: string): Promise<LinkedInProfileFull | null> {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid }, select: { id: true } });
    if (!user) return null;
    const row = await prisma.linkedInConnection.findUnique({
      where: { userId: user.id },
      select: { profile: true, sessionValid: true },
    });
    if (!row || row.sessionValid === false) return null;
    return (row.profile ?? null) as unknown as LinkedInProfileFull | null;
  } catch {
    return null;
  }
}

export async function deleteLinkedInConnection(firebaseUid: string): Promise<boolean> {
  const prisma = getPrismaClient();
  if (!prisma) return false;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid }, select: { id: true } });
    if (!user) return false;
    await prisma.linkedInConnection.deleteMany({ where: { userId: user.id } });
    return true;
  } catch {
    return false;
  }
}

/* ── Optional social connections (Instagram first) ──────────────────────────
   Defensive for the same reason as LinkedInConnection: migrations may lag deploys,
   and optional social enrichment must never block the mandatory One scan flow. */
export async function upsertSocialConnection(
  firebaseUid: string,
  platform: string,
  publicId: string,
  profile: unknown,
) {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid }, select: { id: true } });
    if (!user) return null;
    const normalizedPlatform = platform.trim().toLowerCase();
    const normalizedPublicId = publicId.trim().toLowerCase();
    if (!normalizedPlatform || !normalizedPublicId) return null;
    const data = {
      platform: normalizedPlatform,
      publicId: normalizedPublicId,
      profile: JSON.parse(JSON.stringify(profile)) as Prisma.InputJsonValue,
      sessionValid: true,
    };
    return await prisma.socialConnection.upsert({
      where: { userId_platform_publicId: { userId: user.id, platform: normalizedPlatform, publicId: normalizedPublicId } },
      create: { userId: user.id, ...data },
      update: data,
    });
  } catch {
    return null;
  }
}

export async function getSocialConnections<TProfile = unknown>(firebaseUid: string, platform?: string): Promise<TProfile[]> {
  const prisma = getPrismaClient();
  if (!prisma) return [];
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid }, select: { id: true } });
    if (!user) return [];
    const rows = await prisma.socialConnection.findMany({
      where: {
        userId: user.id,
        sessionValid: true,
        ...(platform ? { platform: platform.trim().toLowerCase() } : {}),
      },
      select: { profile: true },
      orderBy: { refreshedAt: "desc" },
    });
    return rows.map((row) => row.profile as unknown as TProfile).filter(Boolean);
  } catch {
    return [];
  }
}

export async function upsertSocialAccessRequest(input: UpsertSocialAccessRequestInput) {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid: input.firebaseUid }, select: { id: true } });
    if (!user) return null;
    const platform = input.platform.trim().toLowerCase();
    const publicId = input.publicId.trim().toLowerCase();
    const status = input.status.trim();
    if (!platform || !publicId || !status) return null;
    const now = new Date();
    const id = crypto.randomUUID();
    const profileSnapshot = JSON.stringify(input.profileSnapshot ?? null);
    const requestedAt = input.requestedAt ? new Date(input.requestedAt) : null;
    const approvedAt = input.approvedAt ? new Date(input.approvedAt) : null;
    const lastCheckedAt = input.lastCheckedAt ? new Date(input.lastCheckedAt) : now;
    const nextCheckAt = input.nextCheckAt ? new Date(input.nextCheckAt) : null;
    return await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "SocialAccessRequest" (
        "id", "userId", "platform", "publicId", "profileUrl", "status", "profileSnapshot",
        "requestedAt", "approvedAt", "lastCheckedAt", "nextCheckAt", "attemptCount",
        "lastError", "createdAt", "updatedAt"
      )
      VALUES (
        ${id}::uuid, ${user.id}::uuid, ${platform}, ${publicId}, ${input.profileUrl}, ${status},
        ${profileSnapshot}::jsonb, ${requestedAt}, ${approvedAt}, ${lastCheckedAt}, ${nextCheckAt},
        1, ${input.lastError || null}, ${now}, ${now}
      )
      ON CONFLICT ("userId", "platform", "publicId") DO UPDATE SET
        "profileUrl" = EXCLUDED."profileUrl",
        "status" = EXCLUDED."status",
        "profileSnapshot" = EXCLUDED."profileSnapshot",
        "requestedAt" = COALESCE("SocialAccessRequest"."requestedAt", EXCLUDED."requestedAt"),
        "approvedAt" = COALESCE(EXCLUDED."approvedAt", "SocialAccessRequest"."approvedAt"),
        "lastCheckedAt" = EXCLUDED."lastCheckedAt",
        "nextCheckAt" = EXCLUDED."nextCheckAt",
        "attemptCount" = "SocialAccessRequest"."attemptCount" + 1,
        "lastError" = EXCLUDED."lastError",
        "updatedAt" = EXCLUDED."updatedAt"
      RETURNING "id"
    `;
  } catch {
    return null;
  }
}

export async function saveChatGptContextSnapshot(input: SaveChatGptContextSnapshotInput) {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid: input.firebaseUid }, select: { id: true } });
    if (!user) return null;
    const row = await prisma.chatGptContextSnapshot.create({
      data: {
        userId: user.id,
        summary: input.summary,
        categories: JSON.parse(JSON.stringify(input.categories)) as Prisma.InputJsonValue,
        source: "chatgpt_user_approved_summary",
        capturedVia: "openai_connector",
        userPrompt: input.userPrompt || null,
        consentText: input.consentText || null,
        metadata: input.metadata ? (JSON.parse(JSON.stringify(input.metadata)) as Prisma.InputJsonValue) : undefined,
      },
      select: { id: true, createdAt: true, source: true },
    });
    return { snapshotId: row.id, savedAt: row.createdAt.toISOString(), source: row.source };
  } catch {
    return null;
  }
}

export async function saveUserPreferenceProfile(input: SaveUserPreferenceProfileInput) {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid: input.firebaseUid }, select: { id: true } });
    if (!user) return null;
    const profile = JSON.parse(JSON.stringify(input.profile)) as Prisma.InputJsonValue;
    const generatedAt = input.generatedAt ? new Date(input.generatedAt) : new Date();
    const staleAfter = input.staleAfter ? new Date(input.staleAfter) : null;
    return await prisma.userPreferenceProfile.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        scanRunId: input.scanRunId || null,
        status: input.status,
        version: input.version,
        inputHash: input.inputHash || null,
        profile,
        generatedAt,
        staleAfter,
      },
      update: {
        scanRunId: input.scanRunId || null,
        status: input.status,
        version: input.version,
        inputHash: input.inputHash || null,
        profile,
        generatedAt,
        staleAfter,
      },
      select: { id: true, updatedAt: true },
    });
  } catch {
    return null;
  }
}

export async function getUserPreferenceProfileByInputHash<TProfile = unknown>(
  firebaseUid: string,
  inputHash: string | null,
): Promise<TProfile | null> {
  if (!inputHash) return null;
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid }, select: { id: true } });
    if (!user) return null;
    const row = await prisma.userPreferenceProfile.findFirst({
      where: { userId: user.id, inputHash, status: "completed" },
      select: { profile: true },
      orderBy: { updatedAt: "desc" },
    });
    return (row?.profile ?? null) as unknown as TProfile | null;
  } catch {
    return null;
  }
}

export async function logUserPreferenceRun(input: LogUserPreferenceRunInput) {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid: input.firebaseUid }, select: { id: true } });
    if (!user) return null;
    const json = (value: unknown) => (value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue));
    const row = await prisma.socialPreferenceRunLog.create({
      data: {
        userId: user.id,
        scanRunId: input.scanRunId || null,
        status: input.status,
        event: input.event,
        version: input.version || null,
        inputHash: input.inputHash || null,
        platforms: json(input.platforms),
        counts: json(input.counts),
        selectedEvidenceIds: json(input.selectedEvidenceIds),
        selectedSignalIds: json(input.selectedSignalIds),
        durationMs: typeof input.durationMs === "number" ? Math.round(input.durationMs) : null,
        error: input.error || null,
      },
      select: { id: true, createdAt: true },
    });
    return { id: row.id, createdAt: row.createdAt.toISOString() };
  } catch {
    return null;
  }
}

export async function indexSocialPreferenceEvidence(
  input: IndexSocialPreferenceEvidenceInput,
): Promise<IndexedPreferenceEvidenceResult | null> {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid: input.firebaseUid }, select: { id: true } });
    if (!user) return null;
    let contentItems = 0;
    let mediaAssets = 0;
    for (const item of input.evidence) {
      if (item.platform === "linkedin") continue;
      const platform = normalizeSocialPlatform(item.platform);
      const publicId = publicIdFromEvidence(item);
      const itemId = item.id;
      const assetHash = item.mediaUrl ? crypto.createHash("sha256").update(item.mediaUrl).digest("hex") : null;
      const media = item.mediaUrl
        ? {
            primaryUrl: item.mediaUrl,
            urls: [item.mediaUrl],
            assetHashes: assetHash ? [assetHash] : [],
          }
        : null;
      const features = {
        indexVersion: input.version,
        source: "preference_v2_fast_pass",
        scanRunId: input.scanRunId || null,
        evidenceId: item.id,
        reason: item.reason,
        signals: item.signals,
        contentHash: hashValue([item.text, item.url, item.mediaUrl].filter(Boolean).join("|")),
      };
      await prisma.socialContentItem.upsert({
        where: { userId_platform_itemId: { userId: user.id, platform, itemId } },
        create: {
          userId: user.id,
          platform,
          publicId,
          itemId,
          itemUrl: item.url || `urn:one:evidence:${item.id}`,
          itemType: item.type,
          text: item.text || null,
          timestamp: parseDate(item.timestamp),
          ...(media ? { media: safeJson(media) } : {}),
          metrics: safeJson({}),
          features: safeJson(features),
        },
        update: {
          publicId,
          itemUrl: item.url || `urn:one:evidence:${item.id}`,
          itemType: item.type,
          text: item.text || null,
          timestamp: parseDate(item.timestamp),
          ...(media ? { media: safeJson(media) } : {}),
          metrics: safeJson({}),
          features: safeJson(features),
        },
      });
      contentItems += 1;

      if (item.mediaUrl && assetHash) {
        await prisma.socialMediaAsset.upsert({
          where: { userId_platform_assetHash: { userId: user.id, platform, assetHash } },
          create: {
            userId: user.id,
            platform,
            assetHash,
            sourceUrl: item.mediaUrl,
            mediaType: "image",
            cacheUri: null,
            analysisStatus: "pending",
            analysis: safeJson({
              status: "pending",
              provider: "vertex_gemini_cloud_vision",
              source: "preference_v2_fast_pass",
              preferenceVersion: input.version,
              sourceEvidenceIds: [item.id],
              scanRunId: input.scanRunId || null,
            }),
          },
          // Preserve any completed analysis — only refresh the source URL on re-index so the
          // media worker's results are never reset to pending.
          update: { sourceUrl: item.mediaUrl },
        });
        mediaAssets += 1;
      }
    }
    return { contentItems, mediaAssets };
  } catch {
    return null;
  }
}

/* ── v3 preference archive: full 1024-item capture + read path + media-asset queue ───────────
   The deep-scrape worker calls indexSocialArchive with freshly scraped 1024-deep profiles; the
   synthesis reads back the archive; the media worker drains pending SocialMediaAsset rows. Every
   function is defensive (missing table/column or any error → null/empty, never breaks a scan). */

export interface IndexSocialArchiveResult {
  contentItems: number;
  mediaAssets: number;
  perPlatform: Record<string, { items: number; media: number }>;
}

/** Persist the FULL archive (up to 1024 visible items/profile + their media assets). Media rows
 *  are created `pending`; an existing row's completed analysis is preserved on re-index. */
export async function indexSocialArchive(input: {
  firebaseUid: string;
  scanRunId?: string | null;
  version: string;
  profiles: SocialProfileFull[];
  maxItemsPerProfile?: number;
}): Promise<IndexSocialArchiveResult | null> {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid: input.firebaseUid }, select: { id: true } });
    if (!user) return null;
    const archive = extractSocialArchive(input.profiles, { maxItemsPerProfile: input.maxItemsPerProfile });
    let contentItems = 0;
    for (const row of archive.content) {
      try {
        await prisma.socialContentItem.upsert({
          where: { userId_platform_itemId: { userId: user.id, platform: row.platform, itemId: row.itemId } },
          create: {
            userId: user.id,
            platform: row.platform,
            publicId: row.publicId,
            itemId: row.itemId,
            itemUrl: row.itemUrl,
            itemType: row.itemType,
            text: row.text,
            timestamp: parseDate(row.timestamp),
            ...(row.media ? { media: safeJson(row.media) } : {}),
            ...(row.metrics ? { metrics: safeJson(row.metrics) } : {}),
            features: safeJson({ indexVersion: input.version, source: "preference_v3_archive", scanRunId: input.scanRunId || null }),
          },
          update: {
            publicId: row.publicId,
            itemUrl: row.itemUrl,
            itemType: row.itemType,
            text: row.text,
            timestamp: parseDate(row.timestamp),
            ...(row.media ? { media: safeJson(row.media) } : {}),
            ...(row.metrics ? { metrics: safeJson(row.metrics) } : {}),
          },
        });
        contentItems += 1;
      } catch {
        /* skip a malformed row, keep indexing the rest */
      }
    }
    let mediaAssets = 0;
    for (const asset of archive.media) {
      try {
        await prisma.socialMediaAsset.upsert({
          where: { userId_platform_assetHash: { userId: user.id, platform: asset.platform, assetHash: asset.assetHash } },
          create: {
            userId: user.id,
            platform: asset.platform,
            assetHash: asset.assetHash,
            sourceUrl: asset.sourceUrl,
            mediaType: asset.mediaType,
            analysisStatus: "pending",
            analysis: safeJson({ status: "pending", source: "preference_v3_archive", scanRunId: input.scanRunId || null }),
          },
          // Preserve completed analysis on re-index — only refresh the source URL + media type.
          update: { sourceUrl: asset.sourceUrl, mediaType: asset.mediaType },
        });
        mediaAssets += 1;
      } catch {
        /* skip */
      }
    }
    return { contentItems, mediaAssets, perPlatform: archive.perPlatform };
  } catch {
    return null;
  }
}

export interface ArchiveDepthSummary {
  perPlatform: Record<string, { items: number; mediaTotal: number; mediaAnalyzed: number; mediaPending: number; mediaFailed: number }>;
  totals: { items: number; mediaTotal: number; mediaAnalyzed: number; mediaPending: number };
}

/** Per-platform archive depth for the dashboard + synthesis gating (how many items indexed,
 *  how much media analyzed vs pending). */
export async function getArchiveDepthSummary(firebaseUid: string): Promise<ArchiveDepthSummary | null> {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid }, select: { id: true } });
    if (!user) return null;
    const empty = () => ({ items: 0, mediaTotal: 0, mediaAnalyzed: 0, mediaPending: 0, mediaFailed: 0 });
    const [contentGroups, mediaGroups] = await Promise.all([
      prisma.socialContentItem.groupBy({ by: ["platform"], where: { userId: user.id }, _count: { _all: true } }),
      prisma.socialMediaAsset.groupBy({ by: ["platform", "analysisStatus"], where: { userId: user.id }, _count: { _all: true } }),
    ]);
    const perPlatform: ArchiveDepthSummary["perPlatform"] = {};
    for (const group of contentGroups) {
      (perPlatform[group.platform] ??= empty()).items = group._count._all;
    }
    for (const group of mediaGroups) {
      const bucket = (perPlatform[group.platform] ??= empty());
      bucket.mediaTotal += group._count._all;
      if (group.analysisStatus === "completed") bucket.mediaAnalyzed += group._count._all;
      else if (group.analysisStatus === "failed") bucket.mediaFailed += group._count._all;
      else bucket.mediaPending += group._count._all; // pending | processing | skipped
    }
    const totals = Object.values(perPlatform).reduce(
      (acc, p) => ({
        items: acc.items + p.items,
        mediaTotal: acc.mediaTotal + p.mediaTotal,
        mediaAnalyzed: acc.mediaAnalyzed + p.mediaAnalyzed,
        mediaPending: acc.mediaPending + p.mediaPending,
      }),
      { items: 0, mediaTotal: 0, mediaAnalyzed: 0, mediaPending: 0 },
    );
    return { perPlatform, totals };
  } catch {
    return null;
  }
}

export interface ArchiveContentRecord {
  platform: string;
  publicId: string;
  itemId: string;
  itemUrl: string;
  itemType: string;
  text: string | null;
  timestamp: string | null;
  media: unknown;
  metrics: unknown;
}

/** Read indexed content items back for synthesis (newest first). */
export async function getSocialContentItems(
  firebaseUid: string,
  opts: { platform?: string; limit?: number } = {},
): Promise<ArchiveContentRecord[]> {
  const prisma = getPrismaClient();
  if (!prisma) return [];
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid }, select: { id: true } });
    if (!user) return [];
    const rows = await prisma.socialContentItem.findMany({
      where: { userId: user.id, ...(opts.platform ? { platform: opts.platform } : {}) },
      orderBy: [{ timestamp: "desc" }, { lastSeenAt: "desc" }],
      take: Math.max(1, Math.min(opts.limit ?? 1024, 4096)),
    });
    return rows.map((r) => ({
      platform: r.platform,
      publicId: r.publicId,
      itemId: r.itemId,
      itemUrl: r.itemUrl,
      itemType: r.itemType,
      text: r.text,
      timestamp: r.timestamp ? r.timestamp.toISOString() : null,
      media: r.media,
      metrics: r.metrics,
    }));
  } catch {
    return [];
  }
}

export interface PendingMediaAsset {
  id: string;
  platform: string;
  assetHash: string;
  sourceUrl: string;
  mediaType: string;
}

/** Claim a batch of unanalyzed media assets for the media worker. */
export async function getPendingMediaAssets(firebaseUid: string, opts: { limit?: number } = {}): Promise<PendingMediaAsset[]> {
  const prisma = getPrismaClient();
  if (!prisma) return [];
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid }, select: { id: true } });
    if (!user) return [];
    const rows = await prisma.socialMediaAsset.findMany({
      where: { userId: user.id, analysisStatus: "pending" },
      orderBy: { lastSeenAt: "desc" },
      take: Math.max(1, Math.min(opts.limit ?? 32, 256)),
    });
    return rows.map((r) => ({ id: r.id, platform: r.platform, assetHash: r.assetHash, sourceUrl: r.sourceUrl, mediaType: r.mediaType }));
  } catch {
    return [];
  }
}

/** Persist a media-analysis result (or failure) for one asset. */
export async function updateMediaAssetAnalysis(input: {
  assetId: string;
  analysisStatus: "processing" | "completed" | "failed" | "skipped";
  analysis?: unknown;
  analysisModel?: string | null;
  analysisVersion?: string | null;
  analysisError?: string | null;
}): Promise<boolean> {
  const prisma = getPrismaClient();
  if (!prisma) return false;
  try {
    await prisma.socialMediaAsset.update({
      where: { id: input.assetId },
      data: {
        analysisStatus: input.analysisStatus,
        ...(input.analysis !== undefined ? { analysis: safeJson(input.analysis) } : {}),
        ...(input.analysisModel !== undefined ? { analysisModel: input.analysisModel } : {}),
        ...(input.analysisVersion !== undefined ? { analysisVersion: input.analysisVersion } : {}),
        ...(input.analysisError !== undefined ? { analysisError: input.analysisError } : {}),
        ...(input.analysisStatus === "completed" || input.analysisStatus === "failed" ? { lastAnalyzedAt: new Date() } : {}),
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** The user's current stored preference profile (latest, by userId) — used to serve the v3
 *  synthesis once the worker has produced it. */
export async function getUserPreferenceProfile<TProfile = unknown>(
  firebaseUid: string,
): Promise<{ status: string; version: string; profile: TProfile } | null> {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid }, select: { id: true } });
    if (!user) return null;
    const row = await prisma.userPreferenceProfile.findUnique({
      where: { userId: user.id },
      select: { status: true, version: true, profile: true },
    });
    if (!row) return null;
    return { status: row.status, version: row.version, profile: row.profile as TProfile };
  } catch {
    return null;
  }
}

/** True while the user has deep-archive or recompute jobs still queued/processing — the dashboard
 *  keeps the preference layer "running" so the client poll picks up the v3 upgrade. */
export async function hasPendingPreferenceWork(firebaseUid: string): Promise<boolean> {
  const prisma = getPrismaClient();
  if (!prisma) return false;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid }, select: { id: true } });
    if (!user) return false;
    const pending = await prisma.socialRefreshJob.count({
      where: { userId: user.id, status: { in: ["queued", "processing"] } },
    });
    return pending > 0;
  } catch {
    return false;
  }
}

/* ── SocialRefreshJob queue: deep-scrape + recompute jobs drained by the worker ─────────────── */

export interface ClaimedRefreshJob {
  id: string;
  firebaseUid: string | null;
  platform: string;
  publicId: string;
  metadata: unknown;
  attempts: number;
}

/** Sentinel "platform" for a preference-recompute job (reuses the SocialRefreshJob queue). */
export const PREFERENCE_RECOMPUTE_PLATFORM = "__recompute__";

/** Enqueue (or re-arm) one deep-archive refresh job per connected platform. */
export async function enqueueSocialRefreshJobs(input: {
  firebaseUid: string;
  jobs: Array<{ platform: string; publicId: string; metadata?: unknown; priority?: number; resetAttempts?: boolean }>;
}): Promise<number> {
  const prisma = getPrismaClient();
  if (!prisma) return 0;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid: input.firebaseUid }, select: { id: true } });
    if (!user) return 0;
    let count = 0;
    for (const job of input.jobs) {
      try {
        const existing = await prisma.socialRefreshJob.findFirst({
          where: { userId: user.id, platform: job.platform, publicId: job.publicId },
          select: { id: true },
        });
        if (existing) {
          await prisma.socialRefreshJob.update({
            where: { id: existing.id },
            data: {
              status: "queued",
              nextRunAt: new Date(),
              lockedAt: null,
              lastError: null,
              // Staged grow re-enqueues set this so the climbing 240→1024 ladder doesn't exhaust the
              // 5-attempt budget (every claim increments attempts) and die before reaching the ceiling.
              ...(job.resetAttempts ? { attempts: 0 } : {}),
              ...(job.metadata !== undefined ? { metadata: safeJson(job.metadata) } : {}),
              ...(typeof job.priority === "number" ? { priority: job.priority } : {}),
            },
          });
        } else {
          await prisma.socialRefreshJob.create({
            data: {
              userId: user.id,
              platform: job.platform,
              publicId: job.publicId,
              status: "queued",
              priority: job.priority ?? 0,
              ...(job.metadata !== undefined ? { metadata: safeJson(job.metadata) } : {}),
            },
          });
        }
        count += 1;
      } catch {
        /* skip a bad job, enqueue the rest */
      }
    }
    return count;
  } catch {
    return 0;
  }
}

/** Atomically claim due queued jobs (optimistic lock; safe under the worker's low concurrency).
 *  `opts.platforms` / `opts.excludePlatforms` partition deep-scrape jobs from recompute jobs. */
export async function claimSocialRefreshJobs(
  limit = 4,
  opts: { platforms?: string[]; excludePlatforms?: string[] } = {},
): Promise<ClaimedRefreshJob[]> {
  const prisma = getPrismaClient();
  if (!prisma) return [];
  try {
    const now = new Date();
    const candidates = await prisma.socialRefreshJob.findMany({
      where: {
        status: "queued",
        nextRunAt: { lte: now },
        ...(opts.platforms ? { platform: { in: opts.platforms } } : {}),
        ...(opts.excludePlatforms ? { platform: { notIn: opts.excludePlatforms } } : {}),
      },
      orderBy: [{ priority: "desc" }, { nextRunAt: "asc" }],
      take: Math.max(1, Math.min(limit, 32)),
      include: { user: { select: { firebaseUid: true } } },
    });
    const claimed: ClaimedRefreshJob[] = [];
    for (const job of candidates) {
      try {
        const res = await prisma.socialRefreshJob.updateMany({
          where: { id: job.id, status: "queued" },
          data: { status: "processing", lockedAt: now, attempts: { increment: 1 } },
        });
        if (res.count === 1) {
          claimed.push({
            id: job.id,
            firebaseUid: job.user?.firebaseUid ?? null,
            platform: job.platform,
            publicId: job.publicId,
            metadata: job.metadata,
            attempts: job.attempts + 1,
          });
        }
      } catch {
        /* lost the race for this row */
      }
    }
    return claimed;
  } catch {
    return [];
  }
}

/** Claim a global batch of unanalyzed media assets for the Scheduler-driven media worker. Marks each
 *  "processing" so concurrent invocations don't double-pay. Returns the owner's firebaseUid too. */
export async function claimPendingMediaAssetsGlobal(
  limit = 8,
): Promise<Array<{ id: string; firebaseUid: string | null; platform: string; assetHash: string; sourceUrl: string; mediaType: string }>> {
  const prisma = getPrismaClient();
  if (!prisma) return [];
  try {
    const candidates = await prisma.socialMediaAsset.findMany({
      where: { analysisStatus: "pending" },
      orderBy: { lastSeenAt: "desc" },
      take: Math.max(1, Math.min(limit, 64)),
      include: { user: { select: { firebaseUid: true } } },
    });
    const claimed: Array<{ id: string; firebaseUid: string | null; platform: string; assetHash: string; sourceUrl: string; mediaType: string }> = [];
    for (const asset of candidates) {
      try {
        const res = await prisma.socialMediaAsset.updateMany({
          where: { id: asset.id, analysisStatus: "pending" },
          data: { analysisStatus: "processing" },
        });
        if (res.count === 1) {
          claimed.push({
            id: asset.id,
            firebaseUid: asset.user?.firebaseUid ?? null,
            platform: asset.platform,
            assetHash: asset.assetHash,
            sourceUrl: asset.sourceUrl,
            mediaType: asset.mediaType,
          });
        }
      } catch {
        /* lost the race */
      }
    }
    return claimed;
  } catch {
    return [];
  }
}

/** Completed media analyses for one user — input to preference synthesis. */
export async function getCompletedMediaAnalyses(
  firebaseUid: string,
  opts: { limit?: number } = {},
): Promise<Array<{ platform: string; assetHash: string; sourceUrl: string; analysis: unknown }>> {
  const prisma = getPrismaClient();
  if (!prisma) return [];
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid }, select: { id: true } });
    if (!user) return [];
    const rows = await prisma.socialMediaAsset.findMany({
      where: { userId: user.id, analysisStatus: "completed" },
      orderBy: { lastAnalyzedAt: "desc" },
      take: Math.max(1, Math.min(opts.limit ?? 1024, 4096)),
    });
    return rows.map((r) => ({ platform: r.platform, assetHash: r.assetHash, sourceUrl: r.sourceUrl, analysis: r.analysis }));
  } catch {
    return [];
  }
}

export async function completeSocialRefreshJob(id: string): Promise<void> {
  const prisma = getPrismaClient();
  if (!prisma) return;
  try {
    await prisma.socialRefreshJob.update({ where: { id }, data: { status: "completed", lockedAt: null, lastError: null } });
  } catch {
    /* ignore */
  }
}

/** Mark a job failed; retry with backoff until the attempt ceiling, then give up. */
export async function failSocialRefreshJob(id: string, error: string, retryInMs = 5 * 60_000): Promise<void> {
  const prisma = getPrismaClient();
  if (!prisma) return;
  try {
    const job = await prisma.socialRefreshJob.findUnique({ where: { id }, select: { attempts: true } });
    const giveUp = (job?.attempts ?? 0) >= 5;
    await prisma.socialRefreshJob.update({
      where: { id },
      data: {
        status: giveUp ? "failed" : "queued",
        lockedAt: null,
        lastError: error.slice(0, 500),
        nextRunAt: new Date(Date.now() + retryInMs),
      },
    });
  } catch {
    /* ignore */
  }
}

export async function createConsentAndScan(input: CreateScanInput) {
  const prisma = getPrismaClient();
  if (!prisma) return { scanRunId: null };

  const scan = await prisma.$transaction(async (tx) => {
    await tx.consentEvent.create({
      data: {
        userId: input.userId,
        purpose: input.purpose,
        consentVersion: process.env.ONE_CONSENT_VERSION || "2026-06-12-mcp-linkedin",
        locationMode: input.mode,
        latitude: input.latitude,
        longitude: input.longitude,
        zipCode: input.zipCode,
        ipHash: hashValue(input.ip),
        userAgentHash: hashValue(input.userAgent),
      },
    });

    return tx.scanRun.create({
      data: {
        userId: input.userId,
        mode: input.mode,
        purpose: input.purpose,
        input: input.input,
      },
    });
  });

  return { scanRunId: scan.id };
}

export async function completeScanRun(
  scanRunId: string | null,
  data: Prisma.InputJsonValue,
  summary?: string,
  timing?: ScanTiming,
) {
  const prisma = getPrismaClient();
  if (!prisma || !scanRunId) return;
  const base: Prisma.ScanRunUpdateInput = {
    status: "completed",
    normalizedResult: data,
    summary,
    completedAt: new Date(),
  };
  try {
    await prisma.scanRun.update({ where: { id: scanRunId }, data: { ...base, ...timingData({ outcome: "completed", ...timing }) } });
  } catch (error) {
    if (!isMissingColumn(error)) throw error;
    console.warn(JSON.stringify({ event: "one.scan.timing_columns_missing", scanRunId, where: "complete" }));
    await prisma.scanRun.update({ where: { id: scanRunId }, data: base });
  }
}

export async function failScanRun(scanRunId: string | null, message: string, timing?: ScanTiming) {
  const prisma = getPrismaClient();
  if (!prisma || !scanRunId) return;
  const base: Prisma.ScanRunUpdateInput = {
    status: "failed",
    error: message,
    completedAt: new Date(),
  };
  try {
    await prisma.scanRun.update({ where: { id: scanRunId }, data: { ...base, ...timingData({ outcome: "failed", ...timing }) } });
  } catch (error) {
    if (!isMissingColumn(error)) throw error;
    console.warn(JSON.stringify({ event: "one.scan.timing_columns_missing", scanRunId, where: "fail" }));
    await prisma.scanRun.update({ where: { id: scanRunId }, data: base });
  }
}

/* Record a deadline handoff: the streamed request hit our soft deadline before the
   job finished. Status stays "running" (recovery will resume + finalize), so we only
   stamp the timing/outcome for observability. Best-effort — must never break the
   handoff, so all errors are swallowed. */
export async function recordScanDeadline(scanRunId: string | null, timing: ScanTiming) {
  const prisma = getPrismaClient();
  if (!prisma || !scanRunId) return;
  try {
    await prisma.scanRun.update({ where: { id: scanRunId }, data: timingData({ outcome: "deadline", ...timing }) });
  } catch (error) {
    if (!isMissingColumn(error)) {
      console.warn(
        JSON.stringify({
          event: "one.scan.deadline_persist_failed",
          scanRunId,
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
  }
}

/* Recovery net for a dropped result stream: return the saved scan only if it
   belongs to the requesting user. Returns null when the DB is unset or the scan
   isn't owned/found. */
export async function getOwnedScanRun(firebaseUid: string, scanRunId: string) {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid }, select: { id: true } });
    if (!user) return null;
    return await prisma.scanRun.findFirst({
      where: { id: scanRunId, userId: user.id },
      select: { id: true, status: true, normalizedResult: true, error: true },
    });
  } catch {
    return null;
  }
}

/* Like getOwnedScanRun but also returns the stored input (which carries the
   Deep Research jobId) and userId, so the research poll route can resume the
   upstream job and attribute the result. Null when unset/unowned. */
export async function getResearchJob(firebaseUid: string, scanRunId: string) {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid }, select: { id: true } });
    if (!user) return null;
    const scan = await prisma.scanRun.findFirst({
      where: { id: scanRunId, userId: user.id },
      // NOTE: only select columns guaranteed to exist (createdAt is from the init
      // migration). Don't select the new timing columns here — they may be unmigrated
      // in some envs and a missing-column read would throw and break recovery.
      select: { status: true, normalizedResult: true, error: true, input: true, createdAt: true },
    });
    if (!scan) return null;
    return { ...scan, userId: user.id };
  } catch {
    return null;
  }
}

/* Progressive Tier-2 / image tier: merge fields into a COMPLETED scan's normalizedResult
   (schemaless jsonb — no migration). ATOMIC top-level merge via the Postgres `||` operator
   in a single statement (NOT read-modify-write), so the /deep and /image pollers — which
   write concurrently to the SAME blob — can't clobber each other's keys (lost-update race).
   Returns the merged result (so the route can echo it to the client) or null on any miss. */
export async function updateDeepTier(
  firebaseUid: string,
  scanRunId: string,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const patch = JSON.stringify(fields);
    const rows = await prisma.$queryRaw<Array<{ normalizedResult: Record<string, unknown> | null }>>`
      UPDATE "ScanRun" sr
      SET "normalizedResult" = sr."normalizedResult" || ${patch}::jsonb
      FROM "OneUser" u
      WHERE sr."id" = ${scanRunId}::uuid
        AND sr."userId" = u."id"
        AND u."firebaseUid" = ${firebaseUid}
        AND sr."normalizedResult" IS NOT NULL
        AND jsonb_typeof(sr."normalizedResult") = 'object'
      RETURNING sr."normalizedResult" AS "normalizedResult"
    `;
    return rows[0]?.normalizedResult ?? null;
  } catch {
    return null;
  }
}

/* Full account deletion. Removing the OneUser cascades (per schema) to its
   consent events, scan runs — and through them audit jobs and notifications —
   and data requests. Returns false when the DB is unset or the user was already
   gone (P2025), true on a real delete. Other DB errors bubble so the caller
   never reports a fake success. */
export async function deleteOneUser(firebaseUid: string): Promise<boolean> {
  const prisma = getPrismaClient();
  if (!prisma) return false;
  try {
    await prisma.oneUser.delete({ where: { firebaseUid } });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "P2025") return false; // already deleted
    throw error;
  }
}

/* The user's most recent scan (running or completed), so the client can
   re-attach after a full app close when it has no local scan id. Uses the
   [userId, createdAt] index. Null when the DB is unset, the user is unknown,
   or there are no scans. */
export async function getLatestScanForUser(firebaseUid: string) {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid }, select: { id: true } });
    if (!user) return null;
    return await prisma.scanRun.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, normalizedResult: true, error: true, createdAt: true },
    });
  } catch {
    return null;
  }
}

/* Reconstruct the email-delivery summary for a completed scan from the persisted
   OneNotification rows, so a RECOVERED dashboard (dropped stream / app re-open) can
   still show the "emailed to you" banner — the live send only runs once, in the
   streaming POST route. Null when the DB is unset, unowned, or nothing was logged
   (e.g. a scan finalized on the resume path, which doesn't send email). */
export async function getScanEmailDelivery(
  firebaseUid: string,
  scanRunId: string,
): Promise<ScanEmailDeliverySummary | null> {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    const user = await prisma.oneUser.findUnique({ where: { firebaseUid }, select: { id: true } });
    if (!user) return null;
    const owns = await prisma.scanRun.findFirst({ where: { id: scanRunId, userId: user.id }, select: { id: true } });
    if (!owns) return null;

    const rows = await prisma.oneNotification.findMany({
      where: { scanRunId, notificationType: { in: [USER_NOTIFICATION_TYPE, ADMIN_NOTIFICATION_TYPE] } },
      select: { notificationType: true, recipientEmail: true, status: true, providerMessageId: true, errorMessage: true },
    });
    if (!rows.length) return null;

    const audience = (type: string): ScanEmailAudienceDelivery => {
      const recipients = rows
        .filter((row) => row.notificationType === type)
        .map((row) => ({
          recipient: row.recipientEmail,
          status: (row.status === "sent" ? "sent" : "failed") as "sent" | "failed" | "skipped",
          messageId: row.providerMessageId ?? null,
          error: row.errorMessage ?? null,
        }));
      const status: ScanEmailAudienceDelivery["status"] = !recipients.length
        ? "skipped"
        : recipients.every((r) => r.status === "sent")
          ? "sent"
          : recipients.every((r) => r.status === "failed")
            ? "failed"
            : "partial";
      return { status, recipients, error: status === "sent" ? null : recipients.find((r) => r.error)?.error ?? null };
    };

    return { user: audience(USER_NOTIFICATION_TYPE), admins: audience(ADMIN_NOTIFICATION_TYPE) };
  } catch {
    return null;
  }
}

export interface ConnectorSearchResult {
  id: string;
  title: string;
  url: string;
  text: string;
  metadata?: Record<string, unknown>;
}

function compactJsonText(value: unknown, max = 4000): string {
  try {
    return JSON.stringify(value, null, 2).replace(/\s+/g, " ").trim().slice(0, max);
  } catch {
    return "";
  }
}

function connectorRecordUrl(id: string) {
  return `https://one.hushh.ai/connector/records/${encodeURIComponent(id)}`;
}

export async function getConnectorAccountBundle(firebaseUid: string) {
  const prisma = getPrismaClient();
  if (!prisma) return null;
  try {
    return await prisma.oneUser.findUnique({
      where: { firebaseUid },
      select: {
        firebaseUid: true,
        email: true,
        name: true,
        photoUrl: true,
        linkedInConnection: { select: { publicId: true, profile: true, sessionValid: true, refreshedAt: true } },
        socialConnections: {
          where: { sessionValid: true },
          select: { platform: true, publicId: true, profile: true, refreshedAt: true },
          orderBy: { refreshedAt: "desc" },
          take: 10,
        },
        socialAccessRequests: {
          select: {
            platform: true,
            publicId: true,
            profileUrl: true,
            status: true,
            profileSnapshot: true,
            requestedAt: true,
            approvedAt: true,
            lastCheckedAt: true,
            nextCheckAt: true,
            attemptCount: true,
            lastError: true,
          },
          orderBy: { updatedAt: "desc" },
          take: 20,
        },
        chatGptContextSnapshots: {
          select: {
            id: true,
            summary: true,
            categories: true,
            source: true,
            capturedVia: true,
            userPrompt: true,
            consentText: true,
            metadata: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: 20,
        },
        scanRuns: {
          select: {
            id: true,
            status: true,
            mode: true,
            purpose: true,
            input: true,
            normalizedResult: true,
            summary: true,
            error: true,
            createdAt: true,
            completedAt: true,
            phase1Ms: true,
            phase2Ms: true,
            totalMs: true,
            outcome: true,
          },
          orderBy: { createdAt: "desc" },
          take: 20,
        },
      },
    });
  } catch {
    return null;
  }
}

export async function searchConnectorRecords(
  firebaseUid: string,
  query: string,
  type?: string,
  limit = 10,
): Promise<ConnectorSearchResult[]> {
  const bundle = await getConnectorAccountBundle(firebaseUid);
  if (!bundle) return [];
  const needle = query.trim().toLowerCase();
  const max = Math.max(1, Math.min(Math.round(limit) || 10, 20));
  const out: ConnectorSearchResult[] = [];
  const push = (record: ConnectorSearchResult, searchable: unknown, recordType: string) => {
    if (type && type !== "all" && type !== recordType) return;
    const haystack = `${record.title} ${record.text} ${compactJsonText(searchable, 2000)}`.toLowerCase();
    if (needle && !haystack.includes(needle)) return;
    out.push(record);
  };

  push(
    {
      id: "account:me",
      title: "one by hushh account context",
      url: connectorRecordUrl("account:me"),
      text: `${bundle.name || bundle.email} has ${bundle.linkedInConnection ? "a LinkedIn profile" : "no LinkedIn profile"} and ${bundle.socialConnections.length} social profile(s).`,
      metadata: { type: "account", email: bundle.email },
    },
    bundle,
    "account",
  );

  if (bundle.linkedInConnection?.profile && bundle.linkedInConnection.sessionValid !== false) {
    const profile = bundle.linkedInConnection.profile as Record<string, unknown>;
    const title = typeof profile.name === "string" ? profile.name : "LinkedIn profile";
    push(
      {
        id: "linkedin:profile",
        title: `LinkedIn profile: ${title}`,
        url: connectorRecordUrl("linkedin:profile"),
        text: compactJsonText(profile, 1800),
        metadata: { type: "linkedin", publicId: bundle.linkedInConnection.publicId },
      },
      profile,
      "linkedin",
    );
  }

  for (const social of bundle.socialConnections) {
    const profile = social.profile as Record<string, unknown>;
    const id = `${social.platform}:${social.publicId}`;
    push(
      {
        id,
        title: `${social.platform} profile: ${social.publicId}`,
        url: connectorRecordUrl(id),
        text: compactJsonText(profile, 1800),
        metadata: { type: "social", platform: social.platform, publicId: social.publicId },
      },
      profile,
      "social",
    );
  }

  for (const access of bundle.socialAccessRequests) {
    const id = `social-access:${access.platform}:${access.publicId}`;
    push(
      {
        id,
        title: `${access.platform} access state: ${access.publicId}`,
        url: connectorRecordUrl(id),
        text: `${access.status}${access.lastError ? `: ${access.lastError}` : ""}`,
        metadata: { type: "social_access", platform: access.platform, publicId: access.publicId, status: access.status },
      },
      access,
      "social_access",
    );
  }

  for (const scan of bundle.scanRuns) {
    const id = `scan:${scan.id}`;
    push(
      {
        id,
        title: `One scan ${scan.status}: ${scan.createdAt.toISOString()}`,
        url: connectorRecordUrl(id),
        text: scan.summary || compactJsonText(scan.normalizedResult ?? scan.input, 1800) || scan.error || scan.status,
        metadata: { type: "scan", scanRunId: scan.id, status: scan.status, createdAt: scan.createdAt.toISOString() },
      },
      scan,
      "scan",
    );
  }

  for (const snapshot of bundle.chatGptContextSnapshots) {
    const id = `chatgpt-context:${snapshot.id}`;
    push(
      {
        id,
        title: `ChatGPT context import: ${snapshot.createdAt.toISOString()}`,
        url: connectorRecordUrl(id),
        text: snapshot.summary,
        metadata: {
          type: "chatgpt_context",
          snapshotId: snapshot.id,
          source: snapshot.source,
          capturedVia: snapshot.capturedVia,
          createdAt: snapshot.createdAt.toISOString(),
          categories: snapshot.categories,
        },
      },
      snapshot,
      "chatgpt_context",
    );
  }
  return out.slice(0, max);
}

export async function fetchConnectorRecord(firebaseUid: string, id: string): Promise<ConnectorSearchResult | null> {
  const bundle = await getConnectorAccountBundle(firebaseUid);
  if (!bundle) return null;
  if (id === "account:me") {
    return {
      id,
      title: "one by hushh account context",
      url: connectorRecordUrl(id),
      text: compactJsonText({
        email: bundle.email,
        name: bundle.name,
        linkedInConnected: Boolean(bundle.linkedInConnection?.profile && bundle.linkedInConnection.sessionValid !== false),
        socialProfiles: bundle.socialConnections.map((row) => ({ platform: row.platform, publicId: row.publicId })),
        socialAccessRequests: bundle.socialAccessRequests.map((row) => ({
          platform: row.platform,
          publicId: row.publicId,
          status: row.status,
          nextCheckAt: row.nextCheckAt,
        })),
        chatGptContextImports: bundle.chatGptContextSnapshots.map((row) => ({
          snapshotId: row.id,
          createdAt: row.createdAt,
          source: row.source,
          categories: row.categories,
        })),
        latestScan: bundle.scanRuns[0]
          ? { scanRunId: bundle.scanRuns[0].id, status: bundle.scanRuns[0].status, createdAt: bundle.scanRuns[0].createdAt }
          : null,
      }),
      metadata: { type: "account", email: bundle.email },
    };
  }
  if (id === "linkedin:profile" && bundle.linkedInConnection?.profile && bundle.linkedInConnection.sessionValid !== false) {
    return {
      id,
      title: "LinkedIn profile",
      url: connectorRecordUrl(id),
      text: compactJsonText(bundle.linkedInConnection.profile, 6000),
      metadata: { type: "linkedin", publicId: bundle.linkedInConnection.publicId },
    };
  }
  if (id.startsWith("scan:")) {
    const scanRunId = id.slice("scan:".length);
    const scan = bundle.scanRuns.find((row) => row.id === scanRunId);
    if (!scan) return null;
    return {
      id,
      title: `One scan ${scan.status}: ${scan.createdAt.toISOString()}`,
      url: connectorRecordUrl(id),
      text: compactJsonText(
        {
          status: scan.status,
          mode: scan.mode,
          purpose: scan.purpose,
          summary: scan.summary,
          result: scan.normalizedResult,
          error: scan.error,
          createdAt: scan.createdAt,
          completedAt: scan.completedAt,
          timing: { phase1Ms: scan.phase1Ms, phase2Ms: scan.phase2Ms, totalMs: scan.totalMs, outcome: scan.outcome },
        },
        12000,
      ),
      metadata: { type: "scan", scanRunId: scan.id, status: scan.status },
    };
  }
  if (id.startsWith("chatgpt-context:")) {
    const snapshotId = id.slice("chatgpt-context:".length);
    const snapshot = bundle.chatGptContextSnapshots.find((row) => row.id === snapshotId);
    if (!snapshot) return null;
    return {
      id,
      title: `ChatGPT context import: ${snapshot.createdAt.toISOString()}`,
      url: connectorRecordUrl(id),
      text: compactJsonText(
        {
          summary: snapshot.summary,
          categories: snapshot.categories,
          source: snapshot.source,
          capturedVia: snapshot.capturedVia,
          userPrompt: snapshot.userPrompt,
          consentText: snapshot.consentText,
          metadata: snapshot.metadata,
          createdAt: snapshot.createdAt,
          updatedAt: snapshot.updatedAt,
        },
        8000,
      ),
      metadata: {
        type: "chatgpt_context",
        snapshotId: snapshot.id,
        source: snapshot.source,
        capturedVia: snapshot.capturedVia,
        createdAt: snapshot.createdAt.toISOString(),
      },
    };
  }
  if (id.startsWith("social-access:")) {
    const [, platform, publicId] = id.split(":");
    const access = bundle.socialAccessRequests.find((row) => row.platform === platform && row.publicId === publicId);
    if (!access) return null;
    return {
      id,
      title: `${platform} access state: ${publicId}`,
      url: connectorRecordUrl(id),
      text: compactJsonText(access, 5000),
      metadata: { type: "social_access", platform, publicId, status: access.status },
    };
  }
  const [platform, publicId] = id.split(":");
  const social = bundle.socialConnections.find((row) => row.platform === platform && row.publicId === publicId);
  if (!social) return null;
  return {
    id,
    title: `${platform} profile: ${publicId}`,
    url: connectorRecordUrl(id),
    text: compactJsonText(social.profile, 8000),
    metadata: { type: "social", platform, publicId },
  };
}

export async function createAuditJob(params: {
  scanRunId: string | null;
  upstreamJobId?: string | null;
  status?: string;
  totalShards?: number;
  completedShards?: number;
  failedShards?: number;
  reportAvailable?: boolean;
  errors?: string[];
}) {
  const prisma = getPrismaClient();
  if (!prisma || !params.scanRunId || !params.upstreamJobId) return null;

  const audit = await prisma.auditJob.upsert({
    where: { upstreamJobId: params.upstreamJobId },
    create: {
      scanRunId: params.scanRunId,
      upstreamJobId: params.upstreamJobId,
      status: params.status || "running",
      totalShards: params.totalShards || 0,
      completedShards: params.completedShards || 0,
      failedShards: params.failedShards || 0,
      reportAvailable: Boolean(params.reportAvailable),
      errors: params.errors || [],
    },
    update: {
      status: params.status || "running",
      totalShards: params.totalShards || 0,
      completedShards: params.completedShards || 0,
      failedShards: params.failedShards || 0,
      reportAvailable: Boolean(params.reportAvailable),
      errors: params.errors || [],
    },
  });

  return audit.id;
}
