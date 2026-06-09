-- Per-phase scan timing + outcome observability.
-- Idempotent (ADD COLUMN IF NOT EXISTS) so it is safe to apply directly against
-- prod (psql) regardless of whether Prisma's _prisma_migrations history is in sync,
-- as well as via `prisma migrate deploy`.
ALTER TABLE "ScanRun" ADD COLUMN IF NOT EXISTS "phase1Ms" INTEGER;
ALTER TABLE "ScanRun" ADD COLUMN IF NOT EXISTS "phase2Ms" INTEGER;
ALTER TABLE "ScanRun" ADD COLUMN IF NOT EXISTS "totalMs" INTEGER;
ALTER TABLE "ScanRun" ADD COLUMN IF NOT EXISTS "outcome" TEXT;
ALTER TABLE "ScanRun" ADD COLUMN IF NOT EXISTS "deepResearchJobId" TEXT;
ALTER TABLE "ScanRun" ADD COLUMN IF NOT EXISTS "sessionId" TEXT;
