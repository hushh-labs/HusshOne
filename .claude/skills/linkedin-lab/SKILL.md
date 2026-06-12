---
name: linkedin-lab
description: >-
  Run and work on the LinkedIn OAuth 2.0 lab at /labs/linkedin — the local-only
  page that signs in with a real LinkedIn account and dumps exactly what every
  scope returns (OIDC userinfo, decoded id_token, and a per-scope read battery
  incl. /identityMe and /verificationReport). Use whenever someone says "run /
  open the LinkedIn lab", "test LinkedIn sign-in / OAuth", "what does each
  LinkedIn scope return", "what's in basicInfo.profileUrl", "the linkedin lab
  page", "check r_profile_basicinfo / r_verify / identityMe / verificationReport",
  or wants to edit/verify that page. Encodes the one thing that's easy to get
  wrong (it MUST run on port 3000 because the redirect URI is registered there),
  the env it needs, the scopes, and how to preview the connected view WITHOUT a
  real OAuth round-trip.
---

# LinkedIn OAuth 2.0 lab (/labs/linkedin)

A standalone, **local-only** experiment — deliberately isolated from the app's
Firebase/Google auth and from the research pipeline. It runs the OAuth
authorization-code flow against a real LinkedIn app, then shows, per scope, the
verbatim API response (successes AND errors). It's how we answer "what can we
actually get from LinkedIn with the scopes we're approved for".

## Launch it — port 3000 is non-negotiable

```
preview_start  → config "linkedin-lab"   (port 3000, OTEL off)
```
or `ONE_DISABLE_OTEL=true npm run dev -- --port 3000`.

**Why 3000 and not the 317x mock ports:** LinkedIn only redirects back to a
redirect URI that is registered in the LinkedIn app's Auth tab. The registered
one is `http://localhost:3000/api/linkedin/callback`. Run on any other port and
the callback fails. The `one-mock`/`one-research-mock` configs are for the main
One experience, **not** this lab — don't reach for them here.

Open: **http://localhost:3000/labs/linkedin**

## Env it needs (`.env.local`)

- `LINKEDIN_CLIENT_ID` + `LINKEDIN_CLIENT_SECRET` — **required**; without them
  `/api/linkedin/authorize` returns `config_error`. Confidential client: the
  token exchange runs server-side.
- `LINKEDIN_REDIRECT_URI` — optional; defaults to
  `http://localhost:3000/api/linkedin/callback`. Must match the LinkedIn app.
- `LINKEDIN_SCOPES` — optional override of the default requested scope set.

## Scopes

Only self-serve scopes work on a normal (non-partner) app; the page requests
these 6 by default and the callback **auto-drops** any scope LinkedIn rejects
(`unauthorized_scope_error`) and retries, so sign-in always completes:

`openid · profile · email · w_member_social · r_profile_basicinfo · r_verify`

- `openid/profile/email` → OIDC (Sign In with LinkedIn).
- `w_member_social` → write-only (post/comment/like); **no readable data**.
- `r_profile_basicinfo` → `/rest/identityMe` (name, email, **public profileUrl**, photo).
- `r_verify` → `/rest/verificationReport` (identity/workplace verification).
  > `r_profile_basicinfo` and `r_verify` are **dev-tier: app admins only** — they
  > return data only for members who are admins on the LinkedIn app, otherwise 403.

Everything else (Sales Nav, Marketing, org, legacy `r_liteprofile`, and the EU
**Member Data Portability** ~70-domain snapshot) needs a partner program and is
listed in the "Advanced" picker as gated → auto-dropped. Max data (full profile,
connections, DMA snapshot) needs LinkedIn partner approval **and** an EEA member.

## What the page shows once connected

- Identity header (avatar/name/email/sub) + **Copy all JSON** (the whole
  `/api/linkedin/me` response) + Disconnect.
- **Granted scopes** and **Access token** (masked) side by side.
- **Identity token (id_token)** — decoded OIDC claims (+ **Copy claims**); iss/aud
  sanity chips. Signature is NOT verified — display only.
- **Data by scope** — a responsive card grid; each readable scope is called live
  and its raw `{ok,status,data}` shown with a **Copy JSON** button. `profileUrl`
  lives in the `Profile details (/identityMe)` card.

## Files

- UI: `src/app/labs/linkedin/LinkedInLab.tsx` (+ `page.tsx`, `LinkedInLab.test.tsx`)
- Routes: `src/app/api/linkedin/{authorize,callback,me,logout,session}/route.ts`
- Lib: `src/lib/linkedin/oauth.ts` (scope catalog, token exchange, JWT decode,
  `DATA_PROBES` = the per-scope battery) and `profile.ts`

## Preview the connected view WITHOUT real OAuth (UI/layout work)

The `/api/linkedin/me` route reads any `li_token` cookie (httpOnly only blocks
JS-read, not the server). Seed a dummy one to render the whole connected layout —
the live probes return `401 INVALID_ACCESS_TOKEN`, which is fine when you're
verifying layout/markup, not data. In `preview_eval`:

```js
const tok = { access_token: "DEMO_layout_only_000000",
  scope: "openid profile email w_member_social r_profile_basicinfo r_verify",
  token_type: "Bearer", expires_at: Date.now() + 3600e3,
  has_id_token: false, has_refresh_token: false };
document.cookie = "li_token=" + encodeURIComponent(JSON.stringify(tok)) + "; path=/";
window.location.reload();
```
The page's scroll container is `<main>` (globals.css locks `body{overflow:hidden}`),
so scroll with `document.querySelector('main').scrollTop = N`, not `window.scrollTo`.
**Clean up after:** `document.cookie = "li_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";`
so a later real sign-in isn't reading a stale fake token.

For a real, data-bearing connected view there's no shortcut — click **Sign in
with LinkedIn** and complete consent.

## Tests / typecheck

```
npx vitest run src/app/labs/linkedin src/lib/linkedin
npx tsc --noEmit -p tsconfig.json   # all inline-styled, no CSS files
```

## Gotchas

- **Wrong port** → callback never matches the registered redirect URI.
- **Vertex Gemini grounding can't read a bare LinkedIn URL** (blocked / wrong
  person) — this lab is the authenticated, first-party way to get LinkedIn facts;
  don't expect grounding to substitute for it.
- This is an experiment, **not** wired into prod auth. Don't deploy it as a
  user-facing flow without partner review.
