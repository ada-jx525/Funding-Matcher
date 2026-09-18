# Opportunity Atlas frontend

## Local Hybrid mode

From the repository root:

```bash
.venv/bin/python web_prototype/hybrid_server.py
```

Open `http://127.0.0.1:8765`. The first live search loads the existing MiniLM
dense retriever and cached corpus embeddings, then runs BM25 + dense RRF only.
CrossEncoder and LLM review are intentionally not loaded.

Profiles created in the browser and CLI use the same local JSONL repository.
They survive reference-server restarts, appear in the profile picker, can be
updated through the browser, and are included in the protected administrator
CSV export. This adapter is suitable for a local or single-tenant pilot; the
public service must replace it with the hosted tenant-aware repository described
below.

Run the frontend contract suite with:

```bash
cd web_prototype
npm test
```

The verified release boundary and remaining public-launch gates are maintained
in `PRODUCTION_READINESS.md`.

The current canonical query tokenizer and opportunity corpus are English-
language. Profile focus terms therefore require at least two English terms;
other profile fields may still contain international text.

`GET /api/health` is a lightweight liveness check. `GET /api/ready` loads the
corpus and model and returns readiness only after both succeed. The reference
server is deliberately restricted to loopback addresses: its threaded HTTP
server and local JSONL profile store are not a production hosting boundary.

## Vercel

Set `web_prototype` as the Vercel project Root Directory and configure:

- `HYBRID_API_BASE_URL`: externally hosted production backend implementing
  `/api/profiles`, `/api/matches`, `/api/health` and `/api/ready`. It may share
  the reference adapter's response contract, but must provide bounded request
  handling and a tenant-aware database rather than running `hybrid_server.py`.
- `HYBRID_API_TOKEN`: bearer token shared only by the Vercel proxy and backend.
  It is mandatory when `VERCEL_ENV=production`.
- `APPLICATION_ACCESS_MODE=deployment-protected`: explicit acknowledgement that the
  Vercel project is running as the protected pilot. Production API requests
  fail closed without this value. It does not prove the dashboard setting, so
  Deployment Protection must still be verified before release.

The repository includes a provider-neutral authentication boundary, a bundled
MSAL browser client and a Microsoft Entra token validator. Authentication stays
disabled and hidden until the Entra tenant and application roles are configured
and tested. Keep `AUTH_UI_ENABLED=false` until then. The variables are:

- `AUTH_ENABLED=true` and `AUTH_UI_ENABLED=true`
- `ENTRA_ISSUER`, `ENTRA_JWKS_URI` and `ENTRA_API_AUDIENCE` for server-side JWT
  verification
- `ENTRA_CLIENT_ID`, `ENTRA_AUTHORITY` and `ENTRA_API_SCOPE` for the browser
  sign-in adapter

`GET /api/admin/profiles.csv` requires a valid Entra access token containing the
`Admin` application role. Vercel validates that token, then forwards only the
minimal subject and role set over the separately authenticated backend channel.
The backend export route also fails closed when `HYBRID_API_TOKEN` is absent.
The production backend must reject those identity headers unless it has first
authenticated the service bearer token; the export route must never trust
client-supplied identity headers directly.
The current UI wiring is intentionally dormant; it does not provide a mock login
or an authentication bypass. In the protected pilot, matching, profile and
review routes rely on Vercel Deployment Protection rather than an application
user session. Vercel Authentication protects deployments for approved Vercel
viewers; it is not customer identity, self-service sign-up or profile ownership.

Keep Vercel Fluid Compute enabled for the AI review proxy, or configure a
function duration of at least 120 seconds on a plan that supports it.

The browser calls same-origin Vercel functions; backend URLs and tokens are not
included in client JavaScript. If the API is unavailable in production, the UI
shows an explicit failure rather than silently substituting sample rankings.

The Hybrid model is intentionally hosted outside Vercel: the Python/PyTorch
runtime and model artefacts are not a reliable fit for a serverless frontend
function. `hybrid_server.py` is the local/reference adapter; run an equivalent
authenticated service on the Imperial server or a container platform for a
public deployment.

The security policy permits framing only from `undaunted-hq.org` and its `www`
subdomain, so the Vercel UI can be embedded on the agreed Undaunted page without
being frameable by arbitrary sites.

## Public-launch boundary

The current interface is suitable for a protected pilot. The profile persistence
boundary is `ProfileRepository`; `ProfileStore` is its local JSONL adapter. Before
opening the product to multiple external customers, add an Azure-backed adapter
with tenant ownership behind `/api/profiles`. The local JSONL adapter is not a
multi-user production database.

For the pilot, enable Vercel Deployment Protection in the project settings and
add a Vercel Firewall rate-limit rule for `/api/matches`. Before public launch,
replace deployment-level protection with product login/session enforcement so
the API can return only profiles owned by the signed-in organisation.
