import type { Metadata } from "next";
import DocsNav from "./DocsNav";
import styles from "./docs.module.css";

export const metadata: Metadata = {
  title: "Docs — One Burst Compute",
  description: "Documentation for One Burst Compute: personal supercomputing for your Mac with bring-your-own-cloud burst.",
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.shell}>
      <DocsNav />
      <main className={styles.content}>{children}</main>
    </div>
  );
}
