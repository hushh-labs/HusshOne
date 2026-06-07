"use client";

/**
 * Client behaviour beacon. Fire-and-forget event to /api/one/events with a
 * per-tab sessionId so the funnel (landing → sign-in → scan → dashboard) and
 * drop-off can be reconstructed in Log Analytics. Never throws, never blocks.
 */
let cachedSessionId: string | null = null;

function sessionId(): string {
  if (cachedSessionId) return cachedSessionId;
  const fallback = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  try {
    const key = "one_sid";
    let value = window.sessionStorage.getItem(key);
    if (!value) {
      value = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : fallback;
      window.sessionStorage.setItem(key, value);
    }
    cachedSessionId = value;
  } catch {
    cachedSessionId = fallback;
  }
  return cachedSessionId;
}

export function track(event: string, props?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  try {
    const body = JSON.stringify({ event, sessionId: sessionId(), props });
    void fetch("/api/one/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // analytics must never affect the user experience
  }
}
