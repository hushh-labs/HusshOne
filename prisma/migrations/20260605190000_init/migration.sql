CREATE TABLE "OneUser" (
  "id" UUID NOT NULL,
  "firebaseUid" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT,
  "photoUrl" TEXT,
  "provider" TEXT NOT NULL DEFAULT 'google',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OneUser_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConsentEvent" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "purpose" TEXT NOT NULL,
  "consentVersion" TEXT NOT NULL,
  "locationMode" TEXT NOT NULL,
  "latitude" DECIMAL(9,6),
  "longitude" DECIMAL(9,6),
  "zipCode" TEXT,
  "ipHash" TEXT,
  "userAgentHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConsentEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScanRun" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "mode" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "input" JSONB NOT NULL,
  "normalizedResult" JSONB,
  "summary" TEXT,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "ScanRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditJob" (
  "id" UUID NOT NULL,
  "scanRunId" UUID NOT NULL,
  "upstreamJobId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "totalShards" INTEGER NOT NULL DEFAULT 0,
  "completedShards" INTEGER NOT NULL DEFAULT 0,
  "failedShards" INTEGER NOT NULL DEFAULT 0,
  "reportAvailable" BOOLEAN NOT NULL DEFAULT false,
  "report" JSONB,
  "errors" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "AuditJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DataRequest" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'requested',
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "DataRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OneNotification" (
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

CREATE UNIQUE INDEX "OneUser_firebaseUid_key" ON "OneUser"("firebaseUid");
CREATE INDEX "OneUser_email_idx" ON "OneUser"("email");
CREATE INDEX "ConsentEvent_userId_createdAt_idx" ON "ConsentEvent"("userId", "createdAt");
CREATE INDEX "ScanRun_userId_createdAt_idx" ON "ScanRun"("userId", "createdAt");
CREATE INDEX "ScanRun_status_idx" ON "ScanRun"("status");
CREATE UNIQUE INDEX "AuditJob_upstreamJobId_key" ON "AuditJob"("upstreamJobId");
CREATE INDEX "AuditJob_scanRunId_idx" ON "AuditJob"("scanRunId");
CREATE INDEX "AuditJob_status_idx" ON "AuditJob"("status");
CREATE INDEX "DataRequest_userId_requestedAt_idx" ON "DataRequest"("userId", "requestedAt");
CREATE INDEX "DataRequest_type_status_idx" ON "DataRequest"("type", "status");
CREATE UNIQUE INDEX "OneNotification_scanRunId_notificationType_recipientEmail_key" ON "OneNotification"("scanRunId", "notificationType", "recipientEmail");
CREATE INDEX "OneNotification_userId_createdAt_idx" ON "OneNotification"("userId", "createdAt");
CREATE INDEX "OneNotification_status_idx" ON "OneNotification"("status");

ALTER TABLE "ConsentEvent" ADD CONSTRAINT "ConsentEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "OneUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScanRun" ADD CONSTRAINT "ScanRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "OneUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditJob" ADD CONSTRAINT "AuditJob_scanRunId_fkey" FOREIGN KEY ("scanRunId") REFERENCES "ScanRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DataRequest" ADD CONSTRAINT "DataRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "OneUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OneNotification" ADD CONSTRAINT "OneNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "OneUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OneNotification" ADD CONSTRAINT "OneNotification_scanRunId_fkey" FOREIGN KEY ("scanRunId") REFERENCES "ScanRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
