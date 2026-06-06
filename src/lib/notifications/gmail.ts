import { createSign } from "node:crypto";

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

function base64urlEncode(value: Buffer | string) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function encodeHeader(value: string) {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function foldBase64(base64: string) {
  const lines: string[] = [];
  for (let index = 0; index < base64.length; index += 76) {
    lines.push(base64.slice(index, index + 76));
  }
  return lines.join("\r\n");
}

function createSignedJwt(serviceAccountEmail: string, privateKey: string, userToImpersonate: string) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64urlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64urlEncode(
    JSON.stringify({
      iss: serviceAccountEmail,
      sub: userToImpersonate,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
      scope: "https://www.googleapis.com/auth/gmail.send",
    }),
  );
  const signatureInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signatureInput).sign(privateKey);
  return `${signatureInput}.${base64urlEncode(signature)}`;
}

async function getAccessToken(serviceAccountEmail: string, privateKey: string, userToImpersonate: string) {
  const assertion = createSignedJwt(serviceAccountEmail, privateKey, userToImpersonate);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to get Gmail access token: ${await response.text()}`);
  }

  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("Gmail access token response did not include access_token");
  }
  return data.access_token;
}

function createHtmlMessage(input: Required<GmailEmailInput> & { senderEmail: string }) {
  const encodedHtml = foldBase64(Buffer.from(input.htmlContent, "utf8").toString("base64"));
  return [
    `From: ${input.fromName} <${input.senderEmail}>`,
    `To: ${input.recipients.join(", ")}`,
    `Subject: ${encodeHeader(input.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodedHtml,
  ].join("\r\n");
}

export async function sendGmailEmail(input: GmailEmailInput): Promise<GmailEmailResult> {
  try {
    const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
    const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
    const senderEmail = process.env.GMAIL_SENDER_EMAIL?.trim() || "ankit@hushh.ai";

    if (!serviceAccountEmail || !privateKey) {
      return { success: false, error: "Missing Google Service Account credentials" };
    }
    if (!input.recipients.length) {
      return { success: false, error: "No recipients provided" };
    }

    const accessToken = await getAccessToken(serviceAccountEmail, privateKey, senderEmail);
    const raw = createHtmlMessage({
      recipients: input.recipients,
      subject: input.subject,
      htmlContent: input.htmlContent,
      fromName: input.fromName || "Hussh One",
      senderEmail,
    });

    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: base64urlEncode(raw) }),
    });

    if (!response.ok) {
      return { success: false, error: `Gmail API error: ${await response.text()}` };
    }

    const result = (await response.json()) as { id?: string };
    return { success: true, messageId: result.id };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown Gmail error",
    };
  }
}
