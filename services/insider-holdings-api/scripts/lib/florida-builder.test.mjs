import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  extractNetWorthFromPdfResponse,
  readPdfWithinLimit,
} from "../build-florida.mjs";

const pdfResponse = (body = "%PDF-1.7\nnet worth field") => new Response(body, {
  status: 200,
  headers: { "content-type": "application/pdf" },
});

test("Florida PDF response requires application/pdf and PDF magic bytes", async () => {
  await assert.rejects(
    readPdfWithinLimit(new Response("<html>not a filing</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })),
    /application\/pdf/,
  );
  await assert.rejects(
    readPdfWithinLimit(new Response("not a pdf", {
      status: 200,
      headers: { "content-type": "application/pdf" },
    })),
    /magic bytes/,
  );
});

test("Florida PDF response is streaming-size bounded", async () => {
  await assert.rejects(readPdfWithinLimit(pdfResponse("%PDF-too-large"), 5), /size limit/);
  await assert.rejects(
    readPdfWithinLimit(new Response("%PDF-1.7", {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-length": "99999999",
      },
    }), 1024),
    /size limit/,
  );
});

test("temporary Florida PDF is removed even when field extraction fails", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "florida-test-"));
  const file = path.join(work, "filing.pdf");
  try {
    await assert.rejects(
      extractNetWorthFromPdfResponse(pdfResponse(), file, {
        fieldExtractor: () => {
          assert.equal(fs.statSync(file).mode & 0o777, 0o600);
          throw new Error("parser failed");
        },
      }),
      /parser failed/,
    );
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("only the bounded field extractor result reaches the net-worth parser", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "florida-test-"));
  const file = path.join(work, "filing.pdf");
  try {
    const value = await extractNetWorthFromPdfResponse(pdfResponse(), file, {
      fieldExtractor: () => "Net Worth as of December 31, 2025 was $ 1,234.00",
    });
    assert.equal(value, 1234);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
