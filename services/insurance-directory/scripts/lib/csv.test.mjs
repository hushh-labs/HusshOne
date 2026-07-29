import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsvRows, parseCsv } from "./csv.mjs";

test("parseCsvRows splits simple rows and fields", () => {
  const rows = parseCsvRows("a,b,c\n1,2,3");
  assert.deepEqual(rows, [
    ["a", "b", "c"],
    ["1", "2", "3"],
  ]);
});

test("parseCsvRows handles quoted fields with embedded commas and newlines", () => {
  const rows = parseCsvRows('name,note\n"Smith, John","line1\nline2"');
  assert.deepEqual(rows, [
    ["name", "note"],
    ["Smith, John", "line1\nline2"],
  ]);
});

test("parseCsvRows unescapes doubled quotes", () => {
  const rows = parseCsvRows('q\n"she said ""hi"""');
  assert.deepEqual(rows, [["q"], ['she said "hi"']]);
});

test("parseCsvRows treats CRLF and lone CR as row terminators, no trailing empty row", () => {
  assert.deepEqual(parseCsvRows("a,b\r\n1,2\r\n"), [
    ["a", "b"],
    ["1", "2"],
  ]);
  assert.deepEqual(parseCsvRows("a,b\r1,2"), [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("parseCsvRows on empty input yields no rows", () => {
  assert.deepEqual(parseCsvRows(""), []);
  assert.deepEqual(parseCsvRows(null), []);
});

test("parseCsv maps rows to objects keyed by trimmed header", () => {
  const objs = parseCsv("license_number, name\nABC123,Jane Doe\n");
  assert.deepEqual(objs, [{ license_number: "ABC123", name: "Jane Doe" }]);
});

test("parseCsv drops extra columns and back-fills missing trailing columns with ''", () => {
  const objs = parseCsv("a,b,c\n1,2,3,4\n9");
  assert.deepEqual(objs, [
    { a: "1", b: "2", c: "3" }, // extra 4th cell dropped
    { a: "9", b: "", c: "" }, // missing trailing cells default to ""
  ]);
});

test("parseCsv returns [] when there is only a header (or nothing)", () => {
  assert.deepEqual(parseCsv("a,b,c"), []);
  assert.deepEqual(parseCsv(""), []);
});
