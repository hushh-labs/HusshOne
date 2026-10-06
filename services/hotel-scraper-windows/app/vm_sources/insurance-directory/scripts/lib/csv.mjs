// Minimal RFC 4180 CSV parser — enough for Socrata `.csv` exports (the format the
// data.texas.gov download adapter pulls). Handles quoted fields, embedded commas,
// escaped double-quotes ("" -> "), and CRLF/LF/quoted newlines. Zero dependencies.

// Parse a CSV string into an array of row arrays (including the header row).
export function parseCsvRows(text) {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  let sawAny = false; // guards against emitting a trailing empty row
  const s = String(text ?? "");

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    sawAny = false;
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"'; // escaped quote
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      sawAny = true;
    } else if (c === ",") {
      endField();
      sawAny = true;
    } else if (c === "\n") {
      endRow();
    } else if (c === "\r") {
      // swallow — the following \n (if any) triggers endRow; a lone \r also ends a row
      if (s[i + 1] !== "\n") endRow();
    } else {
      field += c;
      sawAny = true;
    }
  }
  // Flush the final field/row if the file didn't end on a newline.
  if (sawAny || field.length || row.length) endRow();
  return rows;
}

// Parse a CSV string into an array of plain objects keyed by the header row.
// Extra columns beyond the header are dropped; missing trailing columns are "".
export function parseCsv(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const obj = {};
    for (let c = 0; c < header.length; c++) obj[header[c]] = cells[c] ?? "";
    out.push(obj);
  }
  return out;
}
