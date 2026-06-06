import { afterEach, describe, expect, it, vi } from "vitest";
import { sendGmailEmail } from "./gmail";

const ORIGINAL_ENV = {
  GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY,
  GMAIL_SENDER_EMAIL: process.env.GMAIL_SENDER_EMAIL,
};

afterEach(() => {
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = ORIGINAL_ENV.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  process.env.GOOGLE_PRIVATE_KEY = ORIGINAL_ENV.GOOGLE_PRIVATE_KEY;
  process.env.GMAIL_SENDER_EMAIL = ORIGINAL_ENV.GMAIL_SENDER_EMAIL;
  vi.restoreAllMocks();
});

describe("sendGmailEmail", () => {
  it("returns a clean failure when service account env is missing", async () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    delete process.env.GOOGLE_PRIVATE_KEY;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await sendGmailEmail({
      recipients: ["ankit@example.com"],
      subject: "Test",
      htmlContent: "<p>hello</p>",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Missing Google Service Account credentials");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
