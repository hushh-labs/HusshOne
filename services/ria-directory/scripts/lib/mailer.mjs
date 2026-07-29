// Gmail sender via SMTP + app password — the SAME mechanism this repo already uses
// in src/lib/notifications/gmail.ts ("reuses the proven hushh-tech Gmail credentials:
// GMAIL_USER + GMAIL_APP_PASSWORD"). Implemented directly on node:tls so the service
// keeps a single runtime dependency (pg); no nodemailer, no service-account/JWT setup.
//
// Flow (Gmail, smtp.gmail.com:465, implicit TLS): open a TLS socket, EHLO, AUTH LOGIN
// with the app password, MAIL FROM / RCPT TO / DATA, then send the MIME message.

import tls from "node:tls";
import crypto from "node:crypto";
import { config, assertMailerConfig } from "./config.mjs";

function encodeSubject(subject) {
  // RFC 2047 encode only when the subject has non-ASCII bytes.
  return /^[\x20-\x7E]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

function encodeBase64WithLineBreaks(content) {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const lines = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join("\r\n");
}

// A base64 body never contains a line starting with "." (the base64 alphabet has no
// dot), so SMTP dot-stuffing is not needed for the body; the "\r\n.\r\n" terminator
// stays unambiguous. We keep transfer-encoding=base64 for exactly that safety.
function buildRawMessage({ fromName, senderEmail, recipients, subject, htmlContent, messageId, date }) {
  return [
    `From: ${fromName} <${senderEmail}>`,
    `To: ${recipients.join(", ")}`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodeBase64WithLineBreaks(htmlContent),
  ].join("\r\n");
}

// Parse SMTP reply lines from a buffer. A reply is complete when a line matches
// "NNN " (space after the 3-digit code); "NNN-" marks a continuation line.
function parseReply(buffer) {
  const lines = buffer.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return null;
  const last = lines[lines.length - 1];
  const m = /^(\d{3})([ -])/.exec(last);
  if (!m || m[2] !== " ") return null; // not yet a final line
  return { code: Number(m[1]), text: lines.join("\n") };
}

// Minimal SMTP conversation over an established TLS socket. The server speaks first
// (220 greeting); then each step sends a command and waits for a reply whose code is
// in `expect`. Anything unexpected rejects the whole send.
function smtpConversation(socket, steps, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let idx = 0;
    let expect = [220]; // greeting
    let settled = false;

    const done = (err, val) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners("data");
      clearTimeout(timer);
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => done(new Error("SMTP timeout")), timeoutMs);

    const advance = () => {
      if (idx >= steps.length) return done(null, true);
      const step = steps[idx++];
      expect = step.expect;
      socket.write(step.cmd + "\r\n");
    };

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const reply = parseReply(buffer);
      if (!reply) return; // wait for the final line of a multiline reply
      buffer = "";
      if (!expect.includes(reply.code)) {
        return done(new Error(`SMTP unexpected ${reply.code}: ${reply.text.replace(/\n/g, " ")}`));
      }
      advance(); // first OK is the greeting; kicks off the command list
    });
    socket.on("error", (err) => done(err));
  });
}

// Exported for unit tests (pure helpers — no socket, no network).
export const _internal = { buildRawMessage, encodeSubject, encodeBase64WithLineBreaks, parseReply };

// Send one HTML email. Returns { success, messageId?, error? } — never throws, so a
// failed report send is logged and audited rather than crashing the timer job.
export async function sendGmailEmail(recipients, subject, htmlContent, opts = {}) {
  try {
    assertMailerConfig();
    const to = (Array.isArray(recipients) ? recipients : [recipients])
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (!to.length) return { success: false, error: "No recipients" };

    const host = config.mail.smtpHost;
    const port = config.mail.smtpPort;
    const user = config.mail.user;
    const pass = config.mail.appPassword;
    const senderEmail = opts.senderEmail || config.mail.senderEmail || user;
    const fromName = opts.fromName || config.mail.fromName;
    const timeoutMs = opts.timeoutMs || 30_000;

    const messageId = `<${crypto.randomUUID()}@${senderEmail.split("@")[1] || "hushh.ai"}>`;
    const raw = buildRawMessage({
      fromName,
      senderEmail,
      recipients: to,
      subject,
      htmlContent,
      messageId,
      date: new Date().toUTCString(),
    });

    const steps = [
      { cmd: `EHLO ${host}`, expect: [250] },
      { cmd: "AUTH LOGIN", expect: [334] },
      { cmd: Buffer.from(user, "utf8").toString("base64"), expect: [334] },
      { cmd: Buffer.from(pass, "utf8").toString("base64"), expect: [235] },
      { cmd: `MAIL FROM:<${senderEmail}>`, expect: [250] },
      ...to.map((rcpt) => ({ cmd: `RCPT TO:<${rcpt}>`, expect: [250, 251] })),
      { cmd: "DATA", expect: [354] },
      { cmd: `${raw}\r\n.`, expect: [250] },
      { cmd: "QUIT", expect: [221] },
    ];

    const socket = tls.connect({ host, port, servername: host });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error("SMTP socket timeout")));
    await new Promise((res, rej) => {
      socket.once("secureConnect", res);
      socket.once("error", rej);
    });

    try {
      await smtpConversation(socket, steps, timeoutMs);
    } finally {
      socket.destroy();
    }
    return { success: true, messageId };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
