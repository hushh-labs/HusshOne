-- CreateTable (idempotent: deploy applies this against prod by hand; re-runs must be safe)
CREATE TABLE IF NOT EXISTS "LinkedInConnection" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "profile" JSONB NOT NULL,
    "publicId" TEXT,
    "sessionValid" BOOLEAN NOT NULL DEFAULT true,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refreshedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkedInConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "LinkedInConnection_userId_key" ON "LinkedInConnection"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LinkedInConnection_userId_idx" ON "LinkedInConnection"("userId");

-- AddForeignKey (Postgres has no "ADD CONSTRAINT IF NOT EXISTS" — guard with a DO block)
DO $$ BEGIN
  ALTER TABLE "LinkedInConnection"
    ADD CONSTRAINT "LinkedInConnection_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "OneUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
