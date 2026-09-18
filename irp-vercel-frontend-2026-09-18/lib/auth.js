const ADMIN_ROLE = "Admin";
const INVALID_TOKEN_ERROR_CODES = new Set([
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_EXPIRED",
  "ERR_JWT_INVALID",
  "ERR_JWKS_NO_MATCHING_KEY"
]);

class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

function isSecureUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function authSettings(env = process.env) {
  const enabled = env.AUTH_ENABLED === "true";
  const required = {
    issuer: env.ENTRA_ISSUER,
    jwksUri: env.ENTRA_JWKS_URI,
    audience: env.ENTRA_API_AUDIENCE,
    tenantId: env.ENTRA_TENANT_ID,
    requiredScope: env.ENTRA_REQUIRED_SCOPE
  };
  const allowedClientIds = String(env.ENTRA_ALLOWED_CLIENT_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const configured = enabled
    && Boolean(required.audience)
    && Boolean(required.tenantId)
    && Boolean(required.requiredScope)
    && allowedClientIds.length > 0
    && isSecureUrl(required.issuer)
    && isSecureUrl(required.jwksUri);
  const browser = {
    clientId: env.ENTRA_CLIENT_ID || "",
    authority: env.ENTRA_AUTHORITY || "",
    scope: env.ENTRA_API_SCOPE || ""
  };
  const browserConfigured = Boolean(browser.clientId && browser.scope)
    && isSecureUrl(browser.authority);
  return {
    enabled,
    configured,
    ...required,
    allowedClientIds,
    ...browser,
    uiEnabled: configured && browserConfigured && env.AUTH_UI_ENABLED === "true"
  };
}

function bearerToken(request) {
  const header = request.headers?.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    throw new AuthError(401, "Sign in is required.");
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) throw new AuthError(401, "Sign in is required.");
  return token;
}

const remoteKeySets = new Map();

async function verifyEntraToken(token, settings) {
  const { createRemoteJWKSet, jwtVerify } = await import("jose");
  let keySet = remoteKeySets.get(settings.jwksUri);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(settings.jwksUri));
    remoteKeySets.set(settings.jwksUri, keySet);
  }
  const { payload } = await jwtVerify(token, keySet, {
    issuer: settings.issuer,
    audience: settings.audience,
    algorithms: ["RS256"]
  });
  return payload;
}

async function authenticatedUser(
  request,
  { env = process.env, verifyToken = verifyEntraToken, logger = console } = {}
) {
  const settings = authSettings(env);
  if (!settings.configured) {
    throw new AuthError(503, "Authentication provider is not configured.");
  }
  const token = bearerToken(request);
  let claims;
  try {
    claims = await verifyToken(token, settings);
  } catch (error) {
    if (INVALID_TOKEN_ERROR_CODES.has(error?.code)) {
      throw new AuthError(401, "Your sign-in session is invalid or has expired.");
    }
    // Operational failures are logged without tokens or claims so deployment
    // faults are distinguishable from invalid user credentials.
    logger?.error?.("Authentication provider verification failed.", {
      name: error?.name || "UnknownError",
      code: error?.code || "UNKNOWN"
    });
    throw new AuthError(503, "Authentication service is temporarily unavailable.");
  }
  const tenantId = typeof claims?.tid === "string" ? claims.tid.trim() : "";
  const objectId = typeof claims?.oid === "string" ? claims.oid.trim() : "";
  const authorisedParty = typeof claims?.azp === "string"
    ? claims.azp.trim()
    : (typeof claims?.appid === "string" ? claims.appid.trim() : "");
  const scopes = new Set(
    typeof claims?.scp === "string"
      ? claims.scp.split(/\s+/).filter(Boolean)
      : []
  );
  if (!tenantId || tenantId !== settings.tenantId
      || !objectId
      || !settings.allowedClientIds.includes(authorisedParty)
      || !scopes.has(settings.requiredScope)) {
    throw new AuthError(401, "Your sign-in session is invalid or has expired.");
  }
  const roles = Array.isArray(claims.roles)
    ? claims.roles.filter((role) => typeof role === "string")
    : [];
  return Object.freeze({
    userId: `entra:${tenantId}:${objectId}`,
    roles: Object.freeze(roles)
  });
}

async function requireAdmin(request, options = {}) {
  const user = await authenticatedUser(request, options);
  if (!user.roles.includes(ADMIN_ROLE)) {
    throw new AuthError(403, "Administrator access is required.");
  }
  return user;
}

module.exports = { ADMIN_ROLE, AuthError, authSettings, authenticatedUser, requireAdmin };
