# Frontend production-readiness boundary

Verified on 12 August 2026. This document records release evidence and known
external dependencies; it is not a simulated usability score.

## Current supported deployment

The frontend is suitable for a deployment-protected, single-tenant pilot:

- same-origin Vercel functions keep the backend URL and service token out of
  browser code;
- the local adapter exposes Hybrid RRF only and keeps CrossEncoder and LLM
  review outside the first-stage ranking path;
- dynamic source data is escaped, outbound links are HTTPS-only, static files
  are allow-listed locally, request/response sizes are bounded, and CSV export
  is protected against spreadsheet formula injection;
- profile creation and editing use the persistent repository contract; the
  JSONL adapter is for local or single-tenant operation only;
- liveness (`/api/health`) and model readiness (`/api/ready`) are separate.
  Uptime monitors and platform health probes must use `/api/health`, which
  answers from process state alone. `/api/ready` loads the retrieval engine if
  it is not already resident, so polling it repeatedly makes every check pay
  for a cold start; it is for a deliberate readiness check after deployment.

Production Vercel functions additionally require
`APPLICATION_ACCESS_MODE=deployment-protected`; this is a fail-closed deployment
acknowledgement, not a substitute for verifying the corresponding Vercel
dashboard setting.

## Public multi-user implementation boundary

The repository now contains the public multi-user code path: bundled MSAL
Browser Authorization Code + PKCE, strict delegated-token validation,
owner-scoped profile operations, PostgreSQL forced RLS, database-backed quotas
and application-data deletion. This code remains fail-closed until real Entra
and PostgreSQL resources are provisioned and the end-to-end release checks in
`deploy/azure-container-app.md` pass.

Public launch is sequenced, and each step assumes the previous one holds. Steps
4 and 6 must each land whole: a partial step 4 leaves accounts without
ownership, or ownership with no way to prove identity, and both states look
finished from the outside.

1. Keep Vercel Deployment Protection enabled. The deployment stays non-public
   until step 7 signs off. This is the control that currently substitutes for
   every missing user-facing check.
2. Configure Vercel WAF IP rate limits for profile writes, matching and AI
   review. While step 1 holds, this reaches no real attacker; its value is that
   the rules are written, deployed and observed well before they are load
   bearing. IP limits are evadable and are not what public launch rests on.
3. Choose and provision Microsoft Entra External ID and the hosted database.
   Settle the tenant model and the API audience/scope here, because both decide
   the storage schema and are expensive to revise later. Do not implement a
   local password database.
4. Configure and validate the implemented `@azure/msal-browser` email
   sign-up/sign-in with Authorization Code + PKCE; token verification on the
   profile, match and review routes; records keyed by the immutable provider
   subject; and owner-scoped profile CRUD. Email is a verified contact claim,
   not an ownership key. Shared canonical profiles stay read-only.
5. Validate the implemented PostgreSQL per-user quotas alongside the WAF
   limits from step 2. Verify 429 and `Retry-After` behaviour in the deployed
   environment.
6. Approve the retention, audit-log and Entra identity-deletion policy. Profile
   deletion and complete application-data deletion are implemented; deletion
   of the External ID directory object remains a governed tenant operation.
7. Pass browser E2E coverage for sign-up, email verification, sign-in, token
   expiry, owner isolation, profile persistence, admin export, sign-out,
   keyboard focus, mobile layout and the real Undaunted iframe. Only then
   remove Deployment Protection.

Vercel Authentication remains useful for protecting pilot deployments, but it
admits Vercel project viewers and is not an end-user account system. Vercel
Marketplace integrations can provision identity products; they do not add
application authorization or profile ownership automatically.

## Release checks

```bash
cd web_prototype
npm test

cd ..
.venv/bin/pytest -q tests/test_hybrid_server_static.py \
  tests/test_profile_store.py tests/test_user_profile.py
```

Before every deployment, also run the dependency audit in a network-enabled CI
job and verify the Vercel Deployment Protection and Firewall configuration in
the target project. A local green test cannot prove dashboard configuration.

Official implementation references:

- Microsoft Entra External ID self-service sign-up:
  https://learn.microsoft.com/en-us/entra/external-id/self-service-sign-up-overview
- MSAL Browser and Authorization Code + PKCE:
  https://learn.microsoft.com/en-us/entra/msal/javascript/browser/about-msal-browser
- Vercel Deployment Protection:
  https://vercel.com/docs/deployment-protection
- Vercel WAF rate limiting:
  https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting
