const { AuthError, authenticatedUser } = require("./auth");
const { proxy, send } = require("./proxy");

async function authenticatedProxy(request, response, path, options, dependencies = {}) {
  return withPrincipal(request, response, (principal) => (
    proxy(request, response, path, { ...options, principal })
  ), dependencies);
}

async function applicationProxy(request, response, path, options, dependencies = {}) {
  return withApplicationPrincipal(request, response, (principal) => (
    proxy(request, response, path, { ...options, principal })
  ), dependencies);
}

function applicationAccessMode(environment = process.env) {
  return environment.APPLICATION_ACCESS_MODE || environment.PILOT_ACCESS_MODE || "";
}

async function withApplicationPrincipal(
  request,
  response,
  callback,
  dependencies = {}
) {
  const environment = dependencies.environment || process.env;
  // Deployment Protection is the authentication boundary for the explicitly
  // configured single-tenant pilot. Public deployments always require the
  // application's verified Entra principal.
  if (
    environment.VERCEL_ENV === "production"
    && applicationAccessMode(environment) === "deployment-protected"
  ) {
    return callback(null);
  }
  return withPrincipal(request, response, callback, dependencies);
}

async function withPrincipal(
  request,
  response,
  callback,
  { authenticate = authenticatedUser } = {}
) {
  try {
    const principal = await authenticate(request);
    return await callback(principal);
  } catch (error) {
    if (error instanceof AuthError) {
      return send(response, error.status, { error: error.message });
    }
    throw error;
  }
}

module.exports = {
  applicationAccessMode,
  applicationProxy,
  authenticatedProxy,
  withApplicationPrincipal,
  withPrincipal
};
