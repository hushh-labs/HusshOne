-- Preference Intelligence v3: queryable media-analysis lifecycle on SocialMediaAsset.
-- The rich result still lives in "analysis" (JSONB); these columns let the media worker
-- scan and claim pending rows by column. Idempotent so it is safe if deploys lag.

ALTER TABLE "SocialMediaAsset" ADD COLUMN IF NOT EXISTS "mediaType" TEXT NOT NULL DEFAULT 'image';
ALTER TABLE "SocialMediaAsset" ADD COLUMN IF NOT EXISTS "analysisStatus" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "SocialMediaAsset" ADD COLUMN IF NOT EXISTS "analysisVersion" TEXT;
ALTER TABLE "SocialMediaAsset" ADD COLUMN IF NOT EXISTS "analysisModel" TEXT;
ALTER TABLE "SocialMediaAsset" ADD COLUMN IF NOT EXISTS "analysisError" TEXT;
ALTER TABLE "SocialMediaAsset" ADD COLUMN IF NOT EXISTS "lastAnalyzedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "SocialMediaAsset_analysisStatus_lastSeenAt_idx"
  ON "SocialMediaAsset"("analysisStatus", "lastSeenAt");
