-- Durable optional-social access state. Idempotent because production migrations may
-- be applied manually while Prisma migration history catches up later.
CREATE TABLE IF NOT EXISTS "SocialAccessRequest" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "profileUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "profileSnapshot" JSONB,
    "requestedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "nextCheckAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialAccessRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SocialAccessRequest_userId_platform_publicId_key"
  ON "SocialAccessRequest"("userId", "platform", "publicId");

CREATE INDEX IF NOT EXISTS "SocialAccessRequest_userId_platform_status_idx"
  ON "SocialAccessRequest"("userId", "platform", "status");

CREATE INDEX IF NOT EXISTS "SocialAccessRequest_nextCheckAt_idx"
  ON "SocialAccessRequest"("nextCheckAt");

DO $$ BEGIN
  ALTER TABLE "SocialAccessRequest"
    ADD CONSTRAINT "SocialAccessRequest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "OneUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
