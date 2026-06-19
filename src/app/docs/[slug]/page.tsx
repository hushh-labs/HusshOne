import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ALL_DOCS, getDoc } from "@/lib/docs/registry";
import { readDocMarkdown } from "@/lib/docs/read";
import DocBody from "../DocBody";
import styles from "../docs.module.css";

export const dynamic = "force-static";

export function generateStaticParams() {
  return ALL_DOCS.map((doc) => ({ slug: doc.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const doc = getDoc(slug);
  if (!doc) return { title: "Docs — One Burst Compute" };
  return { title: `${doc.title} — One Burst Compute`, description: doc.blurb };
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = getDoc(slug);
  if (!doc) notFound();

  const markdown = readDocMarkdown(doc);
  return (
    <article>
      <p className={styles.docMeta}>{doc.blurb}</p>
      <DocBody markdown={markdown} />
    </article>
  );
}
