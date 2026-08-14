"use client";

import Link from "next/link";
import { type FormEvent, useMemo, useState } from "react";
import type {
  NearbyClientRequest,
  NearbyClientResponse,
  NearbyClientResult,
} from "@/lib/nws/contracts";
import styles from "./nearby.module.css";

const FIRST_PAGE_SIZE = 20;
const PAGE_SIZE = 20;
const US_ZIP_PATTERN = /^\d{5}(?:-\d{4})?$/;

const COMPONENT_LABELS = {
  cash_and_near_cash: "Cash and near cash",
  public_securities: "Public securities",
  private_business_equity: "Private business equity",
  real_estate_equity: "Real estate equity",
  other_assets: "Other assets",
  liabilities: "Liabilities",
} as const;

type ComponentKey = keyof typeof COMPONENT_LABELS;
type Component = NearbyClientResult["components"][ComponentKey];

type ViewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; data: NearbyClientResponse }
  | { kind: "error"; title: string; detail: string; retryable: boolean };

type RetryAction =
  | { kind: "request"; payload: NearbyClientRequest }
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

function componentStatus(component: Component): string {
  switch (component.status) {
    case "SUPPORTED":
      return "Supported";
    case "MODELED_RANGE":
      return "Modeled range";
    case "INCLUDED_IN_DECLARED_TOTAL":
      return "Included, not itemized";
    case "NOT_PROVIDED":
      return "Not provided";
    case "NOT_APPLICABLE":
      return "Not applicable";
    case "UNKNOWN":
      return "Unavailable";
  }
}

function componentValue(component: Component): string | null {
  if (
    component.low_usd === null ||
    component.high_usd === null ||
    component.most_likely_usd === null
  ) {
    return null;
  }
  return moneyRange(component.low_usd, component.high_usd);
}

function humanError(
  status: number,
  code: string | undefined,
): { title: string; detail: string; retryable: boolean } {
  if (status === 429 || code === "rate_limited") {
    return { title: "Too many searches", detail: "Try again shortly.", retryable: true };
  }
  if (status === 504 || code === "upstream_timeout") {
    return { title: "Search timed out", detail: "Try again.", retryable: true };
  }
  if (status === 503 || code === "service_unavailable") {
    return { title: "Source unavailable", detail: "Try again soon.", retryable: true };
  }
  if (status === 422 || code === "invalid_request") {
    return { title: "Check ZIP", detail: "Enter a valid U.S. ZIP.", retryable: false };
  }
  return {
    title: "Couldn’t search",
    detail: "Check your connection and try again.",
    retryable: true,
  };
}

