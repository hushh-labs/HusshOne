/**
 * Issuer detail from EDGAR's submissions API.
 *
 * This is where every location in this service comes from: the company's own business
 * address as filed with EDGAR. It is deliberately the ONLY address source — see the
 * reasoning in disclosure.mjs. A corporate headquarters is a public business location;
 * a filer's mailing address may be their home, and this service never touches it.
 */

import { config } from "./config.mjs";

/**
 * A minimal token bucket for outbound SEC calls.
 *
 * The SEC publishes a 10 requests/second ceiling and returns 403 to clients that
 * ignore it. Being throttled here is much cheaper than being blocked, so the default
 * is half their limit.
 */
class SecThrottle {
  constructor(perSecond) {
    this.intervalMs = 1000 / Math.max(1, perSecond);
    this.next = 0;
  }

  async wait() {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.intervalMs;
    if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
  }
}

const throttle = new SecThrottle(config.sec.requestsPerSecond);

/** CIKs are zero-padded to 10 digits in submissions URLs but not in the datasets. */
export const padCik = (cik) => String(cik || "").replace(/^0+/, "").padStart(10, "0");

/**
 * Fetch one issuer's public profile.
 *
 * Returns null on any upstream failure rather than throwing: a company whose address
 * we cannot resolve should drop out of a location search, not break the whole request.
 */
export async function fetchIssuer(cik, { fetchImpl = fetch } = {}) {
  await throttle.wait();

  const url = `${config.sec.submissionsBase}/CIK${padCik(cik)}.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.sec.timeoutMs);

  try {
    const response = await fetchImpl(url, {
      headers: { "user-agent": config.sec.userAgent, accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const body = await response.json();
    const business = body?.addresses?.business || {};

    return {
      cik: String(body.cik || cik).replace(/^0+/, ""),
      name: body.name || null,
      tickers: Array.isArray(body.tickers) ? body.tickers : [],
      exchanges: Array.isArray(body.exchanges) ? body.exchanges : [],
      sic: body.sic || null,
      sicDescription: body.sicDescription || null,
      // Business address only. `addresses.mailing` is not read.
      address: {
        street1: business.street1 || null,
        street2: business.street2 || null,
        city: business.city || null,
        state: business.stateOrCountry || null,
        zip: business.zipCode || null,
        isForeign: Boolean(business.isForeignLocation),
      },
      phone: body.phone || null,
      reportUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${padCik(cik)}&type=4`,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
