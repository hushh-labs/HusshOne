#!/usr/bin/env bash
# Smoke the deployed RIA Identity API from the public internet.
#
# Everything this script asks for is FIRM-LEVEL public record. Adviser names are withheld by
# default and printed only with SHOW_PEOPLE=1 — the service exists to let one person claim
# their OWN profile, and an operator smoke test has no reason to dump a roster to a terminal
# (or to a CI log) to prove the endpoint is up.
#
# It also carries one real regression check: /v1/firms/{crd} must never return person names.
# The shipped version did — it handed back the firm's whole Form ADV Schedule A, every owner
# and executive officer by name, title and ownership band, on a route keyed by a small
# sequential integer. If that ever comes back, this exits non-zero.
set -euo pipefail

PROJECT="${PROJECT:-hushh-tech-prod}"
ZONE="${ZONE:-us-central1-c}"
VM_NAME="${VM_NAME:-ria-identity-api-vm}"
STATIC_IP_NAME="${STATIC_IP_NAME:-ria-identity-api-ip}"

# A real, published main-office line: CRD 2907 NESTLERODE & LOY, INC., State College PA.
# Firm-level fact, straight off the firm's own adviserinfo.sec.gov page.
PHONE="${PHONE:-814-238-6249}"
FIRM_CRD="${FIRM_CRD:-2907}"

STATIC_IP="${STATIC_IP:-$(gcloud compute addresses describe "$STATIC_IP_NAME" --project "$PROJECT" --region "${ZONE%-*}" --format='value(address)' 2>/dev/null || true)}"
[[ -z "$STATIC_IP" ]] && { echo "Could not resolve static IP ($STATIC_IP_NAME). Deployed?" >&2; exit 1; }
BASE="${BASE:-https://ria-identity.${STATIC_IP}.sslip.io}"

KEY="${RIA_IDENTITY_API_KEY:-$(gcloud secrets versions access latest --secret=ria-identity-api-key --project "$PROJECT" 2>/dev/null || true)}"
AUTH=(); [[ -n "$KEY" ]] && AUTH=(-H "Authorization: Bearer $KEY")

FAILED=0
note_fail() { echo "  FAIL: $*"; FAILED=1; }

echo "== $BASE =="

# --- /health (open, no key) ----------------------------------------------------------------
echo "-- /health --"
curl -fsS -m 20 "$BASE/health" | jq '{
  ok,
  formAdvDb: .sources.formAdvDb.reachable,
  dbLatencyMs: .sources.formAdvDb.latencyMs,
  places: .sources.places.configured,
  iapd: .sources.iapd.live,
  lastIngestAt: .freshness.lastIngestAt,
  ageDays: .freshness.ageDays,
  stale: .freshness.stale,
  hints
}' || note_fail "/health did not answer"

# --- the auth gate -------------------------------------------------------------------------
echo
echo "-- auth gate: /v1/claim/lookup WITHOUT a key should be 401 --"
CODE="$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$BASE/v1/claim/lookup?phone=$PHONE")"
echo "   got HTTP $CODE"
[[ "$CODE" == "401" ]] || note_fail "expected 401 without a key, got $CODE (is RIA_IDENTITY_API_KEY set on the VM?)"

