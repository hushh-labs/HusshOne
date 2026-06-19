import Link from "next/link";
import { DOC_SECTIONS } from "@/lib/docs/registry";
import styles from "./docs.module.css";

export const dynamic = "force-static";

export default function DocsIndex() {
  return (
    <div>
      <div className={styles.hero}>
        <h1>One Burst Compute</h1>
        <p>
          Personal supercomputing for your Mac. One runs your work on-device and, when it needs more power,
          borrows a supercomputer from your own cloud — then brings the result home and cleans up. Your keys
          and your data stay yours.
        </p>
      </div>

      <Link href="/docs/onboarding-kit" className={styles.featured}>
        <p className={styles.featuredKicker}>⬇ Self-serve onboarding</p>
        <p className={styles.cardTitle}>Download the onboarding kit</p>
        <p className={styles.cardBlurb}>
          A provisioning script, a Terraform module, and a machine-readable manifest — so a person or an automated
          infrastructure system can stand up your cloud and get One bursting.
        </p>
      </Link>

      {DOC_SECTIONS.map((section) => (
        <section key={section.title} style={{ marginBottom: 32 }}>
          <p className={styles.sectionTitle}>{section.title}</p>
          <div className={styles.cardGrid}>
            {section.docs.map((doc) => (
              <Link key={doc.slug} href={`/docs/${doc.slug}`} className={styles.card}>
                <p className={styles.cardTitle}>{doc.title}</p>
                <p className={styles.cardBlurb}>{doc.blurb}</p>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
