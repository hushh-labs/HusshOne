-- User-approved ChatGPT context summaries imported through the one by hushh
-- OpenAI connector. This intentionally stores only explicit summary payloads,
-- not raw ChatGPT chats, files, cookies, or memory exports.
CREATE TABLE IF NOT EXISTS "ChatGptContextSnapshot" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "summary" TEXT NOT NULL,
  "categories" JSONB NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'chatgpt_user_approved_summary',
  "capturedVia" TEXT NOT NULL DEFAULT 'openai_connector',
  "userPrompt" TEXT,
  "consentText" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChatGptContextSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ChatGptContextSnapshot_userId_createdAt_idx"
  ON "ChatGptContextSnapshot"("userId", "createdAt");

CREATE INDEX IF NOT EXISTS "ChatGptContextSnapshot_source_idx"
  ON "ChatGptContextSnapshot"("source");

DO $$
BEGIN
  ALTER TABLE "ChatGptContextSnapshot"
    ADD CONSTRAINT "ChatGptContextSnapshot_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "OneUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
