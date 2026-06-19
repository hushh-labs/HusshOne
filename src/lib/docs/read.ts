/* Server-only: read a doc's markdown from the repo at build time (SSG).
   Imported only by the server doc page, so node:fs never enters the client bundle. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DocMeta } from "./registry";

/** process.cwd() is the repo root during `next build`, so the source markdown is present. */
export function readDocMarkdown(doc: DocMeta): string {
  return readFileSync(join(process.cwd(), doc.source), "utf8");
}
