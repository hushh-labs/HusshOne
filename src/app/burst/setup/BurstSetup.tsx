"use client";

/* The productized "2-minute GCP setup" flow. Connect your own Google Cloud so One can
   borrow a supercomputer when your Mac needs more power. The key is validated against
   your project, then kept on your device — never on Hushh's servers. */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { User } from "firebase/auth";
import { getFirebaseBearer, isFirebaseClientConfigured, makeDevUser, observeAuth } from "@/lib/firebase/client";

interface SetupStep {
  id: string;
  title: string;
  description: string;
  commands?: string[];
  docUrl?: string;
}
interface SetupCheck {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn";
  detail: string;
}
interface Validation {
  ready: boolean;
  projectId: string | null;
  region: string;
  checks: SetupCheck[];
}

const DEV_AUTH = process.env.NEXT_PUBLIC_ONE_ENABLE_DEV_AUTH === "true";

export default function BurstSetup() {
  const [user, setUser] = useState<User | null>(() =>
    DEV_AUTH || !isFirebaseClientConfigured() ? (makeDevUser() as unknown as User) : null,
  );
  const [steps, setSteps] = useState<SetupStep[]>([]);
  const [serviceAccountJson, setServiceAccountJson] = useState("");
  const [projectId, setProjectId] = useState("");
  const [region, setRegion] = useState("us-central1");
  const [validation, setValidation] = useState<Validation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Dev / unconfigured: the initial state already holds the dev user — nothing to observe.
    if (DEV_AUTH || !isFirebaseClientConfigured()) return;
    return observeAuth(setUser);
  }, []);

  const authHeader = useCallback(async () => getFirebaseBearer(user), [user]);

  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const res = await fetch(`/api/one/burst/setup?region=${encodeURIComponent(region)}`, {
          headers: { Authorization: await authHeader() },
        });
        const json = await res.json();
        if (json.ok) setSteps(json.steps);
      } catch {
        /* steps are guidance; a fetch hiccup shouldn't block the page */
      }
    })();
  }, [user, region, authHeader]);

  const validate = useCallback(async () => {
    setBusy(true);
    setError(null);
    setValidation(null);
    try {
      const res = await fetch("/api/one/burst/setup/validate", {
        method: "POST",
        headers: { Authorization: await authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ byoc: { serviceAccountJson, projectId: projectId || undefined, region } }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Validation failed");
      setValidation(json as Validation);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }, [serviceAccountJson, projectId, region, authHeader]);

  const ready = validation?.ready ?? false;
  const canValidate = useMemo(() => serviceAccountJson.trim().length > 0 && !busy, [serviceAccountJson, busy]);

  return (
    <main style={S.page}>
      <div style={S.card}>
        <h1 style={S.h1}>Connect your cloud</h1>
        <p style={S.lede}>
          One uses your Mac first. When a job needs more power, it borrows a supercomputer from <b>your own</b>{" "}
          Google Cloud — on your bill, under your control. Takes about two minutes.
        </p>
        <p style={S.privacy}>
          🔒 Your key is checked against your project, then kept on your device. Hushh never stores it, and your
          data runs only in your own cloud.
        </p>

        {ready ? (
          <Success projectId={validation?.projectId ?? null} region={validation?.region ?? region} />
        ) : (
          <>
            <ol style={S.steps}>
              {steps.map((s, i) => (
                <li key={s.id} style={S.step}>
                  <span style={S.stepNum}>{i + 1}</span>
                  <div>
                    <div style={S.stepTitle}>{s.title}</div>
                    <div style={S.stepDesc}>{s.description}</div>
                    {s.commands?.length ? <pre style={S.code}>{s.commands.join("\n")}</pre> : null}
                    {s.docUrl ? (
                      <a style={S.link} href={s.docUrl} target="_blank" rel="noreferrer">
                        Open in Google Cloud →
                      </a>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>

            <label style={S.label}>Paste your Google Cloud key (JSON)</label>
            <textarea
              style={S.textarea}
              value={serviceAccountJson}
              onChange={(e) => setServiceAccountJson(e.target.value)}
              placeholder='{ "type": "service_account", "project_id": "…", "private_key": "…", "client_email": "…" }'
              spellCheck={false}
            />
            <div style={S.row}>
              <input style={S.input} value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="Project ID (optional)" />
              <input style={S.input} value={region} onChange={(e) => setRegion(e.target.value)} placeholder="Region" />
            </div>

            <button style={{ ...S.button, opacity: canValidate ? 1 : 0.5 }} disabled={!canValidate} onClick={validate}>
              {busy ? "Checking your cloud…" : "Connect & check"}
            </button>
            {error ? <p style={S.error}>{error}</p> : null}

            {validation ? <Checklist checks={validation.checks} /> : null}
          </>
        )}
      </div>
    </main>
  );
}

function Checklist({ checks }: { checks: SetupCheck[] }) {
  const icon = { pass: "✅", warn: "⚠️", fail: "⛔️" } as const;
  return (
    <ul style={S.checks}>
      {checks.map((c) => (
        <li key={c.id} style={S.check}>
          <span style={S.checkIcon}>{icon[c.status]}</span>
          <div>
            <div style={S.checkLabel}>{c.label}</div>
            <div style={S.checkDetail}>{c.detail}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Success({ projectId, region }: { projectId: string | null; region: string }) {
  return (
    <div style={S.success}>
      <div style={S.successCheck}>✅</div>
      <h2 style={S.h2}>You&rsquo;re set.</h2>
      <p style={S.lede}>
        One can now borrow a supercomputer from{" "}
        <b>{projectId ? `${projectId} (${region})` : "your cloud"}</b> whenever your Mac needs more power. It will
        keep work on your Mac by default, and only burst when it has to — and always tear the cloud machine down
        when it&rsquo;s done.
      </p>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { minHeight: "100vh", display: "flex", justifyContent: "center", padding: "48px 20px", background: "#0b0b0c", color: "#f5f5f7" },
  card: { width: "100%", maxWidth: 640 },
  h1: { fontSize: 34, fontWeight: 700, letterSpacing: -0.5, margin: "0 0 12px" },
  h2: { fontSize: 26, fontWeight: 700, margin: "8px 0" },
  lede: { fontSize: 17, lineHeight: 1.5, color: "#c7c7cc", margin: "0 0 12px" },
  privacy: { fontSize: 14, color: "#9a9aa2", margin: "0 0 24px" },
  steps: { listStyle: "none", padding: 0, margin: "0 0 28px", display: "grid", gap: 16 },
  step: { display: "flex", gap: 12, alignItems: "flex-start" },
  stepNum: { flex: "0 0 26px", height: 26, borderRadius: 13, background: "#1c1c1f", color: "#f5f5f7", display: "grid", placeItems: "center", fontSize: 13, fontWeight: 600 },
  stepTitle: { fontSize: 16, fontWeight: 600 },
  stepDesc: { fontSize: 14, color: "#9a9aa2", marginTop: 2 },
  code: { background: "#141416", border: "1px solid #232327", borderRadius: 8, padding: "10px 12px", fontSize: 12.5, overflowX: "auto", margin: "8px 0 0", whiteSpace: "pre-wrap" },
  link: { display: "inline-block", marginTop: 6, color: "#0a84ff", fontSize: 14, textDecoration: "none" },
  label: { display: "block", fontSize: 14, fontWeight: 600, margin: "0 0 8px" },
  textarea: { width: "100%", minHeight: 120, background: "#141416", border: "1px solid #232327", borderRadius: 10, color: "#f5f5f7", padding: 12, fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", resize: "vertical" },
  row: { display: "flex", gap: 12, margin: "12px 0" },
  input: { flex: 1, background: "#141416", border: "1px solid #232327", borderRadius: 10, color: "#f5f5f7", padding: "10px 12px", fontSize: 14 },
  button: { width: "100%", background: "#0a84ff", color: "#fff", border: "none", borderRadius: 12, padding: "14px 16px", fontSize: 16, fontWeight: 600, cursor: "pointer", marginTop: 4 },
  error: { color: "#ff6b6b", fontSize: 14, marginTop: 12 },
  checks: { listStyle: "none", padding: 0, margin: "20px 0 0", display: "grid", gap: 12 },
  check: { display: "flex", gap: 12, alignItems: "flex-start" },
  checkIcon: { fontSize: 18, lineHeight: "22px" },
  checkLabel: { fontSize: 15, fontWeight: 600 },
  checkDetail: { fontSize: 13.5, color: "#9a9aa2", marginTop: 2 },
  success: { textAlign: "center", padding: "24px 0" },
  successCheck: { fontSize: 56 },
};
