/* Minimal, email-safe Markdown → inline-styled HTML renderer for the Deep Research
   dossier. Email clients strip <style> blocks and classes, so every element carries
   inline styles. Supports the dossier's elements: h1–h4, paragraphs, bold / italic /
   inline-code / links, ordered & unordered lists, blockquotes, GFM tables, and rules.
   This is intentionally self-contained (no markdown lib) so the output is email-safe. */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Inline formatting: code, links, bold, italic. Escapes first, then applies markup. */
function renderInline(text: string): string {
  let s = escapeHtml(text);
  // inline code `...`
  s = s.replace(
    /`([^`]+)`/g,
    '<code style="font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:0.9em;background:#f2f2f2;padding:1px 5px;border-radius:4px;">$1</code>',
  );
  // links [text](url) — only http(s)/mailto are allowed through
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    const raw = url.replace(/&amp;/g, "&");
    const safe = /^(https?:|mailto:)/i.test(raw) ? url : "#";
    return `<a href="${safe}" style="color:#0a0a0a;text-decoration:underline;">${label}</a>`;
  });
  // bold **...** / __...__
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong style="font-weight:700;">$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong style="font-weight:700;">$1</strong>');
  // italic *...* / _..._ (avoid touching the bold markers already replaced)
  s = s.replace(/(^|[^*])\*(?!\*)([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_(?!_)([^_]+)_(?!_)/g, '$1<em>$2</em>');
  return s;
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}
function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

const HEADING_STYLE: Record<number, string> = {
  1: "font-size:22px;font-weight:700;line-height:1.25;color:#0a0a0a;margin:22px 0 10px;",
  2: "font-size:18px;font-weight:700;line-height:1.3;color:#0a0a0a;margin:24px 0 8px;padding-bottom:6px;border-bottom:1px solid #eeeeee;",
  3: "font-size:15px;font-weight:700;line-height:1.3;color:#1d1d1f;margin:18px 0 6px;",
  4: "font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#6a6a6a;margin:16px 0 6px;",
};

/** Render a Markdown dossier string into an inline-styled HTML fragment for email. */
export function renderDossierMarkdownToEmailHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  const isBlockStart = (idx: number): boolean => {
    const t = lines[idx]?.trim() ?? "";
    return (
      /^(#{1,4})\s+/.test(t) ||
      /^>\s?/.test(t) ||
      /^[-*+]\s+/.test(t) ||
      /^\d+[.)]\s+/.test(t) ||
      /^(-{3,}|_{3,}|\*{3,})$/.test(t) ||
      (t.includes("|") && idx + 1 < lines.length && isTableSeparator(lines[idx + 1]))
    );
  };

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      i++;
      continue;
    }

    // heading
    const h = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (h) {
      const level = h[1].length;
      out.push(`<div style="font-family:Inter,Arial,sans-serif;${HEADING_STYLE[level]}">${renderInline(h[2])}</div>`);
      i++;
      continue;
    }

    // horizontal rule
    if (/^(-{3,}|_{3,}|\*{3,})$/.test(trimmed)) {
      out.push(`<div style="border-top:1px solid #e8e8e8;margin:20px 0;"></div>`);
      i++;
      continue;
    }

    // blockquote
    if (/^>\s?/.test(trimmed)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quote.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      out.push(
        `<blockquote style="margin:14px 0;padding:4px 0 4px 16px;border-left:3px solid #0a0a0a;color:#3b3b3b;font-style:italic;font-size:15px;line-height:1.6;">${renderInline(
          quote.join(" "),
        )}</blockquote>`,
      );
      continue;
    }

    // GFM table (header row, separator row, then data rows)
    if (trimmed.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitRow(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(splitRow(lines[i].trim()));
        i++;
      }
      const th = header
        .map(
          (c) =>
            `<th style="text-align:left;padding:8px 10px;border-bottom:2px solid #0a0a0a;font-size:11px;letter-spacing:0.04em;text-transform:uppercase;color:#6a6a6a;font-weight:700;">${renderInline(
              c,
            )}</th>`,
        )
        .join("");
      const trs = rows
        .map(
          (r, ri) =>
            `<tr style="background:${ri % 2 ? "#fafafa" : "#ffffff"};">${r
              .map(
                (c) =>
                  `<td style="padding:8px 10px;border-bottom:1px solid #eeeeee;font-size:13px;line-height:1.5;color:#1d1d1f;vertical-align:top;word-break:break-word;">${renderInline(
                    c,
                  )}</td>`,
              )
              .join("")}</tr>`,
        )
        .join("");
      out.push(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:12px 0;width:100%;"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`,
      );
      continue;
    }

    // unordered list
    if (/^[-*+]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, ""));
        i++;
      }
      out.push(
        `<ul style="margin:8px 0;padding-left:22px;color:#1d1d1f;font-size:14px;line-height:1.7;">${items
          .map((it) => `<li style="margin:0 0 6px 0;">${renderInline(it)}</li>`)
          .join("")}</ul>`,
      );
      continue;
    }

    // ordered list
    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ""));
        i++;
      }
      out.push(
        `<ol style="margin:8px 0;padding-left:22px;color:#1d1d1f;font-size:14px;line-height:1.7;">${items
          .map((it) => `<li style="margin:0 0 6px 0;">${renderInline(it)}</li>`)
          .join("")}</ol>`,
      );
      continue;
    }

    // paragraph — gather consecutive plain lines until the next block element
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(i)) {
      para.push(lines[i].trim());
      i++;
    }
    if (para.length) {
      out.push(
        `<p style="margin:0 0 12px 0;color:#1d1d1f;font-size:14px;line-height:1.7;">${renderInline(para.join(" "))}</p>`,
      );
    }
  }

  return out.join("\n");
}
