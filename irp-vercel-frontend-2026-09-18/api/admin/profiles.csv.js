const { requireAdmin, AuthError } = require("../../lib/auth");
const { proxyDownload, send } = require("../../lib/proxy");

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return send(response, 405, { error: "Method not allowed." });
  }
  try {
    const user = await requireAdmin(request);
    return proxyDownload(request, response, "/api/admin/profiles.csv", {
      userId: user.userId,
      roles: user.roles
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return send(response, error.status, { error: error.message });
    }
    return send(response, 500, { error: "The profile export could not be prepared." });
  }
};
