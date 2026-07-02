# Consent & privacy

Every scan carries an explicit consent contract, and the intelligence it produces is bounded by fixed privacy guarantees — this page documents both.

The One Developer API is built for authorized self-audit. When you call `POST /api/v1/scan` you assert, by default, that you are permitted to research the subject, and you can narrow what the pipeline is allowed to do with two consent flags on the request body.

## The two consent flags

Both flags live on the scan request body and both default to `true`. Absent, `null`, or any truthy value is treated as `true`; only an explicit `false` (boolean, or the strings `false` / `0` / `no`) turns a flag off.

| Field | Type | Default | Effect when `false` |
| --- | --- | --- | --- |
| `consentAttestation` | boolean | `true` | Scan is rejected with `403` — no research is started and nothing is stored. |
| `socialPreferenceConsent` | boolean | `true` | Scan runs, but the preference/lifestyle layer is skipped — dossier only. |

### consentAttestation

By sending the request (or setting `consentAttestation: true`), the API-key holder attests that they are authorized to audit the named subject. This is the gate that permits the scan to run.

If you send `consentAttestation: false`, the request returns `403` with code `consent_required` and the scan is **not** started: no Deep Research job is created, no preference layer runs, and nothing is persisted for the subject.

```json
{
  "ok": false,
  "error": "consentAttestation must be true to run a scan.",
  "code": "consent_required"
}
```

> Note: the `403` check runs after the request body is validated and the provided profile URLs are scraped. That means any URLs you include may still be fetched during the request before the consent check rejects it. Nothing from that fetch is stored when the scan is rejected — but if you do not intend a scan to proceed, do not send profile URLs. To always start a scan, simply omit `consentAttestation` and leave it at its `true` default.

### socialPreferenceConsent

This flag gates the preference and lifestyle layer independently of the scan itself. With it left at `true` and a social feed present in the inputs, the per-subject preference/lifestyle pipeline is enabled alongside the dossier. Set it to `false` and the scan still runs and produces a dossier, but the preference layer is skipped.

```bash
# Dossier only — no preference/lifestyle layer.
curl -sS -X POST https://one.hushh.ai/api/v1/scan \
  -H "Authorization: Bearer $ONE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Ada Lovelace",
    "email": "ada@example.com",
    "zipCode": "94105",
    "socialPreferenceConsent": false
  }'
```

The `202` response echoes whether the preference layer was enabled for this scan:

```json
{
  "ok": true,
  "scanId": "…",
  "status": "running",
  "preferences": { "enabled": false, "status": "skipped" }
}
```

See [Start a scan](/docs/start-a-scan) for the full request body and [Preferences](/docs/preferences) for what the preference layer produces.

## Privacy guarantees

The scan reasons only over what is already public and visible for the subject. Concretely:

- **Public content only.** The pipeline uses publicly visible profile and web content. Private or access-gated profiles are reported as pending in the response and omitted from the scan rather than forced open.
- **No sensitive-trait inference.** Sensitive attributes — including health, religion, political affiliation, and skin tone — are never inferred.
- **No identification of others.** Other people appearing in the subject's photos are never identified.

These guarantees are properties of the pipeline itself; they hold regardless of the consent flags you send.

## Tenant isolation

Each subject is scoped to its own tenant. The preference/lifestyle layer runs against a per-subject synthetic user, so one subject's data never mixes with or leaks into another's — even when many subjects are scanned under the same API key.

## Related

- [Start a scan](/docs/start-a-scan) — the full request body, required fields, and consent flags in context.
- [Preferences](/docs/preferences) — what the preference/lifestyle layer produces when `socialPreferenceConsent` is on.
- [Error handling](/docs/error-handling) and [Status codes](/docs/status-codes) — including the `403 consent_required` response.
