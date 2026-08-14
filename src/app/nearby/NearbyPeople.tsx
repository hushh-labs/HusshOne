"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "firebase/auth";
import {
  completeGoogleRedirect,
  getFirebaseBearer,
  isFirebaseClientConfigured,
  makeDevUser,
  observeAuth,
  signInWithGoogle,
} from "@/lib/firebase/client";
import type {
  NearbyV4ClientRequest,
  NearbyV4ClientResponse,
  NearbyV4ClientResult,
} from "@/lib/nws/v4-contracts";
import styles from "./nearby.module.css";

const FIRST_PAGE_SIZE = 20;
const PAGE_SIZE = 20;
const US_ZIP_PATTERN = /^\d{5}(?:-\d{4})?$/;
const DEV_AUTH = process.env.NEXT_PUBLIC_ONE_ENABLE_DEV_AUTH === "true";

type ViewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; data: NearbyV4ClientResponse }
  | { kind: "error"; title: string; detail: string; retryable: boolean };

type RetryAction =
  | { kind: "request"; payload: NearbyV4ClientRequest }
  | { kind: "location" };

function coarsenCoordinate(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function compactMoney(value: number): string {
  const absolute = Math.abs(value);
  const sign = value < 0 ? "−" : "";
  const format = (divisor: number, suffix: string) => {
    const scaled = absolute / divisor;
    const digits = scaled >= 100 || Number.isInteger(scaled) ? 0 : 1;
    return `${sign}$${scaled.toFixed(digits).replace(/\.0$/, "")}${suffix}`;
  };

  if (absolute >= 1_000_000_000) return format(1_000_000_000, "B");
  if (absolute >= 1_000_000) return format(1_000_000, "M");
  if (absolute >= 1_000) return format(1_000, "K");
  return `${sign}$${absolute.toLocaleString("en-US")}`;
}

function moneyRange(low: number, high: number): string {
  return low === high ? compactMoney(low) : `${compactMoney(low)}–${compactMoney(high)}`;
}

function formatDate(value: string): string {
  if (/^\d{4}$/.test(value)) return value;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function humanError(
  status: number,
  code: string | undefined,
): { title: string; detail: string; retryable: boolean } {
  if (status === 401 || code === "authentication_required") {
    return { title: "Sign in required", detail: "Sign in to search.", retryable: false };
  }
  if (status === 429 || code === "rate_limited") {
    return { title: "Too many searches", detail: "Try again shortly.", retryable: true };
  }
  if (status === 504 || code === "upstream_timeout") {
    return { title: "Search timed out", detail: "Try again.", retryable: true };
  }
  if (status === 503 || code === "service_unavailable") {
    return { title: "Source unavailable", detail: "Try again soon.", retryable: true };
  }
  if (status === 409 || code === "coverage_unavailable") {
    return { title: "Coverage unavailable", detail: "Try another U.S. ZIP.", retryable: false };
  }
  if (status === 422 || code === "invalid_request") {
    return { title: "Check location", detail: "Try a valid U.S. ZIP.", retryable: false };
  }
  return {
    title: "Couldn’t search",
    detail: "Check your connection and try again.",
    retryable: true,
  };
}

async function requestNearby(
  payload: NearbyV4ClientRequest,
  authorization: string,
  signal: AbortSignal,
): Promise<NearbyV4ClientResponse> {
  const response = await fetch("/api/nws/v4/nearby", {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
    signal,
  });
  const body = (await response.json().catch(() => null)) as
    | NearbyV4ClientResponse
    | { code?: string }
    | null;

  if (!response.ok || !body || !("contract_version" in body) || !("results" in body)) {
    const mapped = humanError(response.status, body && "code" in body ? body.code : undefined);
    throw Object.assign(new Error(mapped.detail), { nearby: mapped });
  }
  return body;
}

function resultHeading(data: NearbyV4ClientResponse): { title: string; detail: string } {
  if (data.coverage.status === "NOT_COVERED") {
    return { title: "Outside U.S. coverage", detail: "Use a U.S. ZIP." };
  }
  if (data.coverage.status === "LOCATION_UNRESOLVED") {
    return { title: "Location not found", detail: "Try a U.S. ZIP." };
  }
  if (data.results.length === 0 && data.financial_coverage.discovered_count === 0) {
    return { title: "No public profiles", detail: "Try another U.S. ZIP." };
  }
  if (data.results.length === 0) {
    return {
      title: "No eligible NWS",
      detail: `${data.financial_coverage.discovered_count} found · ${data.result_set.shortfall_count} short`,
    };
  }
  return {
    title: `${data.results.length} NWS ${data.results.length === 1 ? "result" : "results"}`,
    detail: data.result_set.target_satisfied
      ? data.query.label
      : `${data.result_set.shortfall_count} short · ${data.query.label}`,
  };
}

function ResultDetails({ result }: { result: NearbyV4ClientResult }) {
  const rankRange =
    result.rank_interval.low === result.rank_interval.high
      ? `#${result.rank_interval.low}`
      : `#${result.rank_interval.low}–#${result.rank_interval.high}`;

  return (
    <div className={styles.detailBody} id={`nearby-detail-${result.person.id}`}>
      <dl className={styles.detailGrid}>
        <div>
          <dt>Association</dt>
          <dd>{result.location_relationship.label}</dd>
        </div>
        <div>
          <dt>Available-set rank</dt>
          <dd>{rankRange}</dd>
        </div>
        <div>
          <dt>Observed floor</dt>
          <dd>
            {result.observed_net_worth_floor.status === "AVAILABLE" &&
            result.observed_net_worth_floor.amount_usd !== null
              ? compactMoney(result.observed_net_worth_floor.amount_usd)
              : "Unavailable"}
          </dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatDate(result.last_financial_update)}</dd>
        </div>
      </dl>
      <p className={styles.sourceLine}>
        Sources · {result.source_families.join(", ")}
      </p>
      <p className={styles.associationNote}>Public association, not live presence.</p>
    </div>
  );
}

export default function NearbyPeople() {
  const [postalCode, setPostalCode] = useState("");
  const [inputError, setInputError] = useState("");
  const [state, setState] = useState<ViewState>({ kind: "idle" });
  const [visibleCount, setVisibleCount] = useState(FIRST_PAGE_SIZE);
  const [retryAction, setRetryAction] = useState<RetryAction | null>(null);
  const [openResultId, setOpenResultId] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(DEV_AUTH);
  const [signingIn, setSigningIn] = useState(false);
  const [user, setUser] = useState<User | null>(() =>
    DEV_AUTH ? (makeDevUser() as unknown as User) : null,
  );
  const requestSequence = useRef(0);
  const requestController = useRef<AbortController | null>(null);

  useEffect(() => {
    if (DEV_AUTH) return;
    const unsubscribe = observeAuth((nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
    });
    void completeGoogleRedirect().catch(() => {
      setAuthReady(true);
      setState({
        kind: "error",
        title: "Sign-in failed",
        detail: "Try again.",
        retryable: false,
      });
    });
    return unsubscribe;
  }, []);

  useEffect(
    () => () => {
      requestSequence.current += 1;
      requestController.current?.abort();
    },
    [],
  );

  const data = state.kind === "success" ? state.data : null;
  const visibleResults = useMemo(
    () => data?.results.slice(0, visibleCount) ?? [],
    [data, visibleCount],
  );

  async function signIn() {
    if (signingIn) return;
    if (!isFirebaseClientConfigured()) {
      setState({
        kind: "error",
        title: "Sign-in unavailable",
        detail: "Try again soon.",
        retryable: false,
      });
      return;
    }
    setSigningIn(true);
    try {
      const nextUser = await signInWithGoogle();
      if (nextUser) setUser(nextUser);
    } catch {
      setState({
        kind: "error",
        title: "Sign-in failed",
        detail: "Try again.",
        retryable: false,
      });
    } finally {
      setSigningIn(false);
    }
  }

  async function runSearch(payload: NearbyV4ClientRequest, retry: RetryAction) {
    if (!user) {
      setState({
        kind: "error",
        title: "Sign in required",
        detail: "Sign in to search.",
        retryable: false,
      });
      return;
    }

    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    const sequence = ++requestSequence.current;
    setInputError("");
    setVisibleCount(FIRST_PAGE_SIZE);
    setOpenResultId(null);
    setRetryAction(retry);
    setState({ kind: "loading" });

    try {
      const authorization = await getFirebaseBearer(user);
      if (!authorization) {
        throw Object.assign(new Error("Sign in to search."), {
          nearby: humanError(401, "authentication_required"),
        });
      }
      const response = await requestNearby(payload, authorization, controller.signal);
      if (sequence === requestSequence.current) {
        setState({ kind: "success", data: response });
      }
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        return;
      }
      if (sequence !== requestSequence.current) return;
      const mapped = (
        error as { nearby?: { title: string; detail: string; retryable: boolean } }
      ).nearby;
      setState({
        kind: "error",
        title: mapped?.title ?? "Couldn’t search",
        detail: mapped?.detail ?? "Check your connection and try again.",
        retryable: mapped?.retryable ?? true,
      });
    }
  }

  function submitPostal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = postalCode.trim();
    if (!US_ZIP_PATTERN.test(normalized)) {
      setInputError("Enter a valid U.S. ZIP.");
      return;
    }
    const payload: NearbyV4ClientRequest = {
      query: { postal_code: normalized, country_code: "US" },
      count: 100,
    };
    void runSearch(payload, { kind: "request", payload });
  }

  function requestLocation() {
    setInputError("");
    setRetryAction({ kind: "location" });
    if (!("geolocation" in navigator)) {
      setState({
        kind: "error",
        title: "Location unavailable",
        detail: "Enter a ZIP instead.",
        retryable: false,
      });
      return;
    }

    requestController.current?.abort();
    const locationSequence = ++requestSequence.current;
    setState({ kind: "loading" });
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        if (locationSequence !== requestSequence.current) return;
        const payload: NearbyV4ClientRequest = {
          query: {
            latitude: coarsenCoordinate(coords.latitude),
            longitude: coarsenCoordinate(coords.longitude),
          },
          count: 100,
          consent_granted: true,
        };
        void runSearch(payload, { kind: "location" });
      },
      (error) => {
        if (locationSequence !== requestSequence.current) return;
        const timedOut = error.code === error.TIMEOUT;
        setState({
          kind: "error",
          title: timedOut ? "Location timed out" : "Location not shared",
          detail: "Enter a ZIP instead.",
          retryable: timedOut,
        });
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    );
  }

  const heading = data ? resultHeading(data) : null;
  const partial = Boolean(
    data &&
      (!data.result_set.target_satisfied ||
        data.financial_coverage.status !== "AVAILABLE" ||
        !data.limitations.financial_coverage_nationwide),
  );

  return (
    <main className={styles.page}>
      <nav className={styles.nav} aria-label="Primary">
        <div className={styles.navInner}>
          <Link className={styles.brand} href="/">
            <span aria-hidden="true">🤫</span>
            <span>hussh</span>
          </Link>
          <span className={styles.sectionName}>Nearby</span>
        </div>
      </nav>

      <div className={styles.main}>
        <section className={styles.hero} aria-labelledby="nearby-title">
          <h1 id="nearby-title">Net worth nearby</h1>
          <p className={styles.lede}>Public financial signals by U.S. area.</p>

          {!authReady ? (
            <p className={styles.authStatus} aria-live="polite">Checking sign-in…</p>
          ) : !user ? (
            <div className={styles.authGate}>
              <button
                className={styles.primaryButton}
                type="button"
                onClick={() => void signIn()}
                disabled={signingIn}
              >
                {signingIn ? "Signing in…" : "Sign in"}
              </button>
              <p>Sign in to search.</p>
            </div>
          ) : (
            <form className={styles.searchForm} onSubmit={submitPostal} noValidate>
              <div className={styles.searchRow}>
                <label className="sr-only" htmlFor="nearby-postal">U.S. ZIP code</label>
                <input
                  id="nearby-postal"
                  className={styles.input}
                  inputMode="numeric"
                  autoComplete="postal-code"
                  maxLength={10}
                  placeholder="U.S. ZIP"
                  value={postalCode}
                  aria-invalid={Boolean(inputError)}
                  aria-describedby={
                    inputError ? "nearby-input-error nearby-privacy" : "nearby-privacy"
                  }
                  onChange={(event) => {
                    setPostalCode(event.target.value);
                    if (inputError) setInputError("");
                  }}
                />
                <button
                  className={styles.primaryButton}
                  type="submit"
                  disabled={state.kind === "loading"}
                >
                  {state.kind === "loading" ? "Finding…" : "Find people"}
                </button>
                <button
                  className={styles.secondaryButton}
                  type="button"
                  onClick={requestLocation}
                  disabled={state.kind === "loading"}
                >
                  Use location
                </button>
              </div>
              {inputError ? (
                <p id="nearby-input-error" className={styles.inputError} role="alert">
                  {inputError}
                </p>
              ) : null}
              <p id="nearby-privacy" className={styles.privacyNote}>
                Approximate location. Public records only.
              </p>
            </form>
          )}
        </section>

        {state.kind === "loading" ? (
          <section className={styles.results} aria-label="Finding people" aria-busy="true">
            {[0, 1, 2].map((item) => <div className={styles.skeleton} key={item} />)}
            <span className="sr-only">Finding people</span>
          </section>
        ) : null}

        {state.kind === "error" ? (
          <section className={styles.state} role="alert">
            <h2>{state.title}</h2>
            <p>{state.detail}</p>
            <div className={styles.stateActions}>
              {state.title.includes("Sign in") ? (
                <button className={styles.primaryButton} type="button" onClick={() => void signIn()}>
                  Sign in
                </button>
              ) : state.retryable && retryAction ? (
                <button
                  className={styles.primaryButton}
                  type="button"
                  onClick={() => {
                    if (retryAction.kind === "location") requestLocation();
                    else void runSearch(retryAction.payload, retryAction);
                  }}
                >
                  Retry
                </button>
              ) : null}
              {user ? (
                <button
                  className={styles.secondaryButton}
                  type="button"
                  onClick={() => document.getElementById("nearby-postal")?.focus()}
                >
                  Enter ZIP
                </button>
              ) : null}
            </div>
          </section>
        ) : null}

        {data && heading ? (
          <section className={styles.results} aria-live="polite" aria-label="Nearby net worth results">
            <header className={styles.resultHeader}>
              <div>
                <h2>{heading.title}</h2>
                <p>{heading.detail}</p>
              </div>
              {data.results.length > 0 ? <span>{formatDate(data.snapshot.as_of)}</span> : null}
            </header>

            {partial ? (
              <p className={styles.partialNote} role="status">
                Partial public coverage · {data.financial_coverage.eligible_count} eligible from {data.financial_coverage.discovered_count} found
              </p>
            ) : null}

            {visibleResults.length > 0 ? (
              <ol className={styles.list}>
                {visibleResults.map((result) => {
                  const isOpen = openResultId === result.person.id;
                  return (
                    <li className={styles.row} key={result.person.id}>
                      <article>
                        <div className={styles.rowSummary}>
                          <span className={styles.rank} aria-label={`Rank ${result.rank}`}>
                            {result.rank}
                          </span>
                          <div className={styles.identity}>
                            <h3>{result.person.name}</h3>
                            <p>
                              {[result.person.headline, result.person.organization]
                                .filter(Boolean)
                                .join(" · ")}
                            </p>
                          </div>
                          <div className={styles.worth}>
                            <strong>
                              {moneyRange(
                                result.estimated_net_worth.p10_usd,
                                result.estimated_net_worth.p90_usd,
                              )}
                            </strong>
                            <span>Net worth range</span>
                          </div>
                          <div className={styles.scorePair}>
                            <div>
                              <strong>{result.nws.value}</strong>
                              <span>
                                NWS · {result.nws.uncertainty.low}–{result.nws.uncertainty.high}
                              </span>
                            </div>
                            <div>
                              <strong>{result.confidence.grade}</strong>
                              <span>Confidence · {Math.round(result.confidence.score * 100)}%</span>
                            </div>
                          </div>
                          <button
                            className={styles.detailToggle}
                            type="button"
                            aria-expanded={isOpen}
                            aria-controls={`nearby-detail-${result.person.id}`}
                            onClick={() =>
                              setOpenResultId((current) =>
                                current === result.person.id ? null : result.person.id,
                              )
                            }
                          >
                            {isOpen ? "Close" : "Details"}
                          </button>
                        </div>
                        {isOpen ? <ResultDetails result={result} /> : null}
                      </article>
                    </li>
                  );
                })}
              </ol>
            ) : null}

            {data.results.length > visibleCount ? (
              <div className={styles.showMore}>
                <button
                  className={styles.secondaryButton}
                  type="button"
                  onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
                >
                  Show more
                </button>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </main>
  );
}
