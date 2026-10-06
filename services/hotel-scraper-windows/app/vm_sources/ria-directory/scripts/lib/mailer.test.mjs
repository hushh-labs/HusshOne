import { test } from "node:test";
import assert from "node:assert/strict";
import { _internal } from "./mailer.mjs";

const { buildRawMessage, encodeSubject, encodeBase64WithLineBreaks, parseReply } = _internal;

test("buildRawMessage assembles valid MIME headers and base64 body", () => {
  const raw = buildRawMessage({
    fromName: "Hushh RIA Directory",
    senderEmail: "ankit@hushh.ai",
    recipients: ["ankit@hushh.ai", "manish@hushh.ai", "kushal@hushh.ai"],
    subject: "Daily progress",
    htmlContent: "<b>hi</b>",
    messageId: "<abc@hushh.ai>",
    date: "Tue, 01 Jul 2026 10:00:00 GMT",
  });
  assert.match(raw, /^From: Hushh RIA Directory <ankit@hushh\.ai>/m);
  assert.match(raw, /^To: ankit@hushh\.ai, manish@hushh\.ai, kushal@hushh\.ai$/m);
  assert.match(raw, /^Subject: Daily progress$/m);
  assert.match(raw, /^Message-ID: <abc@hushh\.ai>$/m);
  assert.match(raw, /^Date: Tue, 01 Jul 2026 10:00:00 GMT$/m);
  assert.match(raw, /^Content-Type: text\/html; charset="UTF-8"$/m);
  assert.match(raw, /^Content-Transfer-Encoding: base64$/m);
  // Body is the base64 of the HTML, after the blank header/body separator.
  const body = raw.split("\r\n\r\n")[1];
  assert.equal(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8"), "<b>hi</b>");
});

test("encodeSubject RFC2047-encodes non-ASCII, passes ASCII through", () => {
  assert.equal(encodeSubject("Daily progress"), "Daily progress");
  assert.match(encodeSubject("Café progress"), /^=\?UTF-8\?B\?/);
});

test("encodeBase64WithLineBreaks wraps at 76 chars and round-trips", () => {
  const input = "x".repeat(200);
  const out = encodeBase64WithLineBreaks(input);
  for (const line of out.split("\r\n")) assert.ok(line.length <= 76);
  assert.equal(Buffer.from(out.replace(/\r\n/g, ""), "base64").toString("utf8"), input);
});

test("parseReply waits for the final line of a multiline SMTP reply", () => {
  // Continuation lines end in "-"; the reply is only complete on "NNN <space>".
  assert.equal(parseReply("250-smtp.gmail.com at your service\r\n"), null);
  const done = parseReply("250-smtp.gmail.com at your service\r\n250 OK\r\n");
  assert.equal(done.code, 250);
  // A single final line parses immediately.
  assert.equal(parseReply("220 smtp.gmail.com ESMTP\r\n").code, 220);
  // No complete line yet.
  assert.equal(parseReply("33"), null);
});
