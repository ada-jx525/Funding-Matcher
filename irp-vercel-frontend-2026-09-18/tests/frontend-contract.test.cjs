const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const TEST_PRINCIPAL = Object.freeze({ userId: "entra:tenant:user", roles: [] });
const TEST_AUTH_ENV = Object.freeze({
  AUTH_ENABLED: "true",
  AUTH_UI_ENABLED: "true",
  ENTRA_ISSUER: "https://issuer.example/tenant/v2.0",
  ENTRA_JWKS_URI: "https://issuer.example/keys",
  ENTRA_API_AUDIENCE: "api://matcher",
  ENTRA_TENANT_ID: "tenant",
  ENTRA_REQUIRED_SCOPE: "access_as_user",
  ENTRA_ALLOWED_CLIENT_IDS: "client-id",
  ENTRA_CLIENT_ID: "client-id",
  ENTRA_AUTHORITY: "https://issuer.example/tenant",
  ENTRA_API_SCOPE: "api://matcher/access_as_user"
});

function source(file) {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

function browserLogic() {
  const context = vm.createContext({ URL, Intl, Date });
  vm.runInContext(source("data-adapter.js"), context);
  vm.runInContext(source("renderers.js"), context);
  return context;
}

function responseMock() {
  return {
    body: null,
    headers: {},
    statusCode: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      return value;
    },
    send(value) {
      this.body = value;
      return value;
    }
  };
}

test("authentication remains hidden and fail-closed until Entra is configured", async () => {
  const { authSettings, authenticatedUser, AuthError } = require("../lib/auth");
  const settings = authSettings({ AUTH_ENABLED: "false" });
  assert.equal(settings.enabled, false);
  assert.equal(settings.configured, false);
  assert.equal(settings.uiEnabled, false);
  assert.equal(authSettings({
    AUTH_ENABLED: "true",
    AUTH_UI_ENABLED: "true",
    ENTRA_ISSUER: "https://issuer.example/tenant/v2.0",
    ENTRA_JWKS_URI: "https://issuer.example/keys",
    ENTRA_API_AUDIENCE: "api://matcher"
  }).uiEnabled, false, "incomplete browser configuration must not expose sign-in");

  await assert.rejects(
    authenticatedUser(
      { headers: {} },
      { env: { AUTH_ENABLED: "true" }, verifyToken: async () => ({ sub: "ignored" }) }
    ),
    (error) => error instanceof AuthError && error.status === 503
  );
  assert.match(source("index.html"), /id="auth-controls" hidden/);
  assert.match(source("index.html"), />Sign in or create account</);
  assert.match(source("app.js"), /AUTH_CLIENT\.signIn/);
});

test("deployment-protected production uses the platform boundary for product routes only", async () => {
  const { AuthError } = require("../lib/auth");
  const { withApplicationPrincipal } = require("../lib/auth-proxy");
  let authenticationCalls = 0;
  const authenticate = async () => {
    authenticationCalls += 1;
    throw new AuthError(401, "Sign in is required.");
  };

  const pilotPrincipal = await withApplicationPrincipal(
    {},
    responseMock(),
    async (principal) => principal,
    {
      authenticate,
      environment: {
        VERCEL_ENV: "production",
        APPLICATION_ACCESS_MODE: "deployment-protected"
      }
    }
  );
  assert.equal(pilotPrincipal, null);
  assert.equal(authenticationCalls, 0);

  const publicPrincipal = await withApplicationPrincipal(
    {},
    responseMock(),
    async (principal) => principal,
    {
      authenticate: async () => TEST_PRINCIPAL,
      environment: {
        VERCEL_ENV: "production",
        APPLICATION_ACCESS_MODE: "public-authenticated"
      }
    }
  );
  assert.equal(publicPrincipal, TEST_PRINCIPAL);

  const account = require("../api/account").createHandler({ authenticate });
  const accountResponse = responseMock();
  await account({ method: "DELETE", headers: {} }, accountResponse);
  assert.equal(accountResponse.statusCode, 401);
  assert.equal(authenticationCalls, 1, "account deletion must never inherit the pilot bypass");
});

test("authentication rejects non-HTTPS identity-provider configuration", () => {
  const { authSettings } = require("../lib/auth");
  const base = { ...TEST_AUTH_ENV };
  assert.equal(authSettings(base).uiEnabled, true);
  assert.equal(authSettings({ ...base, ENTRA_JWKS_URI: "http://login.example/keys" }).configured, false);
  assert.equal(authSettings({ ...base, ENTRA_AUTHORITY: "javascript:alert(1)" }).uiEnabled, false);
});

