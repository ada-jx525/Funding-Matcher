const { withApplicationPrincipal } = require("../../lib/auth-proxy");
const { proxy, send } = require("../../lib/proxy");

function createHandler({ authenticate } = {}) {
  return async function handler(request, response) {
    return withApplicationPrincipal(request, response, async (principal) => {
      if (request.method !== "DELETE") {
        return proxy(request, response, "/api/profiles/invalid", {
          methods: ["DELETE"], principal
        });
      }
      const raw = request.query?.profileId;
      const profileId = Array.isArray(raw) ? raw[0] : raw;
      if (typeof profileId !== "string" || !/^user:[0-9a-f-]{36}$/.test(profileId)) {
        return send(response, 400, { error: "A valid user profile ID is required." });
      }
      return proxy(
        request,
        response,
        `/api/profiles/${encodeURIComponent(profileId)}`,
        { methods: ["DELETE"], principal }
      );
    }, { authenticate });
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
