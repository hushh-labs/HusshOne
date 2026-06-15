-- CreateTable (idempotent: deploy may apply this by hand; re-runs must be safe)
CREATE TABLE IF NOT EXISTS "SocialConnection" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "profile" JSONB NOT NULL,
    "sessionValid" BOOLEAN NOT NULL DEFAULT true,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refreshedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SocialConnection_userId_platform_publicId_key"
  ON "SocialConnection"("userId", "platform", "publicId");

CREATE INDEX IF NOT EXISTS "SocialConnection_userId_platform_idx"
  ON "SocialConnection"("userId", "platform");

DO $$ BEGIN
  ALTER TABLE "SocialConnection"
    ADD CONSTRAINT "SocialConnection_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "OneUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
