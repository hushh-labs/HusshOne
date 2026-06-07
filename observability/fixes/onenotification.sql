-- Fix: create the missing OneNotification table in the prod DB (hushh-identity-pg).
-- The table is in the init migration but absent in prod (schema drift); every scan
-- logs one.notification.create_failed and result emails don't send. This DDL is
-- the OneNotification slice of prisma/migrations/20260605190000_init, made
-- idempotent so it is safe to run once. Additive only — no data is touched.

CREATE TABLE IF NOT EXISTS "OneNotification" (
  "id" UUID NOT NULL,
  "userId" UUID,
  "scanRunId" UUID NOT NULL,
  "notificationType" TEXT NOT NULL,
  "recipientEmail" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "provider" TEXT NOT NULL DEFAULT 'gmail',
  "providerMessageId" TEXT,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "sentAt" TIMESTAMP(3),
  CONSTRAINT "OneNotification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OneNotification_scanRunId_notificationType_recipientEmail_key"
  ON "OneNotification"("scanRunId", "notificationType", "recipientEmail");
CREATE INDEX IF NOT EXISTS "OneNotification_userId_createdAt_idx"
  ON "OneNotification"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "OneNotification_status_idx"
  ON "OneNotification"("status");

-- Foreign keys (only added if missing).
DO $$ BEGIN
  ALTER TABLE "OneNotification" ADD CONSTRAINT "OneNotification_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "OneUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "OneNotification" ADD CONSTRAINT "OneNotification_scanRunId_fkey"
    FOREIGN KEY ("scanRunId") REFERENCES "ScanRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
