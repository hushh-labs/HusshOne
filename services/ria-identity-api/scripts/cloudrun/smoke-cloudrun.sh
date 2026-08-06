#!/usr/bin/env bash
# Post-deploy smoke for the Cloud Run deployment of the RIA Identity API.
#
# Sibling of scripts/gcp-vm/test-vm-api.sh, and it carries the same discipline:
#
#   * Everything it ASKS for is firm-level public record. Adviser names are withheld from the
#     terminal by default and printed only with SHOW_PEOPLE=1. An operator proving the endpoint
#     is up has no reason to dump a roster into a CI log.
#   * It carries the real regression check: /v1/firms/{crd} MUST NOT disclose person names. The
#     shipped version did — it handed back the firm's whole Form ADV Schedule A, every owner and
#     executive officer by name, title and ownership band, on a route keyed by a small
#     sequential integer that can be walked. If that ever comes back, this exits non-zero.
#
# Plus three things that only exist on the Cloud Run path:
#
#   * It ASSERTS min-instances=0. That is the reason this deployment exists — the owner does not
#     want to pay for an idle service — and it is one `gcloud run services update` away from
#     being silently switched off with no error and no alert, only a bill.
#   * It measures the COLD START, which is the cost of scale-to-zero and the thing a caller
#     actually feels.
#   * It checks the Cloud SQL socket wiring (RIA_DB_HOST=/cloudsql/..., RIA_DB_PORT=5432).
#     Getting the port wrong is silent: the service starts happily and every lookup quietly
#     degrades to the Places-only path.
#
#   ./scripts/cloudrun/smoke-cloudrun.sh
#   SHOW_PEOPLE=1 ./scripts/cloudrun/smoke-cloudrun.sh     # print candidate names too
#   BASE=https://... KEY=... ./scripts/cloudrun/smoke-cloudrun.sh
set -euo pipefail

PROJECT="${PROJECT:-hushh-tech-prod}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-ria-identity-api}"
SHOW_PEOPLE="${SHOW_PEOPLE:-0}"

# A real, published main-office line: CRD 2907 NESTLERODE & LOY, INC., State College PA.
# Firm-level fact, straight off the firm's own adviserinfo.sec.gov page.
PHONE="${PHONE:-814-238-6249}"
FIRM_CRD="${FIRM_CRD:-2907}"

command -v python3 >/dev/null 2>&1 || { echo "python3 is required." >&2; exit 1; }

BASE="${BASE:-$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --format='value(status.url)' 2>/dev/null || true)}"
[[ -n "$BASE" ]] || { echo "Could not resolve the Cloud Run URL for $SERVICE in $PROJECT/$REGION. Deployed?" >&2; exit 1; }

KEY="${KEY:-${RIA_IDENTITY_API_KEY:-$(gcloud secrets versions access latest --secret=ria-identity-api-key --project "$PROJECT" 2>/dev/null || true)}}"
AUTH=(); [[ -n "$KEY" ]] && AUTH=(-H "Authorization: Bearer $KEY")

