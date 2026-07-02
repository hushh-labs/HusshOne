"use client";

import { useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Link from "next/link";
import { resolveDocHref } from "@/lib/docs/registry";
import styles from "./docs.module.css";

/* Renders a doc's markdown with GitHub-flavored tables/code, and a few developer-docs niceties:
   copy-to-clipboard on code blocks, coloured HTTP-method pills for inline `GET`/`POST`/…, and
   anchor links on headings (so the on-this-page TOC and deep links work). In-doc links are
   rewritten to site routes (or GitHub for source docs). Content is our own repo markdown. */

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);

/** Flatten React children to plain text (for heading ids + code copy fallbacks). */
function toText(node: ReactNode): string {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(toText).join("");
  if (typeof node === "object" && "props" in (node as { props?: { children?: ReactNode } })) {
    return toText((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function CodeBlock({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const text = ref.current?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — no-op */
    }
  };
  return (
    <div className={styles.codeWrap}>
      <button className={styles.copyBtn} onClick={copy} aria-label="Copy code" type="button">
        {copied ? "Copied" : "Copy"}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

function Heading({ level, children }: { level: 2 | 3; children: ReactNode }) {
  const id = slugify(toText(children));
  const anchor = (
    <a href={`#${id}`} className={styles.headingAnchor} aria-label="Link to this section">
      #
    </a>
  );
  if (level === 2)
    return (
      <h2 id={id} className={styles.heading}>
        {anchor}
        {children}
      </h2>
    );
  return (
    <h3 id={id} className={styles.heading}>
      {anchor}
      {children}
    </h3>
  );
}

export default function DocBody({ markdown }: { markdown: string }) {
  return (
    <div className={styles.prose}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children, ...props }) {
            const target = resolveDocHref(href || "");
            if (target.external) {
              return (
                <a href={target.href} target="_blank" rel="noreferrer" {...props}>
                  {children}
                </a>
              );
            }
            if (target.href.startsWith("#")) {
              return (
                <a href={target.href} {...props}>
                  {children}
                </a>
              );
            }
            return <Link href={target.href}>{children}</Link>;
          },
          code({ className, children, ...props }) {
            const text = toText(children).trim();
            // Inline code (no language class) that is exactly an HTTP method → coloured pill.
            if (!className && HTTP_METHODS.has(text)) {
              return <span className={`${styles.method} ${styles[`method_${text}`]}`}>{text}</span>;
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          pre({ children }) {
            return <CodeBlock>{children}</CodeBlock>;
          },
          h2({ children }) {
            return <Heading level={2}>{children}</Heading>;
          },
          h3({ children }) {
            return <Heading level={3}>{children}</Heading>;
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
