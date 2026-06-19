"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Link from "next/link";
import { resolveDocHref } from "@/lib/docs/registry";
import styles from "./docs.module.css";

/* Renders a doc's markdown with GitHub-flavored tables/code, and rewrites in-doc links
   to site routes (or to GitHub for code / unpublished docs). Content is our own repo
   markdown, statically rendered at build time. */
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
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
