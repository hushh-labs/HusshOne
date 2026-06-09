"use client";

/* Contains render errors so one bad result never blanks the whole app (the
   "This page couldn't load" / `sourceCards.length` crash). Shows a recoverable
   fallback, clears a possibly-stale recovered scan, and reports the crash to the
   server so it appears in Cloud Logging (one.ui.client_error). */

import { Component, type ReactNode } from "react";

export function reportClientError(message: string, source: string) {
  try {
    let sid = "anon";
    try {
      sid = window.localStorage.getItem("one_sid") || "anon";
    } catch {
      /* storage blocked — keep anon */
    }
    void fetch("/api/one/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "client_error",
        sessionId: sid,
        message: String(message || "").slice(0, 500),
        source: String(source || "").slice(0, 200),
      }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* error reporting must never throw */
  }
}

interface Props {
  children: ReactNode;
}
interface State {
  hasError: boolean;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    reportClientError(error?.message || "render error", "react_error_boundary");
    // A stale/old-shape recovered scan can crash render — drop it so a reload recovers cleanly.
    try {
      window.localStorage.removeItem("one_last_scan");
      window.localStorage.removeItem("one_active_scan");
    } catch {
      /* ignore */
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="screen hero screen-enter">
          <div className="content hero-copy">
            <p className="eyebrow">Something slipped</p>
            <h1 className="display" style={{ fontSize: "clamp(26px,4vw,44px)" }}>
              One couldn&apos;t show that.
            </h1>
            <p className="sub">A reload usually fixes it — your data is safe.</p>
            <div className="state-actions">
              <button
                className="cta"
                style={{ height: 56, fontSize: 16 }}
                onClick={() => window.location.reload()}
              >
                <span className="label">Reload</span>
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
