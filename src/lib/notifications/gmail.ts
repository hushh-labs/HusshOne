import nodemailer from "nodemailer";

export interface GmailEmailInput {
  recipients: string[];
  subject: string;
  htmlContent: string;
  fromName?: string;
}

export interface GmailEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Sends mail via Gmail SMTP using an app password (reuses the proven
 * hushh-tech Gmail credentials: GMAIL_USER + GMAIL_APP_PASSWORD).
 *
 * Sender is the authenticated account. GMAIL_SENDER_EMAIL may override the From
 * address only if it is a configured "send-as" alias on that account, otherwise
 * Gmail rewrites it back to GMAIL_USER.
 */
export async function sendGmailEmail(input: GmailEmailInput): Promise<GmailEmailResult> {
  try {
    const user = process.env.GMAIL_USER?.trim();
    // App passwords are often displayed in 4-char groups; strip any whitespace.
    const pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "");
    const fromAddress = process.env.GMAIL_SENDER_EMAIL?.trim() || user;

    if (!user || !pass) {
      return { success: false, error: "Missing Gmail SMTP credentials" };
    }
    if (!input.recipients.length) {
      return { success: false, error: "No recipients provided" };
    }

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user, pass },
    });

    const info = await transporter.sendMail({
      from: `${input.fromName || "Hussh One"} <${fromAddress}>`,
      to: input.recipients.join(", "),
      subject: input.subject,
      html: input.htmlContent,
    });

    return { success: true, messageId: info.messageId };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown Gmail SMTP error",
    };
  }
}