async function requestNearby(payload: NearbyClientRequest): Promise<NearbyClientResponse> {
  const response = await fetch("/api/nws/nearby", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const body = (await response.json().catch(() => null)) as
    | NearbyClientResponse
    | { code?: string }
    | null;

  if (!response.ok || !body || !("results" in body)) {
    const mapped = humanError(response.status, body && "code" in body ? body.code : undefined);
    throw Object.assign(new Error(mapped.detail), { nearby: mapped });
  }
  return body;
}

function resultHeading(data: NearbyClientResponse): { title: string; detail: string } {
  if (data.coverage.status === "NOT_COVERED") {
    return { title: "Location not covered", detail: "Try another U.S. ZIP." };
  }
  if (data.coverage.status === "LOCATION_UNRESOLVED") {
    return { title: "Location unresolved", detail: "Check the ZIP and try again." };
  }
  if (
    data.source_status.some(
      (source) =>
        source.purpose === "FINANCIAL_EVIDENCE" && source.status === "UNAVAILABLE",
    )
  ) {
    return {
      title: "Financial source unavailable",
      detail: data.results.length > 0 ? "Results may be incomplete." : "Try again soon.",
    };
  }
  if (data.search.scope === "PUBLIC_JURISDICTION" && data.results.length === 0) {
    return {
      title: "No verified NWS",
      detail: "No matching public declarations in the current partial source.",
    };
  }
  if (data.financial_coverage.candidate_count === 0) {
    return { title: "No public candidates nearby", detail: "Try another ZIP." };
  }
  if (data.financial_coverage.status === "FINANCIAL_COVERAGE_INSUFFICIENT") {
    const count = data.financial_coverage.candidate_count;
    return {
      title: "Financial evidence unavailable",
      detail: `${count} nearby ${count === 1 ? "candidate lacks" : "candidates lack"} enough public evidence.`,
    };
  }
  if (data.results.length === 0) {
    return { title: "No scored people nearby", detail: "Try another ZIP." };
  }
  return {
    title: `${data.results.length} scored ${data.results.length === 1 ? "person" : "people"}`,
    detail: data.query.label,
  };
}

function sourceNotice(data: NearbyClientResponse): string | null {
  const unavailable = data.source_status.filter((source) => source.status === "UNAVAILABLE");
  if (unavailable.length === 0) return null;
  if (unavailable.some((source) => source.purpose === "FINANCIAL_EVIDENCE")) {
    return "Financial source unavailable. Some scores may be missing.";
  }
  return "Candidate source unavailable. Results may be incomplete.";
}

function ResultDetails({ result }: { result: NearbyClientResult }) {
  const liquid = result.liquid_wealth;
  const declaredTotal = result.estimated_net_worth.method === "DECLARED_TOTAL_SIMULATION";

  return (
    <div className={styles.detailBody} id={`nearby-detail-${result.person.id}`}>
      {declaredTotal ? (
        <p className={styles.declaredNote}>
          Disclosed total only. Components were not itemized.
        </p>
      ) : null}

      <div className={styles.componentList} aria-label="Net worth components">
        {(Object.keys(COMPONENT_LABELS) as ComponentKey[]).map((key) => {
          const component = result.components[key];
          const value = componentValue(component);
          return (
            <div className={styles.componentRow} key={key}>
              <span>{COMPONENT_LABELS[key]}</span>
              <span className={styles.componentMeasure}>
                {value ?? componentStatus(component)}
                {value && component.confidence !== null ? (
                  <small>{Math.round(component.confidence * 100)}% confidence</small>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>

      <div className={styles.liquidityRow}>
        <div>
          <span>Liquid wealth</span>
          <strong>
            {liquid.status === "AVAILABLE" && liquid.p10_usd !== null && liquid.p90_usd !== null
              ? moneyRange(liquid.p10_usd, liquid.p90_usd)
              : "Unavailable"}
          </strong>
        </div>
        <div>
          <span>
            {result.estimated_net_worth.method === "DECLARED_TOTAL_SIMULATION"
              ? "Declared-total coverage"
              : "Balance-sheet coverage"}
          </span>
          <strong>{Math.round(result.confidence.coverage * 100)}%</strong>
        </div>
        <div>
          <span>Liquidity score</span>
          <strong>{result.liquidity_score ?? "Unavailable"}</strong>
        </div>
      </div>

      <div className={styles.citations}>
        <p>Public sources</p>
        <ul>
          {result.sources.map((source) => (
            <li key={`${result.person.id}:${source.url}`}>
              <a href={source.url} target="_blank" rel="noopener noreferrer">
                {source.title}
              </a>
              <span>{source.publisher} · {formatDate(source.source_date)}</span>
            </li>
          ))}
        </ul>
      </div>
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

  const data = state.kind === "success" ? state.data : null;
  const visibleResults = useMemo(
    () => data?.results.slice(0, visibleCount) ?? [],
    [data, visibleCount],
  );

  async function runSearch(payload: NearbyClientRequest) {
    setInputError("");
    setVisibleCount(FIRST_PAGE_SIZE);
    setOpenResultId(null);
    setRetryAction({ kind: "request", payload });
    setState({ kind: "loading" });
    try {
      setState({ kind: "success", data: await requestNearby(payload) });
    } catch (error) {
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
    void runSearch({
      query: { postal_code: normalized, country_code: "US" },
      top_n: 100,
      initial_radius_km: 20,
      max_radius_km: 100,
      auto_expand: true,
    });
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
    setState({ kind: "loading" });
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        void runSearch({
          query: {
            latitude: coarsenCoordinate(coords.latitude),
            longitude: coarsenCoordinate(coords.longitude),
          },
          top_n: 100,
          initial_radius_km: 20,
          max_radius_km: 100,
          auto_expand: true,
        });
      },
      (error) => {
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
  const sourceWarning = data ? sourceNotice(data) : null;
  const partial = data?.financial_coverage.status === "PARTIAL";
  const partialSource = data?.result_set.reasons.some(
    (reason) => reason === "SOURCE_INDEX_PARTIAL" || reason === "SOURCE_RESULT_TRUNCATED",
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
          <p className={styles.lede}>Verified public financial disclosures.</p>

          <form className={styles.searchForm} onSubmit={submitPostal} noValidate>
            <div className={styles.searchRow}>
              <label className="sr-only" htmlFor="nearby-postal">U.S. ZIP code</label>
              <input
                id="nearby-postal"
                className={styles.input}
                inputMode="numeric"
                autoComplete="postal-code"
                placeholder="U.S. ZIP"
                value={postalCode}
                aria-invalid={Boolean(inputError)}
                aria-describedby={inputError ? "nearby-input-error nearby-privacy" : "nearby-privacy"}
                onChange={(event) => {
                  setPostalCode(event.target.value);
                  if (inputError) setInputError("");
                }}
              />
              <button className={styles.primaryButton} type="submit" disabled={state.kind === "loading"}>
                {state.kind === "loading" ? "Finding…" : "Find people"}
              </button>
              <button className={styles.secondaryButton} type="button" onClick={requestLocation} disabled={state.kind === "loading"}>
                Use location
              </button>
            </div>
            {inputError ? <p id="nearby-input-error" className={styles.inputError} role="alert">{inputError}</p> : null}
            <p id="nearby-privacy" className={styles.privacyNote}>Approximate location. Public filings only.</p>
          </form>
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
              {state.retryable && retryAction ? (
                <button
                  className={styles.primaryButton}
                  type="button"
                  onClick={() => {
                    if (retryAction.kind === "location") requestLocation();
                    else void runSearch(retryAction.payload);
                  }}
                >
                  Retry
                </button>
              ) : null}
              <button className={styles.secondaryButton} type="button" onClick={() => document.getElementById("nearby-postal")?.focus()}>
                Enter ZIP
              </button>
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

            {sourceWarning ? (
              <div className={styles.notice} role="status">
                <span>{sourceWarning}</span>
                {retryAction ? (
                  <button
                    className={styles.textButton}
                    type="button"
                    onClick={() => {
                      if (retryAction.kind === "location") requestLocation();
                      else void runSearch(retryAction.payload);
                    }}
                  >
                    Retry
                  </button>
                ) : null}
              </div>
            ) : null}

            {partialSource ? (
              <p className={styles.partialNote} role="status">Source roster is partial</p>
            ) : partial && data.financial_coverage.insufficient_evidence_count > 0 ? (
              <p className={styles.partialNote} role="status">
                Partial coverage · {data.financial_coverage.insufficient_evidence_count} without enough public evidence
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
                          <span className={styles.rank} aria-label={`Rank ${result.rank}`}>{result.rank}</span>
                          <div className={styles.identity}>
                            <h3>{result.person.name}</h3>
                            <p>{[result.person.headline, result.person.organization].filter(Boolean).join(" · ")}</p>
                          </div>
                          <div className={styles.worth}>
                            <strong>{moneyRange(result.estimated_net_worth.p10_usd, result.estimated_net_worth.p90_usd)}</strong>
                            <span>Estimated net worth</span>
                          </div>
                          <div className={styles.scorePair}>
                            <div>
                              <strong>{result.nws.value}</strong>
                              <span>NWS · 100</span>
                            </div>
                            <div>
                              <strong>{result.confidence.grade}</strong>
                              <span>Confidence · {Math.round(result.confidence.score * 100)}%</span>
                            </div>
                          </div>
                          <div className={styles.relationship}>
                            <p>{result.location_relationship.label}</p>
                            <span>{result.location_relationship.approximate_distance_band}</span>
                          </div>
                          <div className={styles.update}>
                            <span>Updated</span>
                            <strong>
                              {result.financial_update_precision === "YEAR"
                                ? result.last_financial_update
                                : formatDate(result.last_financial_update)}
                            </strong>
                          </div>
                          <button
                            className={styles.detailToggle}
                            type="button"
                            aria-expanded={isOpen}
                            aria-controls={`nearby-detail-${result.person.id}`}
                            onClick={() => setOpenResultId((current) => current === result.person.id ? null : result.person.id)}
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
                <button className={styles.secondaryButton} type="button" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>
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
