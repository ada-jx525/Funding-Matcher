const { send } = require("../../lib/proxy");
const { authSettings } = require("../../lib/auth");

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return send(response, 405, { error: "Method not allowed." });
  }
  const settings = authSettings();
  return send(response, 200, {
    enabled: settings.uiEnabled,
    provider: settings.uiEnabled ? "entra" : null,
    client_id: settings.uiEnabled ? settings.clientId : null,
    authority: settings.uiEnabled ? settings.authority : null,
    api_scope: settings.uiEnabled ? settings.scope : null
  });
};
