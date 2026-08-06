/* The One family dock — a single floating glass tab bar (iOS-style) that makes
   Adam, Reserve, the network, and the stories feel like one product. */
import Link from "next/link";
import styles from "@/app/adam/adam.module.css";

const TABS = [
  { href: "/adam", icon: "⚡️", label: "Adam" },
  { href: "/reserve", icon: "📅", label: "Reserve" },
  { href: "/network", icon: "✦", label: "Network" },
  { href: "/customers", icon: "☰", label: "Stories" },
] as const;

export default function FamilyDock({ active }: { active: (typeof TABS)[number]["href"] }) {
  return (
    <nav className={styles.dock} aria-label="One family">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href}
          className={`${styles.dockItem} ${t.href === active ? styles.dockActive : ""}`}
          aria-current={t.href === active ? "page" : undefined}>
          <span className={styles.dockIcon} aria-hidden>{t.icon}</span>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