FAILED=0
note_fail() { echo "  FAIL: $*"; FAILED=1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== $BASE  ($PROJECT / $REGION / $SERVICE) =="

# --- 1. the deployment shape: scale-to-zero and the DB wiring ---------------------------------
echo
echo "-- service config --"
if gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format=json > "$TMP/svc.json" 2>/dev/null; then
  python3 - "$TMP/svc.json" <<'PY' || FAILED=1
import json, sys
svc = json.load(open(sys.argv[1]))
tmpl = svc["spec"]["template"]
ann  = tmpl["metadata"].get("annotations", {})
c    = tmpl["spec"]["containers"][0]
env  = {e["name"]: e for e in (c.get("env") or [])}
plain= {k: v.get("value") for k, v in env.items() if "value" in v}
secs = sorted(k for k, v in env.items() if "valueFrom" in v)

# minScale absent == 0 on Cloud Run, which is also scale-to-zero.
minscale = ann.get("autoscaling.knative.dev/minScale", "0")
maxscale = ann.get("autoscaling.knative.dev/maxScale")
sql      = ann.get("run.googleapis.com/cloudsql-instances", "")

print("   minScale=%s  maxScale=%s  concurrency=%s  cpu=%s  memory=%s" % (
    minscale, maxscale, tmpl["spec"].get("containerConcurrency"),
    (c.get("resources") or {}).get("limits", {}).get("cpu"),
    (c.get("resources") or {}).get("limits", {}).get("memory")))
print("   cloudsql=%s" % (sql or "<none>"))
print("   secrets injected: %s" % (", ".join(secs) or "<none>"))
print("   RIA_DB_ENABLED=%s  RIA_DB_HOST=%s  RIA_DB_PORT=%s  TRUSTED_PROXY_COUNT=%s  DAILY_LOOKUP_CAP=%s" % (
    plain.get("RIA_DB_ENABLED"), plain.get("RIA_DB_HOST"), plain.get("RIA_DB_PORT"),
    plain.get("TRUSTED_PROXY_COUNT"), plain.get("DAILY_LOOKUP_CAP")))

bad = []
# THE COST REQUIREMENT. A warm instance is billed around the clock; that is the entire reason
# this deployment exists instead of the VM.
if str(minscale) != "0":
    bad.append("min-instances is %s, NOT 0 — this service is being billed while idle" % minscale)
if not maxscale:
    bad.append("no max-instances set — nothing caps a runaway autoscale")

# Cloud SQL is OPTIONAL in config.mjs: a deployment with RIA_DB_ENABLED=off and no attached
# instance is a supported standalone mode (live Places -> IAPD answers the same question), not
# a broken one. Only assert the socket wiring when this deployment claims to have a database.
db_mode = str(plain.get("RIA_DB_ENABLED") or "auto").strip().lower()
if db_mode in ("off", "0", "false", "no", "disabled", "disable"):
    print("   NOTE: RIA_DB_ENABLED=off — no-database mode. Skipping the Cloud SQL socket checks.")
else:
    if not sql:
        bad.append("no Cloud SQL instance attached (--add-cloudsql-instances) but RIA_DB_ENABLED is %r" % db_mode)
    host, port = plain.get("RIA_DB_HOST") or "", str(plain.get("RIA_DB_PORT") or "")
    if not host.startswith("/cloudsql/"):
        bad.append("RIA_DB_HOST is %r — Cloud Run has no Auth Proxy, it needs the /cloudsql/<conn> socket" % host)
    elif port != "5432":
        # pg connects to ${host}/.s.PGSQL.${port}; Cloud Run creates .s.PGSQL.5432 only.
        bad.append("RIA_DB_PORT is %s — over the Cloud SQL socket it must be 5432, or every query ENOENTs" % port)
if str(plain.get("TRUSTED_PROXY_COUNT")) not in ("1", "2"):
    bad.append("TRUSTED_PROXY_COUNT is %r (1 for bare Cloud Run, 2 behind an external HTTPS LB)" % plain.get("TRUSTED_PROXY_COUNT"))
for want in ("RIA_IDENTITY_API_KEY", "RIA_DB_PASSWORD", "PLACES_API_KEY"):
    if want not in secs:
        bad.append("%s is not injected from Secret Manager" % want)

for b in bad:
    print("  FAIL: %s" % b)
sys.exit(1 if bad else 0)
PY
else
  note_fail "could not describe the Cloud Run service"
fi

# --- 2. cold start, then warm ----------------------------------------------------------------
# The first number is what scale-to-zero costs a caller; the second is the steady state. This is
# informational — a slow cold start is a trade-off, not a failure.
echo
echo "-- /health (open, no key) --"
COLD="$(curl -s -m 60 -o "$TMP/health.json" -w '%{time_total}' "$BASE/health" || echo "0")"
WARM="$(curl -s -m 60 -o /dev/null    -w '%{time_total}' "$BASE/health" || echo "0")"
echo "   first request ${COLD}s (cold start if the service had scaled to zero) / second ${WARM}s"
python3 - "$TMP/health.json" <<'PY' || FAILED=1
import json, sys
try:
    h = json.load(open(sys.argv[1]))
except Exception as e:
    print("  FAIL: /health did not return JSON (%s)" % e); sys.exit(1)
src = h.get("sources") or {}
db  = src.get("formAdvDb") or {}
fr  = h.get("freshness") or {}
print("   ok=%s  formAdvDb.reachable=%s (%sms)  host=%s  places=%s" % (
    h.get("ok"), db.get("reachable"), db.get("latencyMs"), db.get("host"),
    (src.get("places") or {}).get("configured")))
print("   formAdv age=%s days  stale=%s" % (fr.get("ageDays"), fr.get("stale")))
for hint in h.get("hints") or []:
    print("   hint: %s" % hint)
if not h.get("ok"):
    print("  FAIL: /health reported ok=false"); sys.exit(1)
# The database being unreachable is DEGRADED, not down: the live Places -> IAPD path still
# resolves a phone and the service is designed to boot without it. Say so, do not fail.
if not db.get("reachable"):
    print("   NOTE: Cloud SQL is unreachable — lookups fall back to the live Places path only.")
    print("         Check --add-cloudsql-instances, RIA_DB_PORT=5432, and roles/cloudsql.client")
    print("         on the runtime service account.")
sys.exit(0)
PY

# --- 3. the auth gate -------------------------------------------------------------------------
echo
echo "-- auth gate: /v1/claim/lookup WITHOUT a key should be 401 --"
CODE="$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$BASE/v1/claim/lookup?phone=$PHONE")"
echo "   got HTTP $CODE"
if [[ "$CODE" != "401" ]]; then
  note_fail "expected 401 without a key, got $CODE (is RIA_IDENTITY_API_KEY bound via --set-secrets?)"
