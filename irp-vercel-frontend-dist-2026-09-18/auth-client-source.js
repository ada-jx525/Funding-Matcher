import {
  BrowserCacheLocation,
  InteractionRequiredAuthError,
  PublicClientApplication
} from "@azure/msal-browser";

let config = Object.freeze({ enabled: false, provider: null });
let client = null;
let account = null;

function user() {
  if (!account) return null;
  const claims = account.idTokenClaims || {};
  return Object.freeze({
    id: String(account.localAccountId || account.homeAccountId),
    name: String(account.name || account.username || "Account"),
    roles: Object.freeze(Array.isArray(claims.roles) ? [...claims.roles] : [])
  });
}

function snapshot() {
  return Object.freeze({ config, user: user() });
}

async function initialise() {
  let response;
  try {
    response = await fetch("/api/auth/config", {
      headers: { Accept: "application/json" },
      credentials: "same-origin"
    });
  } catch {
    return snapshot();
  }
  if (!response.ok) return snapshot();
  const value = await response.json();
  config = Object.freeze({
    enabled: value.enabled === true,
    provider: value.provider === "entra" ? "entra" : null,
    clientId: String(value.client_id || ""),
    authority: String(value.authority || ""),
    apiScope: String(value.api_scope || "")
  });
  if (!config.enabled) return snapshot();

  client = new PublicClientApplication({
    auth: {
      clientId: config.clientId,
      authority: config.authority,
      redirectUri: window.location.origin,
      postLogoutRedirectUri: window.location.origin,
      navigateToLoginRequestUrl: true
    },
    cache: {
      cacheLocation: BrowserCacheLocation.SessionStorage,
      storeAuthStateInCookie: false
    }
  });
  await client.initialize();
  const redirect = await client.handleRedirectPromise();
  account = redirect?.account || client.getActiveAccount() || client.getAllAccounts()[0] || null;
  if (account) client.setActiveAccount(account);
  return snapshot();
}

async function signIn() {
  if (!client || !config.enabled) throw new Error("Sign-in is not configured.");
  await client.loginRedirect({ scopes: [config.apiScope] });
}

async function signOut() {
  if (!client || !account) return;
  await client.logoutRedirect({ account });
}

async function accessToken() {
  if (!config.enabled) return null;
  if (!client || !account) throw new Error("Sign in is required.");
  try {
    const result = await client.acquireTokenSilent({
      account,
      scopes: [config.apiScope]
    });
    return result.accessToken;
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) {
      await client.acquireTokenRedirect({
        account,
        scopes: [config.apiScope]
      });
      return null;
    }
    throw error;
  }
}

async function authorizationHeaders() {
  const token = await accessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function isAdmin() {
  return Boolean(user()?.roles.includes("Admin"));
}

async function downloadProfiles() {
  if (!isAdmin()) throw new Error("Administrator access is required.");
  const response = await fetch("/api/admin/profiles.csv", {
    headers: await authorizationHeaders(),
    credentials: "same-origin"
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "The profile export could not be downloaded.");
  }
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] || "profiles.csv";
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

globalThis.AUTH_CLIENT = Object.freeze({
  initialise,
  snapshot,
  signIn,
  signOut,
  accessToken,
  authorizationHeaders,
  isAdmin,
  downloadProfiles
});
