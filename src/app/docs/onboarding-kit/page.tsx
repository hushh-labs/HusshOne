import type { Metadata } from "next";
import Link from "next/link";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import styles from "../docs.module.css";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Onboarding kit — One Burst Compute",
  description:
    "Download the BYOC onboarding kit: a provisioning script, a Terraform module, and a machine-readable manifest so a human or an IaC system can stand up One Burst Compute.",
};

interface KitInput {
  name: string;
  required?: boolean;
  default?: string;
  description?: string;
}
interface KitMethod {
  id: string;
  title: string;
  tool: string;
  run: string;
  inputs: KitInput[];
  outputs?: KitInput[];
}
interface KitFile {
  path: string;
  bytes: number;
  sha256: string;
}
interface Manifest {
  version: string;
  summary: string;
  methods: KitMethod[];
  handBack: { where: string; values: string[] };
  verify: { ui: string; api: string; checks: string[]; description: string };
  files: KitFile[];
}

const TARBALL = "/downloads/one-burst-onboarding-kit.tar.gz";
const KIT_BASE = "/downloads/onboarding";

function readManifest(): { manifest: Manifest | null; bytes: number } {
  try {
    const dir = join(process.cwd(), "public", "downloads");
    const manifest = JSON.parse(readFileSync(join(dir, "onboarding", "manifest.json"), "utf8")) as Manifest;
    const bytes = readFileSync(join(dir, "one-burst-onboarding-kit.tar.gz")).length;
    return { manifest, bytes };
  } catch {
    return { manifest: null, bytes: 0 };
  }
}

function InputsTable({ rows }: { rows: KitInput[] }) {
  return (
    <div className={styles.prose}>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Required</th>
            <th>Default</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td>
                <code>{r.name}</code>
              </td>
              <td>{r.required ? "yes" : "—"}</td>
              <td>{r.default ? <code>{r.default}</code> : "—"}</td>
              <td>{r.description || ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function OnboardingKitPage() {
  const { manifest, bytes } = readManifest();

  return (
    <article>
      <div className={styles.prose}>
        <h1>Onboarding kit</h1>
        <p>
          Everything needed to stand up One Burst Compute in your own Google Cloud project (BYOC) — packaged so a{" "}
          <strong>person at a terminal</strong> or a <strong>standard infrastructure provisioning system</strong> can
          complete the job. One never owns the compute: bursts run in your project, on your bill, under a least-privilege
          credential you control.
        </p>
      </div>

      <div className={styles.downloadRow}>
        <a className={styles.downloadBtn} href={TARBALL} download>
          ⬇ Download the kit (.tar.gz)
        </a>
        {manifest && (
          <span className={styles.downloadMeta}>
            v{manifest.version} · {(bytes / 1024).toFixed(1)} KiB ·{" "}
            <a href={`${TARBALL}.sha256`} style={{ color: "inherit" }}>
              sha256
            </a>
          </span>
        )}
      </div>

      {manifest ? (
        <>
          <div className={styles.prose}>
            <p>Or grab individual files:</p>
          </div>
          <div className={styles.fileList}>
            {manifest.files.map((f) => (
              <a key={f.path} className={styles.fileChip} href={`${KIT_BASE}/${f.path}`} title={`${f.bytes} bytes · sha256 ${f.sha256}`}>
                {f.path}
              </a>
            ))}
            <a className={styles.fileChip} href={`${KIT_BASE}/manifest.json`} title="Machine-readable contract">
              manifest.json
            </a>
          </div>

          <div className={styles.prose}>
            <h2>Two ways to run it</h2>
            <p>Both produce the same least-privilege result and are safe to re-run.</p>
            {manifest.methods.map((m) => (
              <section key={m.id}>
                <h3>
                  {m.title} <span style={{ color: "#8a8a92", fontWeight: 400, fontSize: 14 }}>· {m.tool}</span>
                </h3>
                <pre>
                  <code>{m.run}</code>
                </pre>
                <p style={{ marginBottom: 6 }}>
                  <strong>Inputs</strong>
                </p>
              </section>
            ))}
          </div>

          {manifest.methods.map((m) => (
            <section key={`${m.id}-io`} style={{ marginBottom: 8 }}>
              <div className={styles.prose}>
                <h3 style={{ borderTop: "none" }}>
                  <code>{m.id}</code> inputs
                </h3>
              </div>
              <InputsTable rows={m.inputs} />
              {m.outputs && (
                <>
                  <div className={styles.prose}>
                    <p style={{ marginBottom: 6 }}>
                      <strong>Outputs</strong>
                    </p>
                  </div>
                  <InputsTable rows={m.outputs} />
                </>
              )}
            </section>
          ))}

          <div className={styles.prose}>
            <h2>Hand the result back to One</h2>
            <p>{manifest.handBack.where}:</p>
            <ul>
              {manifest.handBack.values.map((v) => (
                <li key={v}>{v}</li>
              ))}
            </ul>

            <h2>Confirm it actually works</h2>
            <p>{manifest.verify.description}</p>
            <ul>
              <li>
                In the app: <a href={manifest.verify.ui}>{manifest.verify.ui}</a>
              </li>
              <li>
                Programmatically: <code>{manifest.verify.api}</code> — checks{" "}
                {manifest.verify.checks.map((c, i) => (
                  <span key={c}>
                    <code>{c}</code>
                    {i < manifest.verify.checks.length - 1 ? ", " : ""}
                  </span>
                ))}
                .
              </li>
            </ul>
            <p>
              For the full walkthrough see the <Link href="/docs/getting-started">getting started guide</Link> and{" "}
              <Link href="/docs/provisioning">provisioning reference</Link>; for the trust model,{" "}
              <Link href="/docs/security">security &amp; privacy</Link>.
            </p>
          </div>
        </>
      ) : (
        <div className={styles.prose}>
          <p>
            The kit is generated at build time. Download it directly:{" "}
            <a href={TARBALL}>one-burst-onboarding-kit.tar.gz</a>.
          </p>
        </div>
      )}
    </article>
  );
}