fi

if [[ -z "$KEY" ]]; then
  note_fail "no API key available (set KEY=… or grant access to secret ria-identity-api-key) — the authenticated checks below could not run"
  echo
  echo "One or more checks FAILED."
  exit 1
fi

# --- 4. one real lookup (buffered, so the same document can be reused in check 5) --------------
echo
echo "-- /v1/claim/lookup?phone=$PHONE --"
if ! curl -fsS -m 120 "${AUTH[@]}" -o "$TMP/lookup.json" "$BASE/v1/claim/lookup?phone=$PHONE&stream=off"; then
  note_fail "/v1/claim/lookup failed"
  : > "$TMP/lookup.json"
fi

# --- 5. the disclosure regression -------------------------------------------------------------
echo
echo "-- /v1/firms/$FIRM_CRD must return firm-level facts only --"
FIRM_HEADERS="$TMP/firm.headers"
if ! curl -fsS -m 60 "${AUTH[@]}" -D "$FIRM_HEADERS" -o "$TMP/firm.json" "$BASE/v1/firms/$FIRM_CRD"; then
  note_fail "/v1/firms/$FIRM_CRD did not answer"
  : > "$TMP/firm.json"
fi

SHOW_PEOPLE="$SHOW_PEOPLE" python3 - "$TMP/lookup.json" "$TMP/firm.json" <<'PY' || FAILED=1
import json, os, re, sys

show = os.environ.get("SHOW_PEOPLE") == "1"
failed = []

def load(path):
    try:
        raw = open(path).read()
        return raw, (json.loads(raw) if raw.strip() else None)
    except Exception as e:
        return "", None

lookup_raw, lookup = load(sys.argv[1])
firm_raw,  firm    = load(sys.argv[2])

# ---- the lookup answer, firm-level only ------------------------------------------------------
names = []
if lookup:
    meta = lookup.get("meta") or {}
    done = lookup.get("done") or {}
    print("   meta: outcome=%s confidence=%s nextStep=%s firms=%s candidates=%s" % (
        meta.get("outcome"), meta.get("confidence"), meta.get("nextStep"),
        meta.get("firmCount"), meta.get("candidateCount")))
    print("         currentAdvisers=%s rosterMatchesInclFormer=%s verificationRequired=%s" % (
        meta.get("currentAdviserCount"), meta.get("rosterMatchesIncludingFormer"),
        meta.get("verificationRequired")))
    fr = meta.get("freshness") or {}
    print("         formAdvAge=%s days stale=%s   done in %sms" % (
        fr.get("ageDays"), fr.get("stale"), done.get("ms")))
    for f in lookup.get("firms") or []:
        a = f.get("address") or {}
        print("    firm: CRD %-8s %-38s %s, %s  phone=%s employees=%s scheduleAPersonCount=%s" % (
            f.get("crd"), (f.get("name") or "")[:38], a.get("city"), a.get("state"),
            f.get("phone"), f.get("totalEmployees"), f.get("scheduleAPersonCount")))
    for i, c in enumerate(lookup.get("candidates") or [], 1):
        n = c.get("name")
        if n:
            names.append(n)
        print("    #%-2s score=%-3s crd=%-9s %s" % (
            i, c.get("score"), c.get("individualCrd"),
            (n or "?") if show else "<withheld: SHOW_PEOPLE=1 to print>"))
    if not meta:
        failed.append("/v1/claim/lookup returned no meta frame")
    elif meta.get("verificationRequired") is not True:
        failed.append("/v1/claim/lookup did not carry verificationRequired:true")
