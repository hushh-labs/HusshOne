import { afterEach, describe, expect, it, vi } from "vitest";

const { sendMailMock } = vi.hoisted(() => ({ sendMailMock: vi.fn() }));
vi.mock("nodemailer", () => ({
  default: { createTransport: vi.fn(() => ({ sendMail: sendMailMock })) },
}));

import { sendGmailEmail } from "./gmail";

const ORIGINAL_ENV = {
  GMAIL_USER: process.env.GMAIL_USER,
  GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD,
  GMAIL_SENDER_EMAIL: process.env.GMAIL_SENDER_EMAIL,
};

afterEach(() => {
  // Restore — delete keys that were originally unset (assigning undefined would
  // coerce to the string "undefined", which is truthy).
  for (const k of ["GMAIL_USER", "GMAIL_APP_PASSWORD", "GMAIL_SENDER_EMAIL"] as const) {
    const v = ORIGINAL_ENV[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  sendMailMock.mockReset();
  vi.restoreAllMocks();
});

describe("sendGmailEmail (SMTP)", () => {
  it("returns a clean failure when SMTP creds are missing", async () => {
    delete process.env.GMAIL_USER;
    delete process.env.GMAIL_APP_PASSWORD;

    const result = await sendGmailEmail({
      recipients: ["ankit@example.com"],
      subject: "Test",
      htmlContent: "<p>hello</p>",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Missing Gmail SMTP credentials");
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("fails cleanly with no recipients", async () => {
    process.env.GMAIL_USER = "bot@hushh.ai";
    process.env.GMAIL_APP_PASSWORD = "abcd efgh ijkl mnop";

    const result = await sendGmailEmail({ recipients: [], subject: "T", htmlContent: "<p>h</p>" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("No recipients provided");
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("sends via SMTP and returns the message id", async () => {
    process.env.GMAIL_USER = "bot@hushh.ai";
    process.env.GMAIL_APP_PASSWORD = "abcd efgh ijkl mnop"; // spaces stripped internally
    sendMailMock.mockResolvedValueOnce({ messageId: "<id-123>" });

    const result = await sendGmailEmail({
      recipients: ["a@example.com", "b@example.com"],
      subject: "Your scan",
      htmlContent: "<p>x</p>",
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("<id-123>");
    expect(sendMailMock).toHaveBeenCalledOnce();
    const arg = sendMailMock.mock.calls[0][0] as { to: string; from: string };
    expect(arg.to).toBe("a@example.com, b@example.com");
    expect(arg.from).toContain("bot@hushh.ai");
  });
});