test("token errors remain 401 while authentication service failures return 503", async () => {
  const { authenticatedUser, AuthError } = require("../lib/auth");
  const env = { ...TEST_AUTH_ENV };
  const request = { headers: { authorization: "Bearer test-token" } };

  await assert.rejects(
    authenticatedUser(request, {
      env,
      verifyToken: async () => {
        throw Object.assign(new Error("expired"), { code: "ERR_JWT_EXPIRED" });
      }
    }),
    (error) => error instanceof AuthError && error.status === 401
  );

  const logEntries = [];
  await assert.rejects(
    authenticatedUser(request, {
      env,
      verifyToken: async () => {
        throw Object.assign(new Error("JWKS timed out"), { code: "ERR_JWKS_TIMEOUT" });
      },
      logger: { error: (...entry) => logEntries.push(entry) }
    }),
    (error) => error instanceof AuthError && error.status === 503
  );
  assert.deepEqual(logEntries, [[
    "Authentication provider verification failed.",
    { name: "Error", code: "ERR_JWKS_TIMEOUT" }
  ]]);
});

test("application roles protect the administrator profile export", async () => {
  const { requireAdmin, AuthError } = require("../lib/auth");
  const env = { ...TEST_AUTH_ENV };
  const request = { headers: { authorization: "Bearer valid-token" } };

  await assert.rejects(
    requireAdmin(request, {
      env,
      verifyToken: async () => ({
        tid: "tenant", oid: "user-1", azp: "client-id",
        scp: "access_as_user", roles: ["User"]
      })
    }),
    (error) => error instanceof AuthError && error.status === 403
  );
  const admin = await requireAdmin(request, {
    env,
    verifyToken: async () => ({
      tid: "tenant", oid: "admin-1", azp: "client-id",
      scp: "access_as_user", roles: ["Admin"]
    })
  });
  assert.equal(admin.userId, "entra:tenant:admin-1");
});

test("delegated tokens must match tenant, client and scope", async () => {
  const { authenticatedUser, AuthError } = require("../lib/auth");
  const request = { headers: { authorization: "Bearer valid-token" } };
  const baseClaims = {
    tid: "tenant", oid: "user-1", azp: "client-id", scp: "access_as_user"
  };
  for (const claims of [
    { ...baseClaims, tid: "other-tenant" },
    { ...baseClaims, azp: "other-client" },
    { ...baseClaims, scp: "other_scope" },
    { ...baseClaims, oid: undefined }
  ]) {
    await assert.rejects(
      authenticatedUser(request, {
        env: { ...TEST_AUTH_ENV },
        verifyToken: async () => claims
      }),
      (error) => error instanceof AuthError && error.status === 401
    );
  }
});

function previewClient() {
  const storage = new Map();
  const context = vm.createContext({
    console,
    URL,
    AbortController,
    crypto: { randomUUID: () => "test-profile-id" },
    fetch: async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: "Not found." })
    }),
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value)
    },
    PROFILE_CONTEXT: {},
    PUBLIC_RESULTS: {
      baseline: [],
      llm: [{
        profile_id: "profile:1",
        results: [{
          opportunity: { id: "opp-1" },
          decision: {
            recommendation: "reference",
            suitable_for: { code: "beneficiaries", label: "Supported organisations" },
            reason: "The opportunity may fit supported organisations.",
            missing_information: ["Confirm applicant requirements"]
          }
        }]
      }]
    },
    document: {},
    window: {
      location: { protocol: "http:", hostname: "localhost" },
      setTimeout,
      clearTimeout
    }
  });
  vm.runInContext(`${source("api-client.js")}\nglobalThis.__api = MATCHER_API;`, context);
  return context.__api;
}

const validProfile = {
  name: "Blue Reef Ventures",
  source_type: "eso_profile",
  location: "Lisbon, Portugal",
  sector_focus: "coral restoration, marine monitoring",
  support_offered: "prototyping, investor introductions",
  support_stages: "Pre-Seed, Seed",
  geographies: "Europe, Africa",
  description: "We support early-stage teams building tools for coral reef monitoring."
};

test("profile adapter preserves canonical overview and programme semantics", () => {
  const context = browserLogic();
  const profile = context.normaliseProfile({
    profile_id: "programme:1",
    name: "Climate Programme",
    source_type: "programme_profile",
    overview: "Programme overview"
  });
  assert.equal(profile.description, "Programme overview");
  assert.equal(profile.actorType, "Programme");
  const html = context.renderProfile(profile);
  assert.match(html, /Programme operator location/);
  assert.match(html, /Programme support/);
  assert.match(html, /Participant stages/);
  assert.match(html, /Participant geographies/);
  assert.doesNotMatch(html, /Programme support &amp; participant stage/);
  assert.match(html, /Profile selected/);
  assert.match(html, /data-action="change-profile"/);
  assert.match(html, />Change</);
});