else:
    failed.append("/v1/claim/lookup returned nothing parseable")

# ---- /v1/firms/{crd}: no person names, by two independent tests ------------------------------
if firm:
    f = firm.get("firm") or {}
    a = f.get("address") or {}
    print("   firm: %s | %s, %s | phone=%s employees=%s scheduleAPersonCount=%s | keys=%d verificationRequired=%s" % (
        (f.get("name") or "")[:44], a.get("city"), a.get("state"), f.get("phone"),
        f.get("totalEmployees"), f.get("scheduleAPersonCount"), len(f), firm.get("verificationRequired")))

    # (a) STRUCTURAL — the exact bug that shipped: `scheduleAPersons` / `indexed` / `live`
    #     echoed raw person-bearing arrays.
    if re.search(r'"(scheduleAPersons|indexed|live)"\s*:\s*\[', firm_raw):
        failed.append("DISCLOSURE REGRESSION — /v1/firms returned a person-bearing array (scheduleAPersons/indexed/live)")

    # (b) STRUCTURAL, generalised — any array of objects that looks like a person list, whatever
    #     it is named. Catches a re-introduction under a new key.
    def person_arrays(node, path="$"):
        if isinstance(node, list):
            for item in node:
                if isinstance(item, dict) and "name" in item and (
                        {"title", "ownership", "ownershipCode", "scheduleA", "individualCrd", "crd"} & set(item)):
                    yield path
                    break
            for i, item in enumerate(node):
                yield from person_arrays(item, "%s[%d]" % (path, i))
        elif isinstance(node, dict):
            for k, v in node.items():
                yield from person_arrays(v, "%s.%s" % (path, k))
    hits = sorted(set(person_arrays(firm)))
    if hits:
        failed.append("DISCLOSURE REGRESSION — person-shaped array(s) at: %s" % ", ".join(hits))

    # (c) BY VALUE — the strongest test available, and it needs no fixture: every adviser the
    #     lookup legitimately named at this firm must be ABSENT from the firm route's body.
    #     Compared, never printed. Firm names are excluded from the haystack first: at CRD 2907
    #     ("NESTLERODE & LOY, INC.") an adviser surname legitimately appears inside the firm's
    #     own registered name, and matching on a single token would false-fail forever. Full
    #     multi-token person names do not appear in a firm name by accident.
    haystack = firm_raw
    for firm_name in {f.get("name"), (firm.get("firm") or {}).get("legalName")}:
        if firm_name:
            haystack = haystack.replace(firm_name, " ")
    leaked = 0
    checked = 0
    for n in names:
        toks = [t for t in re.split(r"[^A-Za-z]+", n) if len(t) > 1]
        if len(toks) < 2:
            continue          # a single token is not specific enough to assert on
        checked += 1
        if all(re.search(r"\b%s\b" % re.escape(t), haystack, re.I) for t in toks):
            leaked += 1
    if leaked:
        failed.append("DISCLOSURE REGRESSION — %d adviser name(s) from the lookup appear in the /v1/firms body" % leaked)
    elif checked:
        print("   ok: none of the %d adviser name(s) the lookup returned appear in /v1/firms" % checked)
    else:
        # R6: say what was NOT verified rather than implying coverage.
        print("   NOT VERIFIED by value: the lookup named no multi-token adviser for this firm.")
        print("        Structural checks (a) and (b) still ran and passed.")

    if firm.get("verificationRequired") is not True:
        failed.append("/v1/firms did not carry verificationRequired:true")
else:
    failed.append("/v1/firms returned nothing parseable")

for x in failed:
    print("  FAIL: %s" % x)
sys.exit(1 if failed else 0)
PY

# --- 6. the anti-enumeration controls are actually on the wire --------------------------------
echo
echo "-- daily cap headers on /v1/firms --"
if grep -i '^x-ratelimit-daily' "$FIRM_HEADERS" 2>/dev/null | sed 's/^/   /'; then :; else
  note_fail "daily cap headers missing — the disclosing route is not charging the cap"
fi
echo "   NOTE: on Cloud Run the cap is PER INSTANCE and resets when the instance scales to zero."
echo "         See the header of deploy-cloudrun.sh; the VM path is the stronger posture here."

echo
if [[ $FAILED -eq 0 ]]; then
  echo "All checks passed."
else
  echo "One or more checks FAILED."
  exit 1
fi
