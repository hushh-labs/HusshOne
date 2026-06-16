"use client";

import { useEffect, useMemo, useState } from "react";
import type { User } from "firebase/auth";
import { completeGoogleRedirect, getFirebaseBearer, observeAuth, signInWithGoogle } from "@/lib/firebase/client";

type Status = "loading" | "signed_out" | "ready" | "approving" | "error";

export default function AuthorizeClient() {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [message, setMessage] = useState("Preparing secure one by hushh connector link...");
  const params = useMemo(() => {
    if (typeof window === "undefined") return {};
    return Object.fromEntries(new URLSearchParams(window.location.search).entries());
  }, []);

  useEffect(() => {
    let active = true;
    let cleanup: () => void = () => undefined;
    completeGoogleRedirect()
      .catch((error) => {
        if (!active) return;
        setMessage(error instanceof Error ? error.message : "Google sign-in did not complete.");
        setStatus("error");
      })
      .finally(() => {
        if (!active) return;
        const unsub = observeAuth((next) => {
          if (!active) return;
          setUser(next);
          setStatus(next ? "ready" : "signed_out");
          setMessage(next ? `Continue as ${next.email || next.displayName || "your one.hushh.ai account"}` : "Sign in to one.hushh.ai to continue.");
        });
        cleanup = unsub;
      });
    return () => {
      active = false;
      cleanup();
    };
  }, []);

  async function signIn() {
    setStatus("loading");
    setMessage("Opening Google sign-in...");
    try {
      const signedIn = await signInWithGoogle();
      if (signedIn) {
        setUser(signedIn);
        setStatus("ready");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Google sign-in failed.");
      setStatus("error");
    }
  }

  async function approve() {
    if (!user) return signIn();
    setStatus("approving");
    setMessage("Linking one by hushh to ChatGPT...");
    try {
      const authorization = await getFirebaseBearer(user);
      const res = await fetch("/api/openai/oauth/approve", {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; redirectTo?: string; error?: string };
      if (!res.ok || !data.redirectTo) throw new Error(data.error || "Could not create connector authorization code.");
      window.location.href = data.redirectTo;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not link one by hushh connector.");
      setStatus("error");
    }
  }

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "#f7f7f4", color: "#171717" }}>
      <section style={{ width: "min(480px, 100%)", border: "1px solid #dedbd2", background: "#fff", padding: 28, borderRadius: 8 }}>
        <p style={{ margin: "0 0 8px", fontSize: 13, color: "#6b665d" }}>one by hushh connector</p>
        <h1 style={{ margin: "0 0 12px", fontSize: 28, lineHeight: 1.15 }}>Link one by hushh with ChatGPT</h1>
        <p style={{ margin: "0 0 20px", color: "#46433d", lineHeight: 1.5 }}>{message}</p>
        <button
          type="button"
          onClick={status === "signed_out" || !user ? signIn : approve}
          disabled={status === "loading" || status === "approving"}
          style={{
            width: "100%",
            minHeight: 44,
            border: 0,
            borderRadius: 6,
            background: "#111",
            color: "#fff",
            fontSize: 15,
            fontWeight: 700,
            cursor: status === "loading" || status === "approving" ? "wait" : "pointer",
          }}
        >
          {status === "signed_out" || !user ? "Continue with Google" : status === "approving" ? "Linking..." : "Continue to ChatGPT"}
        </button>
        {status === "error" ? (
          <p style={{ margin: "14px 0 0", color: "#a33", fontSize: 13 }}>Please retry after fixing the sign-in or connector setup issue.</p>
        ) : null}
      </section>
    </main>
  );
}