test("one malformed profile cannot take the whole catalogue offline", () => {
  const context = browserLogic();
  const catalogue = context.normaliseProfiles([
    { profile_id: "profile:1", name: "Valid profile" },
    { name: "Missing identifier" },
    { profile_id: "profile:1", name: "Duplicate profile" }
  ]);
  assert.equal(catalogue.profiles.length, 1);
  assert.equal(catalogue.profiles[0].name, "Valid profile");
  assert.equal(catalogue.rejectedCount, 2);
});

test("results are deduplicated and unsafe links are discarded", () => {
  const context = browserLogic();
  const opportunity = {
    id: "opp-1",
    title: "<script>alert(1)</script>",
    summary_preview: "A useful summary",
    source_url: "javascript:alert(1)"
  };
  const match = context.normaliseMatchResponse({
    results: [
      { rank: 1, opportunity },
      { rank: 2, opportunity }
    ]
  });
  assert.equal(match.results.length, 1);
  assert.equal(match.results[0].sourceUrl, "");
  const html = context.renderResult(match.results[0]);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(source("index.html"), /Rankings indicate relevance, not confirmed eligibility/);
});

test("source providers use public labels rather than internal identifiers", () => {
  const context = browserLogic();
  const match = context.normaliseMatchResponse({
    results: [{
      rank: 1,
      opportunity: {
        id: "eu-1",
        title: "Climate call",
        source_provider: "eu-funding-tenders"
      }
    }]
  });
  assert.equal(match.results[0].sourceProvider, "EU Funding & Tenders");
});

