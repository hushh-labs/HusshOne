CREATE TABLE IF NOT EXISTS "SocialContentItem" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "platform" TEXT NOT NULL,
  "publicId" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "itemUrl" TEXT NOT NULL,
  "itemType" TEXT NOT NULL,
  "text" TEXT,
  "timestamp" TIMESTAMP(3),
  "media" JSONB,
  "metrics" JSONB,
  "features" JSONB,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SocialContentItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SocialContentItem_userId_platform_itemId_key"
  ON "SocialContentItem"("userId", "platform", "itemId");
CREATE INDEX IF NOT EXISTS "SocialContentItem_userId_platform_timestamp_idx"
  ON "SocialContentItem"("userId", "platform", "timestamp");
CREATE INDEX IF NOT EXISTS "SocialContentItem_userId_lastSeenAt_idx"
  ON "SocialContentItem"("userId", "lastSeenAt");

DO $$ BEGIN
  ALTER TABLE "SocialContentItem"
    ADD CONSTRAINT "SocialContentItem_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "OneUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "SocialMediaAsset" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "platform" TEXT NOT NULL,
  "assetHash" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "cacheUri" TEXT,
  "analysis" JSONB,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SocialMediaAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SocialMediaAsset_userId_platform_assetHash_key"
  ON "SocialMediaAsset"("userId", "platform", "assetHash");
CREATE INDEX IF NOT EXISTS "SocialMediaAsset_userId_platform_idx"
  ON "SocialMediaAsset"("userId", "platform");

DO $$ BEGIN
  ALTER TABLE "SocialMediaAsset"
    ADD CONSTRAINT "SocialMediaAsset_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "OneUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "SocialRefreshJob" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "platform" TEXT NOT NULL,
  "publicId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "priority" INTEGER NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lockedAt" TIMESTAMP(3),
  "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SocialRefreshJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SocialRefreshJob_status_nextRunAt_priority_idx"
  ON "SocialRefreshJob"("status", "nextRunAt", "priority");
CREATE INDEX IF NOT EXISTS "SocialRefreshJob_userId_platform_publicId_idx"
  ON "SocialRefreshJob"("userId", "platform", "publicId");

DO $$ BEGIN
  ALTER TABLE "SocialRefreshJob"
    ADD CONSTRAINT "SocialRefreshJob_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "OneUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "UserPreferenceProfile" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "scanRunId" UUID,
  "status" TEXT NOT NULL DEFAULT 'completed',
  "version" TEXT NOT NULL,
  "inputHash" TEXT,
  "profile" JSONB NOT NULL,
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "staleAfter" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserPreferenceProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserPreferenceProfile_userId_key"
  ON "UserPreferenceProfile"("userId");
CREATE INDEX IF NOT EXISTS "UserPreferenceProfile_userId_updatedAt_idx"
  ON "UserPreferenceProfile"("userId", "updatedAt");
CREATE INDEX IF NOT EXISTS "UserPreferenceProfile_staleAfter_idx"
  ON "UserPreferenceProfile"("staleAfter");

DO $$ BEGIN
  ALTER TABLE "UserPreferenceProfile"
    ADD CONSTRAINT "UserPreferenceProfile_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "OneUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "UserPreferenceProfile"
    ADD CONSTRAINT "UserPreferenceProfile_scanRunId_fkey"
    FOREIGN KEY ("scanRunId") REFERENCES "ScanRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "SocialPreferenceRunLog" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "scanRunId" UUID,
  "status" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "version" TEXT,
  "inputHash" TEXT,
  "platforms" JSONB,
  "counts" JSONB,
  "selectedEvidenceIds" JSONB,
  "selectedSignalIds" JSONB,
  "durationMs" INTEGER,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocialPreferenceRunLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SocialPreferenceRunLog_userId_createdAt_idx"
  ON "SocialPreferenceRunLog"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "SocialPreferenceRunLog_scanRunId_createdAt_idx"
  ON "SocialPreferenceRunLog"("scanRunId", "createdAt");
CREATE INDEX IF NOT EXISTS "SocialPreferenceRunLog_status_event_idx"
  ON "SocialPreferenceRunLog"("status", "event");

DO $$ BEGIN
  ALTER TABLE "SocialPreferenceRunLog"
    ADD CONSTRAINT "SocialPreferenceRunLog_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "OneUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SocialPreferenceRunLog"
    ADD CONSTRAINT "SocialPreferenceRunLog_scanRunId_fkey"
    FOREIGN KEY ("scanRunId") REFERENCES "ScanRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