# --- the main endpoint ---------------------------------------------------------------------
echo
echo "-- /v1/claim/lookup?phone=$PHONE (NDJSON) --"
SHOW_PEOPLE="${SHOW_PEOPLE:-0}" curl -fsS -N -m 90 "${AUTH[@]}" "$BASE/v1/claim/lookup?phone=$PHONE" | python3 -c '
import json, os, sys
show = os.environ.get("SHOW_PEOPLE") == "1"
seen_meta = False
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    f = json.loads(line); t = f.get("type")
    if t == "meta":
        seen_meta = True
        src = f.get("sources") or {}
        fresh = f.get("freshness") or {}
        print("  meta: outcome=%s confidence=%s nextStep=%s firms=%s candidates=%s" % (
            f.get("outcome"), f.get("confidence"), f.get("nextStep"),
            f.get("firmCount"), f.get("candidateCount")))
        print("        currentAdvisers=%s rosterMatchesInclFormer=%s truncated=%s" % (
            f.get("currentAdviserCount"), f.get("rosterMatchesIncludingFormer"), f.get("rosterTruncated")))
        print("        matchedOn=%s formAdv=%s placesCrd=%s placesScore=%s/%s" % (
            (f.get("firmMatch") or {}).get("matchedOn"),
            (src.get("formAdv") or {}).get("matched"),
            (src.get("places") or {}).get("crd"),
            (src.get("places") or {}).get("score"), (src.get("places") or {}).get("maxScore")))
        print("        formAdvAge=%s days stale=%s (feed %s)" % (
            fresh.get("ageDays"), fresh.get("stale"), fresh.get("sourceFile")))
        print("        verificationRequired=%s" % f.get("verificationRequired"))
        print("        %s" % f.get("explanation"))
    elif t == "firm":
        fm = f["firm"]; a = fm.get("address") or {}
        print("    firm: CRD %-8s %-38s %s, %s   phone=%s employees=%s scheduleAPersonCount=%s" % (
            fm.get("crd"), (fm.get("name") or "")[:38], a.get("city"), a.get("state"),
            fm.get("phone"), fm.get("totalEmployees"), fm.get("scheduleAPersonCount")))
    elif t == "candidate":
        c = f["candidate"]
        who = (c.get("name") or "?") if show else "<withheld: SHOW_PEOPLE=1 to print>"
        print("    #%-2s score=%-3s crd=%-9s %s" % (f.get("rank"), c.get("score"), c.get("individualCrd"), who))
    elif t == "done":
        print("  done in %sms  firms=%s candidates=%s upstreamSpent=%s" % (
            f.get("ms"), f.get("firms"), f.get("candidates"), (f.get("upstream") or {}).get("spent")))
    elif t == "error":
        print("  ERROR: %s" % f.get("error")); sys.exit(1)
if not seen_meta:
    print("  ERROR: no meta frame"); sys.exit(1)
' || note_fail "/v1/claim/lookup failed"

# --- disclosure regression: firm route must publish NO person names -------------------------
echo
echo "-- /v1/firms/$FIRM_CRD must return firm-level facts only --"
FIRM_JSON="$(curl -fsS -m 30 "${AUTH[@]}" "$BASE/v1/firms/$FIRM_CRD" || true)"
if [[ -z "$FIRM_JSON" ]]; then
  note_fail "/v1/firms/$FIRM_CRD did not answer"
else
  echo "$FIRM_JSON" | jq '{ok, crd, name: .firm.name, city: .firm.address.city, state: .firm.address.state,
    phone: .firm.phone, employees: .firm.totalEmployees, scheduleAPersonCount: .firm.scheduleAPersonCount,
    keys: (.firm | keys_unsorted | length), verificationRequired}'
  # The bug that shipped: `scheduleAPersons`, `indexed` and `live` echoed the raw records.
  if grep -Eq '"(scheduleAPersons|indexed|live)"[[:space:]]*:[[:space:]]*\[' <<<"$FIRM_JSON"; then
    note_fail "DISCLOSURE REGRESSION — /v1/firms/$FIRM_CRD returned a person-bearing array"
  else
    echo "   ok: no Schedule A person array in the response"
  fi
fi

# --- the anti-enumeration controls are actually on the wire --------------------------------
echo
echo "-- daily cap headers --"
HDRS="$(curl -sS -m 30 -D - -o /dev/null "${AUTH[@]}" "$BASE/v1/claim/lookup?phone=$PHONE&stream=off")"
grep -i '^x-ratelimit-daily' <<<"$HDRS" | sed 's/^/   /' || note_fail "daily cap headers missing"

# --- name fallback answers (synthetic name -> expected to find nobody) ----------------------
echo
echo "-- /v1/claim/search (synthetic name, so nobody real is returned) --"
curl -fsS -m 30 "${AUTH[@]}" "$BASE/v1/claim/search?name=Jane%20Q%20Adviser" \
  | jq '{ok, total, candidates: (.candidates | length), verificationRequired}' \
  || note_fail "/v1/claim/search failed"

# --- units ----------------------------------------------------------------------------------
echo
echo "-- units --"
gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" \
  --command 'sudo systemctl is-active cloud-sql-proxy ria-identity-api caddy || true'

echo
[[ $FAILED -eq 0 ]] && echo "All checks passed." || { echo "One or more checks FAILED."; exit 1; }
