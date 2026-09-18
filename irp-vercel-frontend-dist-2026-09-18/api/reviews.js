const { proxy, send } = require("../lib/proxy");
const { withApplicationPrincipal } = require("../lib/auth-proxy");

function createHandler({ authenticate } = {}) {
return async function handler(request, response) {
  return withApplicationPrincipal(request, response, async (principal) => {
  if (request.method !== "POST") {
    return proxy(request, response, "/api/reviews", {
      methods: ["POST"], principal
    });
  }
  const body = request.body || {};
  const searchText = body.search_text == null ? "" : body.search_text;
  if (typeof body.profile_id !== "string" || !body.profile_id.trim()) {
    return send(response, 400, { error: "profile_id is required." });
  }
  if (typeof body.opportunity_id !== "string" || !body.opportunity_id.trim()) {
    return send(response, 400, { error: "opportunity_id is required." });
  }
  if (typeof searchText !== "string" || searchText.length > 300) {
    return send(response, 400, { error: "search_text must be a string of at most 300 characters." });
  }
  request.body = {
    profile_id: body.profile_id.trim(),
    opportunity_id: body.opportunity_id.trim(),
    search_text: searchText.trim() || null
  };
  return proxy(request, response, "/api/reviews", {
    methods: ["POST"], timeoutMs: 120_000, principal
  });
  }, { authenticate });
};
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