test("ranked results render as accessible expandable cards", () => {
  const context = browserLogic();
  const match = context.normaliseMatchResponse({
    results: [
      { rank: 1, opportunity: { id: "opp-1", title: "First opportunity", status: "Open", funding_type: "Grant", source_provider: "ukri" } },
      { rank: 2, opportunity: { id: "opp-2", title: "Second opportunity" } }
    ]
  });
  const html = context.renderResults(match.results);
  assert.match(html, /<details class="result-card"[^>]* open>/);
  assert.match(html, /<summary class="result-summary-row">/);
  assert.match(html, /<h3 class="result-title">First opportunity<\/h3>/);
  assert.match(html, /<h4>Description<\/h4>/);
  assert.match(html, /<dt>Status<\/dt><dd class="">Open<\/dd>/);
  assert.match(html, /<dt>Funding type<\/dt><dd class="">Grant<\/dd>/);
  assert.match(html, /<dt>Deadline<\/dt><dd class="deadline unknown">Not specified<\/dd>/);
  assert.match(html, /<dt>Source<\/dt><dd class="">UKRI<\/dd>/);
  assert.ok(html.indexOf("First opportunity") < html.indexOf("<h4>Description</h4>"));
  assert.doesNotMatch(html, /result-topline/);
  assert.doesNotMatch(html, /result-keyword/);
  assert.match(html, /data-result-id="opp-2">/);
  assert.doesNotMatch(html, /data-result-id="opp-2" open>/);

  const app = source("app.js");
  assert.match(app, /expanded: index === 0/);
  assert.match(app, /addEventListener\("toggle"/);
  assert.match(app, /result\.expanded = card\.open/);
});

test("Top-K supports direct input plus bounded preset choices", () => {
  const context = browserLogic();
  const app = source("app.js");
  const html = source("index.html");
  assert.equal(context.validTopK(3), 3);
  assert.equal(context.validTopK("17"), 17);
  assert.equal(context.validTopK(31), 30);
  assert.equal(context.validTopK(8, 6), 6);
  assert.equal(context.validTopK(0), 1);
  assert.equal(context.validTopK("not-a-number"), 10);
  assert.match(app, /topK: state\.topK/);
  assert.match(app, /match\.results\.slice\(0, state\.topK\)/);
  assert.match(html, /id="top-k-select" type="number" min="1" max="30"/);
  assert.match(html, /id="result-count-toggle"/);
  assert.match(html, /id="result-count-options" role="listbox"/);
  assert.match(app, /\[5, 10, 15, 20, 25, 30\]/);
  assert.match(app, /data-result-count/);
  assert.match(app, /toggleResultCountOptions/);
});

test("match proxy forwards custom result counts up to 30", async () => {
  const handler = require("../api/matches").createHandler({
    authenticate: async () => TEST_PRINCIPAL
  });
  const previous = {
    base: process.env.HYBRID_API_BASE_URL,
    token: process.env.HYBRID_API_TOKEN,
    vercel: process.env.VERCEL_ENV,
    fetch: global.fetch
  };
  let upstreamRequest;
  try {
    process.env.HYBRID_API_BASE_URL = "https://matcher.example";
    process.env.HYBRID_API_TOKEN = "test-token";
    process.env.VERCEL_ENV = "preview";
    global.fetch = async (url, options) => {
      upstreamRequest = { url, options };
      return { status: 200, json: async () => ({ results: [] }) };
    };
    let response = responseMock();
    await handler({ method: "POST", body: { profile_id: "profile:1", top_k: 17 } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(upstreamRequest.options.body).top_k, 17);

    response = responseMock();
    await handler({ method: "POST", body: { profile_id: "profile:1", top_k: 31 } }, response);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.error, /between 1 and 30/);

    response = responseMock();
    await handler({ method: "POST", body: { profile_id: "profile:1", top_k: "17" } }, response);
    assert.equal(response.statusCode, 400);
  } finally {
    if (previous.base === undefined) delete process.env.HYBRID_API_BASE_URL;
    else process.env.HYBRID_API_BASE_URL = previous.base;
    if (previous.token === undefined) delete process.env.HYBRID_API_TOKEN;
    else process.env.HYBRID_API_TOKEN = previous.token;
    if (previous.vercel === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previous.vercel;
    global.fetch = previous.fetch;
  }
});

test("preview profile create and update preserve one editable identity", async () => {
  const api = previewClient();
  const created = await api.createProfile(validProfile);
  assert.equal(created.mode, "preview");
  assert.equal(created.profile.profile_id, "user:test-profile-id");

  const updated = await api.updateProfile(created.profile.profile_id, {
    ...validProfile,
    name: "Blue Reef Network"
  });
  assert.equal(updated.profile.profile_id, created.profile.profile_id);
  assert.equal(updated.profile.name, "Blue Reef Network");
});

test("preview refuses to invent matches for a custom profile", async () => {
  const api = previewClient();
  await assert.rejects(
    api.match({ profileId: "user:unknown", searchText: "", topK: 5 }),
    /Live matching is required/
  );
});

test("client validation mirrors the English canonical token boundary", async () => {
  const api = previewClient();
  for (const sectorFocus of ["海洋 修复", "x y", "a-b"]) {
    await assert.rejects(
      api.createProfile({ ...validProfile, sector_focus: sectorFocus }),
      (error) => {
        assert.match(error.fieldErrors.sector_focus, /English focus terms/);
        return true;
      }
    );
  }
});

test("Vercel proxy fails closed for missing production configuration", async () => {
  const { proxy } = require("../lib/proxy");
  const previous = {
    base: process.env.HYBRID_API_BASE_URL,
    token: process.env.HYBRID_API_TOKEN,
    vercel: process.env.VERCEL_ENV,
    accessMode: process.env.PILOT_ACCESS_MODE
  };
  try {
    delete process.env.HYBRID_API_BASE_URL;
    let response = responseMock();
    await proxy({ method: "GET" }, response, "/api/ready", { methods: ["GET"] });
    assert.equal(response.statusCode, 503);

    process.env.HYBRID_API_TOKEN = "test-token";
    delete process.env.PILOT_ACCESS_MODE;
    response = responseMock();
    await proxy({ method: "GET" }, response, "/api/ready", { methods: ["GET"] });
    assert.equal(response.statusCode, 503, "production must explicitly confirm the protected-pilot boundary");

    process.env.VERCEL_ENV = "preview";
    response = responseMock();
    await proxy({ method: "GET" }, response, "/api/ready", { methods: ["GET"] });
    assert.equal(response.statusCode, 503, "remote preview upstreams also require the service token");

    process.env.HYBRID_API_BASE_URL = "https://matcher.example";
    process.env.VERCEL_ENV = "production";
    delete process.env.HYBRID_API_TOKEN;
    response = responseMock();
    await proxy({ method: "GET" }, response, "/api/ready", { methods: ["GET"] });
    assert.equal(response.statusCode, 503);
  } finally {
    if (previous.base === undefined) delete process.env.HYBRID_API_BASE_URL;
    else process.env.HYBRID_API_BASE_URL = previous.base;
    if (previous.token === undefined) delete process.env.HYBRID_API_TOKEN;
    else process.env.HYBRID_API_TOKEN = previous.token;
    if (previous.vercel === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previous.vercel;
    if (previous.accessMode === undefined) delete process.env.PILOT_ACCESS_MODE;
    else process.env.PILOT_ACCESS_MODE = previous.accessMode;
  }
});

test("upstream URLs cannot smuggle credentials or query state", () => {
  const { upstreamBaseUrl } = require("../lib/proxy");
  const common = { VERCEL_ENV: "preview", HYBRID_API_TOKEN: "secret" };
  assert.equal(
    upstreamBaseUrl({ ...common, HYBRID_API_BASE_URL: "https://user:pass@matcher.example" }).url,
    undefined
  );
  assert.equal(
    upstreamBaseUrl({ ...common, HYBRID_API_BASE_URL: "https://matcher.example?target=other" }).url,
    undefined
  );
  assert.equal(
    upstreamBaseUrl({ ...common, HYBRID_API_BASE_URL: "https://matcher.example" }).url.hostname,
    "matcher.example"
  );
});

test("health and readiness remain separate upstream contracts", async () => {
  const health = require("../api/health");
  const ready = require("../api/ready");
  const previous = {
    base: process.env.HYBRID_API_BASE_URL,
    token: process.env.HYBRID_API_TOKEN,
    fetch: global.fetch
  };
  const paths = [];
  try {
    process.env.HYBRID_API_BASE_URL = "https://matcher.example";
    process.env.HYBRID_API_TOKEN = "test-token";
    global.fetch = async (url) => {
      paths.push(new URL(url).pathname);
      return { status: 200, json: async () => ({ status: "ok" }) };
    };
    await health({ method: "GET" }, responseMock());
    await ready({ method: "GET" }, responseMock());
    assert.deepEqual(paths, ["/api/health", "/api/ready"]);
  } finally {
    if (previous.base === undefined) delete process.env.HYBRID_API_BASE_URL;
    else process.env.HYBRID_API_BASE_URL = previous.base;
    if (previous.token === undefined) delete process.env.HYBRID_API_TOKEN;
    else process.env.HYBRID_API_TOKEN = previous.token;
    global.fetch = previous.fetch;
  }
});

test("proxy rejects oversized upstream responses", async () => {
  const { proxy } = require("../lib/proxy");
  const previous = {
    base: process.env.HYBRID_API_BASE_URL,
    token: process.env.HYBRID_API_TOKEN,
    fetch: global.fetch
  };
  try {
    process.env.HYBRID_API_BASE_URL = "https://matcher.example";
    process.env.HYBRID_API_TOKEN = "test-token";
    global.fetch = async () => new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json", "Content-Length": String(4 * 1024 * 1024 + 1) }
    });
    const response = responseMock();
    await proxy({ method: "GET" }, response, "/api/ready", { methods: ["GET"] });
    assert.equal(response.statusCode, 502);
    assert.match(response.body.error, /too much data/);
  } finally {
    if (previous.base === undefined) delete process.env.HYBRID_API_BASE_URL;
    else process.env.HYBRID_API_BASE_URL = previous.base;
    if (previous.token === undefined) delete process.env.HYBRID_API_TOKEN;
    else process.env.HYBRID_API_TOKEN = previous.token;
    global.fetch = previous.fetch;
  }
});

test("proxy rejects a successful but unreadable upstream response", async () => {
  const { proxy } = require("../lib/proxy");
  const previous = {
    base: process.env.HYBRID_API_BASE_URL,
    token: process.env.HYBRID_API_TOKEN,
    fetch: global.fetch
  };
  try {
    process.env.HYBRID_API_BASE_URL = "https://matcher.example";
    process.env.HYBRID_API_TOKEN = "test-token";
    global.fetch = async () => new Response("not-json", {
      status: 200,
      headers: { "Content-Type": "text/plain" }
    });
    const response = responseMock();
    await proxy({ method: "GET" }, response, "/api/ready", { methods: ["GET"] });
    assert.equal(response.statusCode, 502);
    assert.match(response.body.error, /unreadable response/);
  } finally {
    if (previous.base === undefined) delete process.env.HYBRID_API_BASE_URL;
    else process.env.HYBRID_API_BASE_URL = previous.base;
    if (previous.token === undefined) delete process.env.HYBRID_API_TOKEN;
    else process.env.HYBRID_API_TOKEN = previous.token;
    global.fetch = previous.fetch;
  }
});

test("deployment contract excludes samples and allows only approved iframe origins", () => {
  const html = source("index.html");
  assert.doesNotMatch(html, /src=["'](?:sample-data|public-results-sample)\.js/);
  assert.match(html, /<form[^>]+id="profile-form"[^>]+novalidate/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "HTML IDs must be unique");
  for (const match of html.matchAll(/<label[^>]+for="([^"]+)"/g)) {
    assert.ok(ids.includes(match[1]), `label target #${match[1]} must exist`);
  }
  const ignored = source(".vercelignore").split(/\r?\n/);
  for (const excluded of ["public-results-sample.js", "hybrid_server.py", "tests/"]) {
    assert.ok(ignored.includes(excluded), `${excluded} must be excluded from deployment`);
  }

  const config = JSON.parse(source("vercel.json"));
  const securityHeaders = config.headers[0].headers;
  const csp = securityHeaders.find((header) => header.key === "Content-Security-Policy").value;
  assert.match(csp, /frame-ancestors 'self' https:\/\/undaunted-hq\.org https:\/\/www\.undaunted-hq\.org/);
  assert.doesNotMatch(csp, /frame-ancestors \*/);
});

test("frontend adapter remains Hybrid RRF only", () => {
  const server = source("hybrid_server.py");
  const service = fs.readFileSync(
    path.join(ROOT, "..", "src", "services", "matching_service.py"),
    "utf8"
  );
  assert.match(server, /MatchingService/);
  assert.match(service, /fusion_method="rrf"/);
  assert.match(service, /MAX_TOP_K = 30/);
  assert.match(service, /1 <= value <= MAX_TOP_K/);
  assert.doesNotMatch(server, /CrossEncoder\s*\(/);
  assert.doesNotMatch(service, /CrossEncoder\s*\(/);
  assert.doesNotMatch(server, /\.rerank\s*\(/);
  assert.doesNotMatch(service, /\.rerank\s*\(/);
});

test("profile PUT is forwarded to the authenticated upstream contract", async () => {
  const handler = require("../api/profiles").createHandler({
    authenticate: async () => TEST_PRINCIPAL
  });
  const previous = {
    base: process.env.HYBRID_API_BASE_URL,
    token: process.env.HYBRID_API_TOKEN,
    vercel: process.env.VERCEL_ENV,
    fetch: global.fetch
  };
  let upstreamRequest;
  try {
    process.env.HYBRID_API_BASE_URL = "https://matcher.example";
    process.env.HYBRID_API_TOKEN = "test-token";
    process.env.VERCEL_ENV = "preview";
    global.fetch = async (url, options) => {
      upstreamRequest = { url, options };
      return {
        status: 200,
        json: async () => ({ profile: { profile_id: "user:1" } })
      };
    };
    const response = responseMock();
    await handler(
      { method: "PUT", body: { profile_id: "user:1", name: "Updated" } },
      response
    );
    assert.equal(response.statusCode, 200);
    assert.equal(upstreamRequest.url, "https://matcher.example/api/profiles");
    assert.equal(upstreamRequest.options.method, "PUT");
    assert.equal(upstreamRequest.options.headers.Authorization, "Bearer test-token");
    assert.equal(
      upstreamRequest.options.headers["X-Authenticated-User-Id"],
      TEST_PRINCIPAL.userId
    );
    assert.deepEqual(JSON.parse(upstreamRequest.options.body), {
      profile_id: "user:1",
      name: "Updated"
    });
  } finally {
    if (previous.base === undefined) delete process.env.HYBRID_API_BASE_URL;
    else process.env.HYBRID_API_BASE_URL = previous.base;
    if (previous.token === undefined) delete process.env.HYBRID_API_TOKEN;
    else process.env.HYBRID_API_TOKEN = previous.token;
    if (previous.vercel === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previous.vercel;
    global.fetch = previous.fetch;
  }
});

test("changing search settings is surfaced as a stale-result state", () => {
  const app = source("app.js");
  assert.match(app, /Search settings changed · run matching again/);
  assert.doesNotMatch(app, /Hybrid ranked/);
  assert.match(app, /search_focus\.addEventListener\("input"/);
  assert.match(app, /top_k_select\.addEventListener\("change"/);
  assert.match(app, /reviewDisabled: state\.resultsStale/);
  assert.match(app, /searchText: state\.lastMatchedSearchText/);
  assert.match(source("renderers.js"), /Run matching again before generating an explanation/);
});

test("the catalogue waits for an explicit profile choice", () => {
  const app = source("app.js");
  assert.match(app, /if \(!state\.profiles\.some\(\(profile\) => profile\.id === state\.profileId\)\) state\.profileId = ""/);
  assert.doesNotMatch(app, /state\.profileId = state\.profiles\[0\]/);
});

test("optional search priority is distinct from profile selection and result count", () => {
  const html = source("index.html");
  const app = source("app.js");
  assert.doesNotMatch(html, /Step 1|Step 2|Refine your search/);
  assert.match(html, /<p class="eyebrow" id="profile-step-kicker">Required<\/p><h2 id="profile-step-title">Choose a profile<\/h2>/);
  assert.match(html, /<p class="eyebrow">Optional<\/p><h2>Search priority<\/h2>/);
  assert.match(html, /role="radiogroup" aria-label="Search method"/);
  assert.match(html, /Profile only/);
  assert.match(html, /Add a priority/);
  assert.match(html, /<div class="match-actions">[\s\S]*?id="top-k-select"[\s\S]*?id="match-button"/);
  assert.match(app, /function currentSearchText\(\)/);
  assert.match(app, /state\.searchMode === "focus"/);
  assert.match(app, /function validateSearchFocus\(\)/);
  assert.doesNotMatch(app, /moveFocus/);
});

test("profile picker and per-card AI assessment use user-facing fields", () => {
  const html = source("index.html");
  const app = source("app.js");
  const renderer = source("renderers.js");
  assert.match(html, /Search profiles/);
  assert.match(app, /249 saved profiles/);
  assert.match(renderer, /profile\.name/);
  assert.match(renderer, /profile\.location/);
  assert.match(renderer, /Explain this match with AI/);
  assert.match(app, /MATCHER_API\.review/);
  assert.doesNotMatch(app, /matches\.slice\(0,\s*8\)/);
});

test("profile picker supports keyboard navigation and listbox semantics", () => {
  const html = source("index.html");
  const app = source("app.js");
  const renderer = source("renderers.js");
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-autocomplete="list"/);
  assert.match(app, /"ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape"/);
  assert.match(app, /event\.key === "Tab"/);
  assert.match(app, /aria-activedescendant/);
  assert.match(renderer, /role="option" tabindex="-1"/);
});

test("preview results expose a bounded sample AI explanation", async () => {
  const api = previewClient();
  await api.listProfiles();
  const response = await api.review({
    profileId: "profile:1",
    opportunityId: "opp-1",
    searchText: ""
  });
  assert.equal(response.mode, "preview");
  assert.equal(response.decision.summary, "The opportunity may fit supported organisations.");
  assert.deepEqual(response.decision.required_checks, ["Confirm applicant requirements"]);

  const app = source("app.js");
  assert.match(app, /data-action="review-result"/);
});

test("form errors are described and service failures are assertive", () => {
  const app = source("app.js");
  assert.match(app, /field-error-\$\{name\}/);
  assert.match(app, /field\.setAttribute\("aria-describedby"/);
  assert.match(app, /tone === "error" \? "alert" : "status"/);
  assert.match(app, /tone === "error" \? "assertive" : "polite"/);
});

test("public AI decision is normalised and rendered without internal fields", () => {
  const context = browserLogic();
  const decision = context.normaliseDecision({
    recommendation: "reference",
    suitable_for: { code: "beneficiaries", label: "Supported organisations or founders" },
    summary: "A relevant but conditional fit.",
    match_points: ["Sector alignment"],
    required_checks: ["Confirm applicant type"],
    action: { code: "review_requirements", label: "Check requirements before proceeding" },
    evidence_references: [1, 2]
  });
  assert.equal(decision.suitableFor, "Supported organisations or founders");
  const html = context.renderDecision(decision);
  assert.match(html, /Potential match/);
  assert.doesNotMatch(html, /Worth checking/);
  assert.match(html, /Confirm applicant type/);
  assert.doesNotMatch(html, /evidence_references/);
});

test("cited source quotes are shown so a user can check the AI claim", () => {
  const context = browserLogic();
  const decision = context.normaliseDecision({
    recommendation: "reference",
    suitable_for: { code: "beneficiaries", label: "Supported organisations or founders" },
    summary: "A relevant but conditional fit.",
    match_points: ["Sector alignment"],
    required_checks: ["Confirm applicant type"],
    action: { code: "review_requirements", label: "Check requirements before proceeding" },
    evidence: [
      {
        id: 2,
        source_field: "eligibility_source_text",
        text: "Applicants must be small or medium enterprises."
      }
    ]
  });

  assert.equal(decision.evidence.length, 1);
  // The raw field name is internal; the user sees a readable label.
  assert.equal(decision.evidence[0].sourceField, "Eligibility text");

  const html = context.renderDecision(decision);
  assert.match(html, /1 source quote/);
  assert.match(html, /Applicants must be small or medium enterprises\./);
  assert.doesNotMatch(html, /eligibility_source_text/);
});

test("a decision without citations renders no evidence block", () => {
  const context = browserLogic();
  const decision = context.normaliseDecision({
    recommendation: "not_suitable",
    suitable_for: { code: "none", label: "No suitable group identified" },
    summary: "Out of scope.",
    match_points: [],
    required_checks: [],
    action: { code: "skip", label: "Not a current match" }
  });

  assert.equal(decision.evidence.length, 0);
  const html = context.renderDecision(decision);
  assert.doesNotMatch(html, /source quote/);
  assert.match(html, /No clear match/);
  assert.match(html, /<dt>Assessment<\/dt>/);
  assert.doesNotMatch(html, /Not suitable/);
  assert.doesNotMatch(html, /Why this match/);
});

test("source quotes are escaped because they come from scraped pages", () => {
  const context = browserLogic();
  const decision = context.normaliseDecision({
    recommendation: "reference",
    suitable_for: { code: "beneficiaries", label: "Supported organisations or founders" },
    summary: "A relevant but conditional fit.",
    match_points: ["Sector alignment"],
    required_checks: ["Confirm applicant type"],
    action: { code: "review_requirements", label: "Check requirements before proceeding" },
    evidence: [
      {
        id: 1,
        source_field: "summary_text",
        text: '<img src=x onerror="alert(1)">Applicants must be SMEs.'
      }
    ]
  });

  const html = context.renderDecision(decision);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("AI review proxy rejects incomplete requests before forwarding", async () => {
  const handler = require("../api/reviews").createHandler({
    authenticate: async () => TEST_PRINCIPAL
  });
  const response = responseMock();
  await handler({ method: "POST", body: { profile_id: "profile:1" } }, response);
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /opportunity_id is required/);
});

test("actionability is shown on every result without a review", () => {
  const context = browserLogic();
  const match = context.normaliseMatchResponse({
    results: [{
      rank: 1,
      opportunity: { id: "o1", title: "A call", funders: [], source_url: "https://a.example" },
      actionability: {
        code: "research_only",
        label: "Research applicants only",
        basis: ["The available eligibility evidence limits the visible route to research applicants"],
        evidence: [{ id: 1, source_field: "eligibility_source_text", text: "Applicants must be based at an eligible research organisation." }]
      }
      // No decision: the badge must not depend on an AI review having run.
    }]
  });

  const html = context.renderResults(match.results);
  assert.match(html, /actionability-badge closed/);
  assert.match(html, /Research applicants only/);
  assert.match(html, /eligibility evidence limits/);
  assert.match(html, /Applicants must be based at an eligible research organisation/);
  // It is a source-derived fact, so it must not be presented as AI output.
  assert.doesNotMatch(html, /AI match review/);
});

test("an unstated route shows no badge rather than a noisy one", () => {
  const context = browserLogic();
  const match = context.normaliseMatchResponse({
    results: [{
      rank: 1,
      opportunity: { id: "o1", title: "A call", funders: [], source_url: "https://a.example" },
      actionability: { code: "unstated", label: "Participation requirements not confirmed", basis: [], evidence: [] }
    }]
  });

  const html = context.renderResults(match.results);
  assert.doesNotMatch(html, /actionability-badge/);
  // The whole block is suppressed, not just the badge: it would say nothing.
  assert.doesNotMatch(html, /Participation route/);
});

test("known activity remains visible without claiming applicant eligibility", () => {
  const context = browserLogic();
  const match = context.normaliseMatchResponse({
    results: [{
      rank: 1,
      opportunity: { id: "o1", title: "A call", funders: [], source_url: "https://a.example" },
      actionability: {
        code: "unstated",
        label: "Participation requirements not confirmed",
        basis: [
          "Supports research and technology development",
          "Applicant type is not confirmed from the available evidence"
        ],
        evidence: [{ id: 1, source_field: "support_types", text: "HORIZON Research and Innovation Actions" }]
      }
    }]
  });

  const html = context.renderResults(match.results);
  assert.match(html, /actionability-badge review/);
  assert.match(html, /Participation requirements not confirmed/);
  assert.match(html, /Participation route/);
  assert.match(html, /Supports research and technology development/);
  assert.match(html, /Applicant type is not confirmed/);
  assert.match(html, /<details class="actionability-evidence">/);
  assert.doesNotMatch(html, /<details class="actionability-evidence" open/);
  assert.match(html, /<summary>Source evidence<\/summary>/);
  assert.doesNotMatch(html, /Where this comes from/);
  assert.doesNotMatch(html, /Read from the funder/);
  assert.doesNotMatch(html, /Research applicants only/);
});

test("an unknown actionability code is discarded", () => {
  const context = browserLogic();
  const match = context.normaliseMatchResponse({
    results: [{
      rank: 1,
      opportunity: { id: "o1", title: "A call", funders: [], source_url: "https://a.example" },
      actionability: { code: "definitely_apply", label: "Guaranteed", basis: [], evidence: [] }
    }]
  });

  assert.equal(match.results[0].actionability, null);
  assert.doesNotMatch(context.renderResults(match.results), /Guaranteed/);
});

test("actionability evidence from scraped fields is escaped", () => {
  const context = browserLogic();
  const match = context.normaliseMatchResponse({
    results: [{
      rank: 1,
      opportunity: { id: "o1", title: "A call", funders: [], source_url: "https://a.example" },
      actionability: {
        code: "open_to_ventures",
        label: "Open to companies and ventures",
        basis: ['<img src=x onerror="alert(1)">'],
        evidence: [{ id: 1, source_field: "summary_text", text: '<script>alert(1)</script>SMEs may apply.' }]
      }
    }]
  });

  const html = context.renderResults(match.results);
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img/);
});
