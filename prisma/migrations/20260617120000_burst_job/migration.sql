-- Xtreme Compute Burst job tracking (GCP burst + "One Puppy" device tier).
-- Idempotent (IF NOT EXISTS throughout) so it is safe to apply directly against prod
-- (psql) regardless of whether Prisma's _prisma_migrations history is in sync, as well
-- as via `prisma migrate deploy`. The SA private key is NEVER stored — only
-- projectId/region/credsSource for audit.
CREATE TABLE IF NOT EXISTS "BurstJob" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId"           UUID NOT NULL,
  "provider"         TEXT NOT NULL,
  "acceleratorKind"  TEXT NOT NULL,
  "acceleratorCount" INTEGER NOT NULL DEFAULT 1,
  "machineType"      TEXT NOT NULL,
  "region"           TEXT NOT NULL,
  "placement"        TEXT NOT NULL,
  "placementReason"  TEXT,
  "status"           TEXT NOT NULL DEFAULT 'pending',
  "spec"             JSONB NOT NULL,
  "result"           JSONB,
  "error"            TEXT,
  "providerJobId"    TEXT,
  "instanceName"     TEXT,
  "credsSource"      TEXT,
  "provisionMs"      INTEGER,
  "runMs"            INTEGER,
  "totalMs"          INTEGER,
  "outcome"          TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"      TIMESTAMP(3),
  CONSTRAINT "BurstJob_pkey" PRIMARY KEY ("id")
);

-- Forward-compat: add any columns that may be missing on an older table.
ALTER TABLE "BurstJob" ADD COLUMN IF NOT EXISTS "placementReason" TEXT;
ALTER TABLE "BurstJob" ADD COLUMN IF NOT EXISTS "result" JSONB;
ALTER TABLE "BurstJob" ADD COLUMN IF NOT EXISTS "providerJobId" TEXT;
ALTER TABLE "BurstJob" ADD COLUMN IF NOT EXISTS "instanceName" TEXT;
ALTER TABLE "BurstJob" ADD COLUMN IF NOT EXISTS "credsSource" TEXT;
ALTER TABLE "BurstJob" ADD COLUMN IF NOT EXISTS "provisionMs" INTEGER;
ALTER TABLE "BurstJob" ADD COLUMN IF NOT EXISTS "runMs" INTEGER;
ALTER TABLE "BurstJob" ADD COLUMN IF NOT EXISTS "totalMs" INTEGER;
ALTER TABLE "BurstJob" ADD COLUMN IF NOT EXISTS "outcome" TEXT;

CREATE INDEX IF NOT EXISTS "BurstJob_userId_createdAt_idx" ON "BurstJob" ("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "BurstJob_status_idx" ON "BurstJob" ("status");
CREATE INDEX IF NOT EXISTS "BurstJob_providerJobId_idx" ON "BurstJob" ("providerJobId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'BurstJob_userId_fkey'
  ) THEN
    ALTER TABLE "BurstJob"
      ADD CONSTRAINT "BurstJob_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "OneUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
